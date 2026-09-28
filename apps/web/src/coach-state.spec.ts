import type { LivePosition, LiveState } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  coachReducer,
  createInitialCoachState,
  LIVE_MARKER_STALE_AFTER_MS,
  markerForRun,
} from './coach-state.js';

const runId = '11111111-1111-4111-8111-111111111111';
const otherRunId = '22222222-2222-4222-8222-222222222222';
const streamId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const position: LivePosition = {
  accuracyM: 4,
  coordinates: [21.0122, 52.2297],
  quality: 'confirmed',
  recordedAt: '2026-09-27T10:00:00.000Z',
  seq: '4',
};

function liveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    algorithmVersion: 'track-v1',
    runs: [{ dataRevision: '4', position, runId, status: 'recording' }],
    sequence: 0,
    serverTime: '2026-09-27T10:00:02.000Z',
    streamId,
    ...overrides,
  };
}

describe('coach state', () => {
  it('derives fresh quality and transitions a marker to stale from server-relative age', () => {
    const state = coachReducer(createInitialCoachState(), {
      receivedAtMonotonicMs: 1_000,
      state: liveState(),
      type: 'state-received',
    });

    expect(markerForRun(state, state.runs[0]!, 1_000)).toMatchObject({
      ageMs: 2_000,
      position,
      quality: 'confirmed',
    });
    expect(
      markerForRun(
        state,
        state.runs[0]!,
        1_000 + LIVE_MARKER_STALE_AFTER_MS - 2_000,
      ).quality,
    ).toBe('stale');
  });

  it('keeps a null current position only as stale last-known data', () => {
    const current = coachReducer(createInitialCoachState(), {
      receivedAtMonotonicMs: 1_000,
      state: liveState(),
      type: 'state-received',
    });
    const withoutCurrent = coachReducer(current, {
      receivedAtMonotonicMs: 3_000,
      state: liveState({
        runs: [{ dataRevision: '5', position: null, runId, status: 'paused' }],
        sequence: 1,
        serverTime: '2026-09-27T10:00:04.000Z',
      }),
      type: 'state-received',
    });

    expect(withoutCurrent.runs[0]).toMatchObject({
      currentPosition: null,
      lastKnownPosition: position,
    });
    expect(markerForRun(withoutCurrent, withoutCurrent.runs[0]!, 3_000).quality).toBe('stale');
  });

  it('preserves a fresh server-evaluated unconfirmed marker', () => {
    const state = coachReducer(createInitialCoachState(), {
      receivedAtMonotonicMs: 1_000,
      state: liveState({
        runs: [{
          dataRevision: '4',
          position: { ...position, quality: 'unconfirmed' },
          runId,
          status: 'recording',
        }],
      }),
      type: 'state-received',
    });

    expect(markerForRun(state, state.runs[0]!, 1_000).quality).toBe('unconfirmed');
  });

  it('removes selection and last-known data when a run is no longer authorized', () => {
    let state = coachReducer(createInitialCoachState(), {
      receivedAtMonotonicMs: 1_000,
      state: liveState({
        runs: [
          { dataRevision: '4', position, runId, status: 'recording' },
          { dataRevision: '1', position: null, runId: otherRunId, status: 'paused' },
        ],
      }),
      type: 'state-received',
    });
    state = coachReducer(state, { runId, type: 'track-toggled' });
    state = coachReducer(state, {
      receivedAtMonotonicMs: 2_000,
      state: liveState({
        runs: [{ dataRevision: '1', position: null, runId: otherRunId, status: 'paused' }],
        sequence: 1,
      }),
      type: 'state-received',
    });

    expect(state.runs.map((run) => run.runId)).toEqual([otherRunId]);
    expect([...state.selectedTrackRunIds]).toEqual([]);
    expect([...state.recoverableTrackRunIds]).toEqual([]);
  });

  it('hides selection on transport loss and restores it only after a fresh authorized state', () => {
    let state = coachReducer(createInitialCoachState(), {
      receivedAtMonotonicMs: 1_000,
      state: liveState(),
      type: 'state-received',
    });
    state = coachReducer(state, { runId, type: 'track-toggled' });
    state = coachReducer(state, { type: 'connection-lost' });

    expect(state.runs).toEqual([]);
    expect([...state.selectedTrackRunIds]).toEqual([]);
    expect([...state.recoverableTrackRunIds]).toEqual([runId]);

    state = coachReducer(state, {
      receivedAtMonotonicMs: 2_000,
      state: liveState({
        sequence: 0,
        streamId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      type: 'state-received',
    });

    expect([...state.selectedTrackRunIds]).toEqual([runId]);
  });

  it('ignores duplicate or older sequence values only within the same stream', () => {
    const current = coachReducer(createInitialCoachState(), {
      receivedAtMonotonicMs: 1_000,
      state: liveState({ sequence: 3 }),
      type: 'state-received',
    });
    const old = coachReducer(current, {
      receivedAtMonotonicMs: 2_000,
      state: liveState({ runs: [], sequence: 2 }),
      type: 'state-received',
    });
    const reconnected = coachReducer(old, {
      receivedAtMonotonicMs: 3_000,
      state: liveState({
        runs: [],
        sequence: 0,
        streamId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      type: 'state-received',
    });

    expect(old).toBe(current);
    expect(reconnected.runs).toEqual([]);
  });
});
