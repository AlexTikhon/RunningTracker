import { apiErrorResponseSchema, archiveMetadataResponseSchema } from '@running-tracker/contracts';
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
import { runRetentionDeleteOnce } from '../src/maintenance/run-retention-delete.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';

const runIds = {
  archiveRevision: 'a7100000-0000-4000-8000-000000000011',
  concurrentDelete: 'a7100000-0000-4000-8000-000000000012',
  ingestionRace: 'a7100000-0000-4000-8000-000000000013',
  noSummary: 'a7100000-0000-4000-8000-000000000001',
  purgeRace: 'a7100000-0000-4000-8000-000000000014',
  rollback: 'a7100000-0000-4000-8000-000000000015',
  summaryRace: 'a7100000-0000-4000-8000-000000000016',
  withSummary: 'a7100000-0000-4000-8000-000000000002',
  annualBoundary: 'a7100000-0000-4000-8000-000000000021',
  annualEligible: 'a7100000-0000-4000-8000-000000000022',
  annualOldest: 'a7100000-0000-4000-8000-000000000023',
  annualTooYoung: 'a7100000-0000-4000-8000-000000000024',
  annualUnfinished: 'a7100000-0000-4000-8000-000000000025',
} as const;

const validQualityStats = {
  acceptedEdgeCount: 1,
  acceptedPointCount: 2,
  excessiveSpeedCount: 0,
  excessiveTimeGapCount: 0,
  insufficientData: false,
  nonpositiveTimeDeltaCount: 0,
  poorAccuracyPointCount: 0,
  rawPointCount: 2,
  segmentBreakCount: 0,
  seqGapCount: 0,
};

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse('2032-01-10T00:00:00.000Z');
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date('2032-01-10T00:00:00.000Z');
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

