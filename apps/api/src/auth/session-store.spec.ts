import { describe, expect, it } from 'vitest';

import { InMemorySessionStore, SessionStoreCapacityError, type StoredSession } from './session-store.js';

// Capacity policy (ADR-0075): expired records are evicted first; a store still full of live sessions refuses the new
// one and never evicts a live session, the oldest included. Demo sign-in cannot be enabled in a deployed environment
// (APP_ENV=production refuses LOCAL_AUTH_ENABLED), so the only deployed source of sessions is OIDC sign-in.

const t0 = Date.parse('2026-11-06T10:00:00.000Z');
const ttlMs = 60_000;

function session(name: string, issuedAtMs: number, lifetimeMs = ttlMs): StoredSession {
  return {
    csrfToken: `csrf-${name}`,
    expiresAt: new Date(issuedAtMs + lifetimeMs),
    issuedAt: new Date(issuedAtMs),
    tokenDigest: `digest-${name}`,
    userId: `user-${name}`,
  };
}

function digests(store: InMemorySessionStore, names: readonly string[]): string[] {
  return names.filter((name) => store.get(`digest-${name}`) !== undefined);
}

describe('InMemorySessionStore capacity and eviction', () => {
  it('requires a positive whole maximum', () => {
    for (const maximum of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new InMemorySessionStore(maximum)).toThrow('maximumEntries must be a positive safe integer');
    }
  });

  it('evicts every expired record before it checks capacity, and keeps every live one', () => {
    const store = new InMemorySessionStore(4);
    store.set(session('a', t0, 10_000));
    store.set(session('b', t0 + 1, 20_000));
    store.set(session('c', t0 + 2, 90_000));
    store.set(session('d', t0 + 3, 90_000));

    // Full; a and b have expired by now, c and d have not.
    store.set(session('e', t0 + 30_000));

    expect(digests(store, ['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'd', 'e']);
    // One slot is still free after the sweep: two expired went out, one new came in.
    store.set(session('f', t0 + 30_001));
    expect(digests(store, ['c', 'd', 'e', 'f'])).toEqual(['c', 'd', 'e', 'f']);
  });

  it('treats a record expiring exactly when the new one is issued as expired, and one a millisecond later as live', () => {
    const atBoundary = new InMemorySessionStore(1);
    atBoundary.set(session('old', t0));
    atBoundary.set(session('new', t0 + ttlMs));
    expect(digests(atBoundary, ['old', 'new'])).toEqual(['new']);

    const justLive = new InMemorySessionStore(1);
    justLive.set(session('old', t0));
    expect(() => justLive.set(session('new', t0 + ttlMs - 1))).toThrow(SessionStoreCapacityError);
    expect(digests(justLive, ['old', 'new'])).toEqual(['old']);
  });

  it('refuses a new session when every record is live, without evicting any of them, the oldest included', () => {
    const store = new InMemorySessionStore(3);
    store.set(session('oldest', t0));
    store.set(session('middle', t0 + 1_000));
    store.set(session('newest', t0 + 2_000));

    expect(() => store.set(session('extra', t0 + 3_000))).toThrow(SessionStoreCapacityError);
    expect(() => store.set(session('extra', t0 + 3_000))).toThrow('The local session store is at capacity');

    expect(digests(store, ['oldest', 'middle', 'newest', 'extra'])).toEqual(['oldest', 'middle', 'newest']);
    expect(store.get('digest-oldest')?.userId).toBe('user-oldest');
  });

  it('replaces a record under the same digest at capacity, since the store does not grow', () => {
    const store = new InMemorySessionStore(1);
    store.set(session('same', t0));
    const replacement = { ...session('same', t0 + 1_000), userId: 'user-replaced' };

    store.set(replacement);

    expect(store.get('digest-same')).toEqual(replacement);
  });

  it('frees a slot when a session is revoked, so the next sign-in fits', () => {
    const store = new InMemorySessionStore(2);
    store.set(session('a', t0));
    store.set(session('b', t0 + 1));
    expect(() => store.set(session('c', t0 + 2))).toThrow(SessionStoreCapacityError);

    expect(store.delete('digest-a')).toBe(true);
    expect(store.delete('digest-a')).toBe(false);
    store.set(session('c', t0 + 3));

    expect(digests(store, ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });

  it('recovers on its own once the live sessions expire, with no restart', () => {
    const store = new InMemorySessionStore(2);
    store.set(session('a', t0));
    store.set(session('b', t0 + 5_000));
    expect(() => store.set(session('c', t0 + 30_000))).toThrow(SessionStoreCapacityError);

    // a has expired, b has not: exactly one slot comes back.
    store.set(session('c', t0 + ttlMs));
    expect(() => store.set(session('d', t0 + ttlMs + 1))).toThrow(SessionStoreCapacityError);
    expect(digests(store, ['a', 'b', 'c', 'd'])).toEqual(['b', 'c']);
  });
});
