import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Clock } from '../clock.js';
import type { SessionStore, StoredSession } from './session-store.js';

const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface CreatedSession {
  record: StoredSession;
  sessionToken: string;
}

export interface SessionManagerOptions {
  clock: Clock;
  store: SessionStore;
  tokenGenerator?: () => string;
  ttlMs: number;
}

function defaultTokenGenerator(): string {
  return randomBytes(32).toString('base64url');
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export class SessionManager {
  readonly #clock: Clock;
  readonly #store: SessionStore;
  readonly #tokenGenerator: () => string;
  readonly #ttlMs: number;

  public constructor({ clock, store, tokenGenerator = defaultTokenGenerator, ttlMs }: SessionManagerOptions) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError('ttlMs must be a positive safe integer');
    }
    this.#clock = clock;
    this.#store = store;
    this.#tokenGenerator = tokenGenerator;
    this.#ttlMs = ttlMs;
  }

  public create(userId: string): CreatedSession {
    const sessionToken = this.#generateToken();
    const csrfToken = this.#generateToken();
    const issuedAt = this.#clock.utcNow();
    const record: StoredSession = {
      csrfToken,
      expiresAt: new Date(issuedAt.getTime() + this.#ttlMs),
      issuedAt,
      tokenDigest: tokenDigest(sessionToken),
      userId,
    };
    this.#store.set(record);
    return { record, sessionToken };
  }

  public resolve(sessionToken: string): StoredSession | undefined {
    if (!opaqueTokenPattern.test(sessionToken)) {
      return undefined;
    }
    const digest = tokenDigest(sessionToken);
    const record = this.#store.get(digest);
    if (!record) {
      return undefined;
    }
    if (record.expiresAt.getTime() <= this.#clock.utcNow().getTime()) {
      this.#store.delete(digest);
      return undefined;
    }
    return record;
  }

  public revoke(sessionToken: string): boolean {
    if (!opaqueTokenPattern.test(sessionToken)) {
      return false;
    }
    return this.#store.delete(tokenDigest(sessionToken));
  }

  public verifyCsrf(record: StoredSession, candidate: string): boolean {
    if (!opaqueTokenPattern.test(candidate)) {
      return false;
    }
    const expected = Buffer.from(record.csrfToken, 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }

  #generateToken(): string {
    const token = this.#tokenGenerator();
    if (!opaqueTokenPattern.test(token)) {
      throw new Error('Session token generator returned an invalid opaque token');
    }
    return token;
  }
}
