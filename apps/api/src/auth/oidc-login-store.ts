import { createHash, randomBytes } from 'node:crypto';

import type { Clock } from '../clock.js';

const loginIdPattern = /^[A-Za-z0-9_-]{43}$/u;

/** What the callback needs to complete one authorization-code login. Never leaves the process. */
export interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  state: string;
}

export class OidcLoginStoreCapacityError extends Error {
  public constructor() {
    super('The pending login store is at capacity');
    this.name = 'OidcLoginStoreCapacityError';
  }
}

export interface OidcLoginStoreOptions {
  clock: Clock;
  maxEntries: number;
  ttlMs: number;
}

interface StoredLogin {
  expiresAt: number;
  login: PendingLogin;
}

function digest(loginId: string): string {
  return createHash('sha256').update(loginId, 'utf8').digest('base64url');
}

/**
 * A bounded, single-use, in-memory record of logins that have been sent to the provider and not
 * yet come back. The browser holds only an opaque identifier; this process holds its digest.
 */
export class OidcLoginStore {
  readonly #clock: Clock;
  readonly #entries = new Map<string, StoredLogin>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  public constructor({ clock, maxEntries, ttlMs }: OidcLoginStoreOptions) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive safe integer');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError('ttlMs must be a positive safe integer');
    }
    this.#clock = clock;
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
  }

  public begin(login: PendingLogin): string {
    const now = this.#clock.utcNow().getTime();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
    if (this.#entries.size >= this.#maxEntries) {
      throw new OidcLoginStoreCapacityError();
    }
    const loginId = randomBytes(32).toString('base64url');
    this.#entries.set(digest(loginId), { expiresAt: now + this.#ttlMs, login });
    return loginId;
  }

  public take(loginId: string): PendingLogin | undefined {
    if (!loginIdPattern.test(loginId)) {
      return undefined;
    }
    const key = digest(loginId);
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.#entries.delete(key);
    return entry.expiresAt <= this.#clock.utcNow().getTime() ? undefined : entry.login;
  }
}
