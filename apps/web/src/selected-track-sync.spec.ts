import type { LiveState, TrackPage } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import { LiveTrackStore, type LiveTrackPageSource } from './live-track-sync.js';
import {
  SelectedTrackSynchronizer,
  type SelectedTrackSnapshot,
} from './selected-track-sync.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function page(toRevision: string): TrackPage {
  return {
    algorithmVersion: 'v1',
    fromRevision: null,
    nextCursor: null,
    toRevision,
    upserts: [{
      accuracyM: 5,
      connectFromPrevious: false,
      coordinates: [21, 52],
      predecessorSeq: null,
      recordedAt: '2026-09-27T10:00:00.000Z',
      segmentId: 0,
      seq: '1',
    }],
  };
}

function state(dataRevision: string, algorithmVersion = 'v1'): LiveState {
  return {
    algorithmVersion,
    runs: [{ dataRevision, position: null, runId, status: 'recording' }],
    sequence: 0,
    serverTime: '2026-09-27T10:00:00.000Z',
    streamId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  };
}

function source(): LiveTrackPageSource & {
  readChanges: ReturnType<typeof vi.fn<LiveTrackPageSource['readChanges']>>;
  readSnapshot: ReturnType<typeof vi.fn<LiveTrackPageSource['readSnapshot']>>;
} {
  return {
    readChanges: vi.fn<LiveTrackPageSource['readChanges']>(),
    readSnapshot: vi.fn<LiveTrackPageSource['readSnapshot']>(),
  };
}

describe('SelectedTrackSynchronizer', () => {
  it('uses one run synchronization and coalesces a newer SSE revision target', async () => {
    const pages = source();
    let finishSnapshot: ((value: TrackPage) => void) | undefined;
    pages.readSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishSnapshot = resolve;
      }),
    );
    pages.readChanges.mockResolvedValueOnce({
      ...page('3'),
      fromRevision: '2',
    });
    const changes: Array<readonly SelectedTrackSnapshot[]> = [];
    const synchronizer = new SelectedTrackSynchronizer({
      onChange: (tracks) => changes.push(tracks),
      orgId,
      store: new LiveTrackStore(pages),
      userId,
    });

    synchronizer.reconcile(state('2'), new Set([runId]));
    synchronizer.reconcile(state('3'), new Set([runId]));
    expect(pages.readSnapshot.mock.calls).toHaveLength(1);
    finishSnapshot?.(page('2'));

    await vi.waitFor(() => {
      expect(changes.at(-1)?.[0]).toMatchObject({
        status: 'ready',
        targetRevision: '3',
        track: { revision: '3' },
      });
    });
    expect(pages.readChanges.mock.calls).toHaveLength(1);
  });

  it('aborts and discards a selected track when it is removed from authorized state', () => {
    const pages = source();
    let requestSignal: AbortSignal | undefined;
    pages.readSnapshot.mockImplementationOnce((_input, signal) => {
      requestSignal = signal;
      return new Promise(() => undefined);
    });
    const onChange = vi.fn();
    const synchronizer = new SelectedTrackSynchronizer({
      onChange,
      orgId,
      store: new LiveTrackStore(pages),
      userId,
    });

    synchronizer.reconcile(state('1'), new Set([runId]));
    synchronizer.reconcile({ ...state('1'), runs: [] }, new Set([runId]));

    expect(requestSignal?.aborted).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('starts a fresh snapshot when the announced algorithm version changes', async () => {
    const pages = source();
    pages.readSnapshot
      .mockResolvedValueOnce(page('1'))
      .mockResolvedValueOnce({ ...page('1'), algorithmVersion: 'v2' });
    const changes: Array<readonly SelectedTrackSnapshot[]> = [];
    const synchronizer = new SelectedTrackSynchronizer({
      onChange: (tracks) => changes.push(tracks),
      orgId,
      store: new LiveTrackStore(pages),
      userId,
    });

    synchronizer.reconcile(state('1'), new Set([runId]));
    await vi.waitFor(() => expect(changes.at(-1)?.[0]?.status).toBe('ready'));
    synchronizer.reconcile(state('1', 'v2'), new Set([runId]));

    await vi.waitFor(() => {
      expect(changes.at(-1)?.[0]?.track?.algorithmVersion).toBe('v2');
    });
    expect(pages.readSnapshot.mock.calls).toHaveLength(2);
    expect(pages.readChanges.mock.calls).toHaveLength(0);
  });
});
