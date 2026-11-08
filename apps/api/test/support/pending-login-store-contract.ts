import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  OidcLoginStoreCapacityError,
  type PendingLogin,
  type PendingLoginStore,
} from '../../src/auth/pending-login-store.js';
import type { Clock } from '../../src/clock.js';

// The behaviour every pending-login store owes the OIDC routes (ADR-0081). Run against the in-memory test store
// (src/auth/pending-login-store.spec.ts) and against PostgreSQL (test/postgres-pending-login-store.integration.test.ts),
// so the two cannot drift apart.

export class ContractClock implements Clock {
  public now = Date.parse('2026-11-08T12:00:00.000Z');
  public advance(ms: number): void {
    this.now += ms;
  }
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }
  public monotonicNow(): number {
    return this.now;
  }
  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }
  public utcNow(): Date {
    return new Date(this.now);
  }
}

export type PendingLoginStoreFactory = (options: {
  capacity: number;
  clock: ContractClock;
  ttlMs: number;
}) => Promise<PendingLoginStore>;

/** A login's material in the shape the OIDC client generates (43 URL-safe characters each). */
export function contractLogin(label: string): PendingLogin {
  const value = (part: string) => createHash('sha256').update(`${label}-${part}`, 'utf8').digest('base64url');
  return { codeVerifier: value('verifier'), nonce: value('nonce'), state: value('state') };
}

const ttlMs = 10_000;

