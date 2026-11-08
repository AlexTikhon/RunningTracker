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

/**
 * Opaque session tokens over an asynchronous store (ADR-0080). Every method that reaches the store rejects with
 * SessionStoreUnavailableError when the store cannot answer; that is never turned into "no session" here, so a
 * caller can tell an outage from a refusal. Expiry is absolute from the issue instant and is checked against this
 * process's clock on every read, so a session is refused from its expiry instant on.
 */
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

  public async create(userId: string): Promise<CreatedSession> {
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
    await this.#store.insert(record);
    return { record, sessionToken };
  }

  public async resolve(sessionToken: string): Promise<StoredSession | undefined> {
    if (!opaqueTokenPattern.test(sessionToken)) {
      return undefined;
    }
    return this.#findLive(tokenDigest(sessionToken));
  }

  /** Whether this exact session is still stored, unexpired and for the same identity. Resolves only to a boolean. */
  public async isActive(session: Pick<StoredSession, 'tokenDigest' | 'userId'>): Promise<boolean> {
    const record = await this.#findLive(session.tokenDigest);
    return record !== undefined && record.userId === session.userId;
  }

  /** Resolves once the removal is committed; rejects, and revokes nothing it can vouch for, when the store fails. */
  public async revoke(sessionToken: string): Promise<boolean> {
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

  async #findLive(digest: string): Promise<StoredSession | undefined> {
    const now = this.#clock.utcNow();
    const record = await this.#store.find(digest, now);
    if (!record || record.expiresAt.getTime() <= now.getTime()) {
      return undefined;
    }
    return record;
  }

  #generateToken(): string {
    const token = this.#tokenGenerator();
    if (!opaqueTokenPattern.test(token)) {
      throw new Error('Session token generator returned an invalid opaque token');
    }
    return token;
  }
}
