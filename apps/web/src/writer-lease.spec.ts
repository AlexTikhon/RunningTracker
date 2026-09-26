import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { IndexedDbRunnerStorage } from './runner-storage.js';
import { WriterLeaseCoordinator, type WriterOwnershipState } from './writer-lease.js';

const userId = '11111111-1111-4111-8111-111111111111';
const firstOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const orgId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function createClock() {
  let nowMs = Date.parse('2026-09-26T08:00:00.000Z');
  return {
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
    now: () => new Date(nowMs),
  };
}

function createStorage(factory: IDBFactory, databaseName: string, now: () => Date) {
  return new IndexedDbRunnerStorage({ databaseName, factory, keyRange: IDBKeyRange, now });
}

async function seedVersionOneDatabase(factory: IDBFactory, databaseName: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.addEventListener('upgradeneeded', () => {
      const upgrade = request.result;
      upgrade.createObjectStore('profiles', { keyPath: 'userId' });
      upgrade.createObjectStore('runs', { keyPath: 'storageKey' });
      const points = upgrade.createObjectStore('points', { keyPath: 'storageKey' });
      points.createIndex('by-run-seq', ['userId', 'orgId', 'runId', 'seqKey'], { unique: true });
      const requests = upgrade.createObjectStore('requests', { keyPath: 'storageKey' });
      requests.createIndex('by-user', 'userId');
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('Unable to create the version-1 test database')),
      { once: true },
    );
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['profiles', 'runs'], 'readwrite');
    transaction.objectStore('profiles').put({ activeOrgId: orgId, activeRunId: runId, userId });
    transaction.objectStore('runs').put({
      nextSeq: '1',
      orgId,
      run: {
        controlRevision: '0',
        dataRevision: '0',
        finishedAt: null,
        rawState: 'available',
        runId,
        startedAt: '2026-09-26T08:00:00.000Z',
        status: 'recording',
        summary: null,
      },
      runId,
      storageKey: `${userId}:${orgId}:${runId}`,
      userId,
    });
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('Unable to seed the version-1 test database')),
      { once: true },
    );
  });
  database.close();
}

describe('writer lease', () => {
  it('upgrades the P05.3 database without losing durable run recovery', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const clock = createClock();
    await seedVersionOneDatabase(factory, databaseName);

    const storage = createStorage(factory, databaseName, clock.now);
    await expect(storage.acquireWriterLease(userId, firstOwner, 15_000)).resolves.toMatchObject({
      acquired: true,
    });
    await expect(storage.loadRecovery(userId)).resolves.toMatchObject({
      orgId,
      run: { runId, status: 'recording' },
    });
  });

  it('atomically grants one browser tab and reports the conflicting live owner', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const clock = createClock();
    const first = createStorage(factory, databaseName, clock.now);
    const second = createStorage(factory, databaseName, clock.now);

    const [left, right] = await Promise.all([
      first.acquireWriterLease(userId, firstOwner, 15_000),
      second.acquireWriterLease(userId, secondOwner, 15_000),
    ]);

    expect([left.acquired, right.acquired].filter(Boolean)).toHaveLength(1);
    const winner = left.acquired ? left.lease : right.lease;
    const loser = left.acquired ? right : left;
    expect(loser).toEqual({ acquired: false, lease: winner });
  });

  it('fences an expired owner after takeover and rejects its renew and release', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const clock = createClock();
    const first = createStorage(factory, databaseName, clock.now);
    const second = createStorage(factory, databaseName, clock.now);
    const initial = await first.acquireWriterLease(userId, firstOwner, 100);
    expect(initial.acquired).toBe(true);
    if (!initial.acquired) {
      throw new Error('Expected the first owner to acquire the lease');
    }

    clock.advance(101);
    const takeover = await second.acquireWriterLease(userId, secondOwner, 100);
    expect(takeover).toMatchObject({ acquired: true, lease: { fencingToken: '2' } });
    await expect(first.renewWriterLease(initial.lease, 100)).resolves.toBeNull();
    await expect(first.releaseWriterLease(initial.lease)).resolves.toBe(false);
    await expect(second.acquireWriterLease(userId, firstOwner, 100)).resolves.toMatchObject({
      acquired: false,
      lease: { ownerId: secondOwner },
    });
  });

  it('renews an owned lease and fails closed when another owner has taken over', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const clock = createClock();
    const first = createStorage(factory, databaseName, clock.now);
    const second = createStorage(factory, databaseName, clock.now);
    const states: WriterOwnershipState[] = [];
    const coordinator = new WriterLeaseCoordinator({
      leaseDurationMs: 100,
      onState: (state) => states.push(state),
      ownerId: firstOwner,
      renewIntervalMs: 25,
      storage: first,
      userId,
    });

    await expect(coordinator.claim()).resolves.toBe(true);
    clock.advance(25);
    await expect(coordinator.assertOwned()).resolves.toBe(true);
    expect(states.at(-1)?.status).toBe('owned');

    clock.advance(101);
    await second.acquireWriterLease(userId, secondOwner, 100);
    await expect(coordinator.assertOwned()).resolves.toBe(false);
    expect(states.at(-1)).toMatchObject({ status: 'lost' });
    await coordinator.dispose();
  });

  it('fences segment allocation and point persistence in the same IndexedDB transactions', async () => {
    const factory = new IDBFactory();
    const databaseName = crypto.randomUUID();
    const clock = createClock();
    const first = createStorage(factory, databaseName, clock.now);
    const second = createStorage(factory, databaseName, clock.now);
    const initial = await first.acquireWriterLease(userId, firstOwner, 100);
    if (!initial.acquired) throw new Error('Expected the first owner to acquire the lease');
    await first.saveRunSnapshot(userId, orgId, {
      controlRevision: '0',
      dataRevision: '0',
      finishedAt: null,
      rawState: 'available',
      runId,
      startedAt: '2026-09-26T08:00:00.000Z',
      status: 'recording',
      summary: null,
    });

    await expect(first.allocateCaptureSegment({ orgId, runId, userId }, initial.lease)).resolves.toBe(0);
    await expect(first.appendPointForWriter(
      { orgId, runId, userId },
      {
        accuracyM: 4.5,
        latitude: 52.2297,
        longitude: 21.0122,
        recordedAt: '2026-09-26T08:00:00.000Z',
        segmentId: 0,
      },
      initial.lease,
    )).resolves.toMatchObject({ segmentId: 0, seq: '1' });

    clock.advance(101);
    const takeover = await second.acquireWriterLease(userId, secondOwner, 100);
    if (!takeover.acquired) throw new Error('Expected the second owner to take over');
    await expect(first.appendPointForWriter(
      { orgId, runId, userId },
      {
        accuracyM: 4.5,
        latitude: 52.2298,
        longitude: 21.0123,
        recordedAt: '2026-09-26T08:00:02.000Z',
        segmentId: 0,
      },
      initial.lease,
    )).rejects.toThrow('no longer owns');
    await expect(second.allocateCaptureSegment({ orgId, runId, userId }, takeover.lease)).resolves.toBe(1);
    await expect(second.appendPointForWriter(
      { orgId, runId, userId },
      {
        accuracyM: 4.5,
        latitude: 52.2298,
        longitude: 21.0123,
        recordedAt: '2026-09-26T08:00:02.000Z',
        segmentId: 1,
      },
      takeover.lease,
    )).resolves.toMatchObject({ segmentId: 1, seq: '2' });
  });
});
