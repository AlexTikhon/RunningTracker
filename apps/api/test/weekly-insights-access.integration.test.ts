import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0076: weekly insights are owner-only derived health data, with the access template of activities and
// daily_metrics for all four operations (migration 0030). These checks run as the real runtime and maintenance roles.
// The people come from the shared tenant fixture:
//   userOrgA        runner in org A, owns two weeks
//   userDual        runner in org A with history grants on userOrgA's runs; coach in org B
//   userStranger    coach in org A without any grant, owns one week
//   userInactive    inactive member of org A
//   userOrgB        runner in org B only, owns one week there
const weeks = { first: '2026-10-05', second: '2026-10-12', other: '2026-10-19' } as const;
const hash = (digit: string) => digit.repeat(64);
const readyOutput = JSON.stringify({ dataGaps: [], observations: [], suggestion: 'Rest.', summary: 'Fine.' });

interface WeekRow {
  user_id: string;
  week_start: string;
}

describe('ADR-0076 weekly_insights ACL (migration 0030)', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({ application_name: 'running-tracker-insight-acl-owner', connectionString: config.migration.connectionString, max: 1 });
    maintenancePool = new Pool({
      application_name: 'running-tracker-insight-acl-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  // The object owner bypasses row-level security, so these rows exist whatever the policies say.
  // The current gate revision of a person (migration 0032): an insert must carry it.
  const revisionOf = async (orgId: string, userId: string) =>
    (
      await ownerPool.query<{ revision: string }>(
        'SELECT coalesce((SELECT revision FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2), 0)::text AS revision',
        [orgId, userId],
      )
    ).rows[0]!.revision;

  async function seedInsight(orgId: string, userId: string, weekStart: string, status = 'interrupted'): Promise<void> {
    await ownerPool.query(
      `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision,
                                    model, prompt_version, policy_version, status, output)
       VALUES ($1, $2, $3::date, 'UTC', $3::date::timestamp AT TIME ZONE 'UTC', ($3::date + 7)::timestamp AT TIME ZONE 'UTC',
               $4, $7::bigint, 'fake', 'weekly-insight-v2', 'weekly-insight-policy-2', $5, CASE WHEN $5 = 'ready' THEN $6::jsonb END)`,
      [orgId, userId, weekStart, hash('a'), status, readyOutput, await revisionOf(orgId, userId)],
    );
  }

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await seedInsight(ids.orgA, ids.userOrgA, weeks.first, 'ready');
    await seedInsight(ids.orgA, ids.userOrgA, weeks.second);
    await seedInsight(ids.orgA, ids.userStranger, weeks.first);
    await seedInsight(ids.orgB, ids.userOrgB, weeks.first);
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM weekly_insights').catch(() => undefined);
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  const asRuntime = <Result>(orgId: string, userId: string, work: (client: PoolClient) => Promise<Result>) =>
    withTenantTransaction(runtimePool, { orgId, userId }, work);

  const label = (row: WeekRow) => `${row.user_id.slice(0, 8)}@${row.week_start}`;
  const ownerA = (week: string) => `${ids.userOrgA.slice(0, 8)}@${week}`;
  const strangerA = `${ids.userStranger.slice(0, 8)}@${weeks.first}`;
  const ownerB = `${ids.userOrgB.slice(0, 8)}@${weeks.first}`;

  const readWeeks = (orgId: string, userId: string) =>
    asRuntime(orgId, userId, async (client) => {
      const result = await client.query<WeekRow>(
        `SELECT user_id, to_char(week_start, 'YYYY-MM-DD') AS week_start FROM weekly_insights ORDER BY user_id, week_start`,
      );
      return result.rows.map(label);
    });

  const storedWeeks = async () =>
    (
      await ownerPool.query<WeekRow>(
        `SELECT user_id, to_char(week_start, 'YYYY-MM-DD') AS week_start FROM weekly_insights ORDER BY org_id, user_id, week_start`,
      )
    ).rows.map(label);

  const insertAs = async (orgId: string, userId: string, row: { orgId: string; userId: string }) => {
    const revision = await revisionOf(row.orgId, row.userId);
    return asRuntime(orgId, userId, (client) =>
      client.query(
        `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision,
                                      model, prompt_version, policy_version, job_token, lease_expires_at)
         VALUES ($1, $2, $3::date, 'UTC', $3::date::timestamp AT TIME ZONE 'UTC', ($3::date + 7)::timestamp AT TIME ZONE 'UTC',
                 $4, $5::bigint, 'fake', 'weekly-insight-v2', 'weekly-insight-policy-2', gen_random_uuid(),
                 clock_timestamp() + interval '1 minute')`,
        [row.orgId, row.userId, weeks.other, hash('b'), revision],
      ),
    );
  };

  it('shows each person only their own insights in the current organization', async () => {
    await expect(readWeeks(ids.orgA, ids.userOrgA)).resolves.toEqual([ownerA(weeks.first), ownerA(weeks.second)]);
    await expect(readWeeks(ids.orgA, ids.userStranger)).resolves.toEqual([strangerA]);
    await expect(readWeeks(ids.orgB, ids.userOrgB)).resolves.toEqual([ownerB]);
  });

  it('shows nothing to a coach, a grantee, another organization, an inactive member or a foreign context', async () => {
    await expect(readWeeks(ids.orgA, ids.userDual)).resolves.toEqual([]);
    await expect(readWeeks(ids.orgB, ids.userDual)).resolves.toEqual([]);
    await expect(readWeeks(ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readWeeks(ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(readWeeks(ids.orgB, ids.userOrgA)).resolves.toEqual([]);
    await expect(readWeeks(ids.orgA, ids.userPausedOwner)).resolves.toEqual([]);
  });

  it("answers a filter by someone else's owner with no row, not an error", async () => {
    const probe = (userId: string) =>
      asRuntime(ids.orgA, userId, async (client) => {
        const byOwner = await client.query('SELECT * FROM weekly_insights WHERE user_id = $1', [ids.userOrgA]);
        const counted = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM weekly_insights WHERE org_id = $1', [ids.orgA]);
        return [byOwner.rowCount, counted.rows[0]?.count];
      });
    await expect(probe(ids.userDual)).resolves.toEqual([0, '0']);
    await expect(probe(ids.userStranger)).resolves.toEqual([0, '1']);
  });

  it('fails closed without a tenant context', async () => {
    const missing = await runtimePool.query<{ count: string }>('SELECT count(*)::text AS count FROM weekly_insights');
    expect(missing.rows[0]?.count).toBe('0');
  });

  it('lets the owner insert, update the status and output of, and delete their own insight', async () => {
    await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      await insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userOrgA });
      const updated = await client.query(
        `UPDATE weekly_insights SET status = 'ready', output = $2::jsonb WHERE week_start = $1::date`,
        [weeks.second, readyOutput],
      );
      expect(updated.rowCount).toBe(1);
      const deleted = await client.query('DELETE FROM weekly_insights WHERE week_start = $1::date', [weeks.first]);
      expect(deleted.rowCount).toBe(1);
    });
    expect(await storedWeeks()).toEqual([ownerA(weeks.second), ownerA(weeks.other), strangerA, ownerB]);
    const inserted = await ownerPool.query<{ output: unknown; status: string }>(
      'SELECT status, output FROM weekly_insights WHERE user_id = $1 AND week_start = $2::date',
      [ids.userOrgA, weeks.other],
    );
    // Status and output always start as the defaults: the runtime cannot insert them.
    expect(inserted.rows).toEqual([{ output: null, status: 'queued' }]);
  });

  it('refuses inserting an insight for someone else, into another organization, or without an active membership', async () => {
    const rls = /row-level security/u;
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgA, userId: ids.userStranger })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgA, { orgId: ids.orgB, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userDual, { orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userInactive, { orgId: ids.orgA, userId: ids.userInactive })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgB, { orgId: ids.orgA, userId: ids.userOrgB })).rejects.toThrow(rls);
    expect(await storedWeeks()).toEqual([ownerA(weeks.first), ownerA(weeks.second), strangerA, ownerB]);
  });

  it('does not let a coach, a grantee, another organization or an inactive member update or delete an insight', async () => {
    const attempts: Array<[string, string]> = [
      [ids.orgA, ids.userDual],
      [ids.orgA, ids.userStranger],
      [ids.orgA, ids.userInactive],
      [ids.orgA, ids.userOrgB],
      [ids.orgB, ids.userDual],
    ];
    for (const [orgId, userId] of attempts) {
      const outcome = await asRuntime(orgId, userId, async (client) => {
        const updated = await client.query(
          `UPDATE weekly_insights SET status = 'failed_safety', output = NULL WHERE user_id = ANY($1::uuid[])`,
          [[ids.userOrgA, ids.userOrgB]],
        );
        const deleted = await client.query('DELETE FROM weekly_insights WHERE user_id = ANY($1::uuid[])', [[ids.userOrgA, ids.userOrgB]]);
        return [updated.rowCount, deleted.rowCount];
      });
      expect([orgId, userId, outcome]).toEqual([orgId, userId, [0, 0]]);
    }
    expect(await storedWeeks()).toEqual([ownerA(weeks.first), ownerA(weeks.second), strangerA, ownerB]);
    const statuses = await ownerPool.query<{ status: string }>(
      'SELECT status FROM weekly_insights WHERE user_id = $1 ORDER BY week_start',
      [ids.userOrgA],
    );
    expect(statuses.rows).toEqual([{ status: 'ready' }, { status: 'interrupted' }]);
  });

  it('lets the runtime role write only the columns the service supplies, and update only status and output', async () => {
    const denied = /permission denied/u;
    const attempt = (sql: string, parameters: unknown[] = []) =>
      asRuntime(ids.orgA, ids.userOrgA, (client) => client.query(sql, parameters));
    const values: Record<string, string> = {
      attempts: '2',
      created_at: 'now()',
      failure_reason: `'timeout'`,
      id: 'gen_random_uuid()',
      output: `'{}'::jsonb`,
      status: `'ready'`,
      updated_at: 'now()',
    };
    for (const [column, value] of Object.entries(values)) {
      await expect(
        attempt(
          `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, model, prompt_version, ${column})
           VALUES ($1, $2, $3::date, 'UTC', now(), now() + interval '7 days', $4, 'fake', 'v1', ${value})`,
          [ids.orgA, ids.userOrgA, weeks.other, hash('c')],
        ),
      ).rejects.toThrow(denied);
    }
    for (const assignment of [
      `input_hash = '${hash('d')}'`,
      `week_start = date '2026-10-26'`,
      `model = 'other'`,
      `prompt_version = 'v9'`,
      `user_id = '${ids.userStranger}'`,
      `range_start = now()`,
      `created_at = now()`,
      `source_revision = 0`,
      `policy_version = 'x'`,
      `updated_at = now()`,
    ]) {
      await expect(attempt(`UPDATE weekly_insights SET ${assignment}`)).rejects.toThrow(denied);
    }
  });

  it('gives the maintenance role no access at all', async () => {
    await expect(maintenancePool.query('SELECT count(*) FROM weekly_insights')).rejects.toThrow(/permission denied/u);
    await expect(maintenancePool.query('DELETE FROM weekly_insights')).rejects.toThrow(/permission denied/u);
  });

  it('enforces the row shape: Monday weeks, output exactly when ready, a job exactly when active, a SHA-256 input hash', async () => {
    const revision = await revisionOf(ids.orgA, ids.userDual);
    const insert = (weekStart: string, status: string, output: string | null, inputHash = hash('e'), extra = '') =>
      ownerPool.query(
        `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, source_revision, model,
                                      prompt_version, policy_version, status, output, failure_reason, job_token, lease_expires_at)
         VALUES ($1, $2, $3::date, 'UTC', $3::date::timestamp AT TIME ZONE 'UTC', ($3::date + 7)::timestamp AT TIME ZONE 'UTC',
                 $4, $7::bigint, 'fake', 'v2', 'p2', $5, $6::jsonb, ${extra === 'reason' ? `'Not A Code'` : 'NULL'},
                 ${extra === 'job' ? 'gen_random_uuid()' : 'NULL'}, ${extra === 'job' ? `clock_timestamp() + interval '1 minute'` : 'NULL'})`,
        [ids.orgA, ids.userDual, weekStart, inputHash, status, output, revision],
      );
    await expect(insert('2026-10-06', 'interrupted', null)).rejects.toThrow(/weekly_insights_week_start_monday/u);
    await expect(insert(weeks.other, 'ready', null)).rejects.toThrow(/weekly_insights_output_only_when_ready/u);
    await expect(insert(weeks.other, 'failed_safety', readyOutput)).rejects.toThrow(/weekly_insights_output_only_when_ready/u);
    await expect(insert(weeks.other, 'interrupted', null, 'XYZ')).rejects.toThrow(/weekly_insights_input_hash_shape/u);
    await expect(insert(weeks.other, 'pending', null)).rejects.toThrow(/weekly_insights_status_known/u);
    await expect(insert(weeks.other, 'queued', null)).rejects.toThrow(/weekly_insights_job_only_when_active/u);
    await expect(insert(weeks.other, 'ready', readyOutput, hash('e'), 'job')).rejects.toThrow(/weekly_insights_job_only_when_active/u);
    await expect(insert(weeks.other, 'interrupted', null, hash('e'), 'reason')).rejects.toThrow(/weekly_insights_failure_reason_shape/u);
    await insert(weeks.other, 'queued', null, hash('e'), 'job');
    await expect(insert(weeks.other, 'interrupted', null, hash('f'))).rejects.toThrow(/weekly_insights_one_per_week/u);
  });
});
