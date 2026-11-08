import {
  assertPendingLoginLimits,
  assertPendingLoginShape,
  createLoginId,
  loginIdPattern,
  OidcLoginStoreCapacityError,
  pendingLoginDigest,
  type PendingLogin,
  type PendingLoginStore,
} from '../auth/pending-login-store.js';
import type { Clock } from '../clock.js';

interface StoredAttempt {
  expiresAt: number;
  login?: PendingLogin;
}

export interface InMemoryPendingLoginStoreOptions {
  capacity: number;
  clock: Pick<Clock, 'utcNow'>;
  ttlMs: number;
}

/**
 * Process-local pending logins for unit tests. It follows the same contract as PostgresPendingLoginStore
 * (test/support/pending-login-store-contract.ts runs against both), but a login started on it can never complete in
 * another process or after a restart. The API process uses PostgreSQL (ADR-0081), and createApp has no implicit
 * default, so a test states this choice.
 */
export class InMemoryPendingLoginStore implements PendingLoginStore {
  readonly #attempts = new Map<string, StoredAttempt>();
  readonly #capacity: number;
  readonly #clock: Pick<Clock, 'utcNow'>;
  readonly #ttlMs: number;

  public constructor({ capacity, clock, ttlMs }: InMemoryPendingLoginStoreOptions) {
    assertPendingLoginLimits(capacity, ttlMs);
    this.#capacity = capacity;
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  public reserve(previousLoginId?: string): Promise<string> {
    const now = this.#clock.utcNow().getTime();
    if (previousLoginId !== undefined && loginIdPattern.test(previousLoginId)) {
      this.#attempts.delete(pendingLoginDigest(previousLoginId));
    }
    for (const [digest, attempt] of this.#attempts) {
      if (attempt.expiresAt <= now) this.#attempts.delete(digest);
    }
    if (this.#attempts.size >= this.#capacity) {
      return Promise.reject(new OidcLoginStoreCapacityError());
    }
    const loginId = createLoginId();
    this.#attempts.set(pendingLoginDigest(loginId), { expiresAt: now + this.#ttlMs });
    return Promise.resolve(loginId);
  }

  public completeReservation(loginId: string, login: PendingLogin): Promise<boolean> {
    try {
      assertPendingLoginShape(login);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new TypeError('Invalid pending login material'));
    }
    const attempt = loginIdPattern.test(loginId) ? this.#attempts.get(pendingLoginDigest(loginId)) : undefined;
    if (!attempt || attempt.login !== undefined || attempt.expiresAt <= this.#clock.utcNow().getTime()) {
      return Promise.resolve(false);
    }
    attempt.login = { ...login };
    return Promise.resolve(true);
  }

  public consume(loginId: string): Promise<PendingLogin | undefined> {
    if (!loginIdPattern.test(loginId)) {
      return Promise.resolve(undefined);
    }
    const digest = pendingLoginDigest(loginId);
    const attempt = this.#attempts.get(digest);
    this.#attempts.delete(digest);
    if (!attempt?.login || attempt.expiresAt <= this.#clock.utcNow().getTime()) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ ...attempt.login });
  }

  public cancel(loginId: string): Promise<void> {
    if (loginIdPattern.test(loginId)) this.#attempts.delete(pendingLoginDigest(loginId));
    return Promise.resolve();
  }
}
