import { apiErrorResponseSchema } from '@running-tracker/contracts';
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
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import { runRetentionDeleteOnce } from '../src/maintenance/run-retention-delete.js';
import { runTombstoneReclaimOnce } from '../src/maintenance/run-tombstone-reclaim.js';
import { createRun } from '../src/runs/run-service.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';

const runIds = {
  active: 'a7400000-0000-4000-8000-000000000001',
  boundary: 'a7400000-0000-4000-8000-000000000002',
  contract: 'a7400000-0000-4000-8000-000000000003',
  createRace: 'a7400000-0000-4000-8000-000000000004',
  delayed: 'a7400000-0000-4000-8000-000000000005',
  retentionTakeover: 'a7400000-0000-4000-8000-000000000006',
  takeover: 'a7400000-0000-4000-8000-000000000007',
  other: 'a7400000-0000-4000-8000-000000000008',
} as const;

const appNow = '2032-01-10T00:00:00.000Z';
const oneYearLater = '2033-01-10T00:00:00.000Z';

class FixedClock implements Clock {
  public constructor(private readonly instant: string = appNow) {}

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse(this.instant);
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.instant);
  }
}

function at(instant: string): Pick<Clock, 'utcNow'> {
  return { utcNow: () => new Date(instant) };
}

function plusMs(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
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

function errorCode(response: request.Response): string {
  return apiErrorResponseSchema.parse(objectBody(response)).error.code;
}

describe('P10.4 tombstone lifetime and late-retry contract', () => {
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
      LOCAL_AUTH_USER_IDS: `${ids.userDual},${ids.userStranger}`,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p104-owner',
      connectionString: integration.migration.connectionString,
      max: 5,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p104-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 8,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 8 });
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
    options: { finishedAt?: string; ownerId?: string } = {},
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES ($1, $2, $3, 'finished', $5, $5, $4, 1, 0, 'available')`,
      [
        ids.orgA,
        runId,
        options.ownerId ?? ids.userDual,
        options.finishedAt ?? '2031-01-02T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
      ],
    );
  }

  async function insertTombstone(
    runId: string,
    deletedAt: string,
    expiresAt: string,
    ownerId: string = ids.userDual,
  ): Promise<void> {
    await ownerPool.query(
      `INSERT INTO run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [ids.orgA, runId, ownerId, deletedAt, expiresAt],
    );
  }

  async function tombstoneRow(runId: string) {
    const result = await ownerPool.query<{
      deleted_at: Date;
      expires_at: Date;
      owner_user_id: string;
    }>(
      `SELECT owner_user_id, deleted_at, expires_at
       FROM run_tombstones WHERE org_id = $1 AND run_id = $2`,
      [ids.orgA, runId],
    );
    return result.rows[0];
  }

  async function tombstoneCount(): Promise<number> {
    const result = await ownerPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM run_tombstones',
    );
    return result.rows[0]!.count;
  }

  async function reclaim(pool: Pick<Pool, 'query'>, instant: string, limit = 500): Promise<number> {
    const result = await pool.query<{ reclaimed: number }>(
      'SELECT app_private.reclaim_expired_run_tombstones($1, $2) AS reclaimed',
      [instant, limit],
    );
    return result.rows[0]!.reclaimed;
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
    throw new Error('No other backend reached the expected wait behind the lock holder');
  }

  async function backendPid(client: { query: Pool['query'] }): Promise<number> {
    const identity = await client.query<{ process_id: number }>(
      'SELECT pg_backend_pid() AS process_id',
    );
    const processId = identity.rows[0]?.process_id;
    if (typeof processId !== 'number') throw new Error('Missing backend identity');
    return processId;
  }

  async function openOwnerDeletion(runId: string, userId: string) {
    const client = await runtimePool.connect();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
      [userId, ids.orgA],
    );
    const result = await client.query<{ outcome: string }>(
      'SELECT outcome FROM app_private.delete_run_as_owner($1, $2, $3, $4)',
      [ids.orgA, runId, userId, appNow],
    );
    return { client, outcome: result.rows[0]?.outcome };
  }

  function deleteRun(auth: Authentication, runId: string) {
    return request(app)
      .delete(`/api/orgs/${ids.orgA}/runs/${runId}`)
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken);
  }

  function putRun(auth: Authentication, runId: string, startedAt = '2031-01-01T00:00:00.000Z') {
    return request(app)
      .put(`/api/orgs/${ids.orgA}/runs/${runId}`)
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send({ startedAt });
  }

  function getRun(auth: Authentication, runId: string) {
    return request(app).get(`/api/orgs/${ids.orgA}/runs/${runId}`).set('Cookie', auth.cookie);
  }

  it('grants the reclaim capability to maintenance only and no direct tombstone DELETE to anyone', async () => {
    const catalog = await ownerPool.query<Record<string, boolean | string | string[]>>(
      `SELECT
         has_function_privilege('running_tracker_maintenance', 'app_private.reclaim_expired_run_tombstones(timestamp with time zone,integer)', 'EXECUTE') AS maintenance_execute,
         has_function_privilege('running_tracker_runtime', 'app_private.reclaim_expired_run_tombstones(timestamp with time zone,integer)', 'EXECUTE') AS runtime_execute,
         has_function_privilege('public', 'app_private.reclaim_expired_run_tombstones(timestamp with time zone,integer)', 'EXECUTE') AS public_execute,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'DELETE') AS runtime_delete,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'INSERT') AS runtime_insert,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'UPDATE') AS runtime_update,
         has_table_privilege('running_tracker_maintenance', 'run_tombstones', 'DELETE') AS maintenance_delete,
         has_table_privilege('running_tracker_maintenance', 'run_tombstones', 'SELECT') AS maintenance_select,
         has_table_privilege('public', 'run_tombstones', 'SELECT') AS public_select,
         (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.reclaim_expired_run_tombstones(timestamp with time zone,integer)'::regprocedure) AS security_definer,
         (SELECT proconfig FROM pg_proc WHERE oid = 'app_private.reclaim_expired_run_tombstones(timestamp with time zone,integer)'::regprocedure) AS config,
         (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app_private.reclaim_expired_run_tombstones(timestamp with time zone,integer)'::regprocedure) AS owner_role`,
    );
    expect(catalog.rows[0]).toEqual({
      config: ['search_path=pg_catalog'],
      maintenance_delete: false,
      maintenance_execute: true,
      maintenance_select: false,
      owner_role: 'running_tracker_owner',
      public_execute: false,
      public_select: false,
      runtime_delete: false,
      runtime_execute: false,
      runtime_insert: false,
      runtime_update: false,
      security_definer: true,
    });

    await insertTombstone(runIds.boundary, '2030-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z');
    await expect(runtimePool.query('DELETE FROM run_tombstones')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(maintenancePool.query('DELETE FROM run_tombstones')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(reclaim(runtimePool, appNow)).rejects.toMatchObject({ code: '42501' });
    expect(await tombstoneCount()).toBe(1);
  });

  it('rejects out-of-range batch sizes and non-finite times', async () => {
    for (const limit of [0, -1, 1001]) {
      await expect(reclaim(maintenancePool, appNow, limit)).rejects.toMatchObject({
        code: '22023',
      });
    }
    await expect(reclaim(maintenancePool, 'infinity')).rejects.toMatchObject({ code: '22007' });
    await expect(reclaim(maintenancePool, '-infinity')).rejects.toMatchObject({ code: '22007' });
  });

  it('keeps a marker one millisecond before expires_at and reclaims it at and after it', async () => {
    const deletedAt = '2032-01-10T00:00:00.000Z';
    const expiresAt = oneYearLater;
    await insertTombstone(runIds.boundary, deletedAt, expiresAt);

    expect(await reclaim(maintenancePool, plusMs(expiresAt, -1))).toBe(0);
    expect(await tombstoneRow(runIds.boundary)).toBeDefined();

    expect(await reclaim(maintenancePool, expiresAt)).toBe(1);
    expect(await tombstoneRow(runIds.boundary)).toBeUndefined();

    await insertTombstone(runIds.boundary, deletedAt, expiresAt);
    expect(await reclaim(maintenancePool, plusMs(expiresAt, 1))).toBe(1);
    expect(await tombstoneCount()).toBe(0);
  });

  it('stores expires_at exactly one year after deleted_at for owner and annual-retention deletion', async () => {
    await seedRun(runIds.contract);
    await deleteRun(ownerAuthentication, runIds.contract).expect(204);
    const owner = await tombstoneRow(runIds.contract);
    expect(owner?.deleted_at.toISOString()).toBe(appNow);
    expect(owner?.expires_at.toISOString()).toBe(oneYearLater);

    await seedRun(runIds.active, { finishedAt: '2030-01-01T00:00:00.000Z' });
    await expect(
      runRetentionDeleteOnce(maintenancePool, new FixedClock()),
    ).resolves.toMatchObject({ runId: runIds.active, status: 'deleted' });
    const retention = await tombstoneRow(runIds.active);
    expect(retention?.deleted_at.toISOString()).toBe(appNow);
    expect(retention?.expires_at.toISOString()).toBe(oneYearLater);
  });

  it('protects a deleted ID until reclaim, then allows reuse and ends the DELETE idempotency', async () => {
    await seedRun(runIds.contract);
    await deleteRun(ownerAuthentication, runIds.contract).expect(204);

    // Inside the window: DELETE stays idempotent, PUT is refused, and the
    // reclaim worker leaves the marker alone one millisecond before expiry.
    await expect(
      runTombstoneReclaimOnce(maintenancePool, at(plusMs(oneYearLater, -1))),
    ).resolves.toEqual({ status: 'idle' });
    await deleteRun(ownerAuthentication, runIds.contract).expect(204);
    expect(errorCode(await putRun(ownerAuthentication, runIds.contract).expect(410))).toBe(
      'RUN_DELETED',
    );

    // At expires_at the marker is eligible; only its actual removal frees the ID.
    await expect(
      runTombstoneReclaimOnce(maintenancePool, at(oneYearLater)),
    ).resolves.toEqual({ reclaimedCount: 1, status: 'reclaimed' });
    expect(await tombstoneRow(runIds.contract)).toBeUndefined();

    // Past reclamation the guarantee is over: DELETE is no longer idempotent
    // (the ID is unknown), and a very late PUT creates a brand-new run.
    expect(errorCode(await deleteRun(ownerAuthentication, runIds.contract).expect(404))).toBe(
      'RUN_NOT_FOUND',
    );
    const created = await putRun(ownerAuthentication, runIds.contract).expect(201);
    expect(objectBody(created).status).toBe('recording');
    const points = await ownerPool.query('SELECT 1 FROM run_points WHERE org_id = $1 AND run_id = $2', [
      ids.orgA,
      runIds.contract,
    ]);
    expect(points.rowCount).toBe(0);

    // The ordinary active-run invariants apply to the reused ID.
    await putRun(ownerAuthentication, runIds.contract).expect(200);
    expect(
      errorCode(
        await putRun(ownerAuthentication, runIds.contract, '2031-01-02T00:00:00.000Z').expect(409),
      ),
    ).toBe('ACTIVE_RUN_EXISTS');
    expect(errorCode(await putRun(ownerAuthentication, runIds.other).expect(409))).toBe(
      'ACTIVE_RUN_EXISTS',
    );

    // A newer deletion of the reused ID receives its own full protection window.
    await deleteRun(ownerAuthentication, runIds.contract).expect(204);
    const renewed = await tombstoneRow(runIds.contract);
    expect(renewed?.expires_at.toISOString()).toBe(oneYearLater);
    expect(errorCode(await putRun(ownerAuthentication, runIds.contract).expect(410))).toBe(
      'RUN_DELETED',
    );
  });

  it('keeps protecting an expired but unreclaimed marker and still hides it from other members', async () => {
    // Cleanup is overdue by 100 days: protection can only be longer, never shorter.
    await insertTombstone(runIds.delayed, '2030-06-01T00:00:00.000Z', '2031-10-01T00:00:00.000Z');

    expect(errorCode(await putRun(ownerAuthentication, runIds.delayed).expect(410))).toBe(
      'RUN_DELETED',
    );
    expect(errorCode(await getRun(ownerAuthentication, runIds.delayed).expect(410))).toBe(
      'RUN_DELETED',
    );
    await deleteRun(ownerAuthentication, runIds.delayed).expect(204);

    expect(errorCode(await getRun(strangerAuthentication, runIds.delayed).expect(404))).toBe(
      'RUN_NOT_FOUND',
    );
    expect(errorCode(await deleteRun(strangerAuthentication, runIds.delayed).expect(404))).toBe(
      'RUN_NOT_FOUND',
    );
    expect(await tombstoneCount()).toBe(1);
  });

  it('reclaims only expired markers, oldest first, in bounded batches that are safe to retry', async () => {
    await ownerPool.query(
      `INSERT INTO run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
       SELECT $1,
              ('a7400000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $2,
              '2030-01-01T00:00:00.000Z'::timestamptz,
              '2031-01-01T00:00:00.000Z'::timestamptz + n * interval '1 second'
       FROM generate_series(1, 501) AS n`,
      [ids.orgA, ids.userDual],
    );
    await insertTombstone(runIds.active, '2032-01-01T00:00:00.000Z', '2033-01-01T00:00:00.000Z');

    await expect(runTombstoneReclaimOnce(maintenancePool, at(appNow))).resolves.toEqual({
      reclaimedCount: 500,
      status: 'reclaimed',
    });
    const remaining = await ownerPool.query<{ run_id: string }>(
      'SELECT run_id FROM run_tombstones ORDER BY expires_at',
    );
    expect(remaining.rows.map((row) => row.run_id)).toEqual([
      'a7400000-0000-4000-9000-0000000001f5',
      runIds.active,
    ]);

    await expect(runTombstoneReclaimOnce(maintenancePool, at(appNow))).resolves.toEqual({
      reclaimedCount: 1,
      status: 'reclaimed',
    });
    // Retrying after completion is a harmless empty cycle; the unexpired marker survives.
    await expect(runTombstoneReclaimOnce(maintenancePool, at(appNow))).resolves.toEqual({
      status: 'idle',
    });
    await expect(runTombstoneReclaimOnce(maintenancePool, at(appNow))).resolves.toEqual({
      status: 'idle',
    });
    expect((await tombstoneRow(runIds.active))?.expires_at.toISOString()).toBe(
      '2033-01-01T00:00:00.000Z',
    );
  });

  it('honours a smaller function-level batch limit and takes the oldest markers first', async () => {
    await insertTombstone(runIds.active, '2030-01-01T00:00:00.000Z', '2031-03-01T00:00:00.000Z');
    await insertTombstone(runIds.boundary, '2030-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z');
    await insertTombstone(runIds.other, '2030-01-01T00:00:00.000Z', '2031-02-01T00:00:00.000Z');

    expect(await reclaim(maintenancePool, appNow, 2)).toBe(2);
    expect(await tombstoneRow(runIds.boundary)).toBeUndefined();
    expect(await tombstoneRow(runIds.other)).toBeUndefined();
    expect(await tombstoneRow(runIds.active)).toBeDefined();
  });

  it('applies nothing when the surrounding transaction rolls back', async () => {
    await insertTombstone(runIds.active, '2030-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z');
    await insertTombstone(runIds.other, '2030-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z');

    const client = await maintenancePool.connect();
    try {
      await client.query('BEGIN');
      expect(await reclaim(client, appNow)).toBe(2);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await tombstoneCount()).toBe(2);
    expect(await reclaim(maintenancePool, appNow)).toBe(2);
  });

  it('never lets two workers reclaim the same marker', async () => {
    await ownerPool.query(
      `INSERT INTO run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
       SELECT $1,
              ('a7400000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $2,
              '2030-01-01T00:00:00.000Z'::timestamptz,
              '2031-01-01T00:00:00.000Z'::timestamptz
       FROM generate_series(1, 3) AS n`,
      [ids.orgA, ids.userDual],
    );

    // Deterministic: while the first worker holds its claim uncommitted, the
    // second neither waits for it nor takes any of the same markers.
    const first = await maintenancePool.connect();
    try {
      await first.query('BEGIN');
      expect(await reclaim(first, appNow)).toBe(3);
      expect(await reclaim(maintenancePool, appNow)).toBe(0);
      await first.query('COMMIT');
    } finally {
      first.release();
    }
    expect(await tombstoneCount()).toBe(0);

    // Concurrent workers together remove each marker exactly once.
    await ownerPool.query(
      `INSERT INTO run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
       SELECT $1,
              ('a7400000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid,
              $2,
              '2030-01-01T00:00:00.000Z'::timestamptz,
              '2031-01-01T00:00:00.000Z'::timestamptz
       FROM generate_series(1, 40) AS n`,
      [ids.orgA, ids.userDual],
    );
    const results = await Promise.all([
      runTombstoneReclaimOnce(maintenancePool, at(appNow)),
      runTombstoneReclaimOnce(maintenancePool, at(appNow)),
      runTombstoneReclaimOnce(maintenancePool, at(appNow)),
    ]);
    const total = results.reduce(
      (sum, result) => sum + (result.status === 'reclaimed' ? result.reclaimedCount : 0),
      0,
    );
    expect(total).toBe(40);
    expect(await tombstoneCount()).toBe(0);
  });

  it('orders a create around an in-flight reclaim without a resurrection window', async () => {
    await insertTombstone(runIds.createRace, '2030-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z');
    const clock = new FixedClock();
    const create = () =>
      withTenantTransaction(runtimePool, { orgId: ids.orgA, userId: ids.userDual }, (client) =>
        createRun(
          client,
          { userId: ids.userDual },
          ids.orgA,
          runIds.createRace,
          { startedAt: '2031-01-01T00:00:00.000Z' },
          clock,
        ),
      );

    const worker = await maintenancePool.connect();
    try {
      await worker.query('BEGIN');
      expect(await reclaim(worker, appNow)).toBe(1);

      // The reclaim is not committed, so the marker is still authoritative.
      await expect(create()).rejects.toMatchObject({ code: 'RUN_DELETED', statusCode: 410 });
      expect(await tombstoneRow(runIds.createRace)).toBeDefined();

      await worker.query('COMMIT');
    } catch (error) {
      await worker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      worker.release();
    }

    await expect(create()).resolves.toMatchObject({ created: true });
    // A late reclaim retry cannot touch the recreated run or invent a marker.
    expect(await reclaim(maintenancePool, appNow)).toBe(0);
    const run = await ownerPool.query('SELECT 1 FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      runIds.createRace,
    ]);
    expect(run.rowCount).toBe(1);
  });

  describe('marker takeover when a deletion meets an existing marker', () => {
    // A run ID is unique per organization, but the tombstone SELECT policy is
    // owner-scoped, so another member's PUT may create a live run under an ID
    // that still carries someone else's marker. Deleting that run must work.
    async function seedCollision(): Promise<void> {
      await insertTombstone(runIds.takeover, '2030-06-01T00:00:00.000Z', '2031-06-01T00:00:00.000Z');
      await seedRun(runIds.takeover, { ownerId: ids.userStranger });
    }

    it('lets a deletion that waits behind a reclaim insert a fresh marker instead of failing', async () => {
      await seedCollision();
      const worker = await maintenancePool.connect();
      let deletion: ReturnType<typeof openOwnerDeletion> | undefined;
      try {
        await worker.query('BEGIN');
        expect(await reclaim(worker, appNow)).toBe(1);
        const workerPid = await backendPid(worker);

        deletion = openOwnerDeletion(runIds.takeover, ids.userStranger);
        await waitUntilBlocking(workerPid);
        await worker.query('COMMIT');
      } catch (error) {
        await worker.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        worker.release();
      }

      const opened = await deletion;
      try {
        expect(opened.outcome).toBe('deleted');
        await opened.client.query('COMMIT');
      } finally {
        opened.client.release();
      }

      expect(await tombstoneCount()).toBe(1);
      const marker = await tombstoneRow(runIds.takeover);
      expect(marker?.owner_user_id).toBe(ids.userStranger);
      expect(marker?.deleted_at.toISOString()).toBe(appNow);
      expect(marker?.expires_at.toISOString()).toBe(oneYearLater);
    });

    it('never reclaims a marker that a newer deletion just extended', async () => {
      await seedCollision();
      const opened = await openOwnerDeletion(runIds.takeover, ids.userStranger);
      try {
        expect(opened.outcome).toBe('deleted');
        // The takeover is uncommitted and holds the row: the worker skips it.
        expect(await reclaim(maintenancePool, appNow)).toBe(0);
        await opened.client.query('COMMIT');
      } finally {
        opened.client.release();
      }

      // Committed: the old expiry no longer applies, only the extended one.
      expect(await reclaim(maintenancePool, appNow)).toBe(0);
      const marker = await tombstoneRow(runIds.takeover);
      expect(marker?.owner_user_id).toBe(ids.userStranger);
      expect(marker?.expires_at.toISOString()).toBe(oneYearLater);
      expect(await reclaim(maintenancePool, oneYearLater)).toBe(1);
    });

    it('does not shorten an existing longer protection window on takeover', async () => {
      await insertTombstone(runIds.takeover, '2030-06-01T00:00:00.000Z', '2040-06-01T00:00:00.000Z');
      await seedRun(runIds.takeover, { ownerId: ids.userStranger });

      await deleteRun(strangerAuthentication, runIds.takeover).expect(204);
      const marker = await tombstoneRow(runIds.takeover);
      expect(marker?.owner_user_id).toBe(ids.userStranger);
      expect(marker?.expires_at.toISOString()).toBe('2040-06-01T00:00:00.000Z');
    });

    it('does not wedge annual retention on a pre-existing marker for the same ID', async () => {
      await insertTombstone(
        runIds.retentionTakeover,
        '2029-01-01T00:00:00.000Z',
        '2030-01-01T00:00:00.000Z',
      );
      await seedRun(runIds.retentionTakeover, {
        finishedAt: '2030-01-01T00:00:00.000Z',
        ownerId: ids.userStranger,
      });

      await expect(
        runRetentionDeleteOnce(maintenancePool, new FixedClock()),
      ).resolves.toMatchObject({ runId: runIds.retentionTakeover, status: 'deleted' });
      const marker = await tombstoneRow(runIds.retentionTakeover);
      expect(marker?.owner_user_id).toBe(ids.userStranger);
      expect(marker?.expires_at.toISOString()).toBe(oneYearLater);
    });
  });
});
