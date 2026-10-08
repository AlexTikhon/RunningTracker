import type { RunView } from '@running-tracker/contracts';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type { CommandRequest, StartRequest } from './runner-state.js';
import { IndexedDbRunnerStorage, type PointMeasurement, type WriterLease } from './runner-storage.js';

// ADR-0055: refreshing the run the profile already points at is a different operation from activating a run. It is
// fenced by the writer epoch and by the exact active profile inside the same readwrite transaction, and an
// obsolete refresh performs no durable mutation at all. These tests run the real storage class on fake-indexeddb
// and read the stores back through a second connection, so what they assert is what a reload would find.

const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrgId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ownerA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ownerB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const startedAt = '2026-10-08T08:00:00.000Z';
const DURATION_MS = 15_000;
const stores = ['leases', 'points', 'profiles', 'requests', 'runs'] as const;

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
const measurement: PointMeasurement = { accuracyM: 4, latitude: 52.2, longitude: 21, recordedAt: startedAt, segmentId: 0 };

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
  return { advance: (ms: number) => { nowMs += ms; }, databaseName, dump, factory, open, storage: open() };
}

async function acquire(storage: IndexedDbRunnerStorage, owner: string, forUser = userId): Promise<WriterLease> {
  const result = await storage.acquireWriterLease(forUser, owner, DURATION_MS);
  if (!result.acquired) throw new Error('Expected to acquire the lease');
  return result.lease;
}

async function withActiveRun(runId = runA) {
  const fixture = createFixture();
  await fixture.storage.acknowledgeStart(userId, startOf(runId), run(runId, 'recording', 3, 5));
  await fixture.storage.appendPoint({ orgId, runId, userId }, measurement);
  const lease = await acquire(fixture.storage, ownerA);
  return { ...fixture, lease };
}

const scopeA = { orgId, runId: runA, userId };

