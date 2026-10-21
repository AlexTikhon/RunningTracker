import type { RunView } from '@running-tracker/contracts';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { performFinishedRunClear, type FinishedRunClearPage } from './finished-run-clear.js';
import type { CommandRequest, StartRequest } from './runner-state.js';
import { IndexedDbRunnerStorage, type PointMeasurement, type RunScope, type WriterLease } from './runner-storage.js';

// "New run" clears the finished run the page shows. The clear belongs to the writer capability it began with and to
// the exact run: in one transaction it checks the live lease epoch, the exact active scope, a finished run, no
// buffered point and no queued lifecycle request, and writes nothing otherwise. Two storage instances share one
// IDBFactory and one injected clock, as two tabs share the browser's IndexedDB; interleavings are forced with
// deferred promises, never with a sleep. This is fake-indexeddb, not a browser: the browser regression is
// tests/e2e/new-run-takeover.spec.ts.

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrgId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ownerA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ownerB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const startedAt = '2026-10-08T08:00:00.000Z';
const DURATION_MS = 15_000;
const stores = ['leases', 'points', 'profiles', 'requests', 'runs'] as const;
const scopeA: RunScope = { orgId, runId: runA, userId };
const scopeB: RunScope = { orgId, runId: runB, userId };
const cleared = { outcome: 'cleared' } as const;
const writerLost = { outcome: 'obsolete', reason: 'writer-lost' } as const;
const notActive = { outcome: 'obsolete', reason: 'not-active' } as const;

function run(runId: string, status: RunView['status'], controlRevision: number, dataRevision: number): RunView {
  return {
    controlRevision: String(controlRevision),
    dataRevision: String(dataRevision),
    finishedAt: status === 'finished' ? '2026-10-08T09:00:00.000Z' : null,
    rawState: 'available',
    runId,
    startedAt,
    status,
    summary: null,
  };
}

const startOf = (runId: string): StartRequest => ({ kind: 'start', orgId, runId, startedAt });
const finishOf = (runId: string, expected: number): CommandRequest => ({
  commandId: crypto.randomUUID(), expectedControlRevision: String(expected), kind: 'command', orgId, runId, type: 'finish',
});
const measurement: PointMeasurement = { accuracyM: 4, latitude: 52.2, longitude: 21, recordedAt: startedAt, segmentId: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

function createFixture() {
  const factory = new IDBFactory();
  const databaseName = crypto.randomUUID();
  let nowMs = Date.parse('2026-10-08T08:00:00.000Z');
  const now = () => new Date(nowMs);
  const open = () => new IndexedDbRunnerStorage({ databaseName, factory, keyRange: IDBKeyRange, now });
  // Every record of every store, read through an independent connection: the durable truth.
  const dump = async (): Promise<Record<string, unknown[]>> => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      const result: Record<string, unknown[]> = {};
      for (const name of stores) {
        result[name] = await new Promise<unknown[]>((resolve, reject) => {
          const request = database.transaction(name, 'readonly').objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        });
      }
      return result;
    } finally {
      database.close();
    }
  };
  const fixture = {
    advance: (ms: number) => { nowMs += ms; },
    dump,
    open,
    tabA: open(),
    tabB: open(),
    // Tab A's lease runs out and tab B acquires the next fencing epoch.
    takeOver: async () => {
      fixture.advance(DURATION_MS + 1);
      return acquire(fixture.tabB, ownerB);
    },
  };
  return fixture;
}

async function acquire(storage: IndexedDbRunnerStorage, owner: string): Promise<WriterLease> {
  const result = await storage.acquireWriterLease(userId, owner, DURATION_MS);
  if (!result.acquired) throw new Error('Expected to acquire the lease');
  return result.lease;
}

// Run A started, recorded one point and was finished through the fenced lifecycle; the point is uploaded unless
// `keepPoint`. Tab A holds the lease and shows the finished run with "New run".
async function finishedRunA(f: ReturnType<typeof createFixture>, options: { keepPoint?: boolean } = {}) {
  const lease = await acquire(f.tabA, ownerA);
  await f.tabA.queueRequest(userId, startOf(runA), null, lease);
  await f.tabA.acknowledgeStart(userId, startOf(runA), run(runA, 'recording', 0, 0), lease);
  const point = await f.tabA.appendPointForWriter(scopeA, measurement, lease);
  if (options.keepPoint !== true) await f.tabA.acknowledgePointBatch(scopeA, [point.seq], '1');
  const finish = finishOf(runA, 0);
  await f.tabA.queueRequest(userId, finish, run(runA, 'recording', 0, 1), lease);
  await f.tabA.acknowledgeReconciledRequest(userId, finish, run(runA, 'finished', 1, 1), lease);
  await f.tabA.saveCaptureSource(userId, 'simulator');
  return lease;
}

