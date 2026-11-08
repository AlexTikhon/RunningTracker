import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { Clock } from '../clock.js';
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

  /**
   * One autocommit statement on a pooled connection, bounded as a whole. On the deadline the call fails at once and
   * the connection is destroyed rather than returned (its statement may still be running); a checkout that finishes
   * after the deadline is returned unused.
   */
  #execute<Row extends QueryResultRow>(text: string, values: unknown[]): Promise<Row[]> {
    return new Promise<Row[]>((resolve, reject) => {
      let settled = false;
      let client: PoolClient | undefined;
      let released = false;
      const release = (destroy: boolean): void => {
        if (client === undefined || released) return;
        released = true;
        client.release(destroy ? new Error('Session store connection discarded') : undefined);
      };
      const timer = this.#clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        release(true);
        reject(new SessionStoreUnavailableError(`no answer within ${this.#operationTimeoutMs} ms`));
      }, this.#operationTimeoutMs);
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        this.#clock.clearTimeout(timer);
        outcome();
      };

      this.#pool.connect().then(
        (acquired) => {
          client = acquired;
          if (settled) {
            release(false);
            return;
          }
          acquired.query<Row>(text, values).then(
            (result) => {
              if (settled) return;
              release(false);
              settle(() => resolve(result.rows));
            },
            (error: unknown) => {
              if (settled) return;
              release(true);
              settle(() => reject(new SessionStoreUnavailableError('query failed', { cause: error })));
            },
          );
        },
        (error: unknown) => {
          settle(() => reject(new SessionStoreUnavailableError('no connection', { cause: error })));
        },
      );
    });
  }
}
