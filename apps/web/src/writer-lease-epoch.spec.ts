import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { IndexedDbRunnerStorage, type WriterLease } from './runner-storage.js';
import { WriterLeaseCoordinator } from './writer-lease.js';
import { inertPresence } from './writer-presence.js';

// ADR-0053: the fencing token is a durable per-user epoch. Release ends ownership but never forgets the epoch, so
// a capability issued for an earlier generation can not become valid again, whoever holds it.

const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerC = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const orgId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const scope = { orgId, runId, userId };
const DURATION_MS = 15_000;

function createFixture() {
  const factory = new IDBFactory();
  const databaseName = crypto.randomUUID();
  let nowMs = Date.parse('2026-10-07T08:00:00.000Z');
  const now = () => new Date(nowMs);
  const open = () => new IndexedDbRunnerStorage({ databaseName, factory, keyRange: IDBKeyRange, now });
  return { advance: (ms: number) => { nowMs += ms; }, open, storage: open() };
}

async function acquire(storage: IndexedDbRunnerStorage, owner: string, forUser = userId): Promise<WriterLease> {
  const result = await storage.acquireWriterLease(forUser, owner, DURATION_MS);
  if (!result.acquired) throw new Error('Expected to acquire the lease');
  return result.lease;
}

function measurementAt(second: number) {
  return {
    accuracyM: 4.5,
    latitude: 52.2297,
    longitude: 21.0122,
    recordedAt: `2026-10-07T08:00:${String(second).padStart(2, '0')}.000Z`,
    segmentId: 0,
  };
}

async function withRun(storage: IndexedDbRunnerStorage) {
  await storage.saveRunSnapshot(userId, orgId, {
    controlRevision: '0',
    dataRevision: '0',
    finishedAt: null,
    rawState: 'available',
    runId,
    startedAt: '2026-10-07T08:00:00.000Z',
    status: 'recording',
    summary: null,
  });
}

function failLeasePutOnce(message: string) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the store as this below
  const original = IDBObjectStore.prototype.put;
  let failed = false;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'leases' && !failed) {
      failed = true;
      throw new Error(message);
    }
    return original.call(this, value, key);
  });
}

