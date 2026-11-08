import { describe, expect, it } from 'vitest';

import { describePendingLoginStoreContract } from '../../test/support/pending-login-store-contract.js';
import { systemClock } from '../clock.js';
import { InMemoryPendingLoginStore } from '../testing/in-memory-pending-logins.js';
import { pendingLoginDigest } from './pending-login-store.js';

// ADR-0081. The same contract runs against PostgreSQL in test/postgres-pending-login-store.integration.test.ts. The
// in-memory store is a test dependency only: the API process uses the PostgreSQL store.

describe('InMemoryPendingLoginStore', () => {
  it('requires a capacity of 1 to 10000 and a lifetime of at most one hour', () => {
    for (const capacity of [0, -1, 1.5, 10_001, Number.NaN]) {
      expect(() => new InMemoryPendingLoginStore({ capacity, clock: systemClock, ttlMs: 1_000 })).toThrow(TypeError);
    }
    for (const ttlMs of [0, -1, 1.5, 3_600_001]) {
      expect(() => new InMemoryPendingLoginStore({ capacity: 1, clock: systemClock, ttlMs })).toThrow(TypeError);
    }
    expect(() => new InMemoryPendingLoginStore({ capacity: 10_000, clock: systemClock, ttlMs: 3_600_000 })).not.toThrow();
  });
});

describe('pendingLoginDigest', () => {
  it('is the base64url SHA-256 of the identifier, never the identifier', () => {
    const loginId = 'a'.repeat(43);
    expect(pendingLoginDigest(loginId)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pendingLoginDigest(loginId)).not.toBe(loginId);
    expect(pendingLoginDigest(loginId)).toBe(pendingLoginDigest(loginId));
  });
});

describePendingLoginStoreContract('InMemoryPendingLoginStore', ({ capacity, clock, ttlMs }) =>
  Promise.resolve(new InMemoryPendingLoginStore({ capacity, clock, ttlMs })),
);
