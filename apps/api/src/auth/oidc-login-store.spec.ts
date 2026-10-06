import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { OidcLoginStore, OidcLoginStoreCapacityError } from './oidc-login-store.js';

class ControlledClock implements Clock {
  public now = new Date('2026-10-02T10:00:00.000Z');

  public advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return this.now.getTime();
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.now);
  }
}

const attempt = { codeVerifier: 'verifier-1', nonce: 'nonce-1', state: 'state-1' };

function createStore(overrides: { maxEntries?: number; ttlMs?: number } = {}) {
  const clock = new ControlledClock();
  const store = new OidcLoginStore({ clock, maxEntries: 2, ttlMs: 1_000, ...overrides });
  return { clock, store };
}

describe('OidcLoginStore', () => {
  it('reserves capacity before asynchronous discovery and expires an unfinished reservation', () => {
    const { clock, store } = createStore({ maxEntries: 1 });
    const id = store.reserve();
    expect(() => store.reserve()).toThrow(OidcLoginStoreCapacityError);
    clock.advance(1_000);
    expect(store.completeReservation(id, attempt)).toBe(false);
    expect(() => store.begin(attempt)).not.toThrow();
  });
  it('returns the stored attempt exactly once', () => {
    const { store } = createStore();
    const loginId = store.begin(attempt);

    expect(loginId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.take(loginId)).toEqual(attempt);
    expect(store.take(loginId)).toBeUndefined();
  });

  it('issues unguessable, distinct identifiers', () => {
    const { store } = createStore({ maxEntries: 10 });
    const identifiers = new Set(Array.from({ length: 10 }, () => store.begin(attempt)));

    expect(identifiers.size).toBe(10);
  });

  it('refuses unknown and malformed identifiers', () => {
    const { store } = createStore();
    store.begin(attempt);

    expect(store.take('x'.repeat(43))).toBeUndefined();
    expect(store.take('short')).toBeUndefined();
    expect(store.take('')).toBeUndefined();
  });

  it('expires an attempt after the configured lifetime and consumes it', () => {
    const { clock, store } = createStore();
    const loginId = store.begin(attempt);

    clock.advance(1_000);

    expect(store.take(loginId)).toBeUndefined();
    expect(store.take(loginId)).toBeUndefined();
  });

  it('is bounded, and frees room again once attempts expire or are consumed', () => {
    const { clock, store } = createStore();
    const first = store.begin(attempt);
    store.begin(attempt);

    expect(() => store.begin(attempt)).toThrow(OidcLoginStoreCapacityError);

    expect(store.take(first)).toEqual(attempt);
    expect(() => store.begin(attempt)).not.toThrow();
    expect(() => store.begin(attempt)).toThrow(OidcLoginStoreCapacityError);

    clock.advance(1_000);
    expect(() => store.begin(attempt)).not.toThrow();
  });

  it('rejects invalid limits', () => {
    const clock = new ControlledClock();
    expect(() => new OidcLoginStore({ clock, maxEntries: 0, ttlMs: 1_000 })).toThrow(TypeError);
    expect(() => new OidcLoginStore({ clock, maxEntries: 1, ttlMs: 0 })).toThrow(TypeError);
  });
});
