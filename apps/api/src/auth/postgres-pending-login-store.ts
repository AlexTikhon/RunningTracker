import type { Pool, QueryResultRow } from 'pg';

import type { Clock } from '../clock.js';
import { runBoundedStatement } from '../database/bounded-statement.js';
import {
  assertPendingLoginLimits,
  assertPendingLoginShape,
  createLoginId,
  loginIdPattern,
  OidcLoginStoreCapacityError,
  OidcLoginStoreUnavailableError,
  pendingLoginDigest,
  type PendingLogin,
  type PendingLoginStore,
} from './pending-login-store.js';

export interface PostgresPendingLoginStoreOptions {
  /** OIDC_STORE_MAX_ENTRIES: live attempts (reserved or completed) the shared store holds; every instance agrees. */
  capacity: number;
  clock: Pick<Clock, 'clearTimeout' | 'setTimeout' | 'utcNow'>;
  /** Upper bound of one store operation, connection checkout included (SESSION_STORE_TIMEOUT_MS). */
  operationTimeoutMs: number;
  /** The runtime pool: the role may only call the app_private pending-login functions (migration 0037). */
  pool: Pick<Pool, 'connect'>;
  /** OIDC_LOGIN_TTL_MS: absolute lifetime from the reservation instant. */
  ttlMs: number;
}

interface ConsumedRow {
  code_verifier: unknown;
  oidc_nonce: unknown;
  oidc_state: unknown;
}

/**
 * Pending OpenID Connect logins in PostgreSQL (ADR-0081), shared by every API instance on the database and kept across
 * restarts. Each call is one autocommit statement; no connection or transaction is held between calls, and none while
 * the provider is contacted. No cache: consume always asks the database, which removes the row in the same statement
 * that returns it, so at most one caller on any instance receives an attempt. Every failure to get an answer, the
 * deadline included, becomes OidcLoginStoreUnavailableError; there is no fallback to process memory. A consume that
 * timed out may still have committed: the caller treats it as a failed sign-in, never as a reason to retry.
 */
export class PostgresPendingLoginStore implements PendingLoginStore {
  readonly #capacity: number;
  readonly #clock: PostgresPendingLoginStoreOptions['clock'];
  readonly #operationTimeoutMs: number;
  readonly #pool: Pick<Pool, 'connect'>;
  readonly #ttlMs: number;

  public constructor({ capacity, clock, operationTimeoutMs, pool, ttlMs }: PostgresPendingLoginStoreOptions) {
    assertPendingLoginLimits(capacity, ttlMs);
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1) {
      throw new TypeError('operationTimeoutMs must be a positive safe integer');
    }
    this.#capacity = capacity;
    this.#clock = clock;
    this.#operationTimeoutMs = operationTimeoutMs;
    this.#pool = pool;
    this.#ttlMs = ttlMs;
  }

  public async reserve(previousLoginId?: string): Promise<string> {
    const loginId = createLoginId();
    const reservedAt = this.#now();
    const replaced =
      previousLoginId !== undefined && loginIdPattern.test(previousLoginId) ? pendingLoginDigest(previousLoginId) : null;
    const rows = await this.#execute<{ outcome: unknown }>(
      'SELECT app_private.reserve_oidc_login($1, $2, $3, $4, $5) AS outcome',
      [
        pendingLoginDigest(loginId),
        reservedAt.toISOString(),
        new Date(reservedAt.getTime() + this.#ttlMs).toISOString(),
        this.#capacity,
        replaced,
      ],
    );
    const outcome = rows.length === 1 ? rows[0]?.outcome : undefined;
    switch (outcome) {
      case 'reserved':
        return loginId;
      case 'at_capacity':
        throw new OidcLoginStoreCapacityError();
      default:
        // 'duplicate' needs a 256-bit collision; anything else is a broken answer. Neither reserved anything here.
        throw new OidcLoginStoreUnavailableError('unexpected reserve result');
    }
  }

  public async completeReservation(loginId: string, login: PendingLogin): Promise<boolean> {
    assertPendingLoginShape(login);
    if (!loginIdPattern.test(loginId)) {
      return false;
    }
    const rows = await this.#execute<{ completed: unknown }>(
      'SELECT app_private.complete_oidc_login($1, $2, $3, $4, $5) AS completed',
      [pendingLoginDigest(loginId), login.codeVerifier, login.state, login.nonce, this.#now().toISOString()],
    );
    const completed = rows[0]?.completed;
    if (rows.length !== 1 || typeof completed !== 'boolean') {
      throw new OidcLoginStoreUnavailableError('unexpected complete result');
    }
    return completed;
  }

  public async consume(loginId: string): Promise<PendingLogin | undefined> {
    if (!loginIdPattern.test(loginId)) {
      return undefined;
    }
    const rows = await this.#execute<ConsumedRow>(
      'SELECT code_verifier, oidc_state, oidc_nonce FROM app_private.consume_oidc_login($1, $2)',
      [pendingLoginDigest(loginId), this.#now().toISOString()],
    );
    if (rows.length === 0) {
      return undefined;
    }
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      typeof row.code_verifier !== 'string' ||
      typeof row.oidc_state !== 'string' ||
      typeof row.oidc_nonce !== 'string'
    ) {
      // The row is gone either way; an unreadable answer is never handed to the token exchange.
      throw new OidcLoginStoreUnavailableError('unexpected consume result');
    }
    return { codeVerifier: row.code_verifier, nonce: row.oidc_nonce, state: row.oidc_state };
  }

  public async cancel(loginId: string): Promise<void> {
    if (!loginIdPattern.test(loginId)) {
      return;
    }
    const rows = await this.#execute<{ cancelled: unknown }>('SELECT app_private.cancel_oidc_login($1) AS cancelled', [
      pendingLoginDigest(loginId),
    ]);
    if (rows.length !== 1 || typeof rows[0]?.cancelled !== 'boolean') {
      throw new OidcLoginStoreUnavailableError('unexpected cancel result');
    }
  }

  #now(): Date {
    const now = this.#clock.utcNow();
    if (!Number.isFinite(now.getTime())) {
      throw new OidcLoginStoreUnavailableError('the clock returned an invalid time');
    }
    return now;
  }

  #execute<Row extends QueryResultRow>(text: string, values: unknown[]): Promise<Row[]> {
    return runBoundedStatement<Row>(
      {
        clock: this.#clock,
        discardedConnectionMessage: 'Pending login store connection discarded',
        pool: this.#pool,
        timeoutMs: this.#operationTimeoutMs,
        unavailable: (reason, options) => new OidcLoginStoreUnavailableError(reason, options),
      },
      text,
      values,
    );
  }
}
