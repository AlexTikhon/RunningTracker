import type { LivePosition, LiveState } from '@running-tracker/contracts';

export const LIVE_MARKER_STALE_AFTER_MS = 10_000;

export type CoachMarkerQuality = 'confirmed' | 'stale' | 'unavailable' | 'unconfirmed';

export interface CoachRunState {
  currentPosition: LivePosition | null;
  dataRevision: string;
  lastKnownPosition: LivePosition | null;
  runId: string;
  status: 'paused' | 'recording';
}

export interface CoachState {
  algorithmVersion: string | null;
  receivedAtMonotonicMs: number | null;
  recoverableTrackRunIds: ReadonlySet<string>;
  runs: CoachRunState[];
  selectedTrackRunIds: ReadonlySet<string>;
  sequence: number | null;
  serverTime: string | null;
  streamId: string | null;
}

export interface CoachMarker {
  ageMs: number | null;
  position: LivePosition | null;
  quality: CoachMarkerQuality;
}

export type CoachAction =
  | { type: 'connection-lost' }
  | { type: 'reset' }
  | { runId: string; type: 'track-toggled' }
  | { receivedAtMonotonicMs: number; state: LiveState; type: 'state-received' };

export function createInitialCoachState(): CoachState {
  return {
    algorithmVersion: null,
    receivedAtMonotonicMs: null,
    recoverableTrackRunIds: new Set(),
    runs: [],
    selectedTrackRunIds: new Set(),
    sequence: null,
    serverTime: null,
    streamId: null,
  };
}

function applyLiveState(
  current: CoachState,
  state: LiveState,
  receivedAtMonotonicMs: number,
): CoachState {
  if (
    current.streamId === state.streamId
    && current.sequence !== null
    && state.sequence <= current.sequence
  ) {
    return current;
  }

  const previousRuns = new Map(current.runs.map((run) => [run.runId, run]));
  const runs = state.runs.map((run): CoachRunState => {
    const previous = previousRuns.get(run.runId);
    return {
      currentPosition: run.position,
      dataRevision: run.dataRevision,
      lastKnownPosition: run.position ?? previous?.lastKnownPosition ?? null,
      runId: run.runId,
      status: run.status,
    };
  });
  const availableRunIds = new Set(runs.map(({ runId }) => runId));
  const selectionSource = current.streamId === null
    ? current.recoverableTrackRunIds
    : current.selectedTrackRunIds;
  const selectedTrackRunIds = new Set(
    [...selectionSource].filter((runId) => availableRunIds.has(runId)),
  );

  return {
    algorithmVersion: state.algorithmVersion,
    receivedAtMonotonicMs,
    runs,
    recoverableTrackRunIds: new Set(selectedTrackRunIds),
    selectedTrackRunIds,
    sequence: state.sequence,
    serverTime: state.serverTime,
    streamId: state.streamId,
  };
}

export function coachReducer(state: CoachState, action: CoachAction): CoachState {
  switch (action.type) {
    case 'connection-lost':
      return {
        ...createInitialCoachState(),
        recoverableTrackRunIds: new Set(state.selectedTrackRunIds),
      };
    case 'reset':
      return createInitialCoachState();
    case 'state-received':
      return applyLiveState(state, action.state, action.receivedAtMonotonicMs);
    case 'track-toggled': {
      if (!state.runs.some(({ runId }) => runId === action.runId)) {
        return state;
      }
      const selectedTrackRunIds = new Set(state.selectedTrackRunIds);
      if (selectedTrackRunIds.has(action.runId)) {
        selectedTrackRunIds.delete(action.runId);
      } else {
        selectedTrackRunIds.add(action.runId);
      }
      return {
        ...state,
        recoverableTrackRunIds: new Set(selectedTrackRunIds),
        selectedTrackRunIds,
      };
    }
  }
}

export function markerForRun(
  state: CoachState,
  run: CoachRunState,
  nowMonotonicMs: number,
): CoachMarker {
  const position = run.currentPosition ?? run.lastKnownPosition;
  if (
    position === null
    || state.serverTime === null
    || state.receivedAtMonotonicMs === null
  ) {
    return { ageMs: null, position: null, quality: 'unavailable' };
  }

  const estimatedServerNow = Date.parse(state.serverTime)
    + Math.max(0, nowMonotonicMs - state.receivedAtMonotonicMs);
  const ageMs = Math.max(0, estimatedServerNow - Date.parse(position.recordedAt));
  if (run.currentPosition === null || ageMs >= LIVE_MARKER_STALE_AFTER_MS) {
    return { ageMs, position, quality: 'stale' };
  }

  return { ageMs, position, quality: run.currentPosition.quality };
}