// Tab B, the next epoch, clears A legitimately, starts run B and buffers a point that is not uploaded yet.
async function successorRecordsRunB(f: ReturnType<typeof createFixture>) {
  const leaseB = await f.takeOver();
  await expect(f.tabB.clearFinishedRun(scopeA, leaseB)).resolves.toEqual(cleared);
  await f.tabB.queueRequest(userId, startOf(runB), null, leaseB);
  await f.tabB.acknowledgeStart(userId, startOf(runB), run(runB, 'recording', 0, 0), leaseB);
  await f.tabB.appendPointForWriter(scopeB, measurement, leaseB);
  return leaseB;
}

describe('clearFinishedRun clears only the expected finished run, for the live writer epoch, in one transaction', () => {
  it('A\'s delayed clear after B took over and started another run is obsolete and writes nothing', async () => {
    const f = createFixture();
    const leaseA = await finishedRunA(f);
    const leaseB = await successorRecordsRunB(f);
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, leaseA)).resolves.toEqual(writerLost);

    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ orgId, pendingPointCount: 1, request: null, run: { runId: runB, status: 'recording' } });
    await expect(f.tabB.countPoints(scopeB)).resolves.toBe(1);
    // B's lease is untouched: the same epoch renews.
    await expect(f.tabB.renewWriterLease(leaseB, DURATION_MS)).resolves.toMatchObject({ fencingToken: leaseB.fencingToken, ownerId: ownerB });
  });

  it('the same owner under a newer fencing token makes the earlier capability obsolete', async () => {
    const f = createFixture();
    const first = await finishedRunA(f);
    f.advance(DURATION_MS + 1);
    const second = await acquire(f.tabA, ownerA);
    expect(BigInt(second.fencingToken)).toBeGreaterThan(BigInt(first.fencingToken));
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, first)).resolves.toEqual(writerLost);
    expect(await f.dump()).toEqual(before);

    await expect(f.tabA.clearFinishedRun(scopeA, second)).resolves.toEqual(cleared);
  });

  it('a released lease is obsolete', async () => {
    const f = createFixture();
    const lease = await finishedRunA(f);
    await f.tabA.releaseWriterLease(lease);
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual(writerLost);

    expect(await f.dump()).toEqual(before);
  });

  it.each([
    ['another organization', { ...scopeA, orgId: otherOrgId }],
    ['another run', { ...scopeA, runId: runB }],
  ])('a clear for %s than the active one is not-active and writes nothing', async (_name, wrongScope) => {
    const f = createFixture();
    const lease = await finishedRunA(f);
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(wrongScope, lease)).resolves.toEqual(notActive);

    expect(await f.dump()).toEqual(before);
  });

  it('a second clear of the same run, after the pointer moved on, is not-active', async () => {
    const f = createFixture();
    const lease = await finishedRunA(f);
    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual(cleared);
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual(notActive);

    expect(await f.dump()).toEqual(before);
  });

  it('a lease of another user is refused before any transaction', async () => {
    const f = createFixture();
    const lease = await finishedRunA(f);
    await expect(f.tabA.clearFinishedRun(scopeA, { ...lease, userId: '22222222-2222-4222-8222-222222222222' }))
      .rejects.toThrow('Writer lease does not match the run');
  });

  it.each(['recording', 'paused'] as const)('a %s run is blocked and keeps its points, request queue and record', async (status) => {
    const f = createFixture();
    const lease = await acquire(f.tabA, ownerA);
    await f.tabA.queueRequest(userId, startOf(runA), null, lease);
    await f.tabA.acknowledgeStart(userId, startOf(runA), run(runA, 'recording', 0, 0), lease);
    await f.tabA.refreshActiveRun(scopeA, run(runA, status, status === 'paused' ? 1 : 0, 0), lease);
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual({ outcome: 'blocked', reason: 'not-finished' });

    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ run: { runId: runA, status } });
  });

  it('a finished run with buffered points is blocked until they are uploaded', async () => {
    const f = createFixture();
    const lease = await finishedRunA(f, { keepPoint: true });
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual({ outcome: 'blocked', reason: 'points-buffered' });

    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ pendingPointCount: 1, run: { runId: runA, status: 'finished' } });

    const [point] = await f.tabA.readPointBatch(scopeA);
    await f.tabA.acknowledgePointBatch(scopeA, [point?.seq ?? '']);
    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual(cleared);
  });

  it('a finished run with an unresolved lifecycle request is blocked and the exact request stays queued', async () => {
    const f = createFixture();
    const lease = await acquire(f.tabA, ownerA);
    await f.tabA.queueRequest(userId, startOf(runA), null, lease);
    await f.tabA.acknowledgeStart(userId, startOf(runA), run(runA, 'recording', 0, 0), lease);
    // The Finish is sent and its outcome is unknown; an authority read meanwhile learns the run is finished.
    const finish = finishOf(runA, 0);
    await f.tabA.queueRequest(userId, finish, run(runA, 'recording', 0, 0), lease);
    await f.tabA.refreshActiveRun(scopeA, run(runA, 'finished', 1, 0), lease);
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual({ outcome: 'blocked', reason: 'request-pending' });

    expect(await f.dump()).toEqual(before);
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ request: finish, run: { runId: runA, status: 'finished' } });
  });

  it('the live writer clears its finished run, keeps the record and the preference, and starts another run', async () => {
    const f = createFixture();
    const lease = await finishedRunA(f);
    const before = await f.dump();

    await expect(f.tabA.clearFinishedRun(scopeA, lease)).resolves.toEqual(cleared);

    // Only the pointer changed: the lease, points, queue and run records are as they were.
    const after = await f.dump();
    expect({ ...after, profiles: [] }).toEqual({ ...before, profiles: [] });
    expect(after.profiles).toEqual([{ activeOrgId: null, activeRunId: null, captureSource: 'simulator', userId }]);
    await expect(f.open().loadRecovery(userId)).resolves.toEqual({
      captureSource: 'simulator', orgId: null, pendingPointCount: 0, request: null, run: null, uploadRejection: null,
    });

    await expect(f.tabA.queueRequest(userId, startOf(runB), null, lease)).resolves.toEqual({ outcome: 'applied' });
    await expect(f.tabA.acknowledgeStart(userId, startOf(runB), run(runB, 'recording', 0, 0), lease)).resolves.toEqual({ outcome: 'applied' });
    // A reload finds the new run, and run A's point sequence continues where it was.
    await expect(f.open().loadRecovery(userId)).resolves.toMatchObject({ captureSource: 'simulator', orgId, run: { runId: runB } });
    await expect(f.tabA.appendPointForWriter(scopeB, measurement, lease)).resolves.toMatchObject({ seq: '1' });
  });
});

