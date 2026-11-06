import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apiErrorResponseSchema } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createActivity } from '../src/activities/activity-service.js';
import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import { createFileDeletionJournalSink } from '../src/maintenance/deletion-journal-sink.js';
import { runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { loadErasureLedger, reapplyErasures } from '../src/restore/reapply-erasures.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0073 against the real roles: the erasure ledger (trigger, privileges, failure behaviour, export, replay) and the
// per-owner idempotency key constraint. Restoring an actual backup is covered by the restore drill.
const allowedOrigin = 'http://127.0.0.1:5173';
const activity = (n: number) => `ae000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const createdAt = '2026-10-05T08:00:00.123456Z';
const recreatedAt = '2026-10-06T09:30:00.654321Z';

interface LedgerRow {
  entity_type: string;
  erased_at: Date;
  org_id: string;
  owner_user_id: string;
  record_created_at: string;
  record_id: string;
}

describe('ADR-0073 erasure ledger and idempotency keys', () => {
  let app: ReturnType<typeof createApp>;
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let owner: { cookie: string; csrfToken: string };
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  const directories: string[] = [];

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    const config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: ids.userOrgA,
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 3 });
    ownerPool = new Pool({ application_name: 'running-tracker-integrity-owner', connectionString: integration.migration.connectionString, max: 2 });
    maintenancePool = new Pool({ application_name: 'running-tracker-integrity-maintenance', connectionString: integration.maintenance.connectionString, max: 2 });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    app = createApp({
      clock: systemClock,
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock: systemClock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      }),
    });
    const session = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId: ids.userOrgA }).expect(201);
    const header = session.headers['set-cookie'] as unknown as string[];
    owner = { cookie: header[0]!.split(';', 1)[0]!, csrfToken: (session.body as { csrf: { token: string } }).csrf.token };
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await ownerPool?.query('ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS test_refuse_every_entry').catch(() => undefined);
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    for (const directory of directories) await rm(directory, { force: true, recursive: true });
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  async function insertActivity(id: string, options: { createdAt?: string; key?: string | null; orgId?: string; userId?: string } = {}) {
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, notes, idempotency_key, created_at)
       VALUES ($1, $2, $3, 'swim', '2026-10-05T06:00:00Z', 1800, 'private note', $4, $5)`,
      [options.orgId ?? ids.orgA, id, options.userId ?? ids.userOrgA, options.key ?? null, options.createdAt ?? createdAt],
    );
  }

  const ledger = async (): Promise<LedgerRow[]> =>
    (
      await ownerPool.query<LedgerRow>(
        `SELECT entity_type, org_id, record_id, owner_user_id,
                to_char(record_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS record_created_at,
                erased_at
         FROM erasure_ledger ORDER BY ledger_seq`,
      )
    ).rows;

  const activityIds = async (): Promise<string[]> =>
    (await ownerPool.query<{ id: string }>('SELECT id FROM activities ORDER BY id')).rows.map((row) => row.id);

  const deleteAsOwner = (id: string) =>
    withTenantTransaction(runtimePool, { orgId: ids.orgA, userId: ids.userOrgA }, (client) =>
      client.query('DELETE FROM activities WHERE id = $1', [id]),
    );

  const deleteOverHttp = (id: string) =>
    request(app)
      .delete(`/api/orgs/${ids.orgA}/activities/${id}`)
      .set('Cookie', owner.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, owner.csrfToken);

  async function freshDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'rt-erasure-'));
    directories.push(directory);
    return directory;
  }

  describe('recording erasures', () => {
    it('writes one ledger row per erased activity, in the deleting statement, with identifiers and timestamps only', async () => {
      await insertActivity(activity(1));
      const before = Date.now();
      await deleteAsOwner(activity(1));
      const rows = await ledger();
      expect(rows).toEqual([
        {
          entity_type: 'activity',
          erased_at: expect.any(Date) as Date,
          org_id: ids.orgA,
          owner_user_id: ids.userOrgA,
          record_created_at: createdAt,
          record_id: activity(1),
        },
      ]);
      expect(rows[0]!.erased_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      const columns = await ownerPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'erasure_ledger' ORDER BY column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'entity_type',
        'erased_at',
        'ledger_seq',
        'org_id',
        'owner_user_id',
        'record_created_at',
        'record_id',
      ]);
    });

    it('records the erasure on every path: the API, the owner as the runtime role, and the object owner', async () => {
      await insertActivity(activity(2));
      await insertActivity(activity(3));
      await insertActivity(activity(4));
      await deleteOverHttp(activity(2)).expect(204);
      await deleteAsOwner(activity(3));
      await ownerPool.query('DELETE FROM activities WHERE id = $1', [activity(4)]);
      expect((await ledger()).map((row) => row.record_id)).toEqual([activity(2), activity(3), activity(4)]);
    });

    it('records nothing for a deletion that rolls back or deletes no row', async () => {
      await insertActivity(activity(5));
      const client = await runtimePool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ids.userOrgA, ids.orgA]);
        await client.query('DELETE FROM activities WHERE id = $1', [activity(5)]);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      await deleteOverHttp(activity(99)).expect(204);
      expect(await ledger()).toEqual([]);
      expect(await activityIds()).toEqual([activity(5)]);
    });

    it('fails the deletion, keeps the activity and answers 500 when the ledger cannot be written; a retry succeeds once it can', async () => {
      await insertActivity(activity(6));
      // Make every new ledger entry fail, as a full disk or a broken ledger would.
      await ownerPool.query('ALTER TABLE erasure_ledger ADD CONSTRAINT test_refuse_every_entry CHECK (false) NOT VALID');
      try {
        const failed = await deleteOverHttp(activity(6)).expect(500);
        expect(apiErrorResponseSchema.parse(failed.body).error.code).toBe('INTERNAL_ERROR');
        await expect(deleteAsOwner(activity(6))).rejects.toThrow(/test_refuse_every_entry/u);
        await expect(ownerPool.query('DELETE FROM activities WHERE id = $1', [activity(6)])).rejects.toThrow(/test_refuse_every_entry/u);
        expect(await activityIds()).toEqual([activity(6)]);
        expect(await ledger()).toEqual([]);
      } finally {
        await ownerPool.query('ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS test_refuse_every_entry');
      }
      await deleteOverHttp(activity(6)).expect(204);
      expect(await activityIds()).toEqual([]);
      expect((await ledger()).map((row) => row.record_id)).toEqual([activity(6)]);
    });

    it('gives the application roles no access to the ledger or the replay, and maintenance only claim and acknowledge', async () => {
      await insertActivity(activity(7));
      await deleteAsOwner(activity(7));
      const denied = /permission denied/u;
      await expect(
        withTenantTransaction(runtimePool, { orgId: ids.orgA, userId: ids.userOrgA }, (client) => client.query('SELECT * FROM erasure_ledger')),
      ).rejects.toThrow(denied);
      await expect(
        withTenantTransaction(runtimePool, { orgId: ids.orgA, userId: ids.userOrgA }, (client) => client.query('DELETE FROM erasure_ledger')),
      ).rejects.toThrow(denied);
      await expect(maintenancePool.query('SELECT * FROM erasure_ledger')).rejects.toThrow(denied);
      await expect(maintenancePool.query('DELETE FROM erasure_ledger')).rejects.toThrow(denied);
      const privileges = await ownerPool.query<{ claim: boolean; reapply: boolean; role: string; trigger_fn: boolean }>(
        `SELECT role,
                has_function_privilege(role, 'app_private.reapply_erasure(text, uuid, uuid, uuid, timestamptz)', 'EXECUTE') AS reapply,
                has_function_privilege(role, 'app_private.claim_erasure_ledger_batch(integer)', 'EXECUTE') AS claim,
                has_function_privilege(role, 'app_private.record_activity_erasure()', 'EXECUTE') AS trigger_fn
         FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role ORDER BY role`,
      );
      expect(privileges.rows).toEqual([
        { claim: true, reapply: false, role: 'running_tracker_maintenance', trigger_fn: false },
        { claim: false, reapply: false, role: 'running_tracker_runtime', trigger_fn: false },
      ]);
      expect(await ledger()).toHaveLength(1);
    });
  });

  describe('export and replay', () => {
    it('exports entries off the database with microseconds intact, and removes them only after a durable write', async () => {
      await insertActivity(activity(10));
      await insertActivity(activity(11), { createdAt: recreatedAt });
      await deleteAsOwner(activity(10));
      await deleteAsOwner(activity(11));

      const failing = { write: () => Promise.reject(new Error('mount unavailable')) };
      await expect(runErasureLedgerExportOnce(maintenancePool, failing, systemClock)).rejects.toThrow('mount unavailable');
      expect(await ledger()).toHaveLength(2);

      const directory = await freshDirectory();
      const sink = createFileDeletionJournalSink(directory);
      const result = await runErasureLedgerExportOnce(maintenancePool, sink, systemClock);
      expect(result).toMatchObject({ exportedCount: 2, status: 'exported' });
      expect(await ledger()).toEqual([]);
      expect(await runErasureLedgerExportOnce(maintenancePool, sink, systemClock)).toEqual({ status: 'idle' });

      const loaded = await loadErasureLedger(directory);
      expect(loaded.files).toBe(1);
      expect(loaded.entries.map(({ entityType, ownerUserId, recordCreatedAt, recordId }) => ({ entityType, ownerUserId, recordCreatedAt, recordId }))).toEqual([
        { entityType: 'activity', ownerUserId: ids.userOrgA, recordCreatedAt: createdAt, recordId: activity(10) },
        { entityType: 'activity', ownerUserId: ids.userOrgA, recordCreatedAt: recreatedAt, recordId: activity(11) },
      ]);
    });

    it('replays exported erasures idempotently, skips a record that reused the id, and journals what it erased again', async () => {
      // Erase three activities and export the ledger, as a node would before it is lost.
      for (const n of [20, 21, 22]) await insertActivity(activity(n));
      for (const n of [20, 21, 22]) await deleteAsOwner(activity(n));
      const directory = await freshDirectory();
      await runErasureLedgerExportOnce(maintenancePool, createFileDeletionJournalSink(directory), systemClock);

      // A restored backup brings back 20 exactly as it was; 21 is not in it; 22 was later created again under its id.
      await insertActivity(activity(20));
      await insertActivity(activity(22), { createdAt: recreatedAt });
      await insertActivity(activity(23));
      const journal = await loadErasureLedger(directory);

      const first = await reapplyErasures(ownerPool, journal);
      expect(first).toEqual({ entries: 3, files: 1, outcomes: { absent: 1, erased: 1, skipped_different_record: 1 } });
      expect(await activityIds()).toEqual([activity(22), activity(23)]);
      // The replayed erasure is journaled again, so the recovered node exports it too.
      expect((await ledger()).map((row) => [row.record_id, row.record_created_at])).toEqual([[activity(20), createdAt]]);

      const second = await reapplyErasures(ownerPool, journal);
      expect(second).toEqual({ entries: 3, files: 1, outcomes: { absent: 2, erased: 0, skipped_different_record: 1 } });
      expect(await activityIds()).toEqual([activity(22), activity(23)]);
      expect(await ledger()).toHaveLength(1);
    });

    it('treats another owner as a different record', async () => {
      await insertActivity(activity(30), { userId: ids.userStranger });
      const outcome = await ownerPool.query<{ outcome: string }>(
        `SELECT app_private.reapply_erasure('activity', $1, $2, $3, $4) AS outcome`,
        [ids.orgA, activity(30), ids.userOrgA, createdAt],
      );
      expect(outcome.rows).toEqual([{ outcome: 'skipped_different_record' }]);
      expect(await activityIds()).toEqual([activity(30)]);
    });

    it('refuses an entity type it does not know instead of skipping it', async () => {
      await expect(
        ownerPool.query(`SELECT app_private.reapply_erasure('meal', $1, $2, $3, $4)`, [ids.orgA, activity(31), ids.userOrgA, createdAt]),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        ownerPool.query(
          `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
           VALUES ('meal', $1, $2, $3, now(), now())`,
          [ids.orgA, activity(31), ids.userOrgA],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'erasure_ledger_entity_type_known' });
    });
  });

  describe('idempotency key constraint', () => {
    const key = 'bf000000-0000-4000-8000-0000000000aa';

    it('allows one activity per key for each owner and organization', async () => {
      await insertActivity(activity(40), { key });
      await expect(insertActivity(activity(41), { key })).rejects.toMatchObject({
        code: '23505',
        constraint: 'activities_owner_idempotency_key_unique',
      });
      // Another owner in the same organization, and the same person in another organization, are independent.
      await insertActivity(activity(42), { key, userId: ids.userStranger });
      await insertActivity(activity(43), { key, orgId: ids.orgB, userId: ids.userDual });
      await insertActivity(activity(44), { key, userId: ids.userDual });
      expect(await activityIds()).toEqual([activity(40), activity(42), activity(43), activity(44)]);
    });

    it('settles a real race between two saves of one form session to one activity (the constraint does the work)', async () => {
      // Interleaved explicitly, so the race happens every time: A has inserted under the key but not committed when B
      // saves the same form session under another id. B's reads cannot see A's row yet; only the unique constraint makes
      // B's insert wait for A and then insert nothing, after which B finds A's row by key.
      const details = { durationS: 1_800, idempotencyKey: key, startedAt: '2026-10-05T06:00:00.000Z', type: 'run' as const };
      const session = { userId: ids.userOrgA };
      const begin = async () => {
        const client = await runtimePool.connect();
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ids.userOrgA, ids.orgA]);
        return client;
      };
      const first = await begin();
      const second = await begin();
      try {
        const a = await createActivity(first, session, ids.orgA, activity(47), details, systemClock);
        expect(a.created).toBe(true);
        const racing = createActivity(second, session, ids.orgA, activity(48), details, systemClock);
        // Give B time to reach its insert and wait on A.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await first.query('COMMIT');
        const b = await racing;
        await second.query('COMMIT');
        expect(b).toEqual({ activity: a.activity, created: false });
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
      expect(await activityIds()).toEqual([activity(47)]);
    });

    it('leaves rows without a key unconstrained', async () => {
      await insertActivity(activity(45));
      await insertActivity(activity(46));
      expect(await activityIds()).toEqual([activity(45), activity(46)]);
    });

    it('declares the constraint exactly', async () => {
      const definition = await ownerPool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'public.activities'::regclass AND conname = 'activities_owner_idempotency_key_unique'`,
      );
      expect(definition.rows).toEqual([{ definition: 'UNIQUE (org_id, user_id, idempotency_key)' }]);
    });
  });
});
