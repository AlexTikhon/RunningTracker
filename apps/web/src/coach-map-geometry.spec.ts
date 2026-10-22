import type { LivePosition, LiveState, TrackPoint } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { coachMapGeometry, trackGeometry } from './coach-map-geometry.js';
import {
  coachReducer,
  createInitialCoachState,
  LIVE_MARKER_STALE_AFTER_MS,
  type CoachState,
} from './coach-state.js';
import type { SelectedTrackSnapshot } from './selected-track-sync.js';

const runId = '11111111-1111-4111-8111-111111111111';
const otherRunId = '22222222-2222-4222-8222-222222222222';
const streamId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function point(
  seq: string,
  longitude: number,
  overrides: Partial<TrackPoint> = {},
): TrackPoint {
  return {
    accuracyM: 5,
    connectFromPrevious: true,
    coordinates: [longitude, 52],
    predecessorSeq: seq === '1' ? null : (BigInt(seq) - 1n).toString(),
    recordedAt: '2026-10-22T10:00:00.000Z',
    segmentId: 0,
    seq,
    ...overrides,
  };
}

function first(seq: string, longitude: number, overrides: Partial<TrackPoint> = {}): TrackPoint {
  return point(seq, longitude, { connectFromPrevious: false, predecessorSeq: null, ...overrides });
}

describe('trackGeometry', () => {
  it('draws one line through server-accepted connections, in longitude/latitude order', () => {
    expect(trackGeometry([first('1', 21), point('2', 21.1), point('3', 21.2)])).toEqual({
      isolated: [],
      lines: [[[21, 52], [21.1, 52], [21.2, 52]]],
    });
  });

  it('breaks the line at a rejected connection even though the predecessor is named', () => {
    const geometry = trackGeometry([
      first('1', 21),
      point('2', 21.1),
      point('3', 21.2, { connectFromPrevious: false }),
      point('4', 21.3),
    ]);

    expect(geometry.lines).toEqual([
      [[21, 52], [21.1, 52]],
      [[21.2, 52], [21.3, 52]],
    ]);
    expect(geometry.isolated).toEqual([]);
  });

  it('never bridges a segment boundary, even when a point claims the connection', () => {
    const geometry = trackGeometry([
      first('1', 21),
      point('2', 21.1),
      point('3', 21.2, { segmentId: 1 }),
      point('4', 21.3, { segmentId: 1 }),
    ]);

    expect(geometry.lines).toEqual([
      [[21, 52], [21.1, 52]],
      [[21.2, 52], [21.3, 52]],
    ]);
  });

  it('does not connect a missing or mismatched predecessor', () => {
    const geometry = trackGeometry([
      first('1', 21),
      // Its predecessor 2 is not in the committed snapshot.
      point('3', 21.2, { predecessorSeq: '2' }),
      // Names 3 but follows 4: the annotation does not describe this snapshot.
      point('4', 21.3, { predecessorSeq: '3' }),
      point('5', 21.4, { predecessorSeq: '3' }),
      // No predecessor at all, yet marked connected.
      point('6', 21.5, { predecessorSeq: null }),
    ]);

    expect(geometry.lines).toEqual([[[21.2, 52], [21.3, 52]]]);
    expect(geometry.isolated).toEqual([[21, 52], [21.4, 52], [21.5, 52]]);
  });

  it('keeps a server-accepted edge across a sequence gap', () => {
    const geometry = trackGeometry([first('1', 21), point('7', 21.1, { predecessorSeq: '1' })]);

    expect(geometry.lines).toEqual([[[21, 52], [21.1, 52]]]);
  });

  it('orders and matches sequence values beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const base = 9_007_199_254_740_993n;
    const a = base.toString();
    const b = (base + 1n).toString();
    const c = (base + 2n).toString();
    // As numbers, b and c would round to the same value as their neighbours.
    const geometry = trackGeometry([
      point(c, 21.2, { predecessorSeq: b }),
      first(a, 21),
      point(b, 21.1, { predecessorSeq: a }),
    ]);

    expect(geometry.lines).toEqual([[[21, 52], [21.1, 52], [21.2, 52]]]);
  });

  it('returns nothing for an empty track and one isolated point for a single point', () => {
    expect(trackGeometry([])).toEqual({ isolated: [], lines: [] });
    expect(trackGeometry([first('1', 21)])).toEqual({ isolated: [[21, 52]], lines: [] });
  });

  it('follows a late update that removes or moves an earlier edge', () => {
    const before = [first('1', 21), point('2', 21.1), point('3', 21.2)];
    expect(trackGeometry(before).lines).toEqual([[[21, 52], [21.1, 52], [21.2, 52]]]);

    // Point 2 is re-evaluated as rejected by a later revision.
    const rejected = [before[0]!, point('2', 21.1, { connectFromPrevious: false }), before[2]!];
    expect(trackGeometry(rejected)).toEqual({
      isolated: [[21, 52]],
      lines: [[[21.1, 52], [21.2, 52]]],
    });

    // A late point between 1 and 3 (sequence 2 arrives after 3) and the server's repair of 3's edge.
    const lateInsert = [
      first('1', 21),
      point('3', 21.2, { connectFromPrevious: false, predecessorSeq: '2' }),
      point('2', 21.05, { predecessorSeq: '1' }),
    ];
    expect(trackGeometry(lateInsert)).toEqual({
      isolated: [[21.2, 52]],
      lines: [[[21, 52], [21.05, 52]]],
    });
  });
});