describe('refreshActiveRun', () => {
  it('merges the answer into the active run for the current writer and leaves the pointer and the points alone', async () => {
    const { lease, storage } = await withActiveRun();
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), lease)).resolves.toEqual({ outcome: 'applied' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      orgId, pendingPointCount: 1, run: { controlRevision: '4', dataRevision: '6', runId: runA, status: 'paused' },
    });
  });

  it('keeps the monotonic merge: an older answer cannot bring a finished run back', async () => {
    const { lease, storage } = await withActiveRun();
    await storage.refreshActiveRun(scopeA, run(runA, 'finished', 3, 6), lease);
    await storage.refreshActiveRun(scopeA, run(runA, 'recording', 3, 5), lease);
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ run: { dataRevision: '6', status: 'finished' } });
  });

  it('survives lease renewal: the capability is the epoch, not the expiry', async () => {
    const { advance, lease, storage } = await withActiveRun();
    advance(5_000);
    const renewed = await storage.renewWriterLease(lease, DURATION_MS);
    expect(renewed).not.toBeNull();
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), lease)).resolves.toEqual({ outcome: 'applied' });
  });

  it('answer for A delivered after A was finished, cleared and B started: B stays active and nothing changes', async () => {
    const { dump, lease, open, storage } = await withActiveRun();
    // A is finished and cleared, then B is started and recording with a point and a queued command.
    await storage.refreshActiveRun(scopeA, run(runA, 'finished', 3, 6), lease);
    await storage.clearActiveRun(userId);
    const scopeB = { orgId, runId: runB, userId };
    await storage.acknowledgeStart(userId, startOf(runB), run(runB, 'recording', 0, 0));
    await storage.appendPoint(scopeB, measurement);
    const pause: CommandRequest = { ...scopeB, commandId: crypto.randomUUID(), expectedControlRevision: '0', kind: 'command', type: 'pause' };
    await storage.queueRequest(userId, pause, run(runB, 'recording', 0, 0));
    const before = await dump();

    // The old read of A, asked while A was active, is released only now.
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 9, 9), lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });

    expect(await dump()).toEqual(before);
    await storage.close();
    const reopened = open();
    await expect(reopened.loadRecovery(userId)).resolves.toMatchObject({
      orgId, pendingPointCount: 1, request: { commandId: pause.commandId }, run: { runId: runB, status: 'recording' },
    });
  });

  it('answer for a run the person already discarded cannot restore the pointer or the discarded queue', async () => {
    const { dump, lease, open, storage } = await withActiveRun();
    const pause: CommandRequest = { ...scopeA, commandId: crypto.randomUUID(), expectedControlRevision: '3', kind: 'command', type: 'pause' };
    await storage.queueRequest(userId, pause, run(runA, 'recording', 3, 5));
    await storage.discardRefusedRun(scopeA, lease);
    const before = await dump();

    await expect(storage.refreshActiveRun(scopeA, run(runA, 'recording', 3, 5), lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });

    expect(await dump()).toEqual(before);
    await storage.close();
    await expect(open().loadRecovery(userId)).resolves.toMatchObject({ orgId: null, pendingPointCount: 0, request: null, run: null });
  });

  it('a lease that was released and acquired again by the same owner is a newer epoch: the old completion writes nothing', async () => {
    const { dump, lease, open, storage } = await withActiveRun();
    await expect(storage.releaseWriterLease(lease)).resolves.toBe(true);
    const newer = await acquire(storage, ownerA);
    expect(BigInt(newer.fencingToken)).toBeGreaterThan(BigInt(lease.fencingToken));
    const before = await dump();

    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });

    expect(await dump()).toEqual(before);
    await storage.close();
    await expect(open().loadRecovery(userId)).resolves.toMatchObject({ run: { controlRevision: '3', status: 'recording' } });
    // The current epoch still can.
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), newer)).resolves.toEqual({ outcome: 'applied' });
  });

  it('an expired lease and a lease taken over by another tab are lost owners', async () => {
    const { advance, dump, lease, storage } = await withActiveRun();
    advance(DURATION_MS + 1);
    const before = await dump();
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    expect(await dump()).toEqual(before);

    const other = await acquire(storage, ownerB);
    const taken = await dump();
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    expect(await dump()).toEqual(taken);
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), other)).resolves.toEqual({ outcome: 'applied' });
  });

  it('the lease is checked in the refresh transaction itself: a release queued ahead of it wins, a release queued behind it does not', async () => {
    const behind = await withActiveRun();
    const refresh = behind.storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), behind.lease);
    const release = behind.storage.releaseWriterLease(behind.lease);
    await expect(refresh).resolves.toEqual({ outcome: 'applied' });
    await expect(release).resolves.toBe(true);

    const ahead = await withActiveRun();
    const releasedFirst = ahead.storage.releaseWriterLease(ahead.lease);
    const refused = ahead.storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), ahead.lease);
    await expect(releasedFirst).resolves.toBe(true);
    await expect(refused).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    await expect(ahead.storage.loadRecovery(userId)).resolves.toMatchObject({ run: { controlRevision: '3', status: 'recording' } });
  });

  it.each([
    ['another organization', { ...scopeA, orgId: otherOrgId }],
    ['another run', { ...scopeA, runId: runB }],
  ])('%s is not the exact active profile: nothing is written, nothing is created', async (_name, wrong) => {
    const { dump, lease, storage } = await withActiveRun();
    const before = await dump();
    await expect(storage.refreshActiveRun(wrong, run(wrong.runId, 'paused', 4, 6), lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    expect(await dump()).toEqual(before);
  });

  it('a lease of another user is rejected, and another user never reaches this user\'s run', async () => {
    const { dump, lease, storage } = await withActiveRun();
    const stranger = await acquire(storage, ownerB, otherUserId);
    await expect(storage.refreshActiveRun(scopeA, run(runA, 'paused', 4, 6), stranger)).rejects.toThrow();
    expect(lease.userId).toBe(userId);
    const before = await dump();
    await expect(storage.refreshActiveRun({ ...scopeA, userId: otherUserId }, run(runA, 'paused', 4, 6), stranger)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    expect(await dump()).toEqual(before);
  });

  it('refuses a snapshot of a different run than the scope names', async () => {
    const { lease, storage } = await withActiveRun();
    await expect(storage.refreshActiveRun(scopeA, run(runB, 'paused', 4, 6), lease)).rejects.toThrow();
  });
});

describe('activateRunSnapshot is the only snapshot write that moves the pointer', () => {
  it('points the profile at the run it is given', async () => {
    const { storage } = createFixture();
    await storage.activateRunSnapshot(userId, orgId, run(runA, 'recording', 0, 0));
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ orgId, run: { runId: runA } });
  });
});

describe('rejectUpload fencing', () => {
  it('marks the active run for the current writer', async () => {
    const { lease, storage } = await withActiveRun();
    await expect(storage.rejectUpload(scopeA, 'Run was deleted', lease)).resolves.toEqual({ outcome: 'applied' });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({ uploadRejection: 'Run was deleted' });
  });

  it('marks nothing for a run that is no longer active or a writer that was lost', async () => {
    const { dump, lease, storage } = await withActiveRun();
    const newer = await (async () => { await storage.releaseWriterLease(lease); return acquire(storage, ownerA); })();
    const lost = await dump();
    await expect(storage.rejectUpload(scopeA, 'late', lease)).resolves.toEqual({ outcome: 'obsolete', reason: 'writer-lost' });
    expect(await dump()).toEqual(lost);
    await storage.discardRefusedRun(scopeA, newer);
    const discarded = await dump();
    await expect(storage.rejectUpload(scopeA, 'late', newer)).resolves.toEqual({ outcome: 'obsolete', reason: 'not-active' });
    expect(await dump()).toEqual(discarded);
  });
});
