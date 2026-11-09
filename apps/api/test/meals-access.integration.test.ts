import {
  createMealRequestSchema,
  MEAL_NUTRITION_FIELDS,
  MEAL_NUTRITION_MAX,
  MEAL_TITLE_MAX_LENGTH,
  type MealNutritionField,
} from '@running-tracker/contracts';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0083: the meal log is owner-only health data with the access template of check-ins and movement (ADR-0074,
// ADR-0078), a database-generated identity, editable fields limited to type, title and the four values, and nutrition
// columns that refuse (never round) what the contract refuses. These checks run as the real runtime role (and the
// maintenance role) against migration 0039. People of the shared tenant fixture:
//   userOrgA        runner in org A, owns two entries and the runs shared with userDual
//   userDual        runner in org A holding history/live grants on userOrgA's runs; coach in org B holding a grant
//                   on userOrgB's run
//   userStranger    coach in org A without any grant, owns one entry
//   userInactive    inactive member of org A
//   userOrgB        runner in org B only, owns one entry there
const days = { first: '2026-10-04', second: '2026-10-05', other: '2026-10-06' } as const;

interface EntryRow {
  title: string;
  user_id: string;
}

const utcMicroseconds = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const columnOf: Record<MealNutritionField, string> = {
  carbohydrateG: 'carbohydrate_g',
  energyKcal: 'energy_kcal',
  fatG: 'fat_g',
  proteinG: 'protein_g',
};

describe('ADR-0083 meals ACL, constraints and erasure (migration 0039)', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 3 });
    ownerPool = new Pool({ application_name: 'running-tracker-meals-fixtures', connectionString: config.migration.connectionString, max: 2 });
    maintenancePool = new Pool({
      application_name: 'running-tracker-meals-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query(
      `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, energy_kcal, protein_g, carbohydrate_g, fat_g,
                          idempotency_key, creation_digest)
       VALUES
         ($1, $3, $6, 'Europe/Warsaw', 'breakfast', 'Porridge', 350.5, 12, 60, 0, gen_random_uuid(), sha256('a'::bytea)),
         ($1, $3, $7, 'Europe/Warsaw', 'snack', 'Coffee', NULL, NULL, NULL, NULL, gen_random_uuid(), sha256('b'::bytea)),
         ($1, $4, $6, 'UTC', 'lunch', 'Toast', 200, NULL, NULL, NULL, gen_random_uuid(), sha256('c'::bytea)),
         ($2, $5, $6, 'UTC', 'dinner', 'Rice', NULL, 5, NULL, NULL, gen_random_uuid(), sha256('d'::bytea))`,
      [ids.orgA, ids.orgB, ids.userOrgA, ids.userStranger, ids.userOrgB, days.first, days.second],
    );
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM weekly_insights').catch(() => undefined);
    await ownerPool?.query('DELETE FROM meals').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  const asRuntime = <Result>(orgId: string, userId: string, work: (client: PoolClient) => Promise<Result>) =>
    withTenantTransaction(runtimePool, { orgId, userId }, work);

  const label = (row: EntryRow) => `${row.user_id.slice(0, 8)}:${row.title}`;
  const ownerA = (title: string) => `${ids.userOrgA.slice(0, 8)}:${title}`;
  const strangerA = `${ids.userStranger.slice(0, 8)}:Toast`;
  const ownerB = `${ids.userOrgB.slice(0, 8)}:Rice`;
  const seeded = () => [ownerA('Coffee'), ownerA('Porridge'), strangerA, ownerB].sort();

  const readEntries = (orgId: string, userId: string) =>
    asRuntime(orgId, userId, async (client) => {
      const result = await client.query<EntryRow>('SELECT user_id, title FROM meals');
      return result.rows.map(label).sort();
    });

  const storedEntries = async () => (await ownerPool.query<EntryRow>('SELECT user_id, title FROM meals')).rows.map(label).sort();

  const insertAs = (orgId: string, userId: string, row: { orgId: string; userId: string; title?: string }) =>
    asRuntime(orgId, userId, (client) =>
      client.query(
        `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest)
         VALUES ($1, $2, $3, 'UTC', 'other', $4, gen_random_uuid(), sha256('x'::bytea))`,
        [row.orgId, row.userId, days.other, row.title ?? 'Inserted'],
      ),
    );

  it('shows each person only their own entries in the current organization', async () => {
    await expect(readEntries(ids.orgA, ids.userOrgA)).resolves.toEqual([ownerA('Coffee'), ownerA('Porridge')]);
    await expect(readEntries(ids.orgA, ids.userStranger)).resolves.toEqual([strangerA]);
    await expect(readEntries(ids.orgB, ids.userOrgB)).resolves.toEqual([ownerB]);
  });

  it('shows nothing to a run-sharing grantee, a coach, another organization, an inactive member or a foreign context', async () => {
    // userDual holds history and live grants on userOrgA's runs (and a coach grant in org B): they grant nothing here.
    await expect(readEntries(ids.orgA, ids.userDual)).resolves.toEqual([]);
    await expect(readEntries(ids.orgB, ids.userDual)).resolves.toEqual([]);
    await expect(readEntries(ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readEntries(ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(readEntries(ids.orgB, ids.userOrgA)).resolves.toEqual([]);
    await expect(readEntries(ids.orgA, ids.userPausedOwner)).resolves.toEqual([]);
  });

  it("answers a filter by someone else's owner, title or date with no row, not an error", async () => {
    const probe = (userId: string) =>
      asRuntime(ids.orgA, userId, async (client) => {
        const byOwner = await client.query('SELECT * FROM meals WHERE user_id = $1', [ids.userOrgA]);
        const byTitle = await client.query(`SELECT * FROM meals WHERE title = 'Porridge'`);
        const byDate = await client.query('SELECT * FROM meals WHERE local_date = $1', [days.second]);
        const counted = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM meals WHERE org_id = $1', [ids.orgA]);
        return [byOwner.rowCount, byTitle.rowCount, byDate.rowCount, counted.rows[0]?.count];
      });
    await expect(probe(ids.userDual)).resolves.toEqual([0, 0, 0, '0']);
    await expect(probe(ids.userStranger)).resolves.toEqual([0, 0, 0, '1']);
  });

  it('fails closed for missing and malformed contexts', async () => {
    const missing = await runtimePool.query<{ count: string }>('SELECT count(*)::text AS count FROM meals');
    expect(missing.rows[0]?.count).toBe('0');
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', 'invalid', true)");
      await client.query("SELECT set_config('app.org_id', 'invalid', true)");
      const malformed = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM meals');
      expect(malformed.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userOrgA]);
      const userOnly = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM meals');
      expect(userOnly.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('lets the owner insert a title-only entry with a generated id and manual source, edit the editable fields and delete it', async () => {
    const id = await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      const inserted = await client.query<{ energy_kcal: string | null; id: string; source: string }>(
        `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest)
         VALUES ($1, $2, $3, 'Europe/Warsaw', 'other', 'Apple', gen_random_uuid(), sha256('e'::bytea))
         RETURNING id, source, energy_kcal::text`,
        [ids.orgA, ids.userOrgA, days.other],
      );
      expect(inserted.rows[0]).toMatchObject({ energy_kcal: null, source: 'manual' });
      expect(inserted.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/u);
      const edited = await client.query(
        `UPDATE meals SET meal_type = 'snack', title = 'Green apple', energy_kcal = 0, protein_g = 0.3, carbohydrate_g = 25, fat_g = NULL
         WHERE id = $1`,
        [inserted.rows[0]!.id],
      );
      expect(edited.rowCount).toBe(1);
      return inserted.rows[0]!.id;
    });
    const stored = await ownerPool.query(
      `SELECT meal_type, title, energy_kcal::text, protein_g::text, carbohydrate_g::text, fat_g::text, time_zone, to_char(local_date, 'YYYY-MM-DD') AS local_date
       FROM meals WHERE id = $1`,
      [id],
    );
    expect(stored.rows).toEqual([
      {
        carbohydrate_g: '25',
        energy_kcal: '0',
        fat_g: null,
        local_date: days.other,
        meal_type: 'snack',
        protein_g: '0.3',
        time_zone: 'Europe/Warsaw',
        title: 'Green apple',
      },
    ]);
    const deleted = await asRuntime(ids.orgA, ids.userOrgA, (client) => client.query('DELETE FROM meals WHERE id = $1', [id]));
    expect(deleted.rowCount).toBe(1);
    expect(await storedEntries()).toEqual(seeded());
  });

  it('refuses inserting an entry for someone else, into another organization, or without an active membership', async () => {
    const rls = /row-level security/u;
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userStranger })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgB, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgB, ids.userDual, { orgId: ids.orgB, userId: ids.userOrgB })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userDual, { orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userInactive, { orgId: ids.orgA, userId: ids.userInactive })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgB, { orgId: ids.orgA, userId: ids.userOrgB })).rejects.toThrow(rls);
    expect(await storedEntries()).toEqual(seeded());
  });

  it('does not let a grantee, a coach, another organization or an inactive member update or delete an entry', async () => {
    const attempts: Array<[string, string]> = [
      [ids.orgA, ids.userDual],
      [ids.orgA, ids.userStranger],
      [ids.orgA, ids.userInactive],
      [ids.orgA, ids.userOrgB],
      [ids.orgB, ids.userDual],
    ];
    for (const [orgId, userId] of attempts) {
      const outcome = await asRuntime(orgId, userId, async (client) => {
        const owners = [[ids.userOrgA, ids.userOrgB]];
        const updated = await client.query(`UPDATE meals SET title = 'Changed' WHERE user_id = ANY($1::uuid[])`, owners);
        const deleted = await client.query('DELETE FROM meals WHERE user_id = ANY($1::uuid[])', owners);
        return [updated.rowCount, deleted.rowCount];
      });
      expect(outcome).toEqual([0, 0]);
    }
    expect(await storedEntries()).toEqual(seeded());
  });

  it('lets the runtime role write only the editable columns: never the id, owner, date, zone, source, key, digest or timestamps', async () => {
    const denied = /permission denied/u;
    const attempt = (sql: string, parameters: unknown[] = []) => asRuntime(ids.orgA, ids.userOrgA, (client) => client.query(sql, parameters));
    const immutable: Record<string, string> = {
      created_at: 'now()',
      creation_digest: `sha256('z'::bytea)`,
      id: 'gen_random_uuid()',
      idempotency_key: 'gen_random_uuid()',
      local_date: `'2026-10-01'`,
      org_id: `'${ids.orgB}'`,
      source: `'manual'`,
      time_zone: `'UTC'`,
      updated_at: 'now()',
      user_id: `'${ids.userStranger}'`,
    };
    for (const [column, value] of Object.entries(immutable)) {
      await expect(attempt(`UPDATE meals SET ${column} = ${value} WHERE title = 'Porridge'`)).rejects.toThrow(denied);
    }
    // The identity, the provenance and the instants are the database's to set.
    for (const [column, value] of [
      ['id', 'gen_random_uuid()'],
      ['source', `'manual'`],
      ['created_at', `'2026-01-01T00:00:00Z'`],
      ['updated_at', `'2026-01-01T00:00:00Z'`],
    ] as const) {
      await expect(
        attempt(
          `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest, ${column})
           VALUES ($1, $2, $3, 'UTC', 'other', 'x', gen_random_uuid(), sha256('x'::bytea), ${value})`,
          [ids.orgA, ids.userOrgA, days.other],
        ),
      ).rejects.toThrow(denied);
    }
    await expect(attempt('TRUNCATE meals')).rejects.toThrow(denied);
    expect(await storedEntries()).toEqual(seeded());
  });

  it('takes created_at and updated_at from the database clock and moves only updated_at on an edit', async () => {
    const before = await ownerPool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    await insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userOrgA, title: 'Timed' });
    const read = async () =>
      (
        await ownerPool.query<{ created_at: Date; id: string; updated_at: Date }>(
          `SELECT id, created_at, updated_at FROM meals WHERE title IN ('Timed', 'Retimed')`,
        )
      ).rows[0]!;
    const inserted = await read();
    expect(inserted.created_at.getTime()).toBeGreaterThanOrEqual(before.rows[0]!.now.getTime());
    expect(inserted.updated_at).toEqual(inserted.created_at);
    await asRuntime(ids.orgA, ids.userOrgA, (client) => client.query(`UPDATE meals SET title = 'Retimed' WHERE title = 'Timed'`));
    const edited = await read();
    expect(edited.id).toBe(inserted.id);
    expect(edited.created_at).toEqual(inserted.created_at);
    expect(edited.updated_at.getTime()).toBeGreaterThan(inserted.updated_at.getTime());
  });

  it('exposes nothing through joins from runs, run_shares or memberships', async () => {
    const joins = (orgId: string, userId: string) =>
      asRuntime(orgId, userId, async (client) => {
        const viaRuns = await client.query(
          'SELECT meal.title FROM runs AS run JOIN meals AS meal ON meal.org_id = run.org_id AND meal.user_id = run.user_id',
        );
        const viaShares = await client.query(
          `SELECT meal.title FROM run_shares AS share
           JOIN runs AS run ON run.org_id = share.org_id AND run.id = share.run_id
           JOIN meals AS meal ON meal.org_id = run.org_id AND meal.user_id = run.user_id`,
        );
        const viaMemberships = await client.query(
          `SELECT meal.title FROM memberships AS membership
           JOIN meals AS meal ON meal.org_id = membership.org_id AND meal.user_id = membership.user_id`,
        );
        const visibleRuns = await client.query('SELECT 1 FROM runs');
        return { viaMemberships: viaMemberships.rowCount, viaRuns: viaRuns.rowCount, viaShares: viaShares.rowCount, visibleRuns: visibleRuns.rowCount };
      });
    const grantee = await joins(ids.orgA, ids.userDual);
    expect(grantee.visibleRuns).toBeGreaterThan(0);
    expect(grantee).toMatchObject({ viaMemberships: 0, viaRuns: 0, viaShares: 0 });
    const coachB = await joins(ids.orgB, ids.userDual);
    expect(coachB.visibleRuns).toBeGreaterThan(0);
    expect(coachB).toMatchObject({ viaMemberships: 0, viaRuns: 0, viaShares: 0 });
  });

  it("removes the owner's access as soon as the membership is deactivated", async () => {
    await ownerPool.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readEntries(ids.orgA, ids.userOrgA)).resolves.toEqual([]);
    const changed = await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      const updated = await client.query(`UPDATE meals SET title = 'x'`);
      const deleted = await client.query('DELETE FROM meals');
      return [updated.rowCount, deleted.rowCount];
    });
    expect(changed).toEqual([0, 0]);
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(/row-level security/u);
    await ownerPool.query('UPDATE memberships SET active = true WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readEntries(ids.orgA, ids.userOrgA)).resolves.toHaveLength(2);
  });

  it('keeps the maintenance role without any access, TRUNCATE included', async () => {
    const denied = /permission denied/u;
    await expect(maintenancePool.query('SELECT * FROM meals')).rejects.toThrow(denied);
    await expect(maintenancePool.query('DELETE FROM meals')).rejects.toThrow(denied);
    await expect(maintenancePool.query(`UPDATE meals SET title = 'x'`)).rejects.toThrow(denied);
    await expect(maintenancePool.query('TRUNCATE meals')).rejects.toThrow(denied);
    const truncate = await ownerPool.query<{ any: boolean }>(
      `SELECT has_table_privilege('running_tracker_runtime', 'public.meals', 'TRUNCATE')
              OR has_table_privilege('running_tracker_maintenance', 'public.meals', 'TRUNCATE') AS any`,
    );
    expect(truncate.rows).toEqual([{ any: false }]);
  });

  it('declares exactly the intended RLS, policies, table and column privileges, keys, defaults and index', async () => {
    const relation = await ownerPool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.meals'::regclass`);
    expect(relation.rows).toEqual([{ relforcerowsecurity: false, relrowsecurity: true }]);

    const policies = await ownerPool.query(
      `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meals' ORDER BY policyname`,
    );
    expect(policies.rows).toEqual([
      { cmd: 'DELETE', policyname: 'meals_delete_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'INSERT', policyname: 'meals_insert_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'SELECT', policyname: 'meals_select_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'UPDATE', policyname: 'meals_update_owner', roles: ['running_tracker_runtime'] },
    ]);

    const tablePrivileges = await ownerPool.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'meals' AND grantee <> 'running_tracker_owner' ORDER BY grantee, privilege_type`,
    );
    expect(tablePrivileges.rows).toEqual([
      { grantee: 'running_tracker_runtime', privilege_type: 'DELETE' },
      { grantee: 'running_tracker_runtime', privilege_type: 'SELECT' },
    ]);

    const columnPrivileges = await ownerPool.query(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'meals' AND grantee = 'running_tracker_runtime' AND privilege_type IN ('INSERT', 'UPDATE')
       ORDER BY privilege_type, column_name`,
    );
    expect(columnPrivileges.rows).toEqual([
      ...[
        'carbohydrate_g',
        'creation_digest',
        'energy_kcal',
        'fat_g',
        'idempotency_key',
        'local_date',
        'meal_type',
        'org_id',
        'protein_g',
        'time_zone',
        'title',
        'user_id',
      ].map((column_name) => ({ column_name, privilege_type: 'INSERT' })),
      ...['carbohydrate_g', 'energy_kcal', 'fat_g', 'meal_type', 'protein_g', 'title'].map((column_name) => ({ column_name, privilege_type: 'UPDATE' })),
    ]);

    const keys = await ownerPool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'public.meals'::regclass AND contype IN ('p', 'u', 'f') ORDER BY conname`,
    );
    expect(keys.rows).toEqual([
      { conname: 'meals_owner_idempotency_key_unique', definition: 'UNIQUE (org_id, user_id, idempotency_key)' },
      {
        conname: 'meals_owner_membership_fk',
        definition: 'FOREIGN KEY (org_id, user_id) REFERENCES memberships(org_id, user_id) ON DELETE RESTRICT',
      },
      { conname: 'meals_pkey', definition: 'PRIMARY KEY (org_id, id)' },
    ]);
    const defaults = await ownerPool.query(
      `SELECT column_name, column_default, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meals' AND (column_default IS NOT NULL OR data_type = 'numeric') ORDER BY column_name`,
    );
    expect(defaults.rows).toEqual([
      { column_default: null, column_name: 'carbohydrate_g', data_type: 'numeric' },
      { column_default: 'clock_timestamp()', column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_default: null, column_name: 'energy_kcal', data_type: 'numeric' },
      { column_default: null, column_name: 'fat_g', data_type: 'numeric' },
      { column_default: 'gen_random_uuid()', column_name: 'id', data_type: 'uuid' },
      { column_default: null, column_name: 'protein_g', data_type: 'numeric' },
      { column_default: "'manual'::text", column_name: 'source', data_type: 'text' },
      { column_default: 'clock_timestamp()', column_name: 'updated_at', data_type: 'timestamp with time zone' },
    ]);
    // Unconstrained numeric: no type modifier that could round a value before the CHECK constraints run.
    const typmods = await ownerPool.query(
      `SELECT attname, format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = 'public.meals'::regclass AND attname IN ('energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g') ORDER BY attname`,
    );
    expect(typmods.rows.map((row: { type: string }) => row.type)).toEqual(['numeric', 'numeric', 'numeric', 'numeric']);
    const index = await ownerPool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'meals_owner_date_created_idx'`);
    expect(index.rows).toEqual([
      { indexdef: 'CREATE INDEX meals_owner_date_created_idx ON public.meals USING btree (org_id, user_id, local_date, created_at, id)' },
    ]);
  });

  describe('constraints', () => {
    const insertRow = (values: Record<string, unknown>, localDate: string = days.other) => {
      const row: Record<string, unknown> = { creation_digest: Buffer.alloc(32, 1), meal_type: 'other', time_zone: 'UTC', title: 'x', ...values };
      const columns = Object.keys(row);
      return ownerPool.query(
        `INSERT INTO meals (org_id, user_id, local_date, idempotency_key, ${columns.join(', ')})
         VALUES ($1, $2, $3, gen_random_uuid(), ${columns.map((_, index) => `$${index + 4}`).join(', ')})`,
        [ids.orgA, ids.userOrgA, localDate, ...columns.map((column) => row[column])],
      );
    };
    const violates = (constraint: string): unknown => expect.objectContaining({ code: '23514', constraint });

    it.each([
      ['meals_local_date_range', {}, '1999-12-31'],
      ['meals_local_date_range', {}, 'infinity'],
      ['meals_time_zone_shape', { time_zone: '' }, days.other],
      ['meals_time_zone_shape', { time_zone: '+01:00' }, days.other],
      ['meals_meal_type_known', { meal_type: 'brunch' }, days.other],
      ['meals_meal_type_known', { meal_type: 'Lunch' }, days.other],
      ['meals_title_shape', { title: '' }, days.other],
      ['meals_title_shape', { title: '   ' }, days.other],
      ['meals_title_shape', { title: ' \t\n\r' }, days.other],
      ['meals_title_shape', { title: 'a'.repeat(MEAL_TITLE_MAX_LENGTH + 1) }, days.other],
      ['meals_source_known', { source: 'barcode' }, days.other],
      ['meals_energy_kcal_range', { energy_kcal: -0.1 }, days.other],
      ['meals_energy_kcal_range', { energy_kcal: 20_000.1 }, days.other],
      ['meals_energy_kcal_range', { energy_kcal: 'NaN' }, days.other],
      ['meals_energy_kcal_range', { energy_kcal: 'Infinity' }, days.other],
      ['meals_energy_kcal_range', { energy_kcal: '-Infinity' }, days.other],
      ['meals_energy_kcal_precision', { energy_kcal: 412.55 }, days.other],
      ['meals_protein_g_range', { protein_g: 2_000.1 }, days.other],
      ['meals_protein_g_precision', { protein_g: 0.05 }, days.other],
      ['meals_carbohydrate_g_range', { carbohydrate_g: -1 }, days.other],
      ['meals_carbohydrate_g_precision', { carbohydrate_g: 10.25 }, days.other],
      ['meals_fat_g_range', { fat_g: 'NaN' }, days.other],
      ['meals_fat_g_precision', { fat_g: 1.01 }, days.other],
      ['meals_creation_digest_sha256', { creation_digest: Buffer.alloc(31) }, days.other],
      ['meals_times_finite', { created_at: 'infinity' }, days.other],
    ] as const)('%s rejects %j on %s', async (constraint, values, localDate) => {
      await expect(insertRow(values, localDate)).rejects.toEqual(violates(constraint));
    });

    it('accepts a title-only entry, the inclusive bounds and zero as a value, stored exactly as written', async () => {
      await insertRow({ title: 'Title only' }, '2000-01-01');
      await insertRow({ carbohydrate_g: 2_000, energy_kcal: 20_000, fat_g: 2_000, protein_g: 2_000, title: 'Upper' });
      // '0.0' as text: the value keeps the scale it was written with (no type modifier adds or removes one).
      await insertRow({ carbohydrate_g: 0, energy_kcal: 0, fat_g: '0.0', protein_g: 0.1, title: 'Lower' });
      const stored = await ownerPool.query(
        `SELECT title, energy_kcal::text, protein_g::text, carbohydrate_g::text, fat_g::text FROM meals
         WHERE title IN ('Title only', 'Upper', 'Lower') ORDER BY title`,
      );
      expect(stored.rows).toEqual([
        { carbohydrate_g: '0', energy_kcal: '0', fat_g: '0.0', protein_g: '0.1', title: 'Lower' },
        { carbohydrate_g: null, energy_kcal: null, fat_g: null, protein_g: null, title: 'Title only' },
        { carbohydrate_g: '2000', energy_kcal: '20000', fat_g: '2000', protein_g: '2000', title: 'Upper' },
      ]);
    });

    it('does not enforce a future-date bound in the database (the service owns it, ADR-0074)', async () => {
      await expect(insertRow({}, '2099-01-01')).resolves.toBeDefined();
    });

    it('allows a key once per owner and organization, and binds the owner to a membership of that organization', async () => {
      const key = '0b5e2f9e-9c1b-4f6e-8a3d-2b7c9d1e4f60';
      const keyed = (orgId: string, userId: string) =>
        ownerPool.query(
          `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest)
           VALUES ($1, $2, $3, 'UTC', 'other', 'Keyed', $4, sha256('k'::bytea))`,
          [orgId, userId, days.other, key],
        );
      await keyed(ids.orgA, ids.userOrgA);
      await expect(keyed(ids.orgA, ids.userOrgA)).rejects.toEqual(
        expect.objectContaining({ code: '23505', constraint: 'meals_owner_idempotency_key_unique' }),
      );
      // Another owner, or another organization of the same person: their own key space.
      await keyed(ids.orgA, ids.userStranger);
      await keyed(ids.orgB, ids.userOrgB);
      await expect(keyed(ids.orgA, ids.userOrgB)).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'meals_owner_membership_fk' }));
      await expect(ownerPool.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userStranger])).rejects.toEqual(
        expect.objectContaining({ code: '23503', constraint: 'meals_owner_membership_fk' }),
      );
    });
  });

  describe('contract and database agree on every value (through the runtime role)', () => {
    const insertValue = (column: string, value: string) =>
      asRuntime(ids.orgA, ids.userOrgA, (client) =>
        client.query<{ value: string }>(
          `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest, ${column})
           VALUES ($1, $2, $3, 'UTC', 'other', 'Parity', gen_random_uuid(), sha256('p'::bytea), $4::numeric)
           RETURNING ${column}::text AS value`,
          [ids.orgA, ids.userOrgA, days.other, value],
        ),
      );
    const updateValue = (column: string, value: string) =>
      asRuntime(ids.orgA, ids.userOrgA, (client) =>
        client.query(`UPDATE meals SET ${column} = $1::numeric WHERE title = 'Porridge'`, [value]),
      );

    it.each(MEAL_NUTRITION_FIELDS)('%s: the database accepts exactly the values the contract accepts, on insert and on update', async (field) => {
      const column = columnOf[field];
      const max = MEAL_NUTRITION_MAX[field];
      const minimal = { idempotencyKey: ids.orgA, localDate: days.other, mealType: 'other', timeZone: 'UTC', title: 'Parity' };
      // JSON numbers as the API receives them; the service sends String(value).
      const candidates = [0, -0, 0.1, 0.2, 0.3, 1.1, 12.5, 12.55, 12.49, 0.05, 1e-7, -0.01, -0.1, max - 0.1, max, max + 0.1, max + 0.01, max + 1];
      for (const value of candidates) {
        const api = createMealRequestSchema.safeParse({ ...minimal, [field]: value }).success;
        const inserted = await insertValue(column, String(value)).then(
          (result) => result.rows[0]!.value,
          (error: unknown) => {
            expect(error).toEqual(expect.objectContaining({ code: '23514' }));
            return null;
          },
        );
        expect([value, inserted !== null]).toEqual([value, api]);
        // What was accepted is stored as sent: never rounded.
        if (inserted !== null) expect(Number(inserted)).toBe(value === 0 ? 0 : value);
        const updated = await updateValue(column, String(value)).then(
          () => true,
          (error: unknown) => {
            expect(error).toEqual(expect.objectContaining({ code: '23514' }));
            return false;
          },
        );
        expect([value, updated]).toEqual([value, api]);
        await ownerPool.query(`DELETE FROM meals WHERE title = 'Parity'`);
      }
      // A refused value left nothing rounded behind.
      const porridge = await ownerPool.query<{ value: string }>(`SELECT ${column}::text AS value FROM meals WHERE title = 'Porridge'`);
      expect(Number(porridge.rows[0]!.value)).toBe(max);
    });

    it('stores every title the contract accepts exactly; the contract refuses every title the database refuses', async () => {
      const minimal = { idempotencyKey: ids.orgA, localDate: days.other, mealType: 'other', timeZone: 'UTC' };
      const candidates = [
        'x',
        'Porridge with berries',
        'Śniadanie 🍓',
        ' padded ',
        'a'.repeat(MEAL_TITLE_MAX_LENGTH),
        '🍓'.repeat(MEAL_TITLE_MAX_LENGTH),
        'a'.repeat(MEAL_TITLE_MAX_LENGTH + 1),
        '🍓'.repeat(MEAL_TITLE_MAX_LENGTH + 1),
        '',
        ' ',
        '\t\n',
        // Unicode-only whitespace: the contract refuses it, the database (ASCII whitespace) would not. The stricter rule
        // is the contract's, so nothing the API stores can be refused by the database.
        '  ',
      ];
      for (const title of candidates) {
        const api = createMealRequestSchema.safeParse({ ...minimal, title }).success;
        const stored = await asRuntime(ids.orgA, ids.userOrgA, (client) =>
          client.query<{ title: string }>(
            `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest)
             VALUES ($1, $2, $3, 'UTC', 'other', $4, gen_random_uuid(), sha256('t'::bytea)) RETURNING title`,
            [ids.orgA, ids.userOrgA, days.other, title],
          ),
        ).then(
          (result) => result.rows[0]!.title,
          (error: unknown) => {
            expect(error).toEqual(expect.objectContaining({ code: '23514', constraint: 'meals_title_shape' }));
            return null;
          },
        );
        if (api) expect(stored).toBe(title);
        if (stored === null) expect([title, api]).toEqual([title, false]);
      }
      // NUL cannot reach PostgreSQL text at all; the contract refuses it before it could.
      expect(createMealRequestSchema.safeParse({ ...minimal, title: 'a\u0000b' }).success).toBe(false);
      await expect(
        asRuntime(ids.orgA, ids.userOrgA, (client) =>
          client.query(
            `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest)
             VALUES ($1, $2, $3, 'UTC', 'other', $4, gen_random_uuid(), sha256('t'::bytea))`,
            [ids.orgA, ids.userOrgA, days.other, 'a\u0000b'],
          ),
        ),
      ).rejects.toEqual(expect.objectContaining({ code: '22021' }));
    });
  });

  describe('erasure ledger (ADR-0073 extension point)', () => {
    interface LedgerRow {
      entity_type: string;
      org_id: string;
      owner_user_id: string;
      record_created_at: string;
      record_id: string;
    }
    const ledger = async () =>
      (
        await ownerPool.query<LedgerRow>(
          `SELECT entity_type, org_id, record_id, owner_user_id, ${utcMicroseconds('record_created_at')} AS record_created_at
           FROM erasure_ledger ORDER BY ledger_seq`,
        )
      ).rows;
    const version = async (title: string) =>
      (
        await ownerPool.query<{ created_at: string; id: string; key: string }>(
          `SELECT id, idempotency_key AS key, ${utcMicroseconds('created_at')} AS created_at FROM meals WHERE title = $1`,
          [title],
        )
      ).rows[0];
    const replay = (entry: { created_at: string; id: string }, owner: string = ids.userOrgA) =>
      ownerPool
        .query<{ outcome: string }>(`SELECT app_private.reapply_erasure('meal', $1, $2, $3, $4) AS outcome`, [ids.orgA, entry.id, owner, entry.created_at])
        .then((result) => result.rows[0]?.outcome);

    it('records each deleted entry, as its exact version and identifiers only, in the deleting statement; an edit records nothing', async () => {
      const porridge = (await version('Porridge'))!;
      const coffee = (await version('Coffee'))!;
      await asRuntime(ids.orgA, ids.userOrgA, (client) => client.query(`UPDATE meals SET energy_kcal = 1 WHERE title = 'Porridge'`));
      expect(await ledger()).toEqual([]);
      await asRuntime(ids.orgA, ids.userOrgA, (client) => client.query('DELETE FROM meals'));
      const byRecord = (left: LedgerRow, right: LedgerRow) => left.record_id.localeCompare(right.record_id);
      expect((await ledger()).sort(byRecord)).toEqual(
        [porridge, coffee]
          .map((row) => ({ entity_type: 'meal', org_id: ids.orgA, owner_user_id: ids.userOrgA, record_created_at: row.created_at, record_id: row.id }))
          .sort(byRecord),
      );
      // The ledger's columns cannot carry content, and no row of it mentions a title or a value.
      const columns = await ownerPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'erasure_ledger' ORDER BY column_name`,
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
      const text = JSON.stringify((await ownerPool.query('SELECT * FROM erasure_ledger')).rows);
      for (const content of ['Porridge', 'Coffee', '350.5', 'breakfast', 'snack']) expect(text).not.toContain(content);
    });

    it('fails the DELETE and keeps the entry when the ledger row cannot be written (deletion and outbox are atomic)', async () => {
      await ownerPool.query('ALTER TABLE erasure_ledger ADD CONSTRAINT test_refuse_meal_entry CHECK (false) NOT VALID');
      try {
        await expect(
          asRuntime(ids.orgA, ids.userOrgA, (client) => client.query(`DELETE FROM meals WHERE title = 'Porridge'`)),
        ).rejects.toThrow(/test_refuse_meal_entry/u);
      } finally {
        await ownerPool.query('ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS test_refuse_meal_entry');
      }
      expect(await storedEntries()).toEqual(seeded());
      expect(await ledger()).toEqual([]);
    });

    it('replays an erasure by exact version: erased, then absent; a different version or owner is left alone', async () => {
      const target = (await version('Porridge'))!;
      await expect(replay({ created_at: '2026-01-01T00:00:00.000000Z', id: target.id })).resolves.toBe('skipped_different_record');
      await expect(replay(target, ids.userStranger)).resolves.toBe('skipped_different_record');
      expect(await storedEntries()).toEqual(seeded());
      await expect(replay(target)).resolves.toBe('erased');
      expect(await storedEntries()).toEqual([ownerA('Coffee'), strangerA, ownerB].sort());
      // The replayed deletion is journaled again on this node.
      expect((await ledger()).map((row) => [row.entity_type, row.record_id])).toEqual([['meal', target.id]]);
      await expect(replay(target)).resolves.toBe('absent');
    });

    it('an entry deleted and logged again from the same form session is a new version that the old erasure cannot delete', async () => {
      const erased = (await version('Porridge'))!;
      await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
        await client.query(`DELETE FROM meals WHERE title = 'Porridge'`);
        // The deletion freed the key: the same form session may create the entry again.
        await client.query(
          `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest)
           VALUES ($1, $2, $3, 'UTC', 'breakfast', 'Porridge', $4, sha256('a'::bytea))`,
          [ids.orgA, ids.userOrgA, days.first, erased.key],
        );
      });
      const recreated = (await version('Porridge'))!;
      expect(recreated.key).toBe(erased.key);
      expect(recreated.id).not.toBe(erased.id);
      // clock_timestamp(): a different instant even inside the same transaction.
      expect(recreated.created_at).not.toBe(erased.created_at);
      await expect(replay(erased)).resolves.toBe('absent');
      expect(await version('Porridge')).toEqual(recreated);
      // A row that reused the erased id with another instant is another version too.
      await ownerPool.query(`DELETE FROM meals WHERE title = 'Porridge'`);
      await ownerPool.query(
        `INSERT INTO meals (org_id, id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest, created_at)
         VALUES ($1, $2, $3, $4, 'UTC', 'other', 'Reused id', gen_random_uuid(), sha256('r'::bytea), $5::timestamptz + interval '1 microsecond')`,
        [ids.orgA, erased.id, ids.userOrgA, days.first, erased.created_at],
      );
      await expect(replay(erased)).resolves.toBe('skipped_different_record');
      expect(await version('Reused id')).toBeDefined();
    });

    it('meal writes, edits, deletes and replays change no weekly insight and no insight source revision; a check-in replay still does', async () => {
      const seedInsight = (weekStart: string) =>
        ownerPool.query(
          `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision,
                                        model, prompt_version, policy_version, status)
           VALUES ($1, $2, $3::date, 'UTC', $3::date::timestamp AT TIME ZONE 'UTC', ($3::date + 7)::timestamp AT TIME ZONE 'UTC',
                   repeat('a', 64), coalesce((SELECT revision FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2), 0),
                   'fake', 'weekly-insight-v4', 'weekly-insight-policy-2', 'interrupted')`,
          [ids.orgA, ids.userOrgA, weekStart],
        );
      const state = async () =>
        (
          await ownerPool.query<{ insights: string | null; revision: string | null }>(
            `SELECT (SELECT string_agg(to_char(week_start, 'YYYY-MM-DD') || '@' || updated_at::text, ',' ORDER BY week_start) FROM weekly_insights
                     WHERE org_id = $1 AND user_id = $2) AS insights,
                    (SELECT revision::text FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2) AS revision`,
            [ids.orgA, ids.userOrgA],
          )
        ).rows[0];
      await seedInsight('2026-09-28'); // the week of both seeded entries
      await seedInsight('2026-10-05');
      const before = await state();
      expect(before?.insights).toMatch(/^2026-09-28@.*,2026-10-05@/u);

      const target = (await version('Porridge'))!;
      await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
        await client.query(`UPDATE meals SET title = 'Espresso', energy_kcal = 2 WHERE title = 'Coffee'`);
        await client.query(
          `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest)
           VALUES ($1, $2, $3, 'UTC', 'dinner', 'Pasta', gen_random_uuid(), sha256('q'::bytea))`,
          [ids.orgA, ids.userOrgA, days.other],
        );
        await client.query(`DELETE FROM meals WHERE title = 'Porridge'`);
      });
      expect(await state()).toEqual(before);
      // Restore the erased version, as a backup would hold it, and replay it twice.
      await ownerPool.query(
        `INSERT INTO meals (org_id, id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest, created_at)
         VALUES ($1, $2, $3, $4, 'UTC', 'breakfast', 'Porridge', $5, sha256('a'::bytea), $6)`,
        [ids.orgA, target.id, ids.userOrgA, days.first, target.key, target.created_at],
      );
      for (const expected of ['erased', 'absent']) {
        await expect(replay(target)).resolves.toBe(expected);
        expect(await state()).toEqual(before);
      }
      // The same replay of a check-in entry still invalidates the owner's insights (ADR-0076 unchanged).
      await ownerPool.query(`SELECT app_private.reapply_erasure('daily_metric', $1, $2, $3, '2000-01-01T00:00:00Z')`, [ids.orgA, target.id, ids.userOrgA]);
      const after = await state();
      expect(after?.insights).toBeNull();
      expect(after?.revision).not.toBe(before?.revision);
    });

    it('knows the meal entity type in the ledger and still refuses an unknown one', async () => {
      await ownerPool.query(
        `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
         VALUES ('meal', $1, $2, $3, now(), now())`,
        [ids.orgA, ids.userOrgA, ids.userOrgA],
      );
      for (const unknown of ['meals', 'food', 'meal_import']) {
        await expect(
          ownerPool.query(
            `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
             VALUES ($4, $1, $2, $3, now(), now())`,
            [ids.orgA, ids.userOrgA, ids.userOrgA, unknown],
          ),
        ).rejects.toEqual(expect.objectContaining({ code: '23514', constraint: 'erasure_ledger_entity_type_known' }));
        await expect(
          ownerPool.query(`SELECT app_private.reapply_erasure($4, $1, $2, $3, now())`, [ids.orgA, ids.userOrgA, ids.userOrgA, unknown]),
        ).rejects.toThrow(/unknown erasure entity type/u);
      }
    });
  });
});
