import { apiErrorResponseSchema, runViewSchema } from '@running-tracker/contracts';
import { Pool, type PoolClient, type QueryResult } from 'pg';
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
import {
  purgeRunRawPointsBatch,
  RUN_RAW_PURGE_BATCH_LIMIT,
} from '../src/maintenance/run-raw-purge.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const runIds = {
  bounded: 'a6500000-0000-4000-8000-000000000001',
  concurrent: 'a6500000-0000-4000-8000-000000000002',
  inFlightSummary: 'a6500000-0000-4000-8000-000000000003',
  partialPublication: 'a6500000-0000-4000-8000-000000000004',
  recording: 'a6500000-0000-4000-8000-000000000005',
  rollback: 'a6500000-0000-4000-8000-000000000006',
} as const;

const validQualityStats = {
  acceptedEdgeCount: 1,
  acceptedPointCount: 2,
  excessiveSpeedCount: 0,
  excessiveTimeGapCount: 0,
  insufficientData: false,
  nonpositiveTimeDeltaCount: 0,
  poorAccuracyPointCount: 0,
  rawPointCount: RUN_RAW_PURGE_BATCH_LIMIT + 1,
  segmentBreakCount: 0,
  seqGapCount: 0,
};

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse('2031-01-10T00:00:00.000Z');
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date('2031-01-10T00:00:00.000Z');
  }
}

interface Authentication {
  cookie: string;
  csrfToken: string;
}

