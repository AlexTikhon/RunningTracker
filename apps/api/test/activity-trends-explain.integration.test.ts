import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activityTrendsActivitiesComparisonSql,
  activityTrendsActivitiesSql,
  activityTrendsComparisonWindowOf,
  activityTrendsIntervalOf,
  activityTrendsRecordedRunsComparisonSql,
  activityTrendsRecordedRunsSql,
} from '../src/activity-trends/activity-trends-service.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// EXPLAIN (ANALYZE, BUFFERS) of the two activity trends statements (ADR-0089) under the runtime role, with row-level
// security and the tenant context in force, on synthetic data shaped like a long-term user among others: five members of
// one organization with 30,000 activities each (both sources, every type, spread over about four years) and 3,000
// finished runs each (current, stale and missing summaries). The plans are printed for inspection; the assertions guard
// what the evidence showed: the owner indexes bound both statements to the range, and nothing reads the whole table.

const PEOPLE = [ids.userOrgA, ids.userDual, ids.userStranger, ids.userPausedOwner, ids.userHistoryActiveOwner];
const ACTIVITIES_PER_PERSON = 30_000;
const RUNS_PER_PERSON = 3_000;

interface PlanNode {
  'Actual Rows'?: number;
  'Index Name'?: string;
  'Node Type': string;
  Plans?: PlanNode[];
  'Relation Name'?: string;
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe('activity trends EXPLAIN under the runtime role (synthetic data)', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    ownerPool = new Pool({ application_name: 'running-tracker-activity-trends-explain-owner', connectionString: integration.migration.connectionString, max: 1 });
    runtimePool = new Pool({ application_name: 'running-tracker-activity-trends-explain-runtime', connectionString: integration.runtime.connectionString, max: 1 });
    const runtimeIdentity = await runtimePool.query<{ database_name: string; role_name: string }>('SELECT current_database() AS database_name, current_user AS role_name');
    expect(runtimeIdentity.rows[0]).toEqual({ database_name: integration.runtime.database, role_name: 'running_tracker_runtime' });
    // Validates the owner connection's database and role before deleting and writing anything.
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, source, idempotency_key, import_fingerprint)
       SELECT $1, gen_random_uuid(), person.id,
              (ARRAY['run','walk','ride','hike','swim','strength','other'])[1 + (n % 7)],
              timestamptz '2026-11-12 12:00+00' - make_interval(mins => n * 70 + (person.ordinality::integer * 7)),
              600 + (n % 5400),
              CASE WHEN n % 5 = 0 THEN NULL ELSE 500 + (n % 20000) * 1.5 END,
              CASE WHEN n % 3 = 0 THEN 'gpx' ELSE 'manual' END,
              CASE WHEN n % 3 = 0 THEN gen_random_uuid() END,
              CASE WHEN n % 3 = 0 THEN sha256(gen_random_uuid()::text::bytea) END
         FROM unnest($2::uuid[]) WITH ORDINALITY AS person(id, ordinality)
        CROSS JOIN generate_series(1, $3::integer) AS n`,
      [ids.orgA, PEOPLE, ACTIVITIES_PER_PERSON],
    );
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state)
       SELECT $1, gen_random_uuid(), person.id, 'finished', started, started, started + interval '40 minutes', 2, 0, 'purged'
         FROM unnest($2::uuid[]) WITH ORDINALITY AS person(id, ordinality)
        CROSS JOIN generate_series(1, $3::integer) AS n
        CROSS JOIN LATERAL (SELECT timestamptz '2026-11-12 06:00+00' - make_interval(hours => n * 11 + person.ordinality::integer)) AS t(started)`,
      [ids.orgA, PEOPLE, RUNS_PER_PERSON],
    );
    await ownerPool.query(
      `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s, quality_stats, computed_at)
       SELECT run.org_id, run.id, CASE WHEN row_number() OVER () % 4 = 0 THEN 1 ELSE 2 END, 'explain-v1',
              ST_GeomFromText('MULTILINESTRING((21.0 52.0, 21.001 52.001))', 4326), 5000.5, 1800.25, '{}'::jsonb, now()
         FROM runs AS run
        WHERE run.org_id = $1 AND run.status = 'finished' AND hashtext(run.id::text) % 10 <> 0
          AND NOT EXISTS (SELECT 1 FROM run_summaries AS existing WHERE existing.org_id = run.org_id AND existing.run_id = run.id)`,
      [ids.orgA],
    );
    await ownerPool.query('ANALYZE activities');
    await ownerPool.query('ANALYZE runs');
    await ownerPool.query('ANALYZE run_summaries');
  }, 180_000);

  afterAll(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration).catch(() => undefined);
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await Promise.all([ownerPool?.end(), runtimePool?.end()]);
  });

  async function explain(sql: string, parameters: unknown[]): Promise<{ executionMs: number; plan: PlanNode; text: string }> {
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ids.userOrgA, ids.orgA]);
      const json = await client.query<{ 'QUERY PLAN': Array<{ 'Execution Time': number; Plan: PlanNode }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        parameters,
      );
      const text = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`, parameters);
      await client.query('ROLLBACK');
      const [first] = json.rows[0]!['QUERY PLAN'];
      return { executionMs: first!['Execution Time'], plan: first!.Plan, text: text.rows.map((row) => row['QUERY PLAN']).join('\n') };
    } finally {
      client.release();
    }
  }

  const interval = activityTrendsIntervalOf('2026-11-12', 'Europe/Warsaw');
  const bounds = [ids.orgA, ids.userOrgA, interval.days.map((day) => day.startsAt), interval.startsAt, interval.endsAt];

  it('reads one person’s range of activities through the owner index, never the whole table', async () => {
    const counts = await ownerPool.query<{ owner_rows: number; total_rows: number }>(
      'SELECT count(*)::integer AS total_rows, (count(*) FILTER (WHERE user_id = $1))::integer AS owner_rows FROM activities',
      [ids.userOrgA],
    );
    expect(counts.rows[0]).toEqual({ owner_rows: ACTIVITIES_PER_PERSON, total_rows: ACTIVITIES_PER_PERSON * PEOPLE.length });
    for (const [source, type] of [['manual', 'ride'], ['gpx', 'hike']] as const) {
      const result = await explain(activityTrendsActivitiesSql, [...bounds, source, type]);
      console.info(`activity-trends:activities ${source}/${type} (${result.executionMs.toFixed(2)} ms)\n${result.text}`);
      const all = nodes(result.plan);
      const scans = all.filter((node) => node['Relation Name'] === 'activities');
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);
      // The rows read are the person's rows of the range (one every 70 minutes for 28 days), not the table.
      const read = scans.reduce((sum, node) => sum + (node['Actual Rows'] ?? 0), 0);
      expect(read).toBeLessThan(1_000);
    }
  });

  it('reads one person’s range of runs through the owner index and each run’s summary by its primary key', async () => {
    const result = await explain(activityTrendsRecordedRunsSql, bounds);
    console.info(`activity-trends:recorded-runs (${result.executionMs.toFixed(2)} ms)\n${result.text}`);
    const all = nodes(result.plan);
    expect(all.filter((node) => node['Relation Name'] === 'runs').map((node) => node['Index Name'])).toEqual(['runs_owner_started_idx']);
    // Measured before this statement used a LATERAL lookup: a plain LEFT JOIN hashed a sequential scan of every row of
    // run_summaries (13,483 here, all organizations). Now one primary-key probe per run of the range.
    const summaries = all.filter((node) => node['Relation Name'] === 'run_summaries');
    expect(summaries.map((node) => node['Index Name'])).toEqual(['run_summaries_pkey']);
    const runRows = all.filter((node) => node['Relation Name'] === 'runs').reduce((sum, node) => sum + (node['Actual Rows'] ?? 0), 0);
    expect(runRows).toBeLessThan(200);
  });

  // ADR-0090: the comparison statements read the 56-date window (previous period and range) with the same indexes.
  const window = activityTrendsComparisonWindowOf('2026-11-12', 'Europe/Warsaw');
  const windowBounds = [ids.orgA, ids.userOrgA, window.starts, window.startsAt, window.endsAt];

  it('compares two periods of activities through the owner index, reading the window once', async () => {
    expect(window.starts).toHaveLength(56);
    for (const [source, type] of [['manual', 'ride'], ['gpx', 'hike']] as const) {
      const result = await explain(activityTrendsActivitiesComparisonSql, [...windowBounds, source, type, window.previousDays]);
      console.info(`activity-trends:activities-comparison ${source}/${type} (${result.executionMs.toFixed(2)} ms)\n${result.text}`);
      const scans = nodes(result.plan).filter((node) => node['Relation Name'] === 'activities');
      expect(scans.length).toBe(1);
      expect(scans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);
      // About twice the range's rows (one every 70 minutes for 56 days), not the table.
      expect(scans.reduce((sum, node) => sum + (node['Actual Rows'] ?? 0), 0)).toBeLessThan(2_000);
    }
  });

  it('compares two periods of runs through the owner index and one summary probe per run', async () => {
    const result = await explain(activityTrendsRecordedRunsComparisonSql, [...windowBounds, window.previousDays]);
    console.info(`activity-trends:recorded-runs-comparison (${result.executionMs.toFixed(2)} ms)\n${result.text}`);
    const all = nodes(result.plan);
    expect(all.filter((node) => node['Relation Name'] === 'runs').map((node) => node['Index Name'])).toEqual(['runs_owner_started_idx']);
    expect(all.filter((node) => node['Relation Name'] === 'run_summaries').map((node) => node['Index Name'])).toEqual(['run_summaries_pkey']);
    const runRows = all.filter((node) => node['Relation Name'] === 'runs').reduce((sum, node) => sum + (node['Actual Rows'] ?? 0), 0);
    expect(runRows).toBeLessThan(400);
  });
});
