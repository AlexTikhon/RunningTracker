import { describe, expect, it } from 'vitest';

import { describeSessionStoreContract } from '../../test/support/session-store-contract.js';
import { InMemorySessionStore } from './session-store.js';

// Capacity policy (ADR-0075, unchanged by ADR-0080): expired records are evicted first; a store still full of live
// sessions refuses the new one and never evicts a live session, the oldest included. The same contract runs against
// PostgreSQL in test/postgres-session-store.integration.test.ts. The in-memory store is a test dependency only: the
// API process uses the PostgreSQL store.

describe('InMemorySessionStore', () => {
  it('requires a positive whole maximum', () => {
    for (const maximum of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new InMemorySessionStore(maximum)).toThrow('maximumEntries must be a positive safe integer');
    }
  });
});

describeSessionStoreContract('InMemorySessionStore', (capacity) =>
  Promise.resolve({
    store: new InMemorySessionStore(capacity),
    userIds: ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'],
  }),
);
