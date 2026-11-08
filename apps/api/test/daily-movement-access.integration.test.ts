import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0078: daily movement is owner-only health data with the access template of daily check-ins (ADR-0074): an
// UPDATE limited to the two value columns, and a provenance column the runtime role cannot write at all. These checks
// run as the real runtime role (and the maintenance role) against migrations 0033 and 0034. People of the shared
// tenant fixture:
//   userOrgA        runner in org A, owns two movement days and the runs shared with userDual
//   userDual        runner in org A holding history/live grants on userOrgA's runs; coach in org B holding a grant
//                   on userOrgB's run
//   userStranger    coach in org A without any grant, owns one day
//   userInactive    inactive member of org A
//   userOrgB        runner in org B only, owns one day there
const days = {
  ownerFirst: '2026-10-04',
  ownerSecond: '2026-10-05',
  other: '2026-10-06',
} as const;

interface DayRow {
  local_date: string;
  user_id: string;
}

const utcMicroseconds = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

describe('ADR-0078 daily_movement ACL (migration 0033)', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 3 });
    ownerPool = new Pool({
      application_name: 'running-tracker-daily-movement-fixtures',
      connectionString: config.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-daily-movement-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query(
      `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps, active_energy_kcal)
       VALUES
         ($1, $3, $6, 'Europe/Warsaw', 8042, 412.5),
         ($1, $3, $7, 'Europe/Warsaw', 0, NULL),
         ($1, $4, $6, 'UTC', NULL, 250.0),
         ($2, $5, $6, 'UTC', 12000, NULL)`,
      [ids.orgA, ids.orgB, ids.userOrgA, ids.userStranger, ids.userOrgB, days.ownerFirst, days.ownerSecond],
    );
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM weekly_insights').catch(() => undefined);
    await ownerPool?.query('DELETE FROM daily_movement').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  const asRuntime = <Result>(orgId: string, userId: string, work: (client: PoolClient) => Promise<Result>) =>
    withTenantTransaction(runtimePool, { orgId, userId }, work);

  const label = (row: DayRow) => `${row.user_id.slice(0, 8)}@${row.local_date}`;

  const readDays = (orgId: string, userId: string) =>
    asRuntime(orgId, userId, async (client) => {
      const result = await client.query<DayRow>(
        `SELECT user_id, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM daily_movement ORDER BY user_id, local_date`,
      );
      return result.rows.map(label);
    });

  const storedDays = async () =>
    (
      await ownerPool.query<DayRow>(
        `SELECT user_id, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM daily_movement ORDER BY org_id, user_id, local_date`,
      )
    ).rows.map(label);

  const insertAs = (orgId: string, userId: string, row: { orgId: string; userId: string; localDate?: string }) =>
    asRuntime(orgId, userId, (client) =>
      client.query(
        `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps) VALUES ($1, $2, $3, 'UTC', 100)`,
        [row.orgId, row.userId, row.localDate ?? days.other],
      ),
    );

  const ownerA = (date: string) => `${ids.userOrgA.slice(0, 8)}@${date}`;
  const strangerA = `${ids.userStranger.slice(0, 8)}@${days.ownerFirst}`;
  const ownerB = `${ids.userOrgB.slice(0, 8)}@${days.ownerFirst}`;
  const seeded = () => [ownerA(days.ownerFirst), ownerA(days.ownerSecond), strangerA, ownerB];

  it('shows each person only their own days in the current organization', async () => {
    await expect(readDays(ids.orgA, ids.userOrgA)).resolves.toEqual([ownerA(days.ownerFirst), ownerA(days.ownerSecond)]);
    await expect(readDays(ids.orgA, ids.userStranger)).resolves.toEqual([strangerA]);
    await expect(readDays(ids.orgB, ids.userOrgB)).resolves.toEqual([ownerB]);
  });

  it('shows nothing to a run-sharing grantee, a coach, another organization, an inactive member or a foreign context', async () => {
    // userDual holds history and live grants on userOrgA's runs: they grant nothing here.
    await expect(readDays(ids.orgA, ids.userDual)).resolves.toEqual([]);
    await expect(readDays(ids.orgB, ids.userDual)).resolves.toEqual([]);
    await expect(readDays(ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readDays(ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(readDays(ids.orgB, ids.userOrgA)).resolves.toEqual([]);
    await expect(readDays(ids.orgA, ids.userPausedOwner)).resolves.toEqual([]);
    expect(await readDays(ids.orgA, ids.userStranger)).not.toContain(ownerA(days.ownerFirst));
  });

  it("answers a filter by someone else's owner or date with no row, not an error", async () => {
    const probe = (userId: string) =>
      asRuntime(ids.orgA, userId, async (client) => {
        const byOwner = await client.query('SELECT * FROM daily_movement WHERE user_id = $1', [ids.userOrgA]);
        const byDate = await client.query('SELECT * FROM daily_movement WHERE local_date = $1', [days.ownerSecond]);
        const counted = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM daily_movement WHERE org_id = $1',
          [ids.orgA],
        );
        return [byOwner.rowCount, byDate.rowCount, counted.rows[0]?.count];
      });
    await expect(probe(ids.userDual)).resolves.toEqual([0, 0, '0']);
    await expect(probe(ids.userStranger)).resolves.toEqual([0, 0, '1']);
  });

  it('fails closed for missing and malformed contexts', async () => {
    const missing = await runtimePool.query<{ count: string }>('SELECT count(*)::text AS count FROM daily_movement');
    expect(missing.rows[0]?.count).toBe('0');
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', 'invalid', true)");
      await client.query("SELECT set_config('app.org_id', 'invalid', true)");
      const malformed = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM daily_movement');
      expect(malformed.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userOrgA]);
      const userOnly = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM daily_movement');
      expect(userOnly.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('lets the owner insert with RETURNING, replace the values of, and delete their own day; the source is manual', async () => {
    await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      const inserted = await client.query<{ local_date: string; source: string }>(
        `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps)
         VALUES ($1, $2, $3, 'Europe/Warsaw', 0)
         RETURNING to_char(local_date, 'YYYY-MM-DD') AS local_date, source`,
        [ids.orgA, ids.userOrgA, days.other],
      );
      expect(inserted.rows).toEqual([{ local_date: days.other, source: 'manual' }]);
      const replaced = await client.query(
        'UPDATE daily_movement SET steps = NULL, active_energy_kcal = 99.9 WHERE local_date = $1',
        [days.other],
      );
      expect(replaced.rowCount).toBe(1);
      // The upsert target names the source: the conflict is with the manual row of that day.
      const upserted = await client.query(
        `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps) VALUES ($1, $2, $3, 'UTC', 1)
         ON CONFLICT (org_id, user_id, local_date, source) DO UPDATE SET steps = EXCLUDED.steps`,
        [ids.orgA, ids.userOrgA, days.ownerFirst],
      );
      expect(upserted.rowCount).toBe(1);
      const deleted = await client.query('DELETE FROM daily_movement WHERE local_date = $1', [days.ownerSecond]);
      expect(deleted.rowCount).toBe(1);
    });
    expect(await storedDays()).toEqual([ownerA(days.ownerFirst), ownerA(days.other), strangerA, ownerB]);
    const stored = await ownerPool.query<{ active_energy_kcal: string; steps: number; time_zone: string }>(
      'SELECT steps, active_energy_kcal::text, time_zone FROM daily_movement WHERE user_id = $1 AND local_date = $2',
      [ids.userOrgA, days.ownerFirst],
    );
    // The upsert replaced one value and kept the other and the zone of the first write.
    expect(stored.rows).toEqual([{ active_energy_kcal: '412.5', steps: 1, time_zone: 'Europe/Warsaw' }]);
  });

  it('refuses inserting a day for someone else, into another organization, or without an active membership', async () => {
    const rls = /row-level security/u;
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userStranger })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgB, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgB, ids.userDual, { orgId: ids.orgB, userId: ids.userOrgB })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userDual, { orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userInactive, { orgId: ids.orgA, userId: ids.userInactive })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgB, { orgId: ids.orgA, userId: ids.userOrgB })).rejects.toThrow(rls);
    expect(await storedDays()).toEqual(seeded());
  });

  it('does not let a grantee, a coach, another organization or an inactive member update or delete a day', async () => {
    const attempts: Array<[string, string]> = [
      [ids.orgA, ids.userDual],
      [ids.orgA, ids.userStranger],
      [ids.orgA, ids.userInactive],
      [ids.orgA, ids.userOrgB],
      [ids.orgB, ids.userDual],
    ];
    for (const [orgId, userId] of attempts) {
      const outcome = await asRuntime(orgId, userId, async (client) => {
        const updated = await client.query('UPDATE daily_movement SET steps = 1 WHERE user_id = ANY($1::uuid[])', [
          [ids.userOrgA, ids.userOrgB],
        ]);
        const deleted = await client.query('DELETE FROM daily_movement WHERE user_id = ANY($1::uuid[])', [
          [ids.userOrgA, ids.userOrgB],
        ]);
        return [updated.rowCount, deleted.rowCount];
      });
      expect(outcome).toEqual([0, 0]);
    }
    expect(await storedDays()).toEqual(seeded());
    const steps = await ownerPool.query<{ steps: number | null }>(
      'SELECT steps FROM daily_movement WHERE user_id = $1 ORDER BY local_date',
      [ids.userOrgA],
    );
    expect(steps.rows).toEqual([{ steps: 8042 }, { steps: 0 }]);
  });

  it('lets the runtime role write only the value columns: never the id, owner, date, zone, source or timestamps', async () => {
    const denied = /permission denied/u;
    const attempt = (sql: string, parameters: unknown[] = []) =>
      asRuntime(ids.orgA, ids.userOrgA, (client) => client.query(sql, parameters));
    const values: Record<string, string> = {
      created_at: 'now()',
      id: `'${ids.userStranger}'`,
      local_date: `'2026-10-01'`,
      org_id: `'${ids.orgB}'`,
      source: `'manual'`,
      time_zone: `'UTC'`,
      updated_at: 'now()',
      user_id: `'${ids.userStranger}'`,
    };
    for (const [column, value] of Object.entries(values)) {
      await expect(attempt(`UPDATE daily_movement SET ${column} = ${value} WHERE local_date = $1`, [days.ownerFirst])).rejects.toThrow(
        denied,
      );
    }
    // Not even the one value that exists: the provenance is the database's to set, so a client cannot claim an import.
    for (const [column, value] of [
      ['id', `'${ids.userStranger}'`],
      ['source', `'manual'`],
      ['created_at', `'2026-01-01T00:00:00Z'`],
      ['updated_at', `'2026-01-01T00:00:00Z'`],
    ] as const) {
      await expect(
        attempt(
          `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps, ${column}) VALUES ($1, $2, $3, 'UTC', 1, ${value})`,
          [ids.orgA, ids.userOrgA, days.other],
        ),
      ).rejects.toThrow(denied);
    }
    await expect(attempt('TRUNCATE daily_movement')).rejects.toThrow(denied);
    expect(await storedDays()).toEqual(seeded());
  });

  it('takes created_at and updated_at from the database clock and moves only updated_at on a replacement', async () => {
    const before = await ownerPool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    await insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userOrgA });
    const read = async () =>
      (
        await ownerPool.query<{ created_at: Date; id: string; updated_at: Date }>(
          'SELECT id, created_at, updated_at FROM daily_movement WHERE user_id = $1 AND local_date = $2',
          [ids.userOrgA, days.other],
        )
      ).rows[0]!;
    const inserted = await read();
    expect(inserted.created_at.getTime()).toBeGreaterThanOrEqual(before.rows[0]!.now.getTime());
    await asRuntime(ids.orgA, ids.userOrgA, (client) =>
      client.query('UPDATE daily_movement SET steps = 5 WHERE local_date = $1', [days.other]),
    );
    const replaced = await read();
    expect(replaced.id).toBe(inserted.id);
    expect(replaced.created_at).toEqual(inserted.created_at);
    expect(replaced.updated_at.getTime()).toBeGreaterThan(inserted.updated_at.getTime());
  });

  it('exposes nothing through joins from runs, run_shares or memberships', async () => {
    const joins = (orgId: string, userId: string) =>
      asRuntime(orgId, userId, async (client) => {
        const viaRuns = await client.query(
          `SELECT movement.local_date FROM runs AS run
           JOIN daily_movement AS movement ON movement.org_id = run.org_id AND movement.user_id = run.user_id`,
        );
        const viaShares = await client.query(
          `SELECT movement.local_date FROM run_shares AS share
           JOIN runs AS run ON run.org_id = share.org_id AND run.id = share.run_id
           JOIN daily_movement AS movement ON movement.org_id = run.org_id AND movement.user_id = run.user_id`,
        );
        const viaMemberships = await client.query<{ user_id: string }>(
          `SELECT movement.user_id FROM memberships AS membership
           JOIN daily_movement AS movement ON movement.org_id = membership.org_id AND movement.user_id = membership.user_id`,
        );
        const visibleRuns = await client.query('SELECT 1 FROM runs');
        return {
          viaMemberships: viaMemberships.rows.map(({ user_id }) => user_id),
          viaRuns: viaRuns.rowCount,
          viaShares: viaShares.rowCount,
          visibleRuns: visibleRuns.rowCount,
        };
      });
    const grantee = await joins(ids.orgA, ids.userDual);
    expect(grantee.visibleRuns).toBeGreaterThan(0);
    expect(grantee).toMatchObject({ viaMemberships: [], viaRuns: 0, viaShares: 0 });
    const coachB = await joins(ids.orgB, ids.userDual);
    expect(coachB.visibleRuns).toBeGreaterThan(0);
    expect(coachB).toMatchObject({ viaMemberships: [], viaRuns: 0, viaShares: 0 });
  });

  it("removes the owner's access as soon as the membership is deactivated", async () => {
    await ownerPool.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readDays(ids.orgA, ids.userOrgA)).resolves.toEqual([]);
    const changed = await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      const updated = await client.query('UPDATE daily_movement SET steps = 1');
      const deleted = await client.query('DELETE FROM daily_movement');
      return [updated.rowCount, deleted.rowCount];
    });
    expect(changed).toEqual([0, 0]);
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(/row-level security/u);
    await ownerPool.query('UPDATE memberships SET active = true WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readDays(ids.orgA, ids.userOrgA)).resolves.toHaveLength(2);
  });

  it('keeps the maintenance role without any access, TRUNCATE included', async () => {
    const denied = /permission denied/u;
    await expect(maintenancePool.query('SELECT * FROM daily_movement')).rejects.toThrow(denied);
    await expect(maintenancePool.query('DELETE FROM daily_movement')).rejects.toThrow(denied);
    await expect(maintenancePool.query('UPDATE daily_movement SET steps = 1')).rejects.toThrow(denied);
    await expect(maintenancePool.query('TRUNCATE daily_movement')).rejects.toThrow(denied);
    await expect(
      maintenancePool.query(
        `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps) VALUES ($1, $2, $3, 'UTC', 1)`,
        [ids.orgA, ids.userOrgA, days.other],
      ),
    ).rejects.toThrow(denied);
    const truncate = await ownerPool.query<{ any: boolean }>(
      `SELECT has_table_privilege('running_tracker_runtime', 'public.daily_movement', 'TRUNCATE')
              OR has_table_privilege('running_tracker_maintenance', 'public.daily_movement', 'TRUNCATE') AS any`,
    );
    expect(truncate.rows).toEqual([{ any: false }]);
  });

  it('declares exactly the intended RLS, policies, table and column privileges and the owner/date/source key', async () => {
    const relation = await ownerPool.query<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.daily_movement'::regclass`,
    );
    expect(relation.rows).toEqual([{ relforcerowsecurity: false, relrowsecurity: true }]);

    const policies = await ownerPool.query<{ cmd: string; policyname: string; roles: string[] }>(
      `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'daily_movement' ORDER BY policyname`,
    );
    expect(policies.rows).toEqual([
      { cmd: 'DELETE', policyname: 'daily_movement_delete_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'INSERT', policyname: 'daily_movement_insert_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'SELECT', policyname: 'daily_movement_select_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'UPDATE', policyname: 'daily_movement_update_owner', roles: ['running_tracker_runtime'] },
    ]);

    const tablePrivileges = await ownerPool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'daily_movement' AND grantee <> 'running_tracker_owner'
       ORDER BY grantee, privilege_type`,
    );
    expect(tablePrivileges.rows).toEqual([
      { grantee: 'running_tracker_runtime', privilege_type: 'DELETE' },
      { grantee: 'running_tracker_runtime', privilege_type: 'SELECT' },
    ]);

    const columnPrivileges = await ownerPool.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'daily_movement' AND grantee = 'running_tracker_runtime'
         AND privilege_type IN ('INSERT', 'UPDATE')
       ORDER BY privilege_type, column_name`,
    );
    expect(columnPrivileges.rows).toEqual([
      ...['active_energy_kcal', 'local_date', 'org_id', 'steps', 'time_zone', 'user_id'].map((column_name) => ({
        column_name,
        privilege_type: 'INSERT',
      })),
      ...['active_energy_kcal', 'steps'].map((column_name) => ({ column_name, privilege_type: 'UPDATE' })),
    ]);

    const key = await ownerPool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'public.daily_movement'::regclass AND conname = 'daily_movement_owner_date_source_unique'`,
    );
    expect(key.rows).toEqual([{ definition: 'UNIQUE (org_id, user_id, local_date, source)' }]);
    const sourceDefault = await ownerPool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'daily_movement' AND column_name = 'source'`,
    );
    expect(sourceDefault.rows).toEqual([{ column_default: "'manual'::text" }]);
  });

  describe('constraints', () => {
    const insertRow = (values: Record<string, unknown>, localDate: string = days.other) => {
      const row: Record<string, unknown> = { steps: 100, time_zone: 'UTC', ...values };
      const columns = Object.keys(row);
      return ownerPool.query(
        `INSERT INTO daily_movement (org_id, user_id, local_date, ${columns.join(', ')})
         VALUES ($1, $2, $3, ${columns.map((_, index) => `$${index + 4}`).join(', ')})`,
        [ids.orgA, ids.userOrgA, localDate, ...columns.map((column) => row[column])],
      );
    };
    const violates = (constraint: string): unknown => expect.objectContaining({ code: '23514', constraint });

    it.each([
      ['daily_movement_local_date_range', {}, '1999-12-31'],
      ['daily_movement_local_date_range', {}, 'infinity'],
      ['daily_movement_time_zone_shape', { time_zone: '' }, days.other],
      ['daily_movement_time_zone_shape', { time_zone: '+01:00' }, days.other],
      ['daily_movement_source_known', { source: 'apple_health' }, days.other],
      ['daily_movement_source_known', { source: '' }, days.other],
      ['daily_movement_steps_range', { steps: -1 }, days.other],
      ['daily_movement_steps_range', { steps: 200_001 }, days.other],
      ['daily_movement_active_energy_range', { active_energy_kcal: -0.1 }, days.other],
      ['daily_movement_active_energy_range', { active_energy_kcal: 20_000.1 }, days.other],
      ['daily_movement_active_energy_range', { active_energy_kcal: 'NaN' }, days.other],
      ['daily_movement_some_value', { steps: null }, days.other],
      ['daily_movement_some_value', { active_energy_kcal: null, steps: null }, days.other],
      ['daily_movement_times_finite', { created_at: 'infinity' }, days.other],
    ] as const)('%s rejects %j on %s', async (constraint, values, localDate) => {
      await expect(insertRow(values, localDate)).rejects.toEqual(violates(constraint));
    });

    it('refuses infinite active energy whatever the cause (typmod overflow or the range check)', async () => {
      await expect(insertRow({ active_energy_kcal: 'Infinity' })).rejects.toBeDefined();
      expect(await storedDays()).toEqual(seeded());
    });

    it('accepts the inclusive bounds, zero as a value, and either value alone, stored exactly', async () => {
      await insertRow({ active_energy_kcal: 0, steps: 0 }, '2000-01-01');
      await insertRow({ active_energy_kcal: 20_000, steps: 200_000 }, '2026-10-07');
      await insertRow({ active_energy_kcal: 412.5, steps: null }, '2026-10-08');
      const stored = await ownerPool.query<{ active_energy_kcal: string | null; local_date: string; steps: number | null }>(
        `SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date, steps, active_energy_kcal::text
         FROM daily_movement WHERE user_id = $1 AND local_date IN ('2000-01-01', '2026-10-07', '2026-10-08') ORDER BY local_date`,
        [ids.userOrgA],
      );
      expect(stored.rows).toEqual([
        { active_energy_kcal: '0.0', local_date: '2000-01-01', steps: 0 },
        { active_energy_kcal: '20000.0', local_date: '2026-10-07', steps: 200_000 },
        { active_energy_kcal: '412.5', local_date: '2026-10-08', steps: null },
      ]);
    });

    it('does not enforce a future-date bound in the database (the service owns it, ADR-0074)', async () => {
      await expect(insertRow({}, '2099-01-01')).resolves.toBeDefined();
    });

    it('allows one manual day per owner and organization, and binds the owner to a membership of that organization', async () => {
      await expect(insertRow({}, days.ownerFirst)).rejects.toEqual(
        expect.objectContaining({ code: '23505', constraint: 'daily_movement_owner_date_source_unique' }),
      );
      // Another person, another organization: their own key.
      await expect(
        ownerPool.query(
          `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps) VALUES ($1, $2, $3, 'UTC', 1)`,
          [ids.orgA, ids.userOrgB, days.other],
        ),
      ).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'daily_movement_owner_membership_fk' }));
      await expect(
        ownerPool.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userStranger]),
      ).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'daily_movement_owner_membership_fk' }));
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
    const version = async (userId: string, date: string) =>
      (
        await ownerPool.query<{ created_at: string; id: string }>(
          `SELECT id, ${utcMicroseconds('created_at')} AS created_at FROM daily_movement WHERE user_id = $1 AND local_date = $2`,
          [userId, date],
        )
      ).rows[0];

    it('records each deleted day, as its exact version, in the deleting statement; a replacement records nothing', async () => {
      const first = (await version(ids.userOrgA, days.ownerFirst))!;
      const second = (await version(ids.userOrgA, days.ownerSecond))!;
      await asRuntime(ids.orgA, ids.userOrgA, (client) => client.query('UPDATE daily_movement SET steps = 9 WHERE local_date = $1', [days.ownerFirst]));
      expect(await ledger()).toEqual([]);
      await asRuntime(ids.orgA, ids.userOrgA, (client) => client.query('DELETE FROM daily_movement'));
      // One multi-row DELETE visits rows in physical order, so the two entries may come in either order.
      const byRecord = (left: LedgerRow, right: LedgerRow) => left.record_id.localeCompare(right.record_id);
      expect((await ledger()).sort(byRecord)).toEqual(
        [first, second].map((row) => ({
          entity_type: 'daily_movement',
          org_id: ids.orgA,
          owner_user_id: ids.userOrgA,
          record_created_at: row.created_at,
          record_id: row.id,
        })).sort(byRecord),
      );
    });

    it('fails the DELETE and keeps the day when the ledger row cannot be written', async () => {
      await ownerPool.query('ALTER TABLE erasure_ledger ADD CONSTRAINT test_refuse_movement_entry CHECK (false) NOT VALID');
      try {
        await expect(
          asRuntime(ids.orgA, ids.userOrgA, (client) => client.query('DELETE FROM daily_movement WHERE local_date = $1', [days.ownerFirst])),
        ).rejects.toThrow(/test_refuse_movement_entry/u);
      } finally {
        await ownerPool.query('ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS test_refuse_movement_entry');
      }
      expect(await storedDays()).toEqual(seeded());
      expect(await ledger()).toEqual([]);
    });

    it('replays an erasure by exact version: erased, then absent; a different version or owner is left alone', async () => {
      const target = (await version(ids.userOrgA, days.ownerFirst))!;
      const replay = (createdAt: string, ownerId: string, recordId: string = target.id) =>
        ownerPool
          .query<{ outcome: string }>(`SELECT app_private.reapply_erasure('daily_movement', $1, $2, $3, $4) AS outcome`, [
            ids.orgA,
            recordId,
            ownerId,
            createdAt,
          ])
          .then((result) => result.rows[0]?.outcome);
      await expect(replay('2026-01-01T00:00:00.000000Z', ids.userOrgA)).resolves.toBe('skipped_different_record');
      await expect(replay(target.created_at, ids.userStranger)).resolves.toBe('skipped_different_record');
      expect(await storedDays()).toEqual(seeded());
      await expect(replay(target.created_at, ids.userOrgA)).resolves.toBe('erased');
      expect(await storedDays()).toEqual([ownerA(days.ownerSecond), strangerA, ownerB]);
      // The replayed deletion is journaled again on this node.
      expect((await ledger()).map((row) => [row.entity_type, row.record_id])).toEqual([['daily_movement', target.id]]);
      await expect(replay(target.created_at, ids.userOrgA)).resolves.toBe('absent');
    });

    it('a day deleted and written again is a new version that the old erasure entry cannot delete', async () => {
      const erased = (await version(ids.userOrgA, days.ownerFirst))!;
      await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
        await client.query('DELETE FROM daily_movement WHERE local_date = $1', [days.ownerFirst]);
        await client.query(`INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps) VALUES ($1, $2, $3, 'UTC', 5)`, [
          ids.orgA,
          ids.userOrgA,
          days.ownerFirst,
        ]);
      });
      const recreated = (await version(ids.userOrgA, days.ownerFirst))!;
      expect(recreated.id).not.toBe(erased.id);
      // clock_timestamp(): a different instant even inside the same transaction.
      expect(recreated.created_at).not.toBe(erased.created_at);
      const outcome = await ownerPool.query<{ outcome: string }>(
        `SELECT app_private.reapply_erasure('daily_movement', $1, $2, $3, $4) AS outcome`,
        [ids.orgA, erased.id, ids.userOrgA, erased.created_at],
      );
      expect(outcome.rows[0]?.outcome).toBe('absent');
      expect(await version(ids.userOrgA, days.ownerFirst)).toEqual(recreated);
    });

    it('a movement replay changes no weekly insight and no insight source revision (migration 0034); writes and deletes neither', async () => {
      const seedInsight = (weekStart: string) =>
        ownerPool.query(
          `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision,
                                        model, prompt_version, policy_version, status)
           VALUES ($1, $2, $3::date, 'UTC', $3::date::timestamp AT TIME ZONE 'UTC', ($3::date + 7)::timestamp AT TIME ZONE 'UTC',
                   repeat('a', 64), coalesce((SELECT revision FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2), 0),
                   'fake', 'weekly-insight-v4', 'weekly-insight-policy-2', 'interrupted')`,
          [ids.orgA, ids.userOrgA, weekStart],
        );
      const state = async () => {
        const result = await ownerPool.query<{ insights: string; revision: string | null }>(
          `SELECT (SELECT string_agg(to_char(week_start, 'YYYY-MM-DD'), ',' ORDER BY week_start) FROM weekly_insights
                   WHERE org_id = $1 AND user_id = $2) AS insights,
                  (SELECT revision::text FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2) AS revision`,
          [ids.orgA, ids.userOrgA],
        );
        return result.rows[0];
      };
      await seedInsight('2026-09-28'); // the week of both seeded days
      await seedInsight('2026-10-05');
      const before = await state();
      expect(before?.insights).toBe('2026-09-28,2026-10-05');

      const target = (await version(ids.userOrgA, days.ownerFirst))!;
      await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
        await client.query('UPDATE daily_movement SET steps = 77 WHERE local_date = $1', [days.ownerSecond]);
        await client.query(`INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps) VALUES ($1, $2, $3, 'UTC', 5)`, [
          ids.orgA,
          ids.userOrgA,
          days.other,
        ]);
        await client.query('DELETE FROM daily_movement WHERE local_date = $1', [days.ownerFirst]);
      });
      expect(await state()).toEqual(before);
      // Restore the erased version, as a backup would hold it, and replay it.
      await ownerPool.query(
        `INSERT INTO daily_movement (org_id, id, user_id, local_date, time_zone, steps, created_at) VALUES ($1, $2, $3, $4, 'UTC', 1, $5)`,
        [ids.orgA, target.id, ids.userOrgA, days.ownerFirst, target.created_at],
      );
      for (const expected of ['erased', 'absent']) {
        const outcome = await ownerPool.query<{ outcome: string }>(
          `SELECT app_private.reapply_erasure('daily_movement', $1, $2, $3, $4) AS outcome`,
          [ids.orgA, target.id, ids.userOrgA, target.created_at],
        );
        expect(outcome.rows[0]?.outcome).toBe(expected);
        expect(await state()).toEqual(before);
      }
      // The same replay of a check-in entry still invalidates the owner's insights (ADR-0076 unchanged).
      await ownerPool.query(`SELECT app_private.reapply_erasure('daily_metric', $1, $2, $3, '2000-01-01T00:00:00Z')`, [
        ids.orgA,
        target.id,
        ids.userOrgA,
      ]);
      const after = await state();
      expect(after?.insights).toBeNull();
      expect(after?.revision).not.toBe(before?.revision);
    });

    it('refuses an unknown entity type in the ledger and in the replay', async () => {
      await expect(
        ownerPool.query(
          `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
           VALUES ('daily_steps', $1, $2, $3, now(), now())`,
          [ids.orgA, ids.userOrgA, ids.userOrgA],
        ),
      ).rejects.toEqual(expect.objectContaining({ code: '23514', constraint: 'erasure_ledger_entity_type_known' }));
      await expect(
        ownerPool.query(`SELECT app_private.reapply_erasure('daily_steps', $1, $2, $3, now())`, [ids.orgA, ids.userOrgA, ids.userOrgA]),
      ).rejects.toThrow(/unknown erasure entity type/u);
    });
  });
});
