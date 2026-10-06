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
