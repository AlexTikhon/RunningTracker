import type { RunView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { advanceDataRevision, mergeCommandResult, mergeRunSnapshot } from './run-snapshot.js';

const finished: RunView = {
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T11:00:00.000Z',
  controlRevision: '1', dataRevision: '2', status: 'finished', rawState: 'available',
  summary: { algorithmVersion: 'v1', distanceM: 0, observedDurationS: 0, sourceRevision: '2', qualityStats: {
    acceptedEdgeCount: 0, acceptedPointCount: 0, excessiveSpeedCount: 0, excessiveTimeGapCount: 0, insufficientData: true,
    nonpositiveTimeDeltaCount: 0, poorAccuracyPointCount: 0, rawPointCount: 0, segmentBreakCount: 0, seqGapCount: 0,
  } },
};

describe('run snapshot validity', () => {
  it('retains a valid published summary across command replay, but invalidates it when uploads advance data', () => {
    const replay = mergeCommandResult(finished, { commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', controlRevision: '1', dataRevision: '1', status: 'finished', finishedAt: finished.finishedAt });
    expect(replay.summary).toEqual(finished.summary);
    expect(advanceDataRevision(replay, '3')).toMatchObject({ dataRevision: '3', summary: null });
    expect(mergeRunSnapshot(replay, { ...finished, dataRevision: '3', summary: null }).summary).toBeNull();
    expect(mergeRunSnapshot({ ...finished, dataRevision: '3', summary: null }, finished).summary).toBeNull();
  });
});

// The server's state machine: a control command advances controlRevision by one and moves recording <-> paused or
// to finished; auto-finish moves recording/paused to finished and the data revision, but not controlRevision.
describe('lifecycle ordering', () => {
  const N = 4;
  const at = (status: RunView['status'], controlRevision: number, dataRevision: number): RunView => ({
    ...finished,
    controlRevision: String(controlRevision),
    dataRevision: String(dataRevision),
    finishedAt: status === 'finished' ? '2026-10-06T10:00:00.000Z' : null,
    status,
    summary: null,
  });
  const result = (status: RunView['status'], controlRevision: number, dataRevision: number) => ({
    commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    controlRevision: String(controlRevision),
    dataRevision: String(dataRevision),
    finishedAt: status === 'finished' ? '2026-10-06T10:00:00.000Z' : null,
    status,
  });

  it('REPRO: a late pause response at the control revision auto-finish preserved cannot undo FINISHED', () => {
    const autoFinished = at('finished', N, 7);
    const merged = mergeCommandResult(autoFinished, result('paused', N, 6));
    expect(merged).toMatchObject({ controlRevision: String(N), dataRevision: '7', finishedAt: autoFinished.finishedAt, status: 'finished' });
  });

  it.each([
    ['FINISHED rev N vs PAUSED rev N', at('finished', N, 7), at('paused', N, 6), 'finished'],
    ['FINISHED rev N vs RECORDING rev N', at('finished', N, 7), at('recording', N, 6), 'finished'],
    ['FINISHED rev N+1 vs PAUSED rev N', at('finished', N + 1, 8), at('paused', N, 6), 'finished'],
    ['PAUSED rev N+1 vs RECORDING rev N', at('paused', N + 1, 8), at('recording', N, 6), 'paused'],
    ['RECORDING rev N vs PAUSED rev N+1', at('recording', N, 6), at('paused', N + 1, 8), 'paused'],
    ['PAUSED rev N vs RECORDING rev N+1 (resume)', at('paused', N, 6), at('recording', N + 1, 8), 'recording'],
    ['PAUSED rev N vs FINISHED rev N (auto-finish learned later)', at('paused', N, 6), at('finished', N, 7), 'finished'],
    ['PAUSED rev N vs FINISHED rev N+1 (finish command)', at('paused', N, 6), at('finished', N + 1, 8), 'finished'],
    ['RECORDING rev N vs RECORDING rev N (same state replayed)', at('recording', N, 6), at('recording', N, 9), 'recording'],
  ] as const)('%s -> %s', (_name, current, incoming, expected) => {
    expect(mergeRunSnapshot(current, incoming).status).toBe(expected);
    // The same pair delivered as a command result, which is how a late response reaches the reducer.
    expect(mergeCommandResult(current, result(incoming.status, Number(incoming.controlRevision), Number(incoming.dataRevision))).status).toBe(expected);
  });

  it('an older revision never moves the lifecycle backwards, whatever its data revision', () => {
    const current = at('paused', N + 1, 8);
    expect(mergeRunSnapshot(current, at('recording', N, 99))).toMatchObject({ controlRevision: String(N + 1), dataRevision: '99', status: 'paused' });
  });

  it('is idempotent for identical and repeated FINISHED snapshots, in any order', () => {
    const first = at('finished', N, 7);
    const again = { ...first, dataRevision: '9' };
    const once = mergeRunSnapshot(first, again);
    expect(mergeRunSnapshot(once, again)).toEqual(once);
    expect(mergeRunSnapshot(once, first)).toEqual(once);
    expect(mergeRunSnapshot(first, first)).toEqual(first);
    expect(once).toMatchObject({ dataRevision: '9', finishedAt: first.finishedAt, status: 'finished' });
  });

  it('keeps the finish time it already knows when a later FINISHED snapshot reports another one', () => {
    const known = at('finished', N, 7);
    expect(mergeRunSnapshot(known, { ...known, finishedAt: '2026-10-06T11:00:00.000Z' }).finishedAt).toBe(known.finishedAt);
  });

  it('a stale ACTIVE view of the same run cannot reopen FINISHED: finished is terminal in the domain, not merely locally', () => {
    // The server never leaves finished, so a recording report for a run already known as finished is the older one.
    const merged = mergeRunSnapshot(at('finished', N + 1, 8), at('recording', N + 2, 20));
    expect(merged.status).toBe('finished');
  });
});