describe('writer lease fencing epoch', () => {
  it('issues token 1 on the first acquisition and keeps it across renewals', async () => {
    const { advance, storage } = createFixture();
    const lease = await acquire(storage, ownerA);
    expect(lease.fencingToken).toBe('1');
    advance(1_000);
    const renewed = await storage.renewWriterLease(lease, DURATION_MS);
    expect(renewed).toMatchObject({ fencingToken: '1', ownerId: ownerA });
    expect(Date.parse(renewed?.expiresAt ?? '')).toBeGreaterThan(Date.parse(lease.expiresAt));
  });

  it('issues a strictly higher token after the same owner releases and reacquires, and the old one is dead for every writer operation', async () => {
    const { storage } = createFixture();
    await withRun(storage);
    const old = await acquire(storage, ownerA);
    await expect(storage.releaseWriterLease(old)).resolves.toBe(true);

    const current = await acquire(storage, ownerA);
    expect(current.fencingToken).toBe('2');

    await expect(storage.renewWriterLease(old, DURATION_MS)).resolves.toBeNull();
    await expect(storage.releaseWriterLease(old)).resolves.toBe(false);
    await expect(storage.allocateCaptureSegment(scope, old)).rejects.toThrow('no longer owns');
    await expect(storage.appendPointForWriter(scope, measurementAt(1), old)).rejects.toThrow('no longer owns');
    await expect(storage.discardRefusedRun(scope, old)).rejects.toThrow('no longer owns');

    await expect(storage.appendPointForWriter(scope, measurementAt(2), current)).resolves.toMatchObject({ seq: '1' });
    await expect(storage.countPoints(scope)).resolves.toBe(1);
  });

  it('issues a strictly higher token to a different owner after a release, without waiting for expiry', async () => {
    const { storage } = createFixture();
    const first = await acquire(storage, ownerA);
    await storage.releaseWriterLease(first);
    const second = await acquire(storage, ownerB);
    expect(second).toMatchObject({ fencingToken: '2', ownerId: ownerB });
    await expect(storage.renewWriterLease(first, DURATION_MS)).resolves.toBeNull();
  });

  it('does not let a released lease be renewed or used by its former holder before it would have expired', async () => {
    const { storage } = createFixture();
    await withRun(storage);
    const lease = await acquire(storage, ownerA);
    await storage.releaseWriterLease(lease);
    await expect(storage.renewWriterLease(lease, DURATION_MS)).resolves.toBeNull();
    await expect(storage.appendPointForWriter(scope, measurementAt(1), lease)).rejects.toThrow('no longer owns');
    await expect(storage.releaseWriterLease(lease)).resolves.toBe(false);
  });

  it('issues a strictly higher token after expiry, for the same and for a different owner', async () => {
    const { advance, storage } = createFixture();
    const first = await acquire(storage, ownerA);
    advance(DURATION_MS + 1);
    const sameOwner = await acquire(storage, ownerA);
    expect(sameOwner.fencingToken).toBe('2');
    advance(DURATION_MS + 1);
    const otherOwner = await acquire(storage, ownerB);
    expect(otherOwner.fencingToken).toBe('3');
    await expect(storage.renewWriterLease(first, DURATION_MS)).resolves.toBeNull();
    await expect(storage.renewWriterLease(sameOwner, DURATION_MS)).resolves.toBeNull();
  });

  it('stale renew (same owner, older generation) fails and leaves the successor untouched', async () => {
    const { advance, storage } = createFixture();
    const old = await acquire(storage, ownerA);
    await storage.releaseWriterLease(old);
    const successor = await acquire(storage, ownerA);
    advance(1_000);

    await expect(storage.renewWriterLease(old, DURATION_MS)).resolves.toBeNull();

    // A rival still sees exactly the successor's lease: same token, same owner, same unextended expiry.
    await expect(storage.acquireWriterLease(userId, ownerB, DURATION_MS)).resolves.toEqual({ acquired: false, lease: successor });
  });

  it('stale release (older generation) fails and does not clear the successor', async () => {
    const { storage } = createFixture();
    const old = await acquire(storage, ownerA);
    await storage.releaseWriterLease(old);
    const successor = await acquire(storage, ownerB);

    await expect(storage.releaseWriterLease(old)).resolves.toBe(false);

    await expect(storage.acquireWriterLease(userId, ownerC, DURATION_MS)).resolves.toEqual({ acquired: false, lease: successor });
    await expect(storage.renewWriterLease(successor, DURATION_MS)).resolves.toMatchObject({ fencingToken: '2', ownerId: ownerB });
  });

  it('a repeated release changes nothing and does not move the epoch', async () => {
    const { storage } = createFixture();
    const lease = await acquire(storage, ownerA);
    await expect(storage.releaseWriterLease(lease)).resolves.toBe(true);
    await expect(storage.releaseWriterLease(lease)).resolves.toBe(false);
    expect((await acquire(storage, ownerA)).fencingToken).toBe('2');
  });

  it('gives exactly one of two concurrent acquirers the next generation after a release', async () => {
    const { open, storage } = createFixture();
    const previous = await acquire(storage, ownerA);
    await storage.releaseWriterLease(previous);
    const left = open();
    const right = open();

    const [a, b] = await Promise.all([
      left.acquireWriterLease(userId, ownerB, DURATION_MS),
      right.acquireWriterLease(userId, ownerC, DURATION_MS),
    ]);

    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
    const winner = a.acquired ? a.lease : (b.acquired ? b.lease : null);
    expect(winner?.fencingToken).toBe('2');
    const loser = a.acquired ? b : a;
    expect(loser).toEqual({ acquired: false, lease: winner });
  });

  it('keeps the epoch across a restart: a new storage instance on the same database issues a higher token', async () => {
    const { open, storage } = createFixture();
    await storage.releaseWriterLease(await acquire(storage, ownerA));
    const second = await acquire(storage, ownerA);
    await storage.releaseWriterLease(second);
    await storage.close();

    const restarted = open();
    const third = await acquire(restarted, ownerA);
    expect(third.fencingToken).toBe('3');
    await expect(restarted.renewWriterLease(second, DURATION_MS)).resolves.toBeNull();
  });

  it('keeps an independent epoch for each user', async () => {
    const { storage } = createFixture();
    const mine = await acquire(storage, ownerA);
    await storage.releaseWriterLease(mine);
    const mineAgain = await acquire(storage, ownerA);
    const theirs = await acquire(storage, ownerA, otherUserId);
    expect(mineAgain.fencingToken).toBe('2');
    expect(theirs.fencingToken).toBe('1');
    // Releasing and reacquiring the other user's lease neither moves nor reads this user's epoch.
    await storage.releaseWriterLease(theirs);
    expect((await acquire(storage, ownerA, otherUserId)).fencingToken).toBe('2');
    await expect(storage.renewWriterLease(mineAgain, DURATION_MS)).resolves.toMatchObject({ fencingToken: '2' });
  });

  it('a failed release keeps the holder and the epoch', async () => {
    const { storage } = createFixture();
    const lease = await acquire(storage, ownerA);
    const failing = failLeasePutOnce('disk failure');
    try {
      await expect(storage.releaseWriterLease(lease)).rejects.toThrow('disk failure');
    } finally {
      failing.mockRestore();
    }
    await expect(storage.renewWriterLease(lease, DURATION_MS)).resolves.toMatchObject({ fencingToken: '1', ownerId: ownerA });
    await storage.releaseWriterLease(lease);
    expect((await acquire(storage, ownerB)).fencingToken).toBe('2');
  });

  it('a failed acquisition leaves the released state and the epoch intact, and creates no owner', async () => {
    const { storage } = createFixture();
    const old = await acquire(storage, ownerA);
    await storage.releaseWriterLease(old);
    const failing = failLeasePutOnce('disk failure');
    try {
      await expect(storage.acquireWriterLease(userId, ownerB, DURATION_MS)).rejects.toThrow('disk failure');
    } finally {
      failing.mockRestore();
    }
    await expect(storage.renewWriterLease(old, DURATION_MS)).resolves.toBeNull();
    const next = await acquire(storage, ownerB);
    expect(next.fencingToken).toBe('2');
  });

  it('a failed renewal keeps the holder, the token and the expiry', async () => {
    const { advance, storage } = createFixture();
    const lease = await acquire(storage, ownerA);
    advance(1_000);
    const failing = failLeasePutOnce('disk failure');
    try {
      await expect(storage.renewWriterLease(lease, DURATION_MS)).rejects.toThrow('disk failure');
    } finally {
      failing.mockRestore();
    }
    await expect(storage.acquireWriterLease(userId, ownerB, DURATION_MS)).resolves.toEqual({ acquired: false, lease });
  });

  it('never repeats a token across a fixed sequence of acquire, renew, release and expiry', async () => {
    const { advance, storage } = createFixture();
    const issued: bigint[] = [];
    const take = async (owner: string) => {
      const lease = await acquire(storage, owner);
      issued.push(BigInt(lease.fencingToken));
      return lease;
    };

    const first = await take(ownerA);
    await storage.renewWriterLease(first, DURATION_MS);
    await storage.releaseWriterLease(first);
    const second = await take(ownerA);
    advance(DURATION_MS + 1);
    const third = await take(ownerB);
    await storage.releaseWriterLease(third);
    const fourth = await take(ownerB);
    await storage.releaseWriterLease(second); // stale: must not disturb anything
    await storage.renewWriterLease(first, DURATION_MS); // stale
    await storage.releaseWriterLease(fourth);
    const fifth = await take(ownerA);

    expect(issued).toEqual([1n, 2n, 3n, 4n, 5n]);
    for (const stale of [first, second, third, fourth]) {
      await expect(storage.renewWriterLease(stale, DURATION_MS)).resolves.toBeNull();
    }
    await expect(storage.renewWriterLease(fifth, DURATION_MS)).resolves.toMatchObject({ fencingToken: '5' });
  });
});

