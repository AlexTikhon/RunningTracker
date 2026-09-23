import {
  apiErrorResponseSchema,
  ingestPointsResponseSchema,
  type PointInput,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { runAutoFinishOnce } from '../src/maintenance/run-auto-finish.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2031-01-03T00:00:00.000Z';
const recentFinishedAt = '2031-01-02T01:00:00.000Z';
const closedFinishedAt = '2031-01-01T23:59:59.999Z';
const startedAt = '2031-01-01T00:00:00.000Z';

const runIds = {
  autoRace: 'a4100000-0000-4000-8000-000000000001',
  basic: 'a4100000-0000-4000-8000-000000000002',
  conflict: 'a4100000-0000-4000-8000-000000000003',
  concurrent: 'a4100000-0000-4000-8000-000000000004',
  finishRace: 'a4100000-0000-4000-8000-000000000005',
  lifecycle: 'a4100000-0000-4000-8000-000000000006',
  limit: 'a4100000-0000-4000-8000-000000000007',
  otherOwner: 'a4100000-0000-4000-8000-000000000008',
  rawUnavailable: 'a4100000-0000-4000-8000-000000000009',
  validation: 'a4100000-0000-4000-8000-000000000010',
} as const;

const finishCommandId = 'c4100000-0000-4000-8000-000000000001';

class FixedClock implements Clock {
  public constructor(private readonly timestamp = now) {}

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse(this.timestamp);
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.timestamp);
  }
}

interface Authentication {
  cookie: string;
  csrfToken: string;
}

function objectBody(response: request.Response): Record<string, unknown> {
  const body = response.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected an object response body');
  }
  return body as Record<string, unknown>;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown =
    typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') {
    throw new Error('Expected a session cookie');
  }
  return value.split(';', 1)[0]!;
}

function point(seq: string, overrides: Partial<PointInput> = {}): PointInput {
  return {
    accuracyM: 4.5,
    latitude: 52.2297,
    longitude: 21.0122,
    recordedAt: '2031-01-02T12:00:00.000Z',
    segmentId: 0,
    seq,
    ...overrides,
  };
}

