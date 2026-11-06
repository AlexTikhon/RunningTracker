import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0074: daily check-ins are owner-only health data, with the access template of activities (ADR-0072) plus an
// UPDATE limited to the value columns. These checks run as the real runtime role (and the maintenance role) against
// migration 0028. The people come from the shared tenant fixture:
//   userOrgA        runner in org A, owns two days and the runs shared with userDual
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

describe('ADR-0074 daily_metrics ACL (migration 0028)', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-daily-metrics-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-daily-metrics-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query(
      `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, mood, note)
       VALUES
         ($1, $3, $6, 'Europe/Warsaw', 72.40, 450, 4, 'rested'),
         ($1, $3, $7, 'Europe/Warsaw', NULL, NULL, 3, NULL),
         ($1, $4, $6, 'UTC', 80.00, NULL, NULL, NULL),
         ($2, $5, $6, 'UTC', NULL, 420, NULL, NULL)`,
      [ids.orgA, ids.orgB, ids.userOrgA, ids.userStranger, ids.userOrgB, days.ownerFirst, days.ownerSecond],
    );
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM daily_metrics').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  const asRuntime = <Result>(
    orgId: string,
    userId: string,
    work: (client: PoolClient) => Promise<Result>,
  ) => withTenantTransaction(runtimePool, { orgId, userId }, work);

  const label = (row: DayRow) => `${row.user_id.slice(0, 8)}@${row.local_date}`;

  const readDays = (orgId: string, userId: string) =>
    asRuntime(orgId, userId, async (client) => {
      const result = await client.query<DayRow>(
        `SELECT user_id, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM daily_metrics ORDER BY user_id, local_date`,
      );
      return result.rows.map(label);
    });

  const storedDays = async () =>
    (
      await ownerPool.query<DayRow>(
        `SELECT user_id, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM daily_metrics ORDER BY org_id, user_id, local_date`,
      )
    ).rows.map(label);

  const insertAs = (orgId: string, userId: string, row: { orgId: string; userId: string; localDate?: string }) =>
    asRuntime(orgId, userId, (client) =>
      client.query(
        `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, mood) VALUES ($1, $2, $3, 'UTC', 2)`,
        [row.orgId, row.userId, row.localDate ?? days.other],
      ),
    );

  const ownerA = (date: string) => `${ids.userOrgA.slice(0, 8)}@${date}`;
  const strangerA = `${ids.userStranger.slice(0, 8)}@${days.ownerFirst}`;
  const ownerB = `${ids.userOrgB.slice(0, 8)}@${days.ownerFirst}`;

  it('shows each person only their own days in the current organization', async () => {
    await expect(readDays(ids.orgA, ids.userOrgA)).resolves.toEqual([ownerA(days.ownerFirst), ownerA(days.ownerSecond)]);
    await expect(readDays(ids.orgA, ids.userStranger)).resolves.toEqual([strangerA]);
    await expect(readDays(ids.orgB, ids.userOrgB)).resolves.toEqual([ownerB]);
  });

  it('shows nothing to a coach, a grantee, another organization, an inactive member or a foreign context', async () => {
    await expect(readDays(ids.orgA, ids.userDual)).resolves.toEqual([]);
    await expect(readDays(ids.orgB, ids.userDual)).resolves.toEqual([]);
    await expect(readDays(ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readDays(ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(readDays(ids.orgB, ids.userOrgA)).resolves.toEqual([]);
    await expect(readDays(ids.orgA, ids.userPausedOwner)).resolves.toEqual([]);
    const coachView = await readDays(ids.orgA, ids.userStranger);
    expect(coachView).not.toContain(ownerA(days.ownerFirst));
  });

  it("answers a filter by someone else's owner or date with no row, not an error", async () => {
    const probe = (userId: string) =>
      asRuntime(ids.orgA, userId, async (client) => {
        const byOwner = await client.query('SELECT * FROM daily_metrics WHERE user_id = $1', [ids.userOrgA]);
        const byDate = await client.query('SELECT * FROM daily_metrics WHERE local_date = $1', [days.ownerSecond]);
        const counted = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM daily_metrics WHERE org_id = $1',
          [ids.orgA],
        );
        return [byOwner.rowCount, byDate.rowCount, counted.rows[0]?.count];
      });
    await expect(probe(ids.userDual)).resolves.toEqual([0, 0, '0']);
    await expect(probe(ids.userStranger)).resolves.toEqual([0, 0, '1']);
  });

  it('fails closed for missing and malformed contexts', async () => {
    const missing = await runtimePool.query<{ count: string }>('SELECT count(*)::text AS count FROM daily_metrics');
    expect(missing.rows[0]?.count).toBe('0');

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', 'invalid', true)");
      await client.query("SELECT set_config('app.org_id', 'invalid', true)");
      const malformed = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM daily_metrics');
      expect(malformed.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userOrgA]);
      const userOnly = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM daily_metrics');
      expect(userOnly.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('lets the owner insert with RETURNING, replace the values of, and delete their own day', async () => {
    await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      const inserted = await client.query<{ local_date: string }>(
        `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, soreness)
         VALUES ($1, $2, $3, 'Europe/Warsaw', 0)
         RETURNING to_char(local_date, 'YYYY-MM-DD') AS local_date`,
        [ids.orgA, ids.userOrgA, days.other],
      );
      expect(inserted.rows).toEqual([{ local_date: days.other }]);
      const replaced = await client.query(
        `UPDATE daily_metrics SET mood = 5, soreness = NULL, note = 'better' WHERE local_date = $1`,
        [days.other],
      );
      expect(replaced.rowCount).toBe(1);
      const upserted = await client.query(
        `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, mood) VALUES ($1, $2, $3, 'UTC', 1)
         ON CONFLICT (org_id, user_id, local_date) DO UPDATE SET mood = EXCLUDED.mood`,
        [ids.orgA, ids.userOrgA, days.ownerFirst],
      );
      expect(upserted.rowCount).toBe(1);
      const deleted = await client.query('DELETE FROM daily_metrics WHERE local_date = $1', [days.ownerSecond]);
      expect(deleted.rowCount).toBe(1);
    });
    expect(await storedDays()).toEqual([ownerA(days.ownerFirst), ownerA(days.other), strangerA, ownerB]);
    const stored = await ownerPool.query<{ mood: number; time_zone: string }>(
      'SELECT mood, time_zone FROM daily_metrics WHERE user_id = $1 AND local_date = $2',
      [ids.userOrgA, days.ownerFirst],
    );
    // The upsert replaced the value and kept the zone of the first write.
    expect(stored.rows).toEqual([{ mood: 1, time_zone: 'Europe/Warsaw' }]);
  });

  it('refuses inserting a day for someone else, into another organization, or without an active membership', async () => {
    const rls = /row-level security/u;
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userStranger })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgB, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgB, ids.userDual, { orgId: ids.orgB, userId: ids.userOrgB })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userDual, { orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userInactive, { orgId: ids.orgA, userId: ids.userInactive })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgB, { orgId: ids.orgA, userId: ids.userOrgB })).rejects.toThrow(rls);
    expect(await storedDays()).toEqual([ownerA(days.ownerFirst), ownerA(days.ownerSecond), strangerA, ownerB]);
  });

  it('does not let a coach, a grantee, another organization or an inactive member update or delete a day', async () => {
    const attempts: Array<[string, string]> = [
      [ids.orgA, ids.userDual],
      [ids.orgA, ids.userStranger],
      [ids.orgA, ids.userInactive],
      [ids.orgA, ids.userOrgB],
      [ids.orgB, ids.userDual],
    ];
    for (const [orgId, userId] of attempts) {
      const outcome = await asRuntime(orgId, userId, async (client) => {
        const updated = await client.query('UPDATE daily_metrics SET mood = 1 WHERE user_id = ANY($1::uuid[])', [
          [ids.userOrgA, ids.userOrgB],
        ]);
        const deleted = await client.query('DELETE FROM daily_metrics WHERE user_id = ANY($1::uuid[])', [
          [ids.userOrgA, ids.userOrgB],
        ]);
        return [updated.rowCount, deleted.rowCount];
      });
      expect(outcome).toEqual([0, 0]);
    }
    expect(await storedDays()).toEqual([ownerA(days.ownerFirst), ownerA(days.ownerSecond), strangerA, ownerB]);
    const moods = await ownerPool.query<{ mood: number | null }>(
      'SELECT mood FROM daily_metrics WHERE user_id = $1 ORDER BY local_date',
      [ids.userOrgA],
    );
    expect(moods.rows).toEqual([{ mood: 4 }, { mood: 3 }]);
  });

  it("an upsert by another member conflicts only with their own key and never touches the owner's day", async () => {
    // userDual has an active membership in org A, but no day there: its upsert inserts its own row.
    await asRuntime(ids.orgA, ids.userDual, (client) =>
      client.query(
        `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, mood) VALUES ($1, $2, $3, 'UTC', 1)
         ON CONFLICT (org_id, user_id, local_date) DO UPDATE SET mood = EXCLUDED.mood`,
        [ids.orgA, ids.userDual, days.ownerFirst],
      ),
    );
    const owner = await ownerPool.query<{ mood: number }>(
      'SELECT mood FROM daily_metrics WHERE user_id = $1 AND local_date = $2',
      [ids.userOrgA, days.ownerFirst],
    );
    expect(owner.rows).toEqual([{ mood: 4 }]);
  });

  it('lets the runtime role write only the value columns: never the id, owner, date, zone or timestamps', async () => {
    const denied = /permission denied/u;
    const attempt = (sql: string, parameters: unknown[] = []) =>
      asRuntime(ids.orgA, ids.userOrgA, (client) => client.query(sql, parameters));
    for (const column of ['user_id', 'org_id', 'local_date', 'time_zone', 'created_at', 'updated_at', 'id']) {
      const value =
        column === 'local_date'
          ? `'2026-10-01'`
          : column === 'time_zone'
            ? `'UTC'`
            : column.endsWith('_at')
              ? `now()`
              : `'${ids.userStranger}'`;
      await expect(attempt(`UPDATE daily_metrics SET ${column} = ${value} WHERE local_date = $1`, [days.ownerFirst])).rejects.toThrow(denied);
    }
    for (const column of ['id', 'created_at', 'updated_at']) {
      const value = column === 'id' ? `'${ids.userStranger}'` : `'2026-01-01T00:00:00Z'`;
      await expect(
        attempt(
          `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, mood, ${column}) VALUES ($1, $2, $3, 'UTC', 1, ${value})`,
          [ids.orgA, ids.userOrgA, days.other],
        ),
      ).rejects.toThrow(denied);
    }
    await expect(attempt('TRUNCATE daily_metrics')).rejects.toThrow(denied);
    expect(await storedDays()).toEqual([ownerA(days.ownerFirst), ownerA(days.ownerSecond), strangerA, ownerB]);
  });

  it('takes created_at and updated_at from the database clock and moves only updated_at on a replacement', async () => {
    const before = await ownerPool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    await insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userOrgA });
    const read = async () =>
      (
        await ownerPool.query<{ created_at: Date; updated_at: Date }>(
          'SELECT created_at, updated_at FROM daily_metrics WHERE user_id = $1 AND local_date = $2',
          [ids.userOrgA, days.other],
        )
      ).rows[0]!;
    const inserted = await read();
    expect(inserted.created_at.getTime()).toBeGreaterThanOrEqual(before.rows[0]!.now.getTime());
    expect(inserted.updated_at.getTime()).toBeGreaterThanOrEqual(inserted.created_at.getTime() - 1);
    await asRuntime(ids.orgA, ids.userOrgA, (client) =>
      client.query('UPDATE daily_metrics SET mood = 5 WHERE local_date = $1', [days.other]),
    );
    const replaced = await read();
    expect(replaced.created_at).toEqual(inserted.created_at);
    expect(replaced.updated_at.getTime()).toBeGreaterThan(inserted.updated_at.getTime());
  });

  it('exposes nothing through joins from runs, run_shares or memberships', async () => {
    const joins = (orgId: string, userId: string) =>
      asRuntime(orgId, userId, async (client) => {
        const viaRuns = await client.query(
          `SELECT metric.local_date FROM runs AS run
           JOIN daily_metrics AS metric ON metric.org_id = run.org_id AND metric.user_id = run.user_id`,
        );
        const viaShares = await client.query(
          `SELECT metric.local_date FROM run_shares AS share
           JOIN runs AS run ON run.org_id = share.org_id AND run.id = share.run_id
           JOIN daily_metrics AS metric ON metric.org_id = run.org_id AND metric.user_id = run.user_id`,
        );
        const viaMemberships = await client.query<{ user_id: string }>(
          `SELECT metric.user_id FROM memberships AS membership
           JOIN daily_metrics AS metric ON metric.org_id = membership.org_id AND metric.user_id = membership.user_id`,
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
    const coachA = await joins(ids.orgA, ids.userStranger);
    expect(coachA).toMatchObject({ viaMemberships: [ids.userStranger], viaRuns: 0, viaShares: 0 });
  });

  it("removes the owner's access as soon as the membership is deactivated", async () => {
    await ownerPool.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readDays(ids.orgA, ids.userOrgA)).resolves.toEqual([]);
    const changed = await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      const updated = await client.query('UPDATE daily_metrics SET mood = 1');
      const deleted = await client.query('DELETE FROM daily_metrics');
      return [updated.rowCount, deleted.rowCount];
    });
    expect(changed).toEqual([0, 0]);
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(
      /row-level security/u,
    );
    await ownerPool.query('UPDATE memberships SET active = true WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readDays(ids.orgA, ids.userOrgA)).resolves.toHaveLength(2);
  });

  it('keeps the maintenance role without any access', async () => {
    const denied = /permission denied/u;
    await expect(maintenancePool.query('SELECT * FROM daily_metrics')).rejects.toThrow(denied);
    await expect(maintenancePool.query('DELETE FROM daily_metrics')).rejects.toThrow(denied);
    await expect(maintenancePool.query('UPDATE daily_metrics SET mood = 1')).rejects.toThrow(denied);
    await expect(
      maintenancePool.query(
        `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, mood) VALUES ($1, $2, $3, 'UTC', 1)`,
        [ids.orgA, ids.userOrgA, days.other],
      ),
    ).rejects.toThrow(denied);
  });

  it('declares exactly the intended RLS, policies, table and column privileges and the owner/date key', async () => {
    const relation = await ownerPool.query<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.daily_metrics'::regclass`,
    );
    expect(relation.rows).toEqual([{ relforcerowsecurity: false, relrowsecurity: true }]);

    const policies = await ownerPool.query<{ cmd: string; policyname: string; roles: string[] }>(
      `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'daily_metrics' ORDER BY policyname`,
    );
    expect(policies.rows).toEqual([
      { cmd: 'DELETE', policyname: 'daily_metrics_delete_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'INSERT', policyname: 'daily_metrics_insert_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'SELECT', policyname: 'daily_metrics_select_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'UPDATE', policyname: 'daily_metrics_update_owner', roles: ['running_tracker_runtime'] },
    ]);

    const tablePrivileges = await ownerPool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'daily_metrics' AND grantee <> 'running_tracker_owner'
       ORDER BY grantee, privilege_type`,
    );
    expect(tablePrivileges.rows).toEqual([
      { grantee: 'running_tracker_runtime', privilege_type: 'DELETE' },
      { grantee: 'running_tracker_runtime', privilege_type: 'SELECT' },
    ]);

    const columnPrivileges = await ownerPool.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'daily_metrics' AND grantee = 'running_tracker_runtime'
         AND privilege_type IN ('INSERT', 'UPDATE')
       ORDER BY privilege_type, column_name`,
    );
    expect(columnPrivileges.rows).toEqual([
      ...['local_date', 'mood', 'note', 'org_id', 'sleep_minutes', 'sleep_quality', 'soreness', 'time_zone', 'user_id', 'weight_kg'].map(
        (column_name) => ({ column_name, privilege_type: 'INSERT' }),
      ),
      ...['mood', 'note', 'sleep_minutes', 'sleep_quality', 'soreness', 'weight_kg'].map((column_name) => ({
        column_name,
        privilege_type: 'UPDATE',
      })),
    ]);
    const maintenance = await ownerPool.query<{ any: boolean }>(
      `SELECT has_any_column_privilege('running_tracker_maintenance', 'public.daily_metrics', 'SELECT')
              OR has_any_column_privilege('running_tracker_maintenance', 'public.daily_metrics', 'INSERT')
              OR has_any_column_privilege('running_tracker_maintenance', 'public.daily_metrics', 'UPDATE') AS any`,
    );
    expect(maintenance.rows).toEqual([{ any: false }]);

    const key = await ownerPool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'public.daily_metrics'::regclass AND conname = 'daily_metrics_owner_date_unique'`,
    );
    expect(key.rows).toEqual([{ definition: 'UNIQUE (org_id, user_id, local_date)' }]);
  });

  describe('constraints', () => {
    const insertRow = (values: Record<string, unknown>, localDate: string = days.other) => {
      const row: Record<string, unknown> = { mood: 3, time_zone: 'UTC', ...values };
      const columns = Object.keys(row);
      return ownerPool.query(
        `INSERT INTO daily_metrics (org_id, user_id, local_date, ${columns.join(', ')})
         VALUES ($1, $2, $3, ${columns.map((_, index) => `$${index + 4}`).join(', ')})`,
        [ids.orgA, ids.userOrgA, localDate, ...columns.map((column) => row[column])],
      );
    };
    const violates = (constraint: string): unknown => expect.objectContaining({ code: '23514', constraint });

    it.each([
      ['daily_metrics_local_date_range', { }, '1999-12-31'],
      ['daily_metrics_local_date_range', { }, 'infinity'],
      ['daily_metrics_time_zone_shape', { time_zone: '' }, days.other],
      ['daily_metrics_time_zone_shape', { time_zone: '+01:00' }, days.other],
      ['daily_metrics_weight_range', { weight_kg: 19.99 }, days.other],
      ['daily_metrics_weight_range', { weight_kg: 400.01 }, days.other],
      ['daily_metrics_weight_range', { weight_kg: 'NaN' }, days.other],
      ['daily_metrics_sleep_minutes_range', { sleep_minutes: -1 }, days.other],
      ['daily_metrics_sleep_minutes_range', { sleep_minutes: 1_441 }, days.other],
      ['daily_metrics_sleep_quality_range', { sleep_quality: 0 }, days.other],
      ['daily_metrics_sleep_quality_range', { sleep_quality: 6 }, days.other],
      ['daily_metrics_mood_range', { mood: 0 }, days.other],
      ['daily_metrics_mood_range', { mood: 6 }, days.other],
      ['daily_metrics_soreness_range', { soreness: -1 }, days.other],
      ['daily_metrics_soreness_range', { soreness: 11 }, days.other],
      ['daily_metrics_note_length', { note: '' }, days.other],
      ['daily_metrics_note_length', { note: 'x'.repeat(501) }, days.other],
      ['daily_metrics_some_value', { mood: null }, days.other],
      ['daily_metrics_times_finite', { created_at: 'infinity' }, days.other],
    ] as const)('%s rejects %j on %s', async (constraint, values, localDate) => {
      await expect(insertRow(values, localDate)).rejects.toEqual(violates(constraint));
    });

    it('accepts the boundary values, rounds nothing it should keep, and allows any single value', async () => {
      await insertRow({ mood: 1, note: 'x', sleep_minutes: 0, sleep_quality: 1, soreness: 0, weight_kg: 20 }, '2000-01-01');
      await insertRow({ mood: 5, note: 'é'.repeat(500), sleep_minutes: 1_440, sleep_quality: 5, soreness: 10, weight_kg: 400 }, '2026-10-07');
      await insertRow({ mood: null, weight_kg: 72.35 }, '2026-10-08');
      const weight = await ownerPool.query<{ weight_kg: string }>(
        `SELECT weight_kg::text FROM daily_metrics WHERE user_id = $1 AND local_date = '2026-10-08'`,
        [ids.userOrgA],
      );
      expect(weight.rows).toEqual([{ weight_kg: '72.35' }]);
    });

    it('does not enforce a future-date bound in the database (the service owns it, ADR-0074)', async () => {
      await expect(insertRow({}, '2099-01-01')).resolves.toBeDefined();
    });

    it('allows one day per owner and organization, and binds the owner to a membership of that organization', async () => {
      await expect(insertRow({}, days.ownerFirst)).rejects.toEqual(
        expect.objectContaining({ code: '23505', constraint: 'daily_metrics_owner_date_unique' }),
      );
      await expect(
        ownerPool.query(
          `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, mood) VALUES ($1, $2, $3, 'UTC', 1)`,
          [ids.orgA, ids.userOrgB, days.other],
        ),
      ).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'daily_metrics_owner_membership_fk' }));
      // userStranger owns a day and no run or activity, so the only foreign key that can refuse it is this one.
      await expect(
        ownerPool.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userStranger]),
      ).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'daily_metrics_owner_membership_fk' }));
    });
  });
});

describe('ADR-0074 no TRUNCATE for the application roles', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let maintenancePool: Pool;

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 1 });
    ownerPool = new Pool({ application_name: 'running-tracker-truncate-owner', connectionString: config.migration.connectionString, max: 1 });
    maintenancePool = new Pool({
      application_name: 'running-tracker-truncate-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  // TRUNCATE fires no row trigger, so it would erase health data without an erasure-ledger entry (ADR-0073). Neither
  // application role may hold it on the owner-only tables or on the ledger outbox.
  const tables = ['public.activities', 'public.daily_metrics', 'public.erasure_ledger'];

  it('grants TRUNCATE on activities, daily_metrics and erasure_ledger to neither application role', async () => {
    const result = await ownerPool.query<{ role: string; table_name: string; truncate: boolean }>(
      `SELECT role, table_name, has_table_privilege(role, table_name, 'TRUNCATE') AS truncate
       FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role
       CROSS JOIN unnest($1::text[]) AS table_name
       ORDER BY role, table_name`,
      [tables],
    );
    expect(result.rows).toHaveLength(6);
    expect(result.rows.filter((row) => row.truncate)).toEqual([]);
  });

  it('refuses an actual TRUNCATE by either role', async () => {
    for (const table of tables) {
      await expect(runtimePool.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied/u);
      await expect(maintenancePool.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied/u);
    }
  });
});
