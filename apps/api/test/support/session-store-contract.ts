import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SessionDigestConflictError,
  SessionStoreCapacityError,
  type SessionStore,
  type StoredSession,
} from '../../src/auth/session-store.js';

// The behaviour every session store owes the session manager (ADR-0075 capacity policy, ADR-0080 durable store).
// Run against the in-memory test store (src/auth/session-store.spec.ts) and against PostgreSQL
// (test/postgres-session-store.integration.test.ts), so the two cannot drift apart.

export interface SessionStoreHarness {
  store: SessionStore;
  /** Provisioned identities the store accepts (PostgreSQL refuses unknown users). At least two. */
  userIds: readonly string[];
}

export type SessionStoreFactory = (capacity: number) => Promise<SessionStoreHarness>;

const t0 = Date.parse('2026-11-06T10:00:00.000Z');
const ttlMs = 60_000;

/** A 43-character base64url value derived from a label, the shape of a real digest or CSRF token. */
export function opaqueValue(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('base64url');
}

export function contractSession(
  harness: SessionStoreHarness,
  name: string,
  issuedAtMs: number,
  lifetimeMs = ttlMs,
  userIndex = 0,
): StoredSession {
  return {
    csrfToken: opaqueValue(`csrf-${name}`),
    expiresAt: new Date(issuedAtMs + lifetimeMs),
    issuedAt: new Date(issuedAtMs),
    tokenDigest: opaqueValue(`digest-${name}`),
    userId: harness.userIds[userIndex % harness.userIds.length]!,
  };
}

async function present(harness: SessionStoreHarness, names: readonly string[], atMs: number): Promise<string[]> {
  const found: string[] = [];
  for (const name of names) {
    if ((await harness.store.find(opaqueValue(`digest-${name}`), new Date(atMs))) !== undefined) found.push(name);
  }
  return found;
}

