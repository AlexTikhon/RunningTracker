import { Pool } from 'pg';

import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';

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

export function createDatabasePool(config: Environment): Pool {
  const pool = new Pool({
    application_name: 'running-tracker-api',
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    max: config.DB_POOL_MAX,
  });

  pool.on('error', (error) => {
    console.error(`Unexpected idle PostgreSQL client error: ${error.message}`);
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
