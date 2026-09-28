import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { decodeMvt, type DecodedMvtLayer } from './mvt-test-decoder.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const period = 'from=2026-09-01T00%3A00%3A00Z&to=2026-10-01T00%3A00%3A00Z';
const polarRunId = 'a0000000-0000-4000-8000-000000000009';
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

function tileLayer(response: request.Response): DecodedMvtLayer | undefined {
  if (!Buffer.isBuffer(response.body)) {
    throw new Error('Expected a binary tile response');
  }
  return decodeMvt(response.body).find(({ name }) => name === 'runs');
}

describe('P09.2 PostGIS archive MVT pipeline', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userDual, ids.userStranger].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-archive-tile-fixtures',
      connectionString: integration.migration.connectionString,
      max: 1,
    });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await ownerPool.query(
      `UPDATE run_summaries
       SET display_geom = CASE run_id
         WHEN $2::uuid THEN public.ST_GeomFromText(
           'MULTILINESTRING((21.08 52.0, 21.10 52.0))', 4326
         )
         WHEN $3::uuid THEN public.ST_GeomFromText(
           'MULTILINESTRING((179.8 0.0, 180.0 0.0),(-180.0 0.0,-179.8 0.0))',
           4326
         )
         WHEN $4::uuid THEN public.ST_GeomFromText(
           'MULTILINESTRING((21.08 52.001, 21.10 52.001))', 4326
         )
         ELSE display_geom
       END
       WHERE org_id = $1
         AND run_id IN ($2, $3, $4)`,
      [
        ids.orgA,
        ids.runFinishedHistory,
        ids.runFinishedBoth,
        ids.runFinishedLiveOnly,
      ],
    );
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at, data_revision
       )
       VALUES ($1, $2, $3, 'finished', $4, $4, $5, 1)`,
      [
        ids.orgA,
        polarRunId,
        ids.userOrgA,
        '2026-09-20T08:00:00.000Z',
        '2026-09-20T09:00:00.000Z',
      ],
    );
    await ownerPool.query(
      `INSERT INTO run_shares (
         org_id, run_id, grantee_user_id, can_read_live, can_read_history
       ) VALUES ($1, $2, $3, false, true)`,
      [ids.orgA, polarRunId, ids.userDual],
    );
    await ownerPool.query(
      `INSERT INTO run_summaries (
         org_id, run_id, source_revision, algorithm_version, display_geom,
         distance_m, observed_duration_s, quality_stats, computed_at
       ) VALUES (
         $1,
         $2,
         1,
         'fixture-v1',
         public.ST_GeomFromText('MULTILINESTRING((0.0 84.95,0.0 89.0))', 4326),
         1.0,
         1.0,
         '{}'::jsonb,
         $3
       )`,
      [
        ids.orgA,
        polarRunId,
        '2026-09-20T09:00:00.000Z',
      ],
    );

    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    app = createApp({
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

  async function readTile(
    agent: TestAgent,
    z: number,
    x: number,
    y: number,
  ): Promise<request.Response> {
    return agent
      .get(`/api/orgs/${ids.orgA}/tiles/runs/${z}/${x}/${y}.mvt?revision=0&${period}`)
      .buffer(true)
      .parse(binaryParser)
      .expect('Cache-Control', 'private, no-store')
      .expect('Content-Type', 'application/vnd.mapbox-vector-tile')
      .expect(200);
  }

  it('encodes a string run_id and buffered line geometry in both adjacent tiles', async () => {
    const agent = await login(ids.userDual);
    const west = tileLayer(await readTile(agent, 8, 142, 84));
    const east = tileLayer(await readTile(agent, 8, 143, 84));

    for (const layer of [west, east]) {
      expect(layer).toMatchObject({ extent: 4096, name: 'runs' });
      const feature = layer?.features.find(
        ({ properties }) => properties.run_id === ids.runFinishedHistory,
      );
      expect(feature).toMatchObject({
        properties: { run_id: ids.runFinishedHistory },
        type: 2,
      });
      expect(feature?.geometry.flat().length).toBeGreaterThanOrEqual(2);
    }
  });

  it('selects and shifts both antimeridian world copies without a world-spanning line', async () => {
    const agent = await login(ids.userDual);
    const left = tileLayer(await readTile(agent, 8, 0, 128));
    const right = tileLayer(await readTile(agent, 8, 255, 128));

    for (const layer of [left, right]) {
      const feature = layer?.features.find(
        ({ properties }) => properties.run_id === ids.runFinishedBoth,
      );
      expect(feature?.type).toBe(2);
      expect(feature?.geometry.flat().length).toBeGreaterThanOrEqual(2);
      for (const point of feature?.geometry.flat() ?? []) {
        expect(point.x).toBeGreaterThanOrEqual(-64);
        expect(point.x).toBeLessThanOrEqual(4160);
      }
    }
  });

  it('clips polar geometry to the Web Mercator world before encoding', async () => {
    const agent = await login(ids.userDual);
    const layer = tileLayer(await readTile(agent, 8, 128, 0));
    const feature = layer?.features.find(({ properties }) => properties.run_id === polarRunId);

    expect(feature?.type).toBe(2);
    expect(feature?.geometry.flat().length).toBeGreaterThanOrEqual(2);
    for (const point of feature?.geometry.flat() ?? []) {
      expect(point.y).toBeGreaterThanOrEqual(-64);
      expect(point.y).toBeLessThanOrEqual(4160);
    }
  });

  it('returns a valid empty MVT and keeps history-inaccessible summaries out', async () => {
    const authorized = await login(ids.userDual);
    const visibleLayer = tileLayer(await readTile(authorized, 8, 142, 84));
    expect(
      visibleLayer?.features.some(
        ({ properties }) => properties.run_id === ids.runFinishedLiveOnly,
      ),
    ).toBe(false);

    const unrelated = await login(ids.userStranger);
    const emptyResponse = await readTile(unrelated, 8, 142, 84);
    expect(emptyResponse.body).toEqual(Buffer.alloc(0));
    expect(decodeMvt(emptyResponse.body as Buffer)).toEqual([]);
  });
});
