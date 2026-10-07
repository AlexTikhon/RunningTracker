import { Pool } from 'pg';

import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';
import { defaultLogger, describeError } from '../observability/logger.js';

export interface DatabaseClient {
  query(text: string): Promise<unknown>;
  release(error?: Error | boolean): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
}

export class DatabaseQueryTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Database health query exceeded its ${timeoutMs} ms deadline`);
    this.name = 'DatabaseQueryTimeoutError';
  }
}

/**
 * The runtime pool carries its SQL budgets as connection startup parameters. They are in force before the first
 * statement of every checkout, including the identity lookup and the archive authorization locks, and nothing in
 * this codebase issues a session-level SET, so they cannot drift between borrowers. A transaction may tighten
 * them with SET LOCAL (the archive tile render does); PostgreSQL restores these values when it ends.
 * `statement_timeout` also covers time spent waiting for a lock, so `lock_timeout` is the earlier, finer bound.
 * Maintenance work has different cost profiles and deliberately gets no runtime budget here.
 * `idle_in_transaction_session_timeout` is intentionally not set: when the server ends a checked-out
 * connection, pg raises an unhandled client 'error' that terminates the process.
 */
export function createDatabasePool(config: Environment): Pool {
  const pool = new Pool({
    application_name: 'running-tracker-api',
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    lock_timeout: config.DB_LOCK_TIMEOUT_MS,
    max: config.DB_POOL_MAX,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  });

  pool.on('error', (error) => {
    defaultLogger.error('database.pool.idle_client_error', { ...describeError(error), reason: 'runtime' });
  });

  return pool;
}

export function createMaintenanceDatabasePool(config: Environment): Pool {
  const pool = new Pool({
    application_name: 'running-tracker-maintenance',
    connectionString: config.MAINTENANCE_DATABASE_URL,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    max: config.RUN_SUMMARY_CONCURRENCY + 2,
  });

  pool.on('error', (error) => {
    defaultLogger.error('database.pool.idle_client_error', { ...describeError(error), reason: 'maintenance' });
  });

  return pool;
}

export class DatabaseProbe {
  public constructor(
    private readonly pool: DatabasePool,
    private readonly clock: Clock,
    private readonly queryTimeoutMs: number,
    private readonly queryText = 'SELECT 1',
  ) {}

  public async ping(): Promise<void> {
    const client = await this.pool.connect();
    let released = false;

    const release = (error?: Error): void => {
      if (released) {
        return;
      }

      released = true;
      client.release(error);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeoutError = new DatabaseQueryTimeoutError(this.queryTimeoutMs);
        const timeoutHandle = this.clock.setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          release(timeoutError);
          reject(timeoutError);
        }, this.queryTimeoutMs);

        void client.query(this.queryText).then(
          () => {
            if (settled) {
              return;
            }

            settled = true;
            this.clock.clearTimeout(timeoutHandle);
            resolve();
          },
          (error: unknown) => {
            if (settled) {
              return;
            }

            settled = true;
            this.clock.clearTimeout(timeoutHandle);
            reject(error instanceof Error ? error : new Error('Database health query failed'));
          },
        );
      });

      release();
    } catch (error) {
      release(error instanceof Error ? error : new Error('Database health query failed'));
      throw error;
    }
  }
}