describe('P10.3 owner deletion and annual retention', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let maintenancePool: Pool;
  let ownerAuthentication: Authentication;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let strangerAuthentication: Authentication;
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
      LOCAL_AUTH_USER_IDS: `${ids.userDual},${ids.userStranger},${ids.userOrgA}`,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p103-owner',
      connectionString: integration.migration.connectionString,
      max: 5,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p103-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 5,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
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
    strangerAuthentication = await login(ids.userStranger);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM runs');
    await ownerPool.query('DELETE FROM run_tombstones');
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
    options: {
      command?: boolean;
      finishedAt?: string | null;
      ownerId?: string;
      points?: number;
      share?: boolean;
      status?: 'finished' | 'paused' | 'recording';
      summary?: boolean;
    } = {},
  ): Promise<void> {
    const status = options.status ?? 'finished';
    const ownerId = options.ownerId ?? ids.userDual;
    const finishedAt =
      status === 'finished' ? (options.finishedAt ?? '2031-01-02T00:00:00.000Z') : null;
    const startedAt = '2020-01-01T00:00:00.000Z';
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES (
         $1, $2, $3, $4, $6,
         $6, $5, 1, 0, 'available'
       )`,
      [ids.orgA, runId, ownerId, status, finishedAt, startedAt],
    );
    if (options.points) {
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
        [ids.orgA, runId, options.points],
      );
    }
    if (options.command) {
      await ownerPool.query(
        `INSERT INTO run_commands (org_id, run_id, command_id, canonical_payload, response)
         VALUES ($1, $2, $3, '{"type":"finish"}'::jsonb, '{"status":"finished"}'::jsonb)`,
        [ids.orgA, runId, 'a7100000-0000-4000-8000-000000009999'],
      );
    }
    if (options.share) {
      await ownerPool.query(
        `INSERT INTO run_shares (
           org_id, run_id, grantee_user_id, can_read_history, can_read_live
         ) VALUES ($1, $2, $3, true, false)`,
        [ids.orgA, runId, ids.userOrgA],
      );
    }
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

  async function waitUntilBlocking(holderProcessId: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await ownerPool.query<{ blocking: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_stat_activity AS activity
           WHERE activity.pid <> $1
             AND $1 = ANY(pg_blocking_pids(activity.pid))
         ) AS blocking`,
        [holderProcessId],
      );
      if (activity.rows[0]?.blocking) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('No other backend reached the expected wait behind the advisory-lock holder');
  }

  function deleteRun(auth: Authentication, runId: string) {
    return request(app)
      .delete(`/api/orgs/${ids.orgA}/runs/${runId}`)
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken);
  }

  function putRun(auth: Authentication, runId: string) {
    return request(app)
      .put(`/api/orgs/${ids.orgA}/runs/${runId}`)
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send({ startedAt: '2031-01-01T00:00:00.000Z' });
  }

  it('exposes only the intended deletion capabilities and denies direct table DELETE', async () => {
    const privileges = await ownerPool.query<{
      execute_run_deletion_maintenance: boolean;
      execute_run_deletion_public: boolean;
      execute_run_deletion_runtime: boolean;
      maintenance_claim: boolean;
      maintenance_commands_delete: boolean;
      maintenance_points_delete: boolean;
      maintenance_retention_delete: boolean;
      maintenance_runs_delete: boolean;
      maintenance_summaries_delete: boolean;
      maintenance_tombstones_delete: boolean;
      owner_delete_maintenance: boolean;
      owner_delete_public: boolean;
      owner_delete_runtime: boolean;
      public_claim: boolean;
      runtime_claim: boolean;
      runtime_commands_delete: boolean;
      runtime_points_delete: boolean;
      runtime_retention_delete: boolean;
      runtime_runs_delete: boolean;
      runtime_summaries_delete: boolean;
      runtime_tombstones_delete: boolean;
    }>(
      `SELECT
         has_function_privilege('running_tracker_runtime', 'app_private.delete_run_as_owner(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS owner_delete_runtime,
         has_function_privilege('running_tracker_maintenance', 'app_private.delete_run_as_owner(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS owner_delete_maintenance,
         has_function_privilege('public', 'app_private.delete_run_as_owner(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS owner_delete_public,
         has_function_privilege('running_tracker_maintenance', 'app_private.claim_run_deletion_candidate(timestamp with time zone,integer)', 'EXECUTE') AS maintenance_claim,
         has_function_privilege('running_tracker_runtime', 'app_private.claim_run_deletion_candidate(timestamp with time zone,integer)', 'EXECUTE') AS runtime_claim,
         has_function_privilege('public', 'app_private.claim_run_deletion_candidate(timestamp with time zone,integer)', 'EXECUTE') AS public_claim,
         has_function_privilege('running_tracker_maintenance', 'app_private.delete_run_for_retention(uuid,uuid,timestamp with time zone)', 'EXECUTE') AS maintenance_retention_delete,
         has_function_privilege('running_tracker_runtime', 'app_private.delete_run_for_retention(uuid,uuid,timestamp with time zone)', 'EXECUTE') AS runtime_retention_delete,
         has_function_privilege('running_tracker_runtime', 'app_private.execute_run_deletion(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS execute_run_deletion_runtime,
         has_function_privilege('running_tracker_maintenance', 'app_private.execute_run_deletion(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS execute_run_deletion_maintenance,
         has_function_privilege('public', 'app_private.execute_run_deletion(uuid,uuid,uuid,timestamp with time zone)', 'EXECUTE') AS execute_run_deletion_public,
         has_table_privilege('running_tracker_runtime', 'runs', 'DELETE') AS runtime_runs_delete,
         has_table_privilege('running_tracker_maintenance', 'runs', 'DELETE') AS maintenance_runs_delete,
         has_table_privilege('running_tracker_runtime', 'run_points', 'DELETE') AS runtime_points_delete,
         has_table_privilege('running_tracker_maintenance', 'run_points', 'DELETE') AS maintenance_points_delete,
         has_table_privilege('running_tracker_runtime', 'run_summaries', 'DELETE') AS runtime_summaries_delete,
         has_table_privilege('running_tracker_maintenance', 'run_summaries', 'DELETE') AS maintenance_summaries_delete,
         has_table_privilege('running_tracker_runtime', 'run_commands', 'DELETE') AS runtime_commands_delete,
         has_table_privilege('running_tracker_maintenance', 'run_commands', 'DELETE') AS maintenance_commands_delete,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'DELETE') AS runtime_tombstones_delete,
         has_table_privilege('running_tracker_maintenance', 'run_tombstones', 'DELETE') AS maintenance_tombstones_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      execute_run_deletion_maintenance: false,
      execute_run_deletion_public: false,
      execute_run_deletion_runtime: false,
      maintenance_claim: true,
      maintenance_commands_delete: false,
      maintenance_points_delete: false,
      maintenance_retention_delete: true,
      maintenance_runs_delete: false,
      maintenance_summaries_delete: false,
      maintenance_tombstones_delete: false,
      owner_delete_maintenance: false,
      owner_delete_public: false,
      owner_delete_runtime: true,
      public_claim: false,
      runtime_claim: false,
      runtime_commands_delete: false,
      runtime_points_delete: false,
      runtime_retention_delete: false,
      runtime_runs_delete: false,
      runtime_summaries_delete: false,
      runtime_tombstones_delete: false,
    });
  });

  it('atomically deletes an owned run with a summary: cascade, one tombstone, one revision increment', async () => {
    await seedRun(runIds.withSummary, { command: true, points: 2, share: true, summary: true });
    await ownerPool.query('UPDATE organizations SET archive_revision = 3 WHERE id = $1', [ids.orgA]);

    await deleteRun(ownerAuthentication, runIds.withSummary).expect(204);

    const run = await ownerPool.query('SELECT 1 FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      runIds.withSummary,
    ]);
    expect(run.rowCount).toBe(0);
    const points = await ownerPool.query('SELECT 1 FROM run_points WHERE org_id = $1 AND run_id = $2', [
      ids.orgA,
      runIds.withSummary,
    ]);
    expect(points.rowCount).toBe(0);
    const commands = await ownerPool.query('SELECT 1 FROM run_commands WHERE org_id = $1 AND run_id = $2', [
      ids.orgA,
      runIds.withSummary,
    ]);
    expect(commands.rowCount).toBe(0);
    const shares = await ownerPool.query('SELECT 1 FROM run_shares WHERE org_id = $1 AND run_id = $2', [
      ids.orgA,
      runIds.withSummary,
    ]);
    expect(shares.rowCount).toBe(0);
    const summaries = await ownerPool.query(
      'SELECT 1 FROM run_summaries WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.withSummary],
    );
    expect(summaries.rowCount).toBe(0);

    const tombstone = await ownerPool.query<{
      deleted_at: Date;
      owner_user_id: string;
    }>(
      'SELECT owner_user_id, deleted_at FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.withSummary],
    );
    expect(tombstone.rowCount).toBe(1);
    expect(tombstone.rows[0]?.owner_user_id).toBe(ids.userDual);
    expect(tombstone.rows[0]?.deleted_at.toISOString()).toBe('2032-01-10T00:00:00.000Z');

    const organization = await ownerPool.query<{ archive_revision: string }>(
      'SELECT archive_revision::text FROM organizations WHERE id = $1',
      [ids.orgA],
    );
    expect(organization.rows[0]?.archive_revision).toBe('4');
  });

  it('increments the archive revision exactly once for a run with no summary', async () => {
    await seedRun(runIds.noSummary, { points: 1 });
    await ownerPool.query('UPDATE organizations SET archive_revision = 5 WHERE id = $1', [ids.orgA]);

    await deleteRun(ownerAuthentication, runIds.noSummary).expect(204);

    const organization = await ownerPool.query<{ archive_revision: string }>(
      'SELECT archive_revision::text FROM organizations WHERE id = $1',
      [ids.orgA],
    );
    expect(organization.rows[0]?.archive_revision).toBe('6');
    const tombstone = await ownerPool.query(
      'SELECT 1 FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.noSummary],
    );
    expect(tombstone.rowCount).toBe(1);
  });

  it('is idempotent for a repeated delete by the same owner', async () => {
    await seedRun(runIds.withSummary, { summary: true });

    await deleteRun(ownerAuthentication, runIds.withSummary).expect(204);
    await deleteRun(ownerAuthentication, runIds.withSummary).expect(204);
    await deleteRun(ownerAuthentication, runIds.withSummary).expect(204);

    const tombstones = await ownerPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.withSummary],
    );
    expect(tombstones.rows[0]?.count).toBe(1);
    const organization = await ownerPool.query<{ archive_revision: string }>(
      'SELECT archive_revision::text FROM organizations WHERE id = $1',
      [ids.orgA],
    );
    expect(organization.rows[0]?.archive_revision).toBe('1');
  });

  it('is safe and idempotent for two concurrent duplicate owner deletes', async () => {
    await seedRun(runIds.concurrentDelete, { summary: true });

    const [first, second] = await Promise.all([
      deleteRun(ownerAuthentication, runIds.concurrentDelete),
      deleteRun(ownerAuthentication, runIds.concurrentDelete),
    ]);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);

    const tombstones = await ownerPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.concurrentDelete],
    );
    expect(tombstones.rows[0]?.count).toBe(1);
    const organization = await ownerPool.query<{ archive_revision: string }>(
      'SELECT archive_revision::text FROM organizations WHERE id = $1',
      [ids.orgA],
    );
    expect(organization.rows[0]?.archive_revision).toBe('1');
  });

  it('does not let another organization member delete, or coach/share access imply deletion rights', async () => {
    await seedRun(runIds.withSummary, { share: true, summary: true });

    const denied = await deleteRun(strangerAuthentication, runIds.withSummary).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(denied)).error.code).toBe('RUN_NOT_FOUND');

    const sharedGranteeDenied = await deleteRun(
      await login(ids.userOrgA),
      runIds.withSummary,
    ).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(sharedGranteeDenied)).error.code).toBe(
      'RUN_NOT_FOUND',
    );

    const run = await ownerPool.query('SELECT 1 FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      runIds.withSummary,
    ]);
    expect(run.rowCount).toBe(1);
    const tombstones = await ownerPool.query(
      'SELECT 1 FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.withSummary],
    );
    expect(tombstones.rowCount).toBe(0);
  });

  it('does not let an unauthorized caller learn that a tombstone exists', async () => {
    await seedRun(runIds.withSummary, { summary: true });
    await deleteRun(ownerAuthentication, runIds.withSummary).expect(204);

    const response = await deleteRun(strangerAuthentication, runIds.withSummary).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('RUN_NOT_FOUND');
    const getResponse = await request(app)
      .get(`/api/orgs/${ids.orgA}/runs/${runIds.withSummary}`)
      .set('Cookie', strangerAuthentication.cookie)
      .expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(getResponse)).error.code).toBe('RUN_NOT_FOUND');
  });

  it('rejects PUT recreation of a deleted run while its tombstone is retained', async () => {
    await seedRun(runIds.withSummary, { summary: true });
    await deleteRun(ownerAuthentication, runIds.withSummary).expect(204);

    const response = await putRun(ownerAuthentication, runIds.withSummary).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('RUN_DELETED');
  });

  it('invalidates the archive cache: a stale revision is rejected after deletion', async () => {
    await seedRun(runIds.withSummary, { summary: true });
    const before = await request(app)
      .get(`/api/orgs/${ids.orgA}/archive/metadata?from=2031-01-01T00:00:00Z&to=2031-02-01T00:00:00Z`)
      .set('Cookie', ownerAuthentication.cookie)
      .expect(200);
    const staleRevision = archiveMetadataResponseSchema.parse(objectBody(before)).archiveRevision;

    await deleteRun(ownerAuthentication, runIds.withSummary).expect(204);

    const staleTile = await request(app)
      .get(`/api/orgs/${ids.orgA}/tiles/runs/10/10/10.mvt?revision=${staleRevision}&from=2031-01-01T00:00:00Z&to=2031-02-01T00:00:00Z`)
      .set('Cookie', ownerAuthentication.cookie)
      .expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(staleTile)).error.code).toBe(
      'ARCHIVE_REVISION_CHANGED',
    );

    const after = await request(app)
      .get(`/api/orgs/${ids.orgA}/archive/metadata?from=2031-01-01T00:00:00Z&to=2031-02-01T00:00:00Z`)
      .set('Cookie', ownerAuthentication.cookie)
      .expect(200);
    const currentRevision = archiveMetadataResponseSchema.parse(objectBody(after)).archiveRevision;
    expect(BigInt(currentRevision)).toBe(BigInt(staleRevision) + 1n);
  });

  it('rolls back the tombstone and every deletion together on transaction failure', async () => {
    await seedRun(runIds.rollback, { points: 2, share: true, summary: true });
    const transaction = await runtimePool.connect();
    try {
      await transaction.query('BEGIN');
      await transaction.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
        [ids.userDual, ids.orgA],
      );
      await transaction.query(
        `SELECT outcome FROM app_private.delete_run_as_owner($1, $2, $3, $4)`,
        [ids.orgA, runIds.rollback, ids.userDual, '2032-01-10T00:00:00.000Z'],
      );
      await transaction.query('ROLLBACK');
    } finally {
      transaction.release();
    }

    const run = await ownerPool.query('SELECT 1 FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      runIds.rollback,
    ]);
    expect(run.rowCount).toBe(1);
    const tombstone = await ownerPool.query(
      'SELECT 1 FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.rollback],
    );
    expect(tombstone.rowCount).toBe(0);
    const summary = await ownerPool.query(
      'SELECT 1 FROM run_summaries WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, runIds.rollback],
    );
    expect(summary.rowCount).toBe(1);
    const organization = await ownerPool.query<{ archive_revision: string }>(
      'SELECT archive_revision::text FROM organizations WHERE id = $1',
      [ids.orgA],
    );
    expect(organization.rows[0]?.archive_revision).toBe('0');
  });

  async function deleteRunDirect(
    runId: string,
    userId: string = ids.userDual,
  ): Promise<{ outcome: string }> {
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
        [userId, ids.orgA],
      );
      const result = await client.query<{ outcome: string }>(
        `SELECT outcome FROM app_private.delete_run_as_owner($1, $2, $3, $4)`,
        [ids.orgA, runId, userId, '2032-01-10T00:00:00.000Z'],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) throw new Error('Expected a delete_run_as_owner result row');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it('serializes deletion behind an in-flight raw purge on the shared per-run lock', async () => {
    await seedRun(runIds.purgeRace, { points: 2, summary: true });
    const purge = await maintenancePool.connect();
    try {
      await purge.query('BEGIN');
      const purgeResult = await purge.query<{ current_raw_state: string }>(
        `SELECT current_raw_state FROM app_private.purge_run_raw_points_batch($1, $2, $3, $4)`,
        [ids.orgA, runIds.purgeRace, 1000, '2031-01-10T00:00:00.000Z'],
      );
      expect(purgeResult.rows[0]?.current_raw_state).toBe('purged');

      const identity = await purge.query<{ process_id: number }>(
        'SELECT pg_backend_pid() AS process_id',
      );
      const processId = identity.rows[0]?.process_id;
      if (typeof processId !== 'number') throw new Error('Missing purge backend identity');

      const deletion = deleteRunDirect(runIds.purgeRace);
      await waitUntilBlocking(processId);
      await purge.query('COMMIT');
      await expect(deletion).resolves.toEqual({ outcome: 'deleted' });
    } catch (error) {
      await purge.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      purge.release();
    }

    const run = await ownerPool.query('SELECT 1 FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      runIds.purgeRace,
    ]);
    expect(run.rowCount).toBe(0);
  });

  it('serializes deletion behind an already-claimed in-flight summary', async () => {
    await seedRun(runIds.summaryRace, { points: 2 });
    const summary = await maintenancePool.connect();
    try {
      await summary.query('BEGIN');
      const claim = await summary.query<{ run_id: string }>(
        'SELECT run_id FROM app_private.claim_stale_run_summary(1000)',
      );
      expect(claim.rows[0]?.run_id).toBe(runIds.summaryRace);

      const identity = await summary.query<{ process_id: number }>(
        'SELECT pg_backend_pid() AS process_id',
      );
      const processId = identity.rows[0]?.process_id;
      if (typeof processId !== 'number') throw new Error('Missing summary backend identity');

      const deletion = deleteRunDirect(runIds.summaryRace);
      await waitUntilBlocking(processId);
      await summary.query('ROLLBACK');
      await expect(deletion).resolves.toEqual({ outcome: 'deleted' });
    } catch (error) {
      await summary.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      summary.release();
    }
  });

  describe('annual retention', () => {
    it('is not eligible one instant before the one-year boundary, and is eligible at and after it', async () => {
      await seedRun(runIds.annualBoundary, { finishedAt: '2031-01-10T00:00:00.000Z', summary: true });

      await expect(
        ownerPool.query(
          `SELECT * FROM app_private.delete_run_for_retention($1, $2, $3)`,
          [ids.orgA, runIds.annualBoundary, '2032-01-09T23:59:59.999Z'],
        ),
      ).rejects.toMatchObject({ code: '55000' });

      const deleted = await ownerPool.query<{ delete_run_for_retention: string }>(
        `SELECT delete_run_for_retention::text FROM app_private.delete_run_for_retention($1, $2, $3)`,
        [ids.orgA, runIds.annualBoundary, '2032-01-10T00:00:00.000Z'],
      );
      expect(deleted.rows[0]?.delete_run_for_retention).toBeDefined();
      const run = await ownerPool.query('SELECT 1 FROM runs WHERE org_id = $1 AND id = $2', [
        ids.orgA,
        runIds.annualBoundary,
      ]);
      expect(run.rowCount).toBe(0);
    });

    it('never claims an unfinished run', async () => {
      await seedRun(runIds.annualUnfinished, { status: 'recording' });

      const candidates = await ownerPool.query(
        `SELECT * FROM app_private.claim_run_deletion_candidate($1, $2)`,
        ['2099-01-01T00:00:00.000Z', 1000],
      );
      expect(candidates.rowCount).toBe(0);
    });

    it('selects the oldest eligible run first and reports an empty cycle as idle', async () => {
      await seedRun(runIds.annualTooYoung, { finishedAt: '2031-07-01T00:00:00.000Z', summary: true });
      await seedRun(runIds.annualOldest, { finishedAt: '2030-01-01T00:00:00.000Z', summary: true });
      await seedRun(runIds.annualEligible, { finishedAt: '2030-06-01T00:00:00.000Z', summary: true });

      await expect(runRetentionDeleteOnce(maintenancePool, new FixedClock())).resolves.toMatchObject({
        orgId: ids.orgA,
        runId: runIds.annualOldest,
        status: 'deleted',
      });
      await expect(runRetentionDeleteOnce(maintenancePool, new FixedClock())).resolves.toMatchObject({
        orgId: ids.orgA,
        runId: runIds.annualEligible,
        status: 'deleted',
      });
      await expect(runRetentionDeleteOnce(maintenancePool, new FixedClock())).resolves.toEqual({
        status: 'idle',
      });

      const remaining = await ownerPool.query<{ id: string }>(
        'SELECT id FROM runs WHERE org_id = $1 ORDER BY id',
        [ids.orgA],
      );
      expect(remaining.rows.map((row) => row.id)).toEqual([runIds.annualTooYoung]);
    });

    it('creates a valid tombstone and advances the archive revision like owner deletion', async () => {
      await seedRun(runIds.annualEligible, {
        finishedAt: '2030-01-01T00:00:00.000Z',
        points: 1,
        share: true,
        summary: true,
      });
      await ownerPool.query('UPDATE organizations SET archive_revision = 2 WHERE id = $1', [ids.orgA]);

      const result = await runRetentionDeleteOnce(maintenancePool, new FixedClock());
      expect(result).toMatchObject({
        archiveRevision: '3',
        orgId: ids.orgA,
        runId: runIds.annualEligible,
        status: 'deleted',
      });

      const tombstone = await ownerPool.query<{ owner_user_id: string }>(
        'SELECT owner_user_id FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
        [ids.orgA, runIds.annualEligible],
      );
      expect(tombstone.rows[0]?.owner_user_id).toBe(ids.userDual);
      const organization = await ownerPool.query<{ archive_revision: string }>(
        'SELECT archive_revision::text FROM organizations WHERE id = $1',
        [ids.orgA],
      );
      expect(organization.rows[0]?.archive_revision).toBe('3');
    });

    it('serializes two concurrent maintenance workers without deleting the same run twice', async () => {
      await seedRun(runIds.annualEligible, { finishedAt: '2030-01-01T00:00:00.000Z', summary: true });

      const results = await Promise.all([
        runRetentionDeleteOnce(maintenancePool, new FixedClock()),
        runRetentionDeleteOnce(maintenancePool, new FixedClock()),
      ]);
      const deleted = results.filter((result) => result.status === 'deleted');
      const idle = results.filter((result) => result.status === 'idle');
      expect(deleted).toHaveLength(1);
      expect(idle).toHaveLength(1);

      const tombstones = await ownerPool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
        [ids.orgA, runIds.annualEligible],
      );
      expect(tombstones.rows[0]?.count).toBe(1);
    });
  });
});
