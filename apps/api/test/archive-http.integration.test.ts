import { archiveMetadataResponseSchema } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { ArchiveTileCacheStore } from '../src/archive/archive-tile-cache.js';
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

function objectBody(response: request.Response): Record<string, unknown> {
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) {
    throw new Error('Expected an object response body');
  }
  return response.body as Record<string, unknown>;
}

describe('P09 archive HTTP, cache, and invalidation boundary', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const visibleRunsByUser = new Map<string, string[]>();
  let renderCalls = 0;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userDual, ids.userInactive, ids.userStranger].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-archive-http-fixtures',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);

    const tilePipeline: ArchiveTilePipeline = {
      render: async (client, { path, query }) => {
        renderCalls += 1;
        const result = await client.query<{ run_id: string; user_id: string }>(
          `SELECT summary.run_id::text,
                  current_setting('app.user_id', true) AS user_id
           FROM run_summaries AS summary
           JOIN runs AS run
             ON run.org_id = summary.org_id AND run.id = summary.run_id
           WHERE summary.org_id = $1
             AND run.status = 'finished'
             AND run.started_at >= $2::timestamptz
             AND run.started_at < $3::timestamptz
           ORDER BY summary.run_id`,
          [path.orgId, query.from, query.to],
        );
        const userId = result.rows[0]?.user_id ?? ids.userStranger;
        visibleRunsByUser.set(userId, result.rows.map(({ run_id: runId }) => runId));
        return Buffer.alloc(0);
      },
    };
    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    app = createApp({
      archiveTilePipeline: tilePipeline,
      clock: systemClock,
      config,
      pool: runtimePool,
      sessionManager,
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<TestAgent> {
    const agent = request.agent(app);
    await agent
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId })
      .expect(201);
    return agent;
  }

  it('returns current revision metadata and a concrete private tile template', async () => {
    const agent = await login(ids.userDual);
    const response = await agent
      .get(`/api/orgs/${ids.orgA}/archive/metadata?${period}`)
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    const metadata = archiveMetadataResponseSchema.parse(response.body);
    expect(metadata).toEqual({
      archiveRevision: '0',
      filter: {
        from: '2026-09-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      },
      maxzoom: 16,
      minzoom: 8,
      sourceLayer: 'runs',
      tiles: [
        `/api/orgs/${ids.orgA}/tiles/runs/{z}/{x}/{y}.mvt?revision=0&from=2026-09-01T00%3A00%3A00Z&to=2026-10-01T00%3A00%3A00Z`,
      ],
    });
  });

  it('executes tiles in the runtime tenant context so summary RLS enforces history ACL', async () => {
    const historyReader = await login(ids.userDual);
    await historyReader
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/142/84.mvt?revision=0&${period}`)
      .expect('Cache-Control', 'private, no-store')
      .expect('Content-Type', 'application/vnd.mapbox-vector-tile')
      .expect(200);
    expect(visibleRunsByUser.get(ids.userDual)).toEqual([
      ids.runFinishedHistory,
      ids.runFinishedBoth,
    ]);

    const unrelatedMember = await login(ids.userStranger);
    await unrelatedMember
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/142/84.mvt?revision=0&${period}`)
      .expect(200);
    expect(visibleRunsByUser.get(ids.userStranger)).toEqual([]);
  });

  it('rejects stale revisions before rendering and exposes only the current revision', async () => {
    const agent = await login(ids.userDual);
    await agent
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/142/84.mvt?revision=00&${period}`)
      .expect(200);
    const before = renderCalls;
    const response = await agent
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/142/84.mvt?revision=1&${period}`)
      .expect(409);
    expect(objectBody(response).error).toMatchObject({
      code: 'ARCHIVE_REVISION_CHANGED',
      details: { archiveRevision: '0' },
    });
    expect(renderCalls).toBe(before);
  });

  it('validates period and full XYZ bounds before opening the tile pipeline', async () => {
    const agent = await login(ids.userDual);
    const before = renderCalls;
    const invalidPaths = [
      `/api/orgs/${ids.orgA}/tiles/runs/7/0/0.mvt?revision=0&${period}`,
      `/api/orgs/${ids.orgA}/tiles/runs/17/0/0.mvt?revision=0&${period}`,
      `/api/orgs/${ids.orgA}/tiles/runs/8/256/0.mvt?revision=0&${period}`,
      `/api/orgs/${ids.orgA}/tiles/runs/8/0/256.mvt?revision=0&${period}`,
      `/api/orgs/${ids.orgA}/tiles/runs/08/0/0.mvt?revision=0&${period}`,
    ];
    for (const path of invalidPaths) {
      await agent.get(path).expect(400);
    }
    await agent
      .get(
        `/api/orgs/${ids.orgA}/archive/metadata?from=2025-01-01T00%3A00%3A00Z&to=2026-01-03T00%3A00%3A00Z`,
      )
      .expect(400);
    expect(renderCalls).toBe(before);
  });

  it('requires a valid session and active organization membership', async () => {
    await request(app)
      .get(`/api/orgs/${ids.orgA}/archive/metadata?${period}`)
      .expect(401);
    const inactive = await login(ids.userInactive);
    await inactive.get(`/api/orgs/${ids.orgA}/archive/metadata?${period}`).expect(403);
    await inactive
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/142/84.mvt?revision=0&${period}`)
      .expect(403);
  });

  it('reuses canonical tile bytes only within the authenticated user cache key', async () => {
    const historyReader = await login(ids.userDual);
    const before = renderCalls;
    await historyReader
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/141/84.mvt?revision=000&${period}`)
      .expect(200);
    await historyReader
      .get(
        `/api/orgs/${ids.orgA}/tiles/runs/8/141/84.mvt?revision=0&from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z`,
      )
      .expect(200);
    expect(renderCalls).toBe(before + 1);

    const unrelatedMember = await login(ids.userStranger);
    await unrelatedMember
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/141/84.mvt?revision=0&${period}`)
      .expect(200);
    expect(renderCalls).toBe(before + 2);
  });

  it('advances the archive epoch transactionally for history ACL, summary deletion, and membership changes', async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
    const reader = await login(ids.userStranger);
    const tilePath = `/api/orgs/${ids.orgA}/tiles/runs/8/140/84.mvt`;
    const before = renderCalls;

    await reader.get(`${tilePath}?revision=0&${period}`).expect(200);
    expect(renderCalls).toBe(before + 1);

    await ownerPool.query(
      `INSERT INTO run_shares (
         org_id, run_id, grantee_user_id, can_read_history, can_read_live
       ) VALUES ($1, $2, $3, true, false)`,
      [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
    );
    await expect(
      ownerPool.query<{ archive_revision: string }>(
        'SELECT archive_revision FROM organizations WHERE id = $1',
        [ids.orgA],
      ),
    ).resolves.toMatchObject({ rows: [{ archive_revision: '1' }] });

    await reader.get(`${tilePath}?revision=0&${period}`).expect(409);
    expect(renderCalls).toBe(before + 1);
    await reader.get(`${tilePath}?revision=1&${period}`).expect(200);
    expect(renderCalls).toBe(before + 2);
    expect(visibleRunsByUser.get(ids.userStranger)).toEqual([ids.runFinishedLiveOnly]);

    await ownerPool.query(
      `UPDATE run_shares
       SET can_read_live = true
       WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
      [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
    );
    await expect(
      ownerPool.query<{ archive_revision: string }>(
        'SELECT archive_revision FROM organizations WHERE id = $1',
        [ids.orgA],
      ),
    ).resolves.toMatchObject({ rows: [{ archive_revision: '1' }] });

    const transaction = await ownerPool.connect();
    try {
      await transaction.query('BEGIN');
      await transaction.query(
        `UPDATE run_shares
         SET can_read_history = false
         WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
        [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
      );
      const inside = await transaction.query<{ archive_revision: string }>(
        'SELECT archive_revision FROM organizations WHERE id = $1',
        [ids.orgA],
      );
      expect(inside.rows[0]?.archive_revision).toBe('2');
      await transaction.query('ROLLBACK');
    } finally {
      transaction.release();
    }
    const rolledBack = await ownerPool.query<{
      archive_revision: string;
      can_read_history: boolean;
    }>(
      `SELECT organization.archive_revision, share.can_read_history
       FROM organizations AS organization
       JOIN run_shares AS share ON share.org_id = organization.id
       WHERE organization.id = $1
         AND share.run_id = $2
         AND share.grantee_user_id = $3`,
      [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
    );
    expect(rolledBack.rows[0]).toEqual({ archive_revision: '1', can_read_history: true });

    await ownerPool.query(
      'DELETE FROM run_summaries WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, ids.runFinishedBoth],
    );
    await ownerPool.query(
      'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
      [ids.orgA, ids.userStranger],
    );
    await expect(
      ownerPool.query<{ archive_revision: string }>(
        'SELECT archive_revision FROM organizations WHERE id = $1',
        [ids.orgA],
      ),
    ).resolves.toMatchObject({ rows: [{ archive_revision: '3' }] });
    await reader.get(`${tilePath}?revision=1&${period}`).expect(403);
    expect(renderCalls).toBe(before + 2);
  });

  it('holds the archive epoch read lock across a cache hit until the response transaction commits', async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
    let enterCache!: () => void;
    let releaseCache!: () => void;
    const cacheEntered = new Promise<void>((resolve) => (enterCache = resolve));
    const cacheReleased = new Promise<void>((resolve) => (releaseCache = resolve));
    const cache: ArchiveTileCacheStore = {
      get: async () => {
        enterCache();
        await cacheReleased;
        return Buffer.from('cached-tile');
      },
      getOrCreate: () => Promise.reject(new Error('Legacy cache path must not be used')),
      runSingleFlight: () => Promise.reject(new Error('A cache hit must not create a flight')),
      set: () => undefined,
    };
    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    const lockedApp = createApp({
      archiveTileCache: cache,
      archiveTilePipeline: {
        render: () =>
          Promise.reject(new Error('A cache-hit proof must not invoke the tile pipeline')),
      },
      clock: systemClock,
      config,
      pool: runtimePool,
      sessionManager,
    });
    const reader = request.agent(lockedApp);
    await reader
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: ids.userStranger })
      .expect(201);

    const tileResponse = reader
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/139/84.mvt?revision=0&${period}`)
      .then((response) => response);
    await cacheEntered;

    let membershipChangeCommitted = false;
    const membershipChange = ownerPool
      .query(
        'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userStranger],
      )
      .then(() => {
        membershipChangeCommitted = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(membershipChangeCommitted).toBe(false);
    } finally {
      releaseCache();
    }
    await expect(tileResponse).resolves.toMatchObject({ status: 200 });
    await membershipChange;
    await reader
      .get(`/api/orgs/${ids.orgA}/tiles/runs/8/139/84.mvt?revision=0&${period}`)
      .expect(403);
  });

  it('rechecks membership after waiting for an epoch writer and never enters the cache', async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
    let cacheRead = false;
    const cache: ArchiveTileCacheStore = {
      get: () => {
        cacheRead = true;
        return Buffer.from('cached-tile');
      },
      getOrCreate: () => Promise.reject(new Error('Legacy cache path must not be used')),
      runSingleFlight: () => Promise.reject(new Error('A cache hit must not create a flight')),
      set: () => undefined,
    };
    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    const lockedApp = createApp({
      archiveTileCache: cache,
      archiveTilePipeline: {
        render: () =>
          Promise.reject(new Error('A revoked membership must not invoke the tile pipeline')),
      },
      clock: systemClock,
      config,
      pool: runtimePool,
      sessionManager,
    });
    const reader = request.agent(lockedApp);
    await reader
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: ids.userStranger })
      .expect(201);

    const writer = await ownerPool.connect();
    let transactionActive = false;
    try {
      await writer.query('BEGIN');
      transactionActive = true;
      await writer.query(
        'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userStranger],
      );

      let responseSettled = false;
      const tileResponse = reader
        .get(`/api/orgs/${ids.orgA}/tiles/runs/8/138/84.mvt?revision=0&${period}`)
        .then((response) => {
          responseSettled = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(responseSettled).toBe(false);
      expect(cacheRead).toBe(false);

      await writer.query('COMMIT');
      transactionActive = false;
      await expect(tileResponse).resolves.toMatchObject({ status: 403 });
      expect(cacheRead).toBe(false);
    } finally {
      if (transactionActive) {
        await writer.query('ROLLBACK');
      }
      writer.release();
    }
  });
});