describe('writer lease coordinator epoch', () => {
  it('a coordinator that releases and claims again holds a newer generation; the old lease can not renew, append or release it', async () => {
    const { storage } = createFixture();
    await withRun(storage);
    const coordinator = new WriterLeaseCoordinator({
      onState: () => undefined,
      ownerId: ownerA,
      presence: inertPresence,
      storage,
      userId,
    });

    await expect(coordinator.claim()).resolves.toBe(true);
    const old = await coordinator.assertOwnedLease();
    expect(old?.fencingToken).toBe('1');
    await coordinator.release();
    await expect(coordinator.claim()).resolves.toBe(true);
    const current = await coordinator.assertOwnedLease();
    expect(current?.fencingToken).toBe('2');
    if (old === null || current === null || old === undefined || current === undefined) throw new Error('Expected both leases');

    await expect(storage.renewWriterLease(old, DURATION_MS)).resolves.toBeNull();
    await expect(storage.appendPointForWriter(scope, measurementAt(1), old)).rejects.toThrow('no longer owns');
    await expect(storage.releaseWriterLease(old)).resolves.toBe(false);
    await expect(storage.appendPointForWriter(scope, measurementAt(2), current)).resolves.toMatchObject({ seq: '1' });
    await expect(coordinator.assertOwned()).resolves.toBe(true);
    await coordinator.dispose();
  });
});
