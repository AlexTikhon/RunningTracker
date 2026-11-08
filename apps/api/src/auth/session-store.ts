export interface StoredSession {
  csrfToken: string;
  expiresAt: Date;
  issuedAt: Date;
  tokenDigest: string;
  userId: string;
}

/**
 * Where sessions live (ADR-0080). Every operation is asynchronous and may fail with SessionStoreUnavailableError,
 * which says nothing about the session itself: callers must neither grant access nor treat the session as gone.
 *
 * - insert adds a new session. A store full of live sessions refuses it with SessionStoreCapacityError after
 *   removing expired ones; a live session is never evicted (ADR-0075). An existing digest is never replaced.
 * - find returns the session stored under the digest only while it is live at `now`.
 * - delete removes the session and resolves to whether one existed, only once the removal is committed.
 */
export interface SessionStore {
  delete(tokenDigest: string): Promise<boolean>;
  find(tokenDigest: string, now: Date): Promise<StoredSession | undefined>;
  insert(session: StoredSession): Promise<void>;
}

export class SessionStoreCapacityError extends Error {
  public constructor() {
    super('The session store is at capacity');
    this.name = 'SessionStoreCapacityError';
  }
}

/** The store could not answer (unreachable, timed out, or failed). Not evidence that a session is valid or invalid. */
export class SessionStoreUnavailableError extends Error {
  /** A short machine code (SQLSTATE or a Node network code) for logs; never a message, query or value. */
  public readonly code: string | undefined;

  public constructor(reason: string, options?: { cause?: unknown }) {
    super(`The session store is unavailable: ${reason}`, options);
    this.name = 'SessionStoreUnavailableError';
    const causeCode = (options?.cause as { code?: unknown } | undefined)?.code;
    this.code = typeof causeCode === 'string' ? causeCode : undefined;
  }
}

/** A session can only be created for a provisioned user. */
export class SessionUserUnknownError extends Error {
  public constructor() {
    super('The session user is not provisioned');
    this.name = 'SessionUserUnknownError';
  }
}

export class SessionDigestConflictError extends Error {
  public constructor() {
    super('A session with this digest already exists');
    this.name = 'SessionDigestConflictError';
  }
}

/**
 * Process-local store for tests. It follows the same contract as the PostgreSQL store except that it knows no
 * users, so it never refuses an unknown one. Production and development use PostgresSessionStore.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, StoredSession>();

  public constructor(private readonly maximumEntries: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError('maximumEntries must be a positive safe integer');
    }
  }

  public delete(tokenDigest: string): Promise<boolean> {
    return Promise.resolve(this.#sessions.delete(tokenDigest));
  }

  public find(tokenDigest: string, now: Date): Promise<StoredSession | undefined> {
    const record = this.#sessions.get(tokenDigest);
    if (record && record.expiresAt.getTime() <= now.getTime()) {
      this.#sessions.delete(tokenDigest);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(record);
  }

  public insert(session: StoredSession): Promise<void> {
    for (const [digest, existing] of this.#sessions) {
      if (existing.expiresAt.getTime() <= session.issuedAt.getTime()) {
        this.#sessions.delete(digest);
      }
    }
    if (this.#sessions.has(session.tokenDigest)) {
      return Promise.reject(new SessionDigestConflictError());
    }
    if (this.#sessions.size >= this.maximumEntries) {
      return Promise.reject(new SessionStoreCapacityError());
    }
    this.#sessions.set(session.tokenDigest, session);
    return Promise.resolve();
  }
}
