import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { systemClock } from '../src/clock.js';
import { loadTestEnvironment, type Environment } from '../src/config/environment.js';
import { createDatabasePool, DatabaseProbe } from '../src/database/database.js';

describe('PostGIS integration', () => {
  let app: ReturnType<typeof createApp> | undefined;
  let config: Environment | undefined;
  let pool: Pool | undefined;

  beforeAll(() => {
    config = loadTestEnvironment();
    pool = createDatabasePool({ ...config, DB_POOL_MAX: 2 });
    app = createApp({ clock: systemClock, config, pool });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('loads PostGIS in the isolated test database', async () => {
    if (!pool || !config) {
      throw new Error('Integration setup did not complete');
    }

    expect(pool.options.connectionString).toBe(config.DATABASE_URL);
    expect(config.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL ?? config.DATABASE_URL);
    if (process.env.DATABASE_URL && process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL) {
      expect(config.DATABASE_URL).not.toBe(process.env.DATABASE_URL);
    }

    const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
    expect(database.rows[0]?.name.endsWith('_test')).toBe(true);

    const result = await pool.query<{ version: string }>(
      'SELECT PostGIS_Full_Version() AS version',
    );

    expect(result.rows[0]?.version).toContain('POSTGIS=');
  });

  it('reports the real database as ready', async () => {
    if (!app) {
      throw new Error('Integration setup did not complete');
    }

    await request(app)
      .get('/api/health/ready')
      .expect(200)
      .expect({ checks: { database: 'up' }, status: 'ok' });
  });

  it('destroys timed-out real connections instead of exhausting the pool', async () => {
    if (!pool) {
      throw new Error('Integration setup did not complete');
    }

    const probe = new DatabaseProbe(pool, systemClock, 25, 'SELECT pg_sleep(10)');

    for (let index = 0; index < 3; index += 1) {
      await expect(probe.ping()).rejects.toThrow('deadline');
      expect(pool.waitingCount).toBe(0);
    }

    expect(pool.idleCount).toBe(0);
    expect(pool.totalCount).toBe(0);
  });
});
