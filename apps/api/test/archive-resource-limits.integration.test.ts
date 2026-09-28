import { performance } from 'node:perf_hooks';

import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES } from '../src/archive/archive-tile-coordinator.js';
import { ArchiveTileGenerationScheduler } from '../src/archive/archive-tile-scheduler.js';
import type { ArchiveTilePipeline } from '../src/archive/archive-service.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const period = 'from=2026-09-01T00%3A00%3A00Z&to=2026-10-01T00%3A00%3A00Z';
type TestAgent = ReturnType<typeof request.agent>;

function binaryParser(
  response: request.Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', (error: Error) => callback(error, Buffer.alloc(0)));
}

function objectBody(response: request.Response): Record<string, unknown> {
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) {
    throw new Error('Expected an object response body');
  }
  return response.body as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Deterministic integration condition was not reached');
}

describe('P09.6 archive tile resource limits', () => {
  let agent: TestAgent;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const renderCalls = new Map<number, number>();

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: ids.userDual,
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 3 });
    ownerPool = new Pool({
      application_name: 'running-tracker-p096-fixtures',
      connectionString: integration.migration.connectionString,
      max: 1,
    });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);

    const pipeline: ArchiveTilePipeline = {
      render: async (client, tileRequest) => {
        const x = tileRequest.path.x;
        renderCalls.set(x, (renderCalls.get(x) ?? 0) + 1);
        switch (x) {
          case 130:
            await client.query('SELECT pg_sleep(10) /* p096_timeout_probe */');
            return Buffer.alloc(0);
          case 131:
            await client.query('SELECT 1');
            return Buffer.from([0x1a, 0x00]);
          case 132:
            return Buffer.alloc(0);
          case 133:
            return Buffer.alloc(ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES);
          default:
            return Buffer.alloc(ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES + 1);
        }
      },
    };
    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    const app = createApp({
      archiveTilePipeline: pipeline,
      clock: systemClock,
      config: { ...config, DB_POOL_MAX: 3 },
      pool: runtimePool,
      sessionManager,
    });
    agent = request.agent(app);
    await agent
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: ids.userDual })
      .expect(201);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function tilePath(x: number): string {
    return `/api/orgs/${ids.orgA}/tiles/runs/8/${x}/84.mvt?revision=0&${period}`;
  }

  async function readTile(x: number): Promise<request.Response> {
    return agent
      .get(tilePath(x))
      .buffer(true)
      .parse(binaryParser)
      .expect('Cache-Control', 'private, no-store')
      .expect('Content-Type', 'application/vnd.mapbox-vector-tile')
      .expect(200);
  }

  it('allows normal, empty, and exactly 1 MiB raw MVT buffers', async () => {
    await expect(readTile(131)).resolves.toMatchObject({ body: Buffer.from([0x1a, 0x00]) });
    await expect(readTile(132)).resolves.toMatchObject({ body: Buffer.alloc(0) });
    await expect(readTile(133)).resolves.toMatchObject({
      body: Buffer.alloc(ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES),
    });
    await readTile(133);
    expect(renderCalls.get(133)).toBe(1);
  });

  it('returns TILE_TOO_COMPLEX and retries generation instead of caching oversized output', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await agent.get(tilePath(134)).expect(422);
      expect(objectBody(response).error).toMatchObject({ code: 'TILE_TOO_COMPLEX' });
    }
    expect(renderCalls.get(134)).toBe(2);
  });

  it('leaves one pool client available while two generators and sixteen waiters are saturated', async () => {
    const scheduler = new ArchiveTileGenerationScheduler();
    const gates: Array<() => void> = [];
    const blockingPipeline: ArchiveTilePipeline = {
      render: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return Buffer.alloc(0);
      },
    };
    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    const saturatedApp = createApp({
      archiveTilePipeline: blockingPipeline,
      archiveTileScheduler: scheduler,
      clock: systemClock,
      config: { ...config, DB_POOL_MAX: 3 },
      pool: runtimePool,
      sessionManager,
    });
    const saturatedAgent = request.agent(saturatedApp);
    await saturatedAgent
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: ids.userDual })
      .expect(201);

    const pending: Array<Promise<request.Response>> = [];
    let released = 0;
    try {
      for (let index = 0; index < 2; index += 1) {
        pending.push(
          saturatedAgent.get(
            `/api/orgs/${ids.orgA}/tiles/runs/8/${180 + index}/84.mvt?revision=0&${period}`,
          ).then((response) => response),
        );
      }
      await waitFor(() => gates.length === 2);
      for (let index = 0; index < 16; index += 1) {
        pending.push(
          saturatedAgent.get(
            `/api/orgs/${ids.orgA}/tiles/runs/8/${182 + index}/84.mvt?revision=0&${period}`,
          ).then((response) => response),
        );
        await waitFor(() => scheduler.queueDepth === index + 1);
      }

      expect(scheduler.activeCount).toBe(2);
      expect(runtimePool.totalCount - runtimePool.idleCount).toBe(2);
      await request(saturatedApp).get('/api/health/ready').expect(200);
      await saturatedAgent
        .get(`/api/orgs/${ids.orgA}/tiles/runs/8/198/84.mvt?revision=0&${period}`)
        .expect(503)
        .expect(({ body }) => {
          expect((body as Record<string, unknown>).error).toMatchObject({ code: 'TILE_BUSY' });
        });
    } finally {
      while (released < pending.length) {
        await waitFor(() => gates.length > released);
        gates[released]?.();
        released += 1;
      }
    }
    const responses = await Promise.all(pending);
    expect(responses.map(({ status }) => status)).toEqual(Array(18).fill(200));
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.queueDepth).toBe(0);
  });

  it('cancels slow SQL in PostgreSQL, returns TILE_TIMEOUT, and leaves the pool reusable', async () => {
    const startedAt = performance.now();
    const response = await agent.get(tilePath(130)).expect(503);
    const elapsedMs = performance.now() - startedAt;

    expect(objectBody(response).error).toMatchObject({ code: 'TILE_TIMEOUT' });
    expect(elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(runtimePool.waitingCount).toBe(0);
    expect(runtimePool.idleCount).toBe(runtimePool.totalCount);
    await expect(runtimePool.query('SELECT 1 AS reusable')).resolves.toMatchObject({
      rows: [{ reusable: 1 }],
    });
    await expect(readTile(131)).resolves.toMatchObject({ body: Buffer.from([0x1a, 0x00]) });
  });
});
