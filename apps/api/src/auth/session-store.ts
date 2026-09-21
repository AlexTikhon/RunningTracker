export interface StoredSession {
  csrfToken: string;
  expiresAt: Date;
  issuedAt: Date;
  tokenDigest: string;
  userId: string;
}

export interface SessionStore {
  delete(tokenDigest: string): boolean;
  get(tokenDigest: string): StoredSession | undefined;
  set(session: StoredSession): void;
}

export class SessionStoreCapacityError extends Error {
  public constructor() {
    super('The local session store is at capacity');
    this.name = 'SessionStoreCapacityError';
  }
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, StoredSession>();

  public constructor(private readonly maximumEntries: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError('maximumEntries must be a positive safe integer');
    }
  }

  public delete(tokenDigest: string): boolean {
    return this.#sessions.delete(tokenDigest);
  }

  public get(tokenDigest: string): StoredSession | undefined {
    return this.#sessions.get(tokenDigest);
  }

  public set(session: StoredSession): void {
    for (const [digest, existing] of this.#sessions) {
      if (existing.expiresAt.getTime() <= session.issuedAt.getTime()) {
        this.#sessions.delete(digest);
      }
    }
    if (!this.#sessions.has(session.tokenDigest) && this.#sessions.size >= this.maximumEntries) {
      throw new SessionStoreCapacityError();
    }
    this.#sessions.set(session.tokenDigest, session);
  }
}