interface RawPurgeRow {
  completed: boolean;
  current_raw_state: string;
  deleted_count: number;
  has_more: boolean;
  previous_raw_state: string;
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

describe('P10.1 bounded restart-safe raw point purge', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let maintenancePool: Pool;
  let ownerAuthentication: Authentication;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let unauthorizedAuthentication: Authentication;
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
      LOCAL_AUTH_USER_IDS: `${ids.userDual},${ids.userStranger}`,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p101-owner',
      connectionString: integration.migration.connectionString,
      max: 5,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p101-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 5,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 5 });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);

    const clock = new FixedClock();
    app = createApp({
      clock,
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      }),
    });
    ownerAuthentication = await login(ids.userDual);
    unauthorizedAuthentication = await login(ids.userStranger);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM runs');
    await ownerPool.query('UPDATE organizations SET archive_revision = 0 WHERE id = $1', [ids.orgA]);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
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

  async function seedRun(
    runId: string,
    pointCount: number,
    options: { summary?: boolean; status?: 'finished' | 'recording' } = {},
  ): Promise<void> {
    const status = options.status ?? 'finished';
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES (
         $1, $2, $3, $4, '2031-01-01T00:00:00.000Z',
         '2031-01-01T00:00:00.000Z', $5, 1, 0, 'available'
       )`,
      [
        ids.orgA,
        runId,
        ids.userDual,
        status,
        status === 'finished' ? '2031-01-02T00:00:00.000Z' : null,
      ],
    );
    if (pointCount > 0) {
      await ownerPool.query(
        `INSERT INTO run_points (
           org_id, run_id, seq, segment_id, recorded_at, received_at,
           geom, accuracy_m, ingested_revision
         )
         SELECT $1, $2, generated.seq, 0,
                '2031-01-01T00:00:00.000Z'::timestamptz + generated.seq * interval '1 second',
                '2031-01-01T01:00:00.000Z',
                ST_SetSRID(ST_MakePoint(21.0 + generated.seq / 1000000.0, 52.0), 4326),
                5.0, 1
         FROM generate_series(1, $3) AS generated(seq)`,
        [ids.orgA, runId, pointCount],
      );
    }
    await ownerPool.query(
      `INSERT INTO run_shares (
         org_id, run_id, grantee_user_id, can_read_history, can_read_live
       ) VALUES ($1, $2, $3, true, false)`,
      [ids.orgA, runId, ids.userOrgA],
    );
    if (options.summary) {
      await ownerPool.query(
        `INSERT INTO run_summaries (
           org_id, run_id, source_revision, algorithm_version, display_geom,
           distance_m, observed_duration_s, quality_stats, computed_at
         ) VALUES (
           $1, $2, 1, 'v1',
           ST_GeomFromText('MULTILINESTRING((21 52,21.001 52.001))', 4326),
           130.5, 60.25, $3::jsonb, '2031-01-02T00:05:00.000Z'
         )`,
        [ids.orgA, runId, JSON.stringify(validQualityStats)],
      );
    }
  }

  function purgeDirect(
    client: Pick<Pool, 'query'> | PoolClient,
    runId: string,
    limit: number,
  ): Promise<QueryResult<RawPurgeRow>> {
    return client.query<RawPurgeRow>(
      `SELECT previous_raw_state, current_raw_state, deleted_count, completed, has_more
       FROM app_private.purge_run_raw_points_batch($1, $2, $3)`,
      [ids.orgA, runId, limit],
    );
  }

  async function waitUntilBlocked(processId: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await ownerPool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [processId],
      );
      if (activity.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Database operation did not reach the expected advisory-lock wait');
  }

  function authorizedGet(path: string) {
    return request(app).get(path).set('Cookie', ownerAuthentication.cookie);
  }

  it('exposes only the bounded maintenance capability and validates its preconditions', async () => {
    const privileges = await ownerPool.query<{
      maintenance_execute: boolean;
      maintenance_run_delete: boolean;
      maintenance_run_select: boolean;
      maintenance_run_update: boolean;
      maintenance_summary_delete: boolean;
      maintenance_summary_select: boolean;
      maintenance_summary_update: boolean;
      maintenance_points_delete: boolean;
      maintenance_points_select: boolean;
      public_execute: boolean;
      runtime_execute: boolean;
      runtime_raw_state_update: boolean;
      runtime_status_update: boolean;
      security_definer: boolean;
      settings: string[];
    }>(
      `SELECT
         has_function_privilege(
           'running_tracker_maintenance',
           'app_private.purge_run_raw_points_batch(uuid,uuid,integer)',
           'EXECUTE'
         ) AS maintenance_execute,
         has_function_privilege(
           'running_tracker_runtime',
           'app_private.purge_run_raw_points_batch(uuid,uuid,integer)',
           'EXECUTE'
         ) AS runtime_execute,
         has_function_privilege(
           'public',
           'app_private.purge_run_raw_points_batch(uuid,uuid,integer)',
           'EXECUTE'
         ) AS public_execute,
         has_table_privilege('running_tracker_maintenance', 'runs', 'SELECT')
           AS maintenance_run_select,
         has_table_privilege('running_tracker_maintenance', 'runs', 'UPDATE')
           AS maintenance_run_update,
         has_table_privilege('running_tracker_maintenance', 'runs', 'DELETE')
           AS maintenance_run_delete,
         has_table_privilege('running_tracker_maintenance', 'run_points', 'SELECT')
           AS maintenance_points_select,
         has_table_privilege('running_tracker_maintenance', 'run_points', 'DELETE')
           AS maintenance_points_delete,
         has_table_privilege('running_tracker_maintenance', 'run_summaries', 'SELECT')
           AS maintenance_summary_select,
         has_table_privilege('running_tracker_maintenance', 'run_summaries', 'UPDATE')
           AS maintenance_summary_update,
         has_table_privilege('running_tracker_maintenance', 'run_summaries', 'DELETE')
           AS maintenance_summary_delete,
         has_column_privilege('running_tracker_runtime', 'runs', 'raw_state', 'UPDATE')
           AS runtime_raw_state_update,
         has_column_privilege('running_tracker_runtime', 'runs', 'status', 'UPDATE')
           AS runtime_status_update,
         procedure.prosecdef AS security_definer,
         procedure.proconfig AS settings
       FROM pg_proc AS procedure
       WHERE procedure.oid =
         'app_private.purge_run_raw_points_batch(uuid,uuid,integer)'::regprocedure`,
    );
    expect(privileges.rows[0]).toEqual({
      maintenance_execute: true,
      maintenance_points_delete: false,
      maintenance_points_select: false,
      maintenance_run_delete: false,
      maintenance_run_select: false,
      maintenance_run_update: false,
      maintenance_summary_delete: false,
      maintenance_summary_select: false,
      maintenance_summary_update: false,
      public_execute: false,
      runtime_execute: false,
      runtime_raw_state_update: false,
      runtime_status_update: true,
      security_definer: true,
      settings: ['search_path=pg_catalog'],
    });

    await seedRun(runIds.recording, 1, { status: 'recording' });
    await expect(purgeDirect(runtimePool, runIds.recording, 1)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(purgeDirect(maintenancePool, runIds.recording, 0)).rejects.toMatchObject({
      code: '22023',
    });
    await expect(purgeDirect(maintenancePool, runIds.recording, 1001)).rejects.toMatchObject({
      code: '22023',
    });
    await expect(purgeDirect(maintenancePool, runIds.recording, 1)).rejects.toMatchObject({
      code: '55000',
    });
    await expect(maintenancePool.query('SELECT * FROM run_points')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('bounds each commit, resumes after restart, hides partial raw data, and preserves archive state', async () => {
    await seedRun(runIds.bounded, RUN_RAW_PURGE_BATCH_LIMIT + 1, { summary: true });
    await ownerPool.query('UPDATE organizations SET archive_revision = 7 WHERE id = $1', [ids.orgA]);

    await expect(
      purgeRunRawPointsBatch(maintenancePool, ids.orgA, runIds.bounded),
    ).resolves.toEqual({
      completed: false,
      currentRawState: 'purging',
      deletedCount: RUN_RAW_PURGE_BATCH_LIMIT,
      hasMore: true,
      previousRawState: 'available',
    });
    const partial = await ownerPool.query<{ point_count: string; raw_state: string }>(
      `SELECT run.raw_state, count(point.seq) AS point_count
       FROM runs AS run
       LEFT JOIN run_points AS point
         ON point.org_id = run.org_id AND point.run_id = run.id
       WHERE run.org_id = $1 AND run.id = $2
       GROUP BY run.raw_state`,
      [ids.orgA, runIds.bounded],
    );
    expect(partial.rows[0]).toEqual({ point_count: '1', raw_state: 'purging' });

    for (const path of [
      `/api/orgs/${ids.orgA}/runs/${runIds.bounded}/points`,
      `/api/orgs/${ids.orgA}/runs/${runIds.bounded}/live-track`,
      `/api/orgs/${ids.orgA}/runs/${runIds.bounded}/live-track/changes?afterRevision=0`,
    ]) {
      const response = await authorizedGet(path).expect(410);
      expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe(
        'RAW_HISTORY_UNAVAILABLE',
      );
    }
    const hidden = await request(app)
      .get(`/api/orgs/${ids.orgA}/runs/${runIds.bounded}/points`)
      .set('Cookie', unauthorizedAuthentication.cookie)
      .expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(hidden)).error.code).toBe('RUN_NOT_FOUND');
    const ingestion = await request(app)
      .post(`/api/orgs/${ids.orgA}/runs/${runIds.bounded}/points`)
      .set('Cookie', ownerAuthentication.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, ownerAuthentication.csrfToken)
      .type('application/json')
      .send({
        points: [
          {
            accuracyM: 5,
            latitude: 52,
            longitude: 21,
            recordedAt: '2031-01-01T00:20:00.000Z',
            segmentId: 0,
            seq: '2000',
          },
        ],
      })
      .expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(ingestion)).error.code).toBe(
      'RAW_HISTORY_UNAVAILABLE',
    );

    const restartedWorkerPool = new Pool({
      application_name: 'running-tracker-p101-restarted-maintenance',
      connectionString: config.MAINTENANCE_DATABASE_URL,
      max: 1,
    });
    try {
      await expect(
        purgeRunRawPointsBatch(restartedWorkerPool, ids.orgA, runIds.bounded),
      ).resolves.toEqual({
        completed: true,
        currentRawState: 'purged',
        deletedCount: 1,
        hasMore: false,
        previousRawState: 'purging',
      });
    } finally {
      await restartedWorkerPool.end();
    }
    await expect(
      purgeRunRawPointsBatch(maintenancePool, ids.orgA, runIds.bounded),
    ).resolves.toEqual({
      completed: true,
      currentRawState: 'purged',
      deletedCount: 0,
      hasMore: false,
      previousRawState: 'purged',
    });

    const preserved = await ownerPool.query<{
      archive_revision: string;
      geometry: string | null;
      point_count: string;
      raw_state: string;
      share_count: string;
      summary_count: string;
    }>(
      `SELECT organization.archive_revision,
              run.raw_state,
              count(DISTINCT point.seq) AS point_count,
              count(DISTINCT summary.run_id) AS summary_count,
              count(DISTINCT share.grantee_user_id) AS share_count,
              ST_AsText(max(summary.display_geom)) AS geometry
       FROM organizations AS organization
       JOIN runs AS run ON run.org_id = organization.id
       LEFT JOIN run_points AS point
         ON point.org_id = run.org_id AND point.run_id = run.id
       LEFT JOIN run_summaries AS summary
         ON summary.org_id = run.org_id AND summary.run_id = run.id
       LEFT JOIN run_shares AS share
         ON share.org_id = run.org_id AND share.run_id = run.id
       WHERE run.org_id = $1 AND run.id = $2
       GROUP BY organization.archive_revision, run.raw_state`,
      [ids.orgA, runIds.bounded],
    );
    expect(preserved.rows[0]).toEqual({
      archive_revision: '7',
      geometry: 'MULTILINESTRING((21 52,21.001 52.001))',
      point_count: '0',
      raw_state: 'purged',
      share_count: '1',
      summary_count: '1',
    });
    const run = await authorizedGet(`/api/orgs/${ids.orgA}/runs/${runIds.bounded}`).expect(200);
    expect(runViewSchema.parse(objectBody(run))).toMatchObject({
      rawState: 'purged',
      summary: { distanceM: 130.5, observedDurationS: 60.25 },
    });
  });

  it('rolls back the state transition and point deletion together', async () => {
    await seedRun(runIds.rollback, 3);
    const transaction = await maintenancePool.connect();
    try {
      await transaction.query('BEGIN');
      await expect(purgeDirect(transaction, runIds.rollback, 2)).resolves.toMatchObject({
        rows: [
          {
            completed: false,
            current_raw_state: 'purging',
            deleted_count: 2,
            has_more: true,
            previous_raw_state: 'available',
          },
        ],
      });
      await transaction.query('ROLLBACK');
    } finally {
      transaction.release();
    }
    const restored = await ownerPool.query<{ point_count: string; raw_state: string }>(
      `SELECT run.raw_state, count(point.seq) AS point_count
       FROM runs AS run
       LEFT JOIN run_points AS point
         ON point.org_id = run.org_id AND point.run_id = run.id
       WHERE run.org_id = $1 AND run.id = $2
       GROUP BY run.raw_state`,
      [ids.orgA, runIds.rollback],
    );
    expect(restored.rows[0]).toEqual({ point_count: '3', raw_state: 'available' });
  });

  it('serializes concurrent purge attempts without double deletion', async () => {
    await seedRun(runIds.concurrent, 5);
    const first = await maintenancePool.connect();
    const second = await maintenancePool.connect();
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      const firstResult = await purgeDirect(first, runIds.concurrent, 2);
      expect(firstResult.rows[0]).toMatchObject({
        current_raw_state: 'purging',
        deleted_count: 2,
        previous_raw_state: 'available',
      });
      const identity = await second.query<{ process_id: number }>(
        'SELECT pg_backend_pid() AS process_id',
      );
      const processId = identity.rows[0]?.process_id;
      if (typeof processId !== 'number') throw new Error('Missing purge backend identity');
      const secondResult = purgeDirect(second, runIds.concurrent, 2);
      await waitUntilBlocked(processId);
      await first.query('COMMIT');
      await expect(secondResult).resolves.toMatchObject({
        rows: [
          {
            current_raw_state: 'purging',
            deleted_count: 2,
            previous_raw_state: 'purging',
          },
        ],
      });
      await second.query('COMMIT');
    } catch (error) {
      await Promise.all([
        first.query('ROLLBACK').catch(() => undefined),
        second.query('ROLLBACK').catch(() => undefined),
      ]);
      throw error;
    } finally {
      first.release();
      second.release();
    }
    const remaining = await ownerPool.query<{ point_count: string; raw_state: string }>(
      `SELECT run.raw_state, count(point.seq) AS point_count
       FROM runs AS run
       LEFT JOIN run_points AS point
         ON point.org_id = run.org_id AND point.run_id = run.id
       WHERE run.org_id = $1 AND run.id = $2
       GROUP BY run.raw_state`,
      [ids.orgA, runIds.concurrent],
    );
    expect(remaining.rows[0]).toEqual({ point_count: '1', raw_state: 'purging' });
  });

  it('waits for an already-claimed summary to publish before purging', async () => {
    await seedRun(runIds.inFlightSummary, 3);
    const summary = await maintenancePool.connect();
    const purge = await maintenancePool.connect();
    try {
      await Promise.all([summary.query('BEGIN'), purge.query('BEGIN')]);
      const claim = await summary.query<{ run_id: string }>(
        'SELECT run_id FROM app_private.claim_stale_run_summary(1000)',
      );
      expect(claim.rows[0]?.run_id).toBe(runIds.inFlightSummary);
      const identity = await purge.query<{ process_id: number }>(
        'SELECT pg_backend_pid() AS process_id',
      );
      const processId = identity.rows[0]?.process_id;
      if (typeof processId !== 'number') throw new Error('Missing purge backend identity');
      const purgeResult = purgeDirect(purge, runIds.inFlightSummary, 1000);
      await waitUntilBlocked(processId);

      const publication = await summary.query<{ published: boolean }>(
        `WITH calculation AS MATERIALIZED (
           SELECT *
           FROM app_private.calculate_run_summary($1, $2, 1, 'v1')
         ), prepared AS MATERIALIZED (
           SELECT calculation.*,
                  app_private.simplify_display_geometry(calculation.accepted_chains, 'v1')
                    AS display_geom
           FROM calculation
         )
         SELECT published
         FROM prepared
         CROSS JOIN LATERAL app_private.publish_run_summary(
           $1, $2, 1, 'v1', prepared.display_geom, prepared.distance_m,
           prepared.observed_duration_s, prepared.quality_stats,
           '2031-01-02T00:05:00.000Z'
         )`,
        [ids.orgA, runIds.inFlightSummary],
      );
      expect(publication.rows[0]?.published).toBe(true);
      await summary.query('COMMIT');
      await expect(purgeResult).resolves.toMatchObject({
        rows: [{ completed: true, deleted_count: 3 }],
      });
      await purge.query('COMMIT');
    } catch (error) {
      await Promise.all([
        summary.query('ROLLBACK').catch(() => undefined),
        purge.query('ROLLBACK').catch(() => undefined),
      ]);
      throw error;
    } finally {
      summary.release();
      purge.release();
    }
    const stored = await ownerPool.query<{ raw_point_count: number; raw_state: string }>(
      `SELECT run.raw_state,
              (summary.quality_stats ->> 'rawPointCount')::integer AS raw_point_count
       FROM runs AS run
       JOIN run_summaries AS summary
         ON summary.org_id = run.org_id AND summary.run_id = run.id
       WHERE run.org_id = $1 AND run.id = $2`,
      [ids.orgA, runIds.inFlightSummary],
    );
    expect(stored.rows[0]).toEqual({ raw_point_count: 3, raw_state: 'purged' });
  });

  it('does not claim or publish a summary from a partially purged point set', async () => {
    await seedRun(runIds.partialPublication, 3);
    await expect(purgeDirect(maintenancePool, runIds.partialPublication, 2)).resolves.toMatchObject({
      rows: [{ current_raw_state: 'purging', deleted_count: 2 }],
    });
    await expect(
      maintenancePool.query('SELECT * FROM app_private.claim_stale_run_summary(1000)'),
    ).resolves.toMatchObject({ rowCount: 0 });

    const publication = await maintenancePool.query<{ published: boolean; raw_point_count: number }>(
      `WITH calculation AS MATERIALIZED (
         SELECT *
         FROM app_private.calculate_run_summary($1, $2, 1, 'v1')
       ), publication AS MATERIALIZED (
         SELECT result.published
         FROM calculation
         CROSS JOIN LATERAL app_private.publish_run_summary(
           $1, $2, 1, 'v1', NULL::geometry, calculation.distance_m,
           calculation.observed_duration_s, calculation.quality_stats,
           '2031-01-02T00:05:00.000Z'
         ) AS result
       )
       SELECT publication.published,
              (calculation.quality_stats ->> 'rawPointCount')::integer AS raw_point_count
       FROM calculation CROSS JOIN publication`,
      [ids.orgA, runIds.partialPublication],
    );
    expect(publication.rows[0]).toEqual({ published: false, raw_point_count: 1 });
    await expect(
      ownerPool.query(
        'SELECT 1 FROM run_summaries WHERE org_id = $1 AND run_id = $2',
        [ids.orgA, runIds.partialPublication],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});
