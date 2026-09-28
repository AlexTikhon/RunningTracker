import { describe, expect, it, vi } from 'vitest';

import { LiveTrackStore, type LiveTrackPageSource } from './live-track-sync.js';
import { RunnerApiError } from './runner-api.js';

const scope = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

const apiScope = { orgId: scope.orgId, runId: scope.runId };

function point(seq: string, predecessorSeq: string | null = null, connected = false) {
  return {
    accuracyM: 5,
    connectFromPrevious: connected,
    coordinates: [21 + Number(seq) / 10_000, 52] as [number, number],
    predecessorSeq,
    recordedAt: `2026-09-27T10:00:${seq.padStart(2, '0')}.000Z`,
    segmentId: 0,
    seq,
  };
}

function page(input: {
  algorithmVersion?: string;
  fromRevision: string | null;
  nextCursor?: string | null;
  toRevision: string;
  upserts?: ReturnType<typeof point>[];
}) {
  return {
    algorithmVersion: input.algorithmVersion ?? 'v1',
    fromRevision: input.fromRevision,
    nextCursor: input.nextCursor ?? null,
    toRevision: input.toRevision,
    upserts: input.upserts ?? [],
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

describe('LiveTrackStore', () => {
  it('publishes a snapshot only after every fixed-revision page succeeds', async () => {
    const pages = source();
    let finishPage: ((value: ReturnType<typeof page>) => void) | undefined;
    pages.readSnapshot
      .mockResolvedValueOnce(page({
        fromRevision: null,
        nextCursor: 'next',
        toRevision: '2',
        upserts: [point('1')],
      }))
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishPage = resolve;
        }),
      );
    const store = new LiveTrackStore(pages);

    const synchronization = store.synchronize(scope);
    await vi.waitFor(() => expect(pages.readSnapshot.mock.calls).toHaveLength(2));
    expect(store.get(scope)).toBeNull();

    finishPage?.(page({
      fromRevision: null,
      toRevision: '2',
      upserts: [point('2', '1', true)],
    }));
    await expect(synchronization).resolves.toMatchObject({
      revision: '2',
      points: [{ seq: '1' }, { seq: '2' }],
    });
    expect(pages.readSnapshot.mock.calls[1]).toEqual([
      { ...apiScope, cursor: 'next' },
      expect.any(AbortSignal),
    ]);
  });

  it('keeps the committed revision and points unchanged when a later change page fails', async () => {
    const pages = source();
    pages.readSnapshot.mockResolvedValueOnce(page({
      fromRevision: null,
      toRevision: '1',
      upserts: [point('1')],
    }));
    pages.readChanges
      .mockResolvedValueOnce(page({
        fromRevision: '1',
        nextCursor: 'next',
        toRevision: '3',
        upserts: [point('2', '1', true)],
      }))
      .mockRejectedValueOnce(new Error('connection lost'));
    const store = new LiveTrackStore(pages);
    const committed = await store.synchronize(scope);

    await expect(store.synchronize(scope)).rejects.toThrow('connection lost');
    expect(store.get(scope)).toBe(committed);
    expect(store.get(scope)).toMatchObject({ revision: '1', points: [{ seq: '1' }] });
  });

  it('idempotently upserts late points and repaired successors before advancing revision', async () => {
    const pages = source();
    pages.readSnapshot.mockResolvedValueOnce(page({
      fromRevision: null,
      toRevision: '1',
      upserts: [point('1'), point('3', '1', true)],
    }));
    pages.readChanges
      .mockResolvedValueOnce(page({
        fromRevision: '1',
        toRevision: '2',
        upserts: [point('2', '1', true), point('3', '2', true)],
      }))
      .mockResolvedValueOnce(page({
        fromRevision: '2',
        toRevision: '2',
        upserts: [point('2', '1', true), point('3', '2', true)],
      }));
    const store = new LiveTrackStore(pages);
    await store.synchronize(scope);

    const changed = await store.synchronize(scope);
    const repeated = await store.synchronize(scope);

    expect(changed).toMatchObject({
      revision: '2',
      points: [
        { predecessorSeq: null, seq: '1' },
        { predecessorSeq: '1', seq: '2' },
        { predecessorSeq: '2', seq: '3' },
      ],
    });
    expect(repeated).toEqual(changed);
  });

  it('replaces local state with a snapshot when the algorithm version changes', async () => {
    const pages = source();
    pages.readSnapshot
      .mockResolvedValueOnce(page({
        fromRevision: null,
        toRevision: '1',
        upserts: [point('1')],
      }))
      .mockResolvedValueOnce(page({
        algorithmVersion: 'v2',
        fromRevision: null,
        toRevision: '2',
        upserts: [point('2')],
      }));
    pages.readChanges.mockResolvedValueOnce(page({
      algorithmVersion: 'v2',
      fromRevision: '1',
      toRevision: '2',
      upserts: [point('2')],
    }));
    const store = new LiveTrackStore(pages);
    await store.synchronize(scope);

    await expect(store.synchronize(scope)).resolves.toMatchObject({
      algorithmVersion: 'v2',
      points: [{ seq: '2' }],
      revision: '2',
    });
  });

  it('falls back to a fresh snapshot after an invalid continuation cursor', async () => {
    const pages = source();
    pages.readSnapshot
      .mockResolvedValueOnce(page({
        fromRevision: null,
        toRevision: '1',
        upserts: [point('1')],
      }))
      .mockResolvedValueOnce(page({
        fromRevision: null,
        toRevision: '3',
        upserts: [point('1'), point('2', '1', true), point('3', '2', true)],
      }));
    pages.readChanges
      .mockResolvedValueOnce(page({
        fromRevision: '1',
        nextCursor: 'expired',
        toRevision: '3',
        upserts: [point('2', '1', true)],
      }))
      .mockRejectedValueOnce(new RunnerApiError('invalid', 400, 'INVALID_CURSOR', null));
    const store = new LiveTrackStore(pages);
    await store.synchronize(scope);

    await expect(store.synchronize(scope)).resolves.toMatchObject({
      revision: '3',
      points: [{ seq: '1' }, { seq: '2' }, { seq: '3' }],
    });
  });

  it('serializes one synchronization per run and drains the latest requested revision', async () => {
    const pages = source();
    let finishSnapshot: ((value: ReturnType<typeof page>) => void) | undefined;
    pages.readSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishSnapshot = resolve;
      }),
    );
    pages.readChanges.mockResolvedValueOnce(page({
      fromRevision: '2',
      toRevision: '3',
      upserts: [point('3', '2', true)],
    }));
    const store = new LiveTrackStore(pages);

    const initial = store.synchronize(scope);
    const notified = store.synchronize(scope, '3');
    expect(pages.readSnapshot.mock.calls).toHaveLength(1);
    finishSnapshot?.(page({
      fromRevision: null,
      toRevision: '2',
      upserts: [point('1'), point('2', '1', true)],
    }));

    await expect(Promise.all([initial, notified])).resolves.toEqual([
      expect.objectContaining({ revision: '3' }),
      expect.objectContaining({ revision: '3' }),
    ]);
    expect(pages.readChanges.mock.calls).toHaveLength(1);
    expect(store.get(scope)).toMatchObject({
      revision: '3',
      points: [{ seq: '1' }, { seq: '2' }, { seq: '3' }],
    });
  });

  it('isolates cached tracks by authenticated user as well as organization and run', async () => {
    const pages = source();
    pages.readSnapshot
      .mockResolvedValueOnce(page({
        fromRevision: null,
        toRevision: '1',
        upserts: [point('1')],
      }))
      .mockResolvedValueOnce(page({
        fromRevision: null,
        toRevision: '2',
        upserts: [point('2')],
      }));
    const store = new LiveTrackStore(pages);
    const otherUserScope = {
      ...scope,
      userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };

    await store.synchronize(scope);
    await store.synchronize(otherUserScope);

    expect(store.get(scope)).toMatchObject({ revision: '1', points: [{ seq: '1' }] });
    expect(store.get(otherUserScope)).toMatchObject({
      revision: '2',
      points: [{ seq: '2' }],
    });
  });

  it('aborts in-flight pages and evicts committed state when a scope is removed', async () => {
    const pages = source();
    let requestSignal: AbortSignal | undefined;
    pages.readSnapshot.mockImplementationOnce((_input, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted', 'AbortError'),
        ));
      });
    });
    const store = new LiveTrackStore(pages);

    const synchronization = store.synchronize(scope);
    store.remove(scope);

    expect(requestSignal?.aborted).toBe(true);
    expect(store.get(scope)).toBeNull();
    await expect(synchronization).rejects.toMatchObject({ name: 'AbortError' });
  });
});
