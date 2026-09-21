import { describe, expect, it, vi } from 'vitest';

import { systemClock } from '../clock.js';
import { validateEnvironment } from '../config/environment.js';
import type { DatabaseClient, DatabasePool } from './database.js';
import { DatabaseProbe, DatabaseQueryTimeoutError, createDatabasePool } from './database.js';

describe('DatabaseProbe', () => {
  it('destroys a client after a query deadline and does not accumulate occupied slots', async () => {
    let occupied = 0;
    const releases: (Error | boolean | undefined)[] = [];
    const pool: DatabasePool = {
      connect: vi.fn(() => {
        occupied += 1;
        const client: DatabaseClient = {
          query: vi.fn(() => new Promise(() => undefined)),
          release: (error) => {
            releases.push(error);
            occupied -= 1;
          },
        };
        return Promise.resolve(client);
      }),
    };
    const probe = new DatabaseProbe(pool, systemClock, 10);

    for (let index = 0; index < 3; index += 1) {
      await expect(probe.ping()).rejects.toBeInstanceOf(DatabaseQueryTimeoutError);
      expect(occupied).toBe(0);
    }

    expect(releases).toHaveLength(3);
    expect(releases.every((error) => error instanceof DatabaseQueryTimeoutError)).toBe(true);
  });

  it('configures pool acquisition separately from the query deadline', async () => {
    const pool = createDatabasePool(validateEnvironment({
      APP_ENV: 'test',
      DATABASE_URL:
        'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker_test',
      DB_CONNECTION_TIMEOUT_MS: 321,
      DB_POOL_MAX: 4,
      DB_QUERY_TIMEOUT_MS: 654,
      PORT: 3_000,
      SHUTDOWN_TIMEOUT_MS: 1_000,
    }));

    expect(pool.options.connectionTimeoutMillis).toBe(321);
    expect(pool.options.max).toBe(4);
    await pool.end();
  });
});
