import type { AddressInfo } from 'node:net';
import type { PointInput } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { createApiMetrics } from '../src/observability/api-metrics.js';
import { createLogger } from '../src/observability/logger.js';
import { startMetricsListener } from '../src/observability/metrics-server.js';
import { observePool, registerProcessMetrics } from '../src/observability/runtime-metrics.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const runId = 'a1100000-0000-4000-8000-000000000001';
const distinctiveLatitude = 52.229676;
const distinctiveLongitude = 21.012229;

function point(seq: string, overrides: Partial<PointInput> = {}): PointInput {
  return {
    accuracyM: 4.5,
    latitude: distinctiveLatitude,
    longitude: distinctiveLongitude,
    recordedAt: '2031-01-02T12:00:00.000Z',
    segmentId: 0,
    seq,
    ...overrides,
  };
}

describe('P11.1 observability against real PostgreSQL', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let cookie = '';
  let csrfToken = '';
  const logged: string[] = [];
  const metrics = createApiMetrics();
  const processMetrics = registerProcessMetrics(metrics.registry);
  const logger = createLogger({
    clock: systemClock,
    write: (_level, line) => void logged.push(line),
  });

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: `${ids.userDual}`,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p111-fixtures',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 4 });
    observePool(runtimePool, { clock: systemClock, metrics, name: 'runtime' });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await ownerPool.query('DELETE FROM runs');
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, 'recording', now(), now(), 0, 0, 'available')`,
      [ids.orgA, runId, ids.userDual],
    );
    app = createApp({
      clock: systemClock,
      config,
      logger,
      metrics,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock: systemClock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      }),
    });
    const login = await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: ids.userDual })
      .expect(201);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    cookie = (setCookie[0] ?? '').split(';', 1)[0] ?? '';
    csrfToken = (login.body as { csrf: { token: string } }).csrf.token;
  });

  afterAll(async () => {
    processMetrics.stop();
    await ownerPool?.query('DELETE FROM runs');
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function ingest(points: unknown[]) {
    return request(app)
      .post(`/api/orgs/${ids.orgA}/runs/${runId}/points`)
      .set('Cookie', cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, csrfToken)
      .type('application/json')
      .send({ points });
  }

  it('measures real ingestion, keeps route labels templated, and leaks no coordinates, tokens, or identifiers', async () => {
    await ingest([point('1'), point('2'), point('3')]).expect(200);
    await ingest([point('2'), point('4')]).expect(200);
    await ingest([point('3', { latitude: 10 })]).expect(409);
    await request(app).get(`/api/orgs/${ids.orgA}/runs/${runId}`).set('Cookie', cookie).expect(200);
    await request(app).get('/api/no-such-route').expect(404);

    const listener = await startMetricsListener(metrics.registry, { host: '127.0.0.1', port: 0 });
    try {
      const { port } = listener.server.address() as AddressInfo;
      const scrape = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(scrape.status).toBe(200);
      const output = await scrape.text();

      expect(output).toContain('point_ingest_points_total{kind="inserted"} 4');
      expect(output).toContain('point_ingest_points_total{kind="duplicate"} 1');
      expect(output).toContain('point_ingest_commit_seconds_count{outcome="ok"} 2');
      expect(output).toContain('point_ingest_commit_seconds_count{outcome="rejected"} 1');
      expect(output).toContain('point_ingest_rejections_total{code="POINT_CONFLICT"} 1');
      expect(output).toContain(
        'http_requests_total{method="POST",route="/api/orgs/:uuid/runs/:uuid/points",status="200"} 2',
      );
      expect(output).toContain(
        'http_requests_total{method="POST",route="/api/orgs/:uuid/runs/:uuid/points",status="409"} 1',
      );
      expect(output).toContain('http_requests_total{method="GET",route="unmatched",status="404"} 1');
      expect(output).toMatch(/db_pool_acquire_seconds_count\{pool="runtime"\} [1-9]/u);
      expect(output).toMatch(/db_pool_connections\{pool="runtime",state="total"\} [1-9]/u);
      expect(output).toMatch(/^process_resident_memory_bytes [1-9]/mu);

      const everything = `${output}\n${logged.join('\n')}`;
      for (const forbidden of [
        String(distinctiveLatitude),
        String(distinctiveLongitude),
        runId,
        ids.orgA,
        ids.userDual,
        cookie.split('=')[1] ?? 'unreachable-cookie-value',
        csrfToken,
      ]) {
        expect(everything).not.toContain(forbidden);
      }
    } finally {
      await listener.close();
    }
  });
});