const position: LivePosition = {
  accuracyM: 4,
  coordinates: [21.0122, 52.2297],
  quality: 'confirmed',
  recordedAt: '2026-10-22T10:00:00.000Z',
  seq: '3',
};

function liveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    algorithmVersion: 'track-v1',
    runs: [
      { dataRevision: '3', position, runId, status: 'recording' },
      { dataRevision: '1', position: null, runId: otherRunId, status: 'paused' },
    ],
    sequence: 0,
    serverTime: '2026-10-22T10:00:01.000Z',
    streamId,
    ...overrides,
  };
}

function received(state: CoachState, live: LiveState, at: number): CoachState {
  return coachReducer(state, { receivedAtMonotonicMs: at, state: live, type: 'state-received' });
}

function readyTrack(revision = '3', points = [first('1', 21), point('2', 21.1), point('3', 21.2)]): SelectedTrackSnapshot {
  return {
    message: null,
    runId,
    status: 'ready',
    targetRevision: revision,
    track: { algorithmVersion: 'track-v1', points, revision },
  };
}

describe('coachMapGeometry', () => {
  it('draws a marker for each run with a coordinate and nothing for an unavailable one', () => {
    const state = received(createInitialCoachState(), liveState(), 1_000);
    const geometry = coachMapGeometry(state, [], 1_000);

    expect(geometry.markers.features).toEqual([{
      geometry: { coordinates: [21.0122, 52.2297], type: 'Point' },
      properties: { label: 'Run #11111111', quality: 'confirmed', runId },
      type: 'Feature',
    }]);
    expect(geometry.markerCounts).toEqual({ confirmed: 1, stale: 0, unconfirmed: 0 });
    expect(geometry.bounds).toEqual([[21.0122, 52.2297], [21.0122, 52.2297]]);
  });

  it('turns a confirmed marker stale by the monotonic freshness rule', () => {
    const state = received(createInitialCoachState(), liveState(), 1_000);
    const later = 1_000 + LIVE_MARKER_STALE_AFTER_MS - 1_000;

    expect(coachMapGeometry(state, [], later - 1).markers.features[0]?.properties.quality).toBe('confirmed');
    expect(coachMapGeometry(state, [], later).markers.features[0]?.properties.quality).toBe('stale');
  });

  it('keeps a null current position only as a stale last-known point and never invents one', () => {
    const current = received(createInitialCoachState(), liveState(), 1_000);
    const withoutCurrent = received(current, liveState({
      runs: [
        { dataRevision: '4', position: null, runId, status: 'paused' },
        { dataRevision: '1', position: null, runId: otherRunId, status: 'paused' },
      ],
      sequence: 1,
      serverTime: '2026-10-22T10:00:02.000Z',
    }), 2_000);
    const geometry = coachMapGeometry(withoutCurrent, [], 2_000);

    expect(geometry.markers.features).toHaveLength(1);
    expect(geometry.markers.features[0]).toMatchObject({
      geometry: { coordinates: [21.0122, 52.2297] },
      properties: { quality: 'stale', runId },
    });
    expect(geometry.markerCounts).toEqual({ confirmed: 0, stale: 1, unconfirmed: 0 });
  });

  it('draws a track only for a selected run that is in the authorized run set', () => {
    const state = received(createInitialCoachState(), liveState(), 1_000);
    const selected = coachReducer(state, { runId, type: 'track-toggled' });

    expect(coachMapGeometry(state, [readyTrack()], 1_000).tracks.features).toEqual([]);
    expect(coachMapGeometry(selected, [readyTrack()], 1_000).tracks.features).toEqual([{
      geometry: { coordinates: [[21, 52], [21.1, 52], [21.2, 52]], type: 'LineString' },
      properties: { kind: 'line', label: 'Run #11111111', latest: true, revision: '3', runId },
      type: 'Feature',
    }]);

    // A later full state without the run: neither its marker nor its retained track is drawn.
    const revoked = received(selected, liveState({
      runs: [{ dataRevision: '1', position: null, runId: otherRunId, status: 'paused' }],
      sequence: 1,
    }), 1_500);
    const geometry = coachMapGeometry(revoked, [readyTrack()], 1_500);
    expect(geometry.markers.features).toEqual([]);
    expect(geometry.tracks.features).toEqual([]);
    expect(geometry.bounds).toBeNull();
  });

  it('removes only the track when a run is deselected', () => {
    const selected = coachReducer(received(createInitialCoachState(), liveState(), 1_000), {
      runId,
      type: 'track-toggled',
    });
    const deselected = coachReducer(selected, { runId, type: 'track-toggled' });
    const geometry = coachMapGeometry(deselected, [readyTrack()], 1_000);

    expect(geometry.tracks.features).toEqual([]);
    expect(geometry.markers.features).toHaveLength(1);
  });

  it('marks retained older geometry as not the latest revision while syncing or after a failure', () => {
    const state = coachReducer(received(createInitialCoachState(), liveState({
      runs: [{ dataRevision: '5', position, runId, status: 'recording' }],
    }), 1_000), { runId, type: 'track-toggled' });
    const syncing: SelectedTrackSnapshot = { ...readyTrack('3'), status: 'loading', targetRevision: '5' };
    const failed: SelectedTrackSnapshot = { ...readyTrack('3'), message: 'x', status: 'error', targetRevision: '5' };

    for (const snapshot of [syncing, failed]) {
      const geometry = coachMapGeometry(state, [snapshot], 1_000);
      expect(geometry.tracks.features[0]?.properties).toMatchObject({ latest: false, revision: '3' });
      expect(geometry.trackStatuses).toEqual([{
        drawnRevision: '3',
        label: 'Run #11111111',
        latest: false,
        runId,
        status: snapshot.status,
        targetRevision: '5',
      }]);
    }
  });

  it('draws nothing for a first snapshot still being assembled or one from another algorithm', () => {
    const state = coachReducer(received(createInitialCoachState(), liveState(), 1_000), {
      runId,
      type: 'track-toggled',
    });
    const loading: SelectedTrackSnapshot = { message: null, runId, status: 'loading', targetRevision: '3', track: null };
    const otherAlgorithm: SelectedTrackSnapshot = {
      ...readyTrack(),
      track: { ...readyTrack().track!, algorithmVersion: 'track-v0' },
    };

    expect(coachMapGeometry(state, [loading], 1_000).tracks.features).toEqual([]);
    expect(coachMapGeometry(state, [loading], 1_000).trackStatuses[0]?.drawnRevision).toBeNull();
    expect(coachMapGeometry(state, [otherAlgorithm], 1_000).tracks.features).toEqual([]);
  });

  it('draws isolated points and widens the bounds over markers and tracks', () => {
    const state = coachReducer(received(createInitialCoachState(), liveState(), 1_000), {
      runId,
      type: 'track-toggled',
    });
    const geometry = coachMapGeometry(state, [readyTrack('3', [first('1', 20.5), point('2', 21.5, { connectFromPrevious: false })])], 1_000);

    expect(geometry.tracks.features.map((feature) => [feature.geometry.type, feature.geometry.coordinates])).toEqual([
      ['Point', [20.5, 52]],
      ['Point', [21.5, 52]],
    ]);
    expect(geometry.bounds).toEqual([[20.5, 52], [21.5, 52.2297]]);
  });

  it('computes a committed snapshot once and keys the tracks by run, revision and latest flag', () => {
    const state = coachReducer(received(createInitialCoachState(), liveState(), 1_000), {
      runId,
      type: 'track-toggled',
    });
    const snapshot = readyTrack();
    const initial = coachMapGeometry(state, [snapshot], 1_000);
    const tick = coachMapGeometry(state, [snapshot], 2_000);

    // The same coordinate array, not a recomputation, on the next freshness tick.
    expect(tick.tracks.features[0]?.geometry.coordinates).toBe(initial.tracks.features[0]?.geometry.coordinates);
    expect(tick.tracksKey).toBe(initial.tracksKey);
    expect(initial.tracksKey).toBe(JSON.stringify([[runId, 'track-v1', '3', true]]));

    const syncing = coachMapGeometry(state, [{ ...snapshot, status: 'loading', targetRevision: '4' }], 2_000);
    const newer = coachMapGeometry(state, [readyTrack('4', [first('1', 21), point('2', 21.1)])], 2_000);
    const deselected = coachMapGeometry(coachReducer(state, { runId, type: 'track-toggled' }), [snapshot], 2_000);
    expect(new Set([initial.tracksKey, syncing.tracksKey, newer.tracksKey, deselected.tracksKey]).size).toBe(4);
    expect(deselected.tracksKey).toBe('[]');
  });

  it('shows nothing after the connection is lost or the state is reset', () => {
    const selected = coachReducer(received(createInitialCoachState(), liveState(), 1_000), {
      runId,
      type: 'track-toggled',
    });

    for (const action of [{ type: 'connection-lost' }, { type: 'reset' }] as const) {
      const geometry = coachMapGeometry(coachReducer(selected, action), [readyTrack()], 1_000);
      expect(geometry.markers.features).toEqual([]);
      expect(geometry.tracks.features).toEqual([]);
      expect(geometry.bounds).toBeNull();
    }
  });
});