describe('P04.1 bounded atomic point ingestion', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let ownerAuthentication: Authentication;
  let otherAuthentication: Authentication;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: `${ids.userDual},${ids.userOrgA}`,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p041-fixtures',
      connectionString: integration.migration.connectionString,
      max: 4,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 8 });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p041-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 2,
    });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    const sessionManager = new SessionManager({
      clock: new FixedClock(),
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    app = createApp({ clock: new FixedClock(), config, pool: runtimePool, sessionManager });
    ownerAuthentication = await login(ids.userDual);
    otherAuthentication = await login(ids.userOrgA);
  });

  beforeEach(async () => {
    await ownerPool.query('DROP TRIGGER IF EXISTS p041_reject_point ON run_points');
    await ownerPool.query('DROP FUNCTION IF EXISTS public.p041_reject_point()');
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM runs');
  });

  afterAll(async () => {
    if (ownerPool) {
      await ownerPool.query('DROP TRIGGER IF EXISTS p041_reject_point ON run_points');
      await ownerPool.query('DROP FUNCTION IF EXISTS public.p041_reject_point()');
      await ownerPool.query('DELETE FROM runs');
    }
    await maintenancePool?.end();
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId })
      .expect(201);
    const csrf = objectBody(response).csrf as Record<string, unknown>;
    if (typeof csrf.token !== 'string') {
      throw new Error('Expected a CSRF token');
    }
    return { cookie: cookiePair(response), csrfToken: csrf.token };
  }

  async function insertRun(options: {
    createdAt?: string;
    dataRevision?: number;
    finishedAt?: string;
    id: string;
    ownerId?: string;
    rawState?: 'available' | 'purging' | 'purged';
    status?: 'recording' | 'paused' | 'finished';
  }): Promise<void> {
    const status = options.status ?? 'recording';
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`,
      [
        ids.orgA,
        options.id,
        options.ownerId ?? ids.userDual,
        status,
        startedAt,
        options.createdAt ?? (status === 'finished' ? startedAt : '2031-01-02T23:00:00.000Z'),
        status === 'finished' ? (options.finishedAt ?? recentFinishedAt) : null,
        options.dataRevision ?? 0,
        options.rawState ?? 'available',
      ],
    );
  }

  function mutation(path: string, authentication = ownerAuthentication) {
    return request(app)
      .post(path)
      .set('Cookie', authentication.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, authentication.csrfToken)
      .type('application/json');
  }

  function ingest(runId: string, points: unknown[], authentication = ownerAuthentication) {
    return mutation(`/api/orgs/${ids.orgA}/runs/${runId}/points`, authentication).send({ points });
  }

  async function readRun(runId: string) {
    const result = await ownerPool.query<{
      control_revision: string;
      data_revision: string;
      raw_state: string;
      status: string;
    }>(
      'SELECT status, raw_state, data_revision, control_revision FROM runs WHERE org_id = $1 AND id = $2',
      [ids.orgA, runId],
    );
    return result.rows[0];
  }

  async function pointCount(runId: string): Promise<string> {
    const result = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM run_points WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runId],
    );
    return result.rows[0]?.count ?? 'missing';
  }

  it('stores an out-of-order batch canonically and replays equivalent payloads without a revision', async () => {
    await insertRun({ id: runIds.basic });
    const input = [
      point('43', { recordedAt: '2031-01-02T12:00:00.000499Z' }),
      point('00041', { accuracyM: -0, latitude: -0, longitude: -0 }),
      point('42', { recordedAt: '2031-01-02T12:00:00.000Z' }),
      point('00042', { recordedAt: '2031-01-02T12:00:00Z' }),
    ];
    const created = await ingest(runIds.basic, input).expect(200);
    expect(ingestPointsResponseSchema.parse(objectBody(created))).toEqual({
      dataRevision: '1',
      duplicateCount: 1,
      insertedCount: 3,
    });

    const replay = await ingest(runIds.basic, [
      point('000043', { recordedAt: '2031-01-02T12:00:00.000Z' }),
      point('41', { accuracyM: 0, latitude: 0, longitude: 0 }),
      point('00042', { recordedAt: '2031-01-02T12:00:00Z' }),
    ]).expect(200);
    expect(ingestPointsResponseSchema.parse(objectBody(replay))).toEqual({
      dataRevision: '1',
      duplicateCount: 3,
      insertedCount: 0,
    });

    const late = await ingest(runIds.basic, [
      point('40', { recordedAt: '2030-12-31T23:59:59.000Z' }),
    ]).expect(200);
    expect(ingestPointsResponseSchema.parse(objectBody(late))).toMatchObject({
      dataRevision: '2',
      insertedCount: 1,
    });

    const stored = await ownerPool.query<{
      accuracy_m: number;
      ingested_revision: string;
      latitude: number;
      longitude: number;
      recorded_at: Date;
      seq: string;
    }>(
      `SELECT seq, recorded_at, ST_X(geom) AS longitude, ST_Y(geom) AS latitude,
              accuracy_m, ingested_revision
       FROM run_points WHERE org_id = $1 AND run_id = $2 ORDER BY seq`,
      [ids.orgA, runIds.basic],
    );
    expect(stored.rows.map(({ seq }) => seq)).toEqual(['40', '41', '42', '43']);
    expect(stored.rows.map(({ ingested_revision }) => ingested_revision)).toEqual(['2', '1', '1', '1']);
    expect(stored.rows[1]).toMatchObject({ accuracy_m: 0, latitude: 0, longitude: 0 });
  });

  it('enforces validation, the 100-point batch boundary, and the 64 KiB body limit', async () => {
    await insertRun({ id: runIds.validation });
    expect(apiErrorResponseSchema.parse(objectBody(await ingest(runIds.validation, []).expect(400))).error.code)
      .toBe('INVALID_REQUEST');
    expect(
      apiErrorResponseSchema.parse(
        objectBody(await ingest(runIds.validation, Array.from({ length: 101 }, (_, index) => point(String(index + 1)))).expect(413)),
      ).error.code,
    ).toBe('BATCH_TOO_LARGE');
    const invalid = { ...point('1'), longitude: 181, extra: true };
    expect(apiErrorResponseSchema.parse(objectBody(await ingest(runIds.validation, [invalid]).expect(400))).error.code)
      .toBe('INVALID_REQUEST');

    const maximum = await ingest(
      runIds.validation,
      Array.from({ length: 100 }, (_, index) => point(String(index + 1))),
    ).expect(200);
    expect(ingestPointsResponseSchema.parse(objectBody(maximum)).insertedCount).toBe(100);

    const oversized = await mutation(`/api/orgs/${ids.orgA}/runs/${runIds.validation}/points`)
      .send({ padding: 'x'.repeat(70 * 1024), points: [point('101')] })
      .expect(413);
    expect(apiErrorResponseSchema.parse(objectBody(oversized)).error.code).toBe('BATCH_TOO_LARGE');
  });

  it.each(['recording', 'paused', 'finished'] as const)(
    'accepts new points for an owned %s run inside the upload window',
    async (status) => {
      await insertRun({ id: runIds.lifecycle, status });
      const response = await ingest(runIds.lifecycle, [
        point('1', { recordedAt: '2040-01-01T00:00:00.000Z' }),
      ]).expect(200);
      expect(ingestPointsResponseSchema.parse(objectBody(response))).toMatchObject({
        dataRevision: '1',
        insertedCount: 1,
      });
    },
  );

  it('hides other owners, rejects missing runs, closes only new uploads, and rejects unavailable raw history', async () => {
    await insertRun({ id: runIds.otherOwner, ownerId: ids.userOrgA });
    const hidden = await ingest(runIds.otherOwner, [point('1')]).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(hidden)).error.code).toBe('RUN_NOT_FOUND');
    await ingest('a4100000-0000-4000-8000-000000000099', [point('1')]).expect(404);

    await insertRun({
      dataRevision: 1,
      finishedAt: closedFinishedAt,
      id: runIds.lifecycle,
      status: 'finished',
    });
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at, geom,
         accuracy_m, ingested_revision
       ) VALUES ($1, $2, 1, 0, $3, $3, ST_SetSRID(ST_MakePoint(21.0122, 52.2297), 4326), 4.5, 1)`,
      [ids.orgA, runIds.lifecycle, '2031-01-02T12:00:00.000Z'],
    );
    const replay = await ingest(runIds.lifecycle, [point('1')]).expect(200);
    expect(ingestPointsResponseSchema.parse(objectBody(replay))).toMatchObject({
      dataRevision: '1',
      duplicateCount: 1,
      insertedCount: 0,
    });
    const closed = await ingest(runIds.lifecycle, [point('2')]).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(closed)).error.code).toBe('UPLOAD_WINDOW_CLOSED');

    await insertRun({ id: runIds.rawUnavailable, rawState: 'purging', status: 'finished' });
    const unavailable = await ingest(runIds.rawUnavailable, [point('1')]).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(unavailable)).error.code).toBe('RAW_HISTORY_UNAVAILABLE');
    await ownerPool.query(
      'UPDATE runs SET raw_state = $3 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.rawUnavailable, 'purged'],
    );
    const purged = await ingest(runIds.rawUnavailable, [point('1')]).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(purged)).error.code).toBe('RAW_HISTORY_UNAVAILABLE');

    const acceptedByOwner = await ingest(runIds.otherOwner, [point('1')], otherAuthentication).expect(200);
    expect(ingestPointsResponseSchema.parse(objectBody(acceptedByOwner)).insertedCount).toBe(1);
  });

  it('rejects conflicting seq payloads and rolls back the entire batch on a database failure', async () => {
    await insertRun({ id: runIds.conflict });
    await ingest(runIds.conflict, [point('1')]).expect(200);
    const conflict = await ingest(runIds.conflict, [
      point('1', { accuracyM: 99 }),
      point('2'),
    ]).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(conflict)).error.code).toBe('POINT_CONFLICT');
    expect(await pointCount(runIds.conflict)).toBe('1');
    expect((await readRun(runIds.conflict))?.data_revision).toBe('1');

    const internalConflict = await ingest(runIds.conflict, [point('3'), point('0003', { segmentId: 1 })]).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(internalConflict)).error.code).toBe('POINT_CONFLICT');
    expect(await pointCount(runIds.conflict)).toBe('1');

    await ownerPool.query(
      `CREATE FUNCTION public.p041_reject_point()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced point failure'; END $$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER p041_reject_point BEFORE INSERT ON run_points
       FOR EACH STATEMENT EXECUTE FUNCTION public.p041_reject_point()`,
    );
    const failed = await ingest(runIds.conflict, [point('4')]).expect(500);
    expect(apiErrorResponseSchema.parse(objectBody(failed)).error.code).toBe('INTERNAL_ERROR');
    expect(await pointCount(runIds.conflict)).toBe('1');
    expect((await readRun(runIds.conflict))?.data_revision).toBe('1');
  });

  it('enforces the 50000-point run limit without advancing the revision', async () => {
    await insertRun({ dataRevision: 1, id: runIds.limit, status: 'finished' });
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       )
       SELECT $1, $2, value, 0, $3, $3,
              ST_SetSRID(ST_MakePoint(21, 52), 4326), 1, 1
       FROM generate_series(1, 50000) AS value`,
      [ids.orgA, runIds.limit, '2031-01-02T12:00:00.000Z'],
    );
    const response = await ingest(runIds.limit, [point('50001')]).expect(422);
    expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('RUN_POINT_LIMIT');
    expect(await pointCount(runIds.limit)).toBe('50000');
    expect((await readRun(runIds.limit))?.data_revision).toBe('1');
  }, 20_000);

  it('serializes concurrent batches and makes a concurrent identical retry a no-op', async () => {
    await insertRun({ id: runIds.concurrent });
    const identical = await Promise.all([
      ingest(runIds.concurrent, [point('1'), point('2')]),
      ingest(runIds.concurrent, [point('1'), point('2')]),
    ]);
    expect(identical.every(({ status }) => status === 200)).toBe(true);
    expect(
      identical.map((response) => ingestPointsResponseSchema.parse(objectBody(response)).insertedCount).sort(),
    ).toEqual([0, 2]);
    expect(await pointCount(runIds.concurrent)).toBe('2');
    expect((await readRun(runIds.concurrent))?.data_revision).toBe('1');

    const distinct = await Promise.all([
      ingest(runIds.concurrent, [point('3')]),
      ingest(runIds.concurrent, [point('4')]),
    ]);
    expect(
      distinct.map((response) => ingestPointsResponseSchema.parse(objectBody(response)).dataRevision).sort(),
    ).toEqual(['2', '3']);
    const revisions = await ownerPool.query<{ ingested_revision: string; seq: string }>(
      `SELECT seq, ingested_revision FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND seq IN (3, 4) ORDER BY ingested_revision`,
      [ids.orgA, runIds.concurrent],
    );
    expect(revisions.rows.map(({ ingested_revision }) => ingested_revision)).toEqual(['2', '3']);
  });

  it('serializes ingestion with explicit finish and maintenance auto-finish', async () => {
    await insertRun({ id: runIds.finishRace });
    const [ingestion, finish] = await Promise.all([
      ingest(runIds.finishRace, [point('1')]),
      mutation(`/api/orgs/${ids.orgA}/runs/${runIds.finishRace}/commands`).send({
        commandId: finishCommandId,
        expectedControlRevision: '0',
        type: 'finish',
      }),
    ]);
    expect(ingestion.status).toBe(200);
    expect(finish.status).toBe(200);
    expect(await readRun(runIds.finishRace)).toMatchObject({
      control_revision: '1',
      data_revision: '2',
      status: 'finished',
    });
    expect(await pointCount(runIds.finishRace)).toBe('1');

    await insertRun({
      createdAt: '2031-01-01T23:59:59.999Z',
      id: runIds.autoRace,
      ownerId: ids.userOrgA,
    });
    const [autoIngestion, autoFinish] = await Promise.all([
      ingest(runIds.autoRace, [point('1')], otherAuthentication),
      runAutoFinishOnce(maintenancePool, new FixedClock()),
    ]);
    expect(autoIngestion.status).toBe(200);
    expect(autoFinish).toBe(1);
    expect(await readRun(runIds.autoRace)).toMatchObject({
      control_revision: '0',
      data_revision: '2',
      status: 'finished',
    });
    expect(await pointCount(runIds.autoRace)).toBe('1');
  });
});