describe('performFinishedRunClear reports a completion only to the page, session and writer epoch it began in', () => {
  async function clearing(options: { keepPoint?: boolean } = {}) {
    const f = createFixture();
    const lease = await finishedRunA(f, options);
    const state = { current: true, lease: lease as WriterLease | null };
    const page: FinishedRunClearPage = { current: () => state.current, lease: () => state.lease };
    const dispatch = vi.fn();
    const onFollow = vi.fn();
    const release = vi.fn(() => Promise.resolve());
    // A barrier the clear transaction waits behind, so a test can change the page while it is pending.
    const gate = { entered: deferred<void>(), open: deferred<void>() };
    const storage = {
      clearFinishedRun: async (...input: Parameters<IndexedDbRunnerStorage['clearFinishedRun']>) => {
        gate.entered.resolve();
        await gate.open.promise;
        return f.tabA.clearFinishedRun(...input);
      },
      loadRecovery: f.tabA.loadRecovery.bind(f.tabA),
    };
    const revalidate = vi.fn(() => f.tabA.renewWriterLease(lease, DURATION_MS));
    const settle = () => performFinishedRunClear({ dispatch, onFollow, page, release, revalidate, scope: scopeA, storage });
    return { dispatch, f, gate, lease, onFollow, page, release, revalidate, settle, state, storage };
  }

  it('the current page clears the run, reports it and releases its own lease', async () => {
    const t = await clearing();
    t.gate.open.resolve();

    await expect(t.settle()).resolves.toEqual({ kind: 'cleared' });

    expect(t.dispatch.mock.calls).toEqual([[{ runId: runA, type: 'finished-run-cleared' }]]);
    expect(t.release).toHaveBeenCalledTimes(1);
    await expect(t.f.open().loadRecovery(userId)).resolves.toMatchObject({ run: null });
  });

  it('a session replaced while the clear is pending receives nothing and releases nothing', async () => {
    const t = await clearing();
    const settled = t.settle();
    await t.gate.entered.promise;
    // The session is replaced; the page now belongs to another session and another coordinator.
    t.state.current = false;
    t.state.lease = null;
    t.gate.open.resolve();

    await expect(settled).resolves.toEqual({ kind: 'detached' });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(t.onFollow).not.toHaveBeenCalled();
    expect(t.release).not.toHaveBeenCalled();
  });

  it('a newer epoch at completion is never released: the page follows the durable state instead', async () => {
    const t = await clearing();
    const write = t.f.tabA.clearFinishedRun.bind(t.f.tabA);
    t.storage.clearFinishedRun = async (...input) => {
      const outcome = await write(...input);
      // The same owner reacquired under a newer token between the commit and the completion.
      t.state.lease = { ...t.lease, fencingToken: (BigInt(t.lease.fencingToken) + 1n).toString() };
      return outcome;
    };

    await expect(t.settle()).resolves.toEqual({ kind: 'followed', reason: 'writer-lost' });

    expect(t.release).not.toHaveBeenCalled();
    expect(t.dispatch.mock.calls).toEqual([[{
      pendingPointCount: 0, request: null, run: null, type: 'storage-restored', uploadRejection: null,
    }]]);
    expect(t.onFollow).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, run: null }));
  });

  it('a stale page whose clear B made obsolete follows B\'s run and releases nothing', async () => {
    const t = await clearing();
    const settled = t.settle();
    await t.gate.entered.promise;
    // A passed its ownership check; its lease then expires and B clears A, starts run B and buffers a point.
    await successorRecordsRunB(t.f);
    const before = await t.f.dump();
    t.gate.open.resolve();

    await expect(settled).resolves.toEqual({ kind: 'followed', reason: 'writer-lost' });

    expect(await t.f.dump()).toEqual(before);
    expect(t.release).not.toHaveBeenCalled();
    // The lease is proven again, so the page's writer state shows the loss before it follows B's run.
    expect(t.revalidate).toHaveBeenCalledTimes(2);
    await expect(t.revalidate.mock.results[1]?.value).resolves.toBeNull();
    expect(t.dispatch.mock.calls).toEqual([[{
      pendingPointCount: 1, request: null, run: run(runB, 'recording', 0, 0), type: 'storage-restored', uploadRejection: null,
    }]]);
  });

  it('a page that is no longer the writer before the clear writes nothing and follows the durable state', async () => {
    const t = await clearing();
    t.revalidate.mockResolvedValueOnce(null);
    const before = await t.f.dump();

    await expect(t.settle()).resolves.toEqual({ kind: 'followed', reason: 'writer-lost' });

    expect(await t.f.dump()).toEqual(before);
    expect(t.release).not.toHaveBeenCalled();
    expect(t.dispatch.mock.calls).toEqual([[expect.objectContaining({ run: run(runA, 'finished', 1, 1), type: 'storage-restored' })]]);
  });

  it('a blocked clear follows the durable state: the buffered point is shown, not hidden', async () => {
    const t = await clearing({ keepPoint: true });
    t.gate.open.resolve();

    await expect(t.settle()).resolves.toEqual({ kind: 'followed', reason: 'points-buffered' });

    expect(t.release).not.toHaveBeenCalled();
    expect(t.dispatch.mock.calls).toEqual([[expect.objectContaining({ pendingPointCount: 1, type: 'storage-restored' })]]);
  });

  it('a storage failure is reported to the current page and to no replaced one', async () => {
    const current = await clearing();
    current.storage.clearFinishedRun = () => Promise.reject(new Error('disk full'));
    await expect(current.settle()).rejects.toThrow('disk full');
    expect(current.dispatch).not.toHaveBeenCalled();
    expect(current.release).not.toHaveBeenCalled();

    const replaced = await clearing();
    replaced.storage.clearFinishedRun = () => {
      replaced.state.current = false;
      return Promise.reject(new Error('disk full'));
    };
    await expect(replaced.settle()).resolves.toEqual({ kind: 'detached' });
    expect(replaced.dispatch).not.toHaveBeenCalled();
    expect(replaced.release).not.toHaveBeenCalled();
  });
});