export function describeSessionStoreContract(label: string, factory: SessionStoreFactory): void {
  describe(`${label}: session store contract`, () => {
    it('returns exactly what was stored while live, and nothing from the expiry instant on', async () => {
      const harness = await factory(4);
      const stored = contractSession(harness, 'kept', t0);
      await harness.store.insert(stored);

      expect(await harness.store.find(stored.tokenDigest, new Date(t0 + ttlMs - 1))).toEqual(stored);
      expect(await harness.store.find(stored.tokenDigest, new Date(t0 + ttlMs))).toBeUndefined();
      expect(await harness.store.find(opaqueValue('digest-never-stored'), new Date(t0))).toBeUndefined();
    });

    it('deletes once: true for the stored session, false afterwards, and it is gone', async () => {
      const harness = await factory(2);
      const stored = contractSession(harness, 'revoked', t0);
      await harness.store.insert(stored);

      expect(await harness.store.delete(stored.tokenDigest)).toBe(true);
      expect(await harness.store.delete(stored.tokenDigest)).toBe(false);
      expect(await harness.store.find(stored.tokenDigest, new Date(t0 + 1))).toBeUndefined();
    });

    it('evicts expired records before it checks capacity, and keeps every live one', async () => {
      const harness = await factory(4);
      await harness.store.insert(contractSession(harness, 'a', t0, 10_000));
      await harness.store.insert(contractSession(harness, 'b', t0 + 1, 20_000));
      await harness.store.insert(contractSession(harness, 'c', t0 + 2, 90_000));
      await harness.store.insert(contractSession(harness, 'd', t0 + 3, 90_000));

      // Full; a and b have expired by now, c and d have not.
      await harness.store.insert(contractSession(harness, 'e', t0 + 30_000));
      // One slot is still free: two expired went out, one new came in.
      await harness.store.insert(contractSession(harness, 'f', t0 + 30_001));

      expect(await present(harness, ['c', 'd', 'e', 'f'], t0 + 30_002)).toEqual(['c', 'd', 'e', 'f']);
      await expect(harness.store.insert(contractSession(harness, 'g', t0 + 30_003))).rejects.toBeInstanceOf(
        SessionStoreCapacityError,
      );
    });

    it('treats a record expiring exactly when the new one is issued as expired, and one a millisecond later as live', async () => {
      const atBoundary = await factory(1);
      await atBoundary.store.insert(contractSession(atBoundary, 'old', t0));
      await atBoundary.store.insert(contractSession(atBoundary, 'new', t0 + ttlMs));
      expect(await present(atBoundary, ['new'], t0 + ttlMs)).toEqual(['new']);

      const justLive = await factory(1);
      await justLive.store.insert(contractSession(justLive, 'old2', t0));
      await expect(justLive.store.insert(contractSession(justLive, 'new2', t0 + ttlMs - 1))).rejects.toBeInstanceOf(
        SessionStoreCapacityError,
      );
      expect(await present(justLive, ['old2', 'new2'], t0 + ttlMs - 1)).toEqual(['old2']);
    });

    it('refuses a new session when every record is live, without evicting any of them, the oldest included', async () => {
      const harness = await factory(3);
      await harness.store.insert(contractSession(harness, 'oldest', t0));
      await harness.store.insert(contractSession(harness, 'middle', t0 + 1_000, ttlMs, 1));
      await harness.store.insert(contractSession(harness, 'newest', t0 + 2_000));

      await expect(harness.store.insert(contractSession(harness, 'extra', t0 + 3_000))).rejects.toThrow(
        'The session store is at capacity',
      );

      expect(await present(harness, ['oldest', 'middle', 'newest', 'extra'], t0 + 3_000)).toEqual([
        'oldest',
        'middle',
        'newest',
      ]);
    });

    it('never replaces a stored digest, so a session cannot be moved to another identity', async () => {
      const harness = await factory(4);
      const original = contractSession(harness, 'same', t0, ttlMs, 0);
      await harness.store.insert(original);
      const takeover = { ...contractSession(harness, 'same', t0 + 1_000, ttlMs, 1), csrfToken: opaqueValue('other') };

      await expect(harness.store.insert(takeover)).rejects.toBeInstanceOf(SessionDigestConflictError);

      expect(await harness.store.find(original.tokenDigest, new Date(t0 + 1_000))).toEqual(original);
    });

    it('frees a slot when a session is revoked, so the next sign-in fits', async () => {
      const harness = await factory(2);
      await harness.store.insert(contractSession(harness, 'a', t0));
      await harness.store.insert(contractSession(harness, 'b', t0 + 1));
      await expect(harness.store.insert(contractSession(harness, 'c', t0 + 2))).rejects.toBeInstanceOf(
        SessionStoreCapacityError,
      );

      expect(await harness.store.delete(opaqueValue('digest-a'))).toBe(true);
      await harness.store.insert(contractSession(harness, 'c', t0 + 3));

      expect(await present(harness, ['a', 'b', 'c'], t0 + 4)).toEqual(['b', 'c']);
    });

    it('recovers on its own once live sessions expire, with no restart', async () => {
      const harness = await factory(2);
      await harness.store.insert(contractSession(harness, 'a', t0));
      await harness.store.insert(contractSession(harness, 'b', t0 + 5_000));
      await expect(harness.store.insert(contractSession(harness, 'c', t0 + 30_000))).rejects.toBeInstanceOf(
        SessionStoreCapacityError,
      );

      // a has expired, b has not: exactly one slot comes back.
      await harness.store.insert(contractSession(harness, 'c', t0 + ttlMs));
      await expect(harness.store.insert(contractSession(harness, 'd', t0 + ttlMs + 1))).rejects.toBeInstanceOf(
        SessionStoreCapacityError,
      );
      expect(await present(harness, ['a', 'b', 'c', 'd'], t0 + ttlMs + 1)).toEqual(['b', 'c']);
    });
  });
}
