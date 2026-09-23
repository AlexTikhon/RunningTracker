import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { systemClock } from '../src/clock.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { DatabaseClient, DatabasePool } from '../src/database/database.js';

const config = validateEnvironment({
  APP_ENV: 'test',
  DATABASE_URL:
    'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker_test',
  MAINTENANCE_DATABASE_URL:
    'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/running_tracker_test',
  DB_CONNECTION_TIMEOUT_MS: 100,
  DB_POOL_MAX: 2,
  DB_QUERY_TIMEOUT_MS: 25,
  PORT: 3_000,
  SHUTDOWN_TIMEOUT_MS: 100,
});

function poolWithQuery(query: DatabaseClient['query']): {
  pool: DatabasePool;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const client: DatabaseClient = { query, release };
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, release };
}

describe('health endpoints', () => {
  it('reports liveness and readiness when PostgreSQL responds', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const { pool, release } = poolWithQuery(query);
    const app = createApp({ clock: systemClock, config, pool });

    await request(app)
      .get('/api/health/live')
      .expect(200)
      .expect('X-Request-Id', /^[0-9a-f-]{36}$/u)
      .expect({ status: 'ok' });
    await request(app)
      .get('/api/health/ready')
      .expect(200)
      .expect({ checks: { database: 'up' }, status: 'ok' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('keeps liveness up while readiness reports a database failure', async () => {
    const { pool } = poolWithQuery(
      vi.fn().mockRejectedValue(new Error('postgresql://user:secret@database/internal')),
    );
    const app = createApp({ clock: systemClock, config, pool });

    await request(app)
      .get('/api/health/ready')
      .expect(503)
      .expect({ checks: { database: 'down' }, status: 'not-ready' });
    await request(app).get('/api/health/live').expect(200).expect({ status: 'ok' });
  });
});