export function describePendingLoginStoreContract(label: string, factory: PendingLoginStoreFactory): void {
  describe(`${label}: pending login store contract`, () => {
    async function setup(capacity = 4) {
      const clock = new ContractClock();
      return { clock, store: await factory({ capacity, clock, ttlMs }) };
    }

    it('issues distinct opaque identifiers and returns a completed attempt exactly once', async () => {
      const { store } = await setup();
      const first = await store.reserve();
      const second = await store.reserve();
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(second).not.toBe(first);

      expect(await store.completeReservation(first, contractLogin('a'))).toBe(true);
      expect(await store.consume(first)).toEqual(contractLogin('a'));
      expect(await store.consume(first)).toBeUndefined();
      // Completing after consumption cannot bring the attempt back.
      expect(await store.completeReservation(first, contractLogin('again'))).toBe(false);
      expect(await store.consume(first)).toBeUndefined();
    });

    it('never hands out a reservation that was not completed, and consuming it ends it', async () => {
      const { store } = await setup();
      const loginId = await store.reserve();

      expect(await store.consume(loginId)).toBeUndefined();
      expect(await store.completeReservation(loginId, contractLogin('late'))).toBe(false);
      expect(await store.consume(loginId)).toBeUndefined();
    });

    it('refuses unknown and malformed identifiers without touching other attempts', async () => {
      const { store } = await setup();
      const loginId = await store.reserve();
      await store.completeReservation(loginId, contractLogin('kept'));

      for (const candidate of ['A'.repeat(43), 'short', '', `${'a'.repeat(42)}!`, 'a'.repeat(44)]) {
        expect(await store.consume(candidate)).toBeUndefined();
        expect(await store.completeReservation(candidate, contractLogin('x'))).toBe(false);
        await store.cancel(candidate);
      }
      expect(await store.consume(loginId)).toEqual(contractLogin('kept'));
    });

    it('keeps the reservation expiry: completion does not extend it, and the expiry instant ends the attempt', async () => {
      const { clock, store } = await setup();
      const completedLate = await store.reserve();
      const reservedAt = clock.now;

      clock.now = reservedAt + ttlMs - 1;
      expect(await store.completeReservation(completedLate, contractLogin('late'))).toBe(true);
      clock.now = reservedAt + ttlMs;
      expect(await store.consume(completedLate)).toBeUndefined();

      clock.now = reservedAt;
      const atExpiry = await store.reserve();
      clock.now = reservedAt + ttlMs;
      expect(await store.completeReservation(atExpiry, contractLogin('expired'))).toBe(false);

      clock.now = reservedAt;
      const justInTime = await store.reserve();
      await store.completeReservation(justInTime, contractLogin('in-time'));
      clock.now = reservedAt + ttlMs - 1;
      expect(await store.consume(justInTime)).toEqual(contractLogin('in-time'));
    });

    it('never overwrites a completed attempt', async () => {
      const { store } = await setup();
      const loginId = await store.reserve();

      expect(await store.completeReservation(loginId, contractLogin('first'))).toBe(true);
      expect(await store.completeReservation(loginId, contractLogin('second'))).toBe(false);
      expect(await store.consume(loginId)).toEqual(contractLogin('first'));
    });

    it('counts reservations and completed attempts against the capacity, and never evicts a live attempt', async () => {
      const { store } = await setup(2);
      const reserved = await store.reserve();
      const completed = await store.reserve();
      await store.completeReservation(completed, contractLogin('completed'));

      await expect(store.reserve()).rejects.toBeInstanceOf(OidcLoginStoreCapacityError);

      // The refused reservation removed nothing: both attempts are still usable.
      expect(await store.completeReservation(reserved, contractLogin('reserved'))).toBe(true);
      expect(await store.consume(completed)).toEqual(contractLogin('completed'));
      // Consumption frees a slot, and so does cancellation.
      const third = await store.reserve();
      await expect(store.reserve()).rejects.toBeInstanceOf(OidcLoginStoreCapacityError);
      await store.cancel(third);
      await store.reserve();
      expect(await store.consume(reserved)).toEqual(contractLogin('reserved'));
    });

    it('frees room once attempts expire, reserved or completed', async () => {
      const { clock, store } = await setup(2);
      await store.reserve();
      const completed = await store.reserve();
      await store.completeReservation(completed, contractLogin('completed'));
      await expect(store.reserve()).rejects.toBeInstanceOf(OidcLoginStoreCapacityError);

      clock.advance(ttlMs - 1);
      await expect(store.reserve()).rejects.toBeInstanceOf(OidcLoginStoreCapacityError);
      clock.advance(1);
      const fresh = await store.reserve();
      await store.reserve();
      expect(await store.consume(completed)).toBeUndefined();
      expect(await store.completeReservation(fresh, contractLogin('fresh'))).toBe(true);
    });

    it("replaces the browser's own previous attempt even at capacity, and only that one", async () => {
      const { store } = await setup(2);
      const other = await store.reserve();
      await store.completeReservation(other, contractLogin('other'));
      const previous = await store.reserve();
      await store.completeReservation(previous, contractLogin('previous'));

      const replacement = await store.reserve(previous);

      expect(await store.consume(previous)).toBeUndefined();
      expect(await store.completeReservation(replacement, contractLogin('replacement'))).toBe(true);
      expect(await store.consume(other)).toEqual(contractLogin('other'));
      expect(await store.consume(replacement)).toEqual(contractLogin('replacement'));
      // A malformed previous identifier is ignored rather than refused.
      await store.reserve('not-an-identifier');
    });

    it('cancels exactly the named attempt', async () => {
      const { store } = await setup();
      const cancelled = await store.reserve();
      const kept = await store.reserve();
      await store.completeReservation(cancelled, contractLogin('cancelled'));
      await store.completeReservation(kept, contractLogin('kept'));

      await store.cancel(cancelled);
      await store.cancel(cancelled);

      expect(await store.consume(cancelled)).toBeUndefined();
      expect(await store.consume(kept)).toEqual(contractLogin('kept'));
    });

    it('refuses material it must not store, as a programming error', async () => {
      const { store } = await setup();
      const loginId = await store.reserve();
      for (const login of [
        { ...contractLogin('x'), state: '' },
        { ...contractLogin('x'), nonce: 'has space' },
        { ...contractLogin('x'), codeVerifier: 'v'.repeat(256) },
      ]) {
        await expect(store.completeReservation(loginId, login)).rejects.toBeInstanceOf(TypeError);
      }
      expect(await store.completeReservation(loginId, contractLogin('valid'))).toBe(true);
    });
  });
}
