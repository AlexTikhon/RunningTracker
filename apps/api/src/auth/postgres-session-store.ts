import type { Pool, QueryResultRow } from 'pg';

import type { Clock } from '../clock.js';
import { runBoundedStatement } from '../database/bounded-statement.js';
import {
  SessionDigestConflictError,
  SessionStoreCapacityError,
  SessionStoreUnavailableError,
  SessionUserUnknownError,
  type SessionStore,
  type StoredSession,
} from './session-store.js';

export interface PostgresSessionStoreOptions {
  /** SESSION_STORE_MAX_ENTRIES: live sessions the shared store holds; every instance on one database should agree. */
  capacity: number;
  clock: Pick<Clock, 'clearTimeout' | 'setTimeout'>;
  /** Upper bound of one store operation, connection checkout included (SESSION_STORE_TIMEOUT_MS). */
  operationTimeoutMs: number;
  /** The runtime pool: the role may only call the app_private session functions (migration 0036). */
  pool: Pick<Pool, 'connect'>;
}

interface SessionRow {
  csrf_token: unknown;
  expires_at: unknown;
  issued_at: unknown;
  user_id: unknown;
}

function validInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Sessions in PostgreSQL (ADR-0080), shared by every API instance on the database and kept across restarts. No
 * positive cache: every find asks the database, so a committed revocation is seen by the next request on any
 * instance. Every failure to get an answer, including the deadline, becomes SessionStoreUnavailableError; there is no
 * fallback to another store.
 */
export class PostgresSessionStore implements SessionStore {
  readonly #capacity: number;
  readonly #clock: PostgresSessionStoreOptions['clock'];
  readonly #operationTimeoutMs: number;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor({ capacity, clock, operationTimeoutMs, pool }: PostgresSessionStoreOptions) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new TypeError('capacity must be an integer between 1 and 10000');
    }
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1) {
      throw new TypeError('operationTimeoutMs must be a positive safe integer');
    }
    this.#capacity = capacity;
    this.#clock = clock;
    this.#operationTimeoutMs = operationTimeoutMs;
    this.#pool = pool;
  }

  public async delete(tokenDigest: string): Promise<boolean> {
    const rows = await this.#execute<{ revoked: unknown }>(
      'SELECT app_private.revoke_auth_session($1) AS revoked',
      [tokenDigest],
    );
    const revoked = rows[0]?.revoked;
    if (rows.length !== 1 || typeof revoked !== 'boolean') {
      throw new SessionStoreUnavailableError('unexpected revoke result');
    }
    return revoked;
  }

  public async find(tokenDigest: string, now: Date): Promise<StoredSession | undefined> {
    const rows = await this.#execute<SessionRow>(
      'SELECT user_id, csrf_token, issued_at, expires_at FROM app_private.read_auth_session($1, $2)',
      [tokenDigest, now.toISOString()],
    );
    if (rows.length === 0) {
      return undefined;
    }
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      typeof row.user_id !== 'string' ||
      typeof row.csrf_token !== 'string' ||
      !validInstant(row.issued_at) ||
      !validInstant(row.expires_at)
    ) {
      throw new SessionStoreUnavailableError('unexpected read result');
    }
    return {
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      issuedAt: row.issued_at,
      tokenDigest,
      userId: row.user_id,
    };
  }

  public async insert(session: StoredSession): Promise<void> {
    const rows = await this.#execute<{ outcome: unknown }>(
      'SELECT app_private.create_auth_session($1, $2, $3, $4, $5, $6) AS outcome',
      [
        session.tokenDigest,
        session.userId,
        session.csrfToken,
        session.issuedAt.toISOString(),
        session.expiresAt.toISOString(),
        this.#capacity,
      ],
    );
    const outcome = rows.length === 1 ? rows[0]?.outcome : undefined;
    switch (outcome) {
      case 'created':
        return;
      case 'at_capacity':
        throw new SessionStoreCapacityError();
      case 'unknown_user':
        throw new SessionUserUnknownError();
      case 'duplicate':
        throw new SessionDigestConflictError();
      default:
        throw new SessionStoreUnavailableError('unexpected create result');
    }
  }

  #execute<Row extends QueryResultRow>(text: string, values: unknown[]): Promise<Row[]> {
    return runBoundedStatement<Row>(
      {
        clock: this.#clock,
        discardedConnectionMessage: 'Session store connection discarded',
        pool: this.#pool,
        timeoutMs: this.#operationTimeoutMs,
        unavailable: (reason, options) => new SessionStoreUnavailableError(reason, options),
      },
      text,
      values,
    );
  }
}
