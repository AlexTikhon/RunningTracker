import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deleteActivity } from '../src/activities/activity-service.js';
import { systemClock } from '../src/clock.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { deleteDailyMetrics, putDailyMetrics } from '../src/daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../src/database/authenticated-tenant-transaction.js';
import { createDatabasePool } from '../src/database/database.js';
import { deleteRun } from '../src/runs/run-service.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0076 derived-data erasure (migration 0031): deleting a source record deletes the insights of its week in the same
// statement, through every path, the restore replays included. The fixture's finished runs of userOrgA started at
// 2026-09-20T08:00Z, a Sunday, inside the Warsaw week of 2026-09-14.
const activityId = 'c0000000-0000-4000-8000-0000000000a1';
const owner = { userId: ids.userOrgA };

describe('ADR-0076 weekly insight erasure (migration 0031)', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({ application_name: 'running-tracker-insight-erasure-owner', connectionString: config.migration.connectionString, max: 2 });
  });

  async function seedInsight(userId: string, weekStart: string, timeZone: string): Promise<void> {
    await ownerPool.query(
      `INSERT INTO weekly_insights (org_id, user_id, week_start, time_zone, range_start, range_end, input_hash, model, prompt_version)
       VALUES ($1, $2, $3::date, $4, $3::date::timestamp AT TIME ZONE $4, ($3::date + 7)::timestamp AT TIME ZONE $4,
               repeat('a', 64), 'fake', 'weekly-insight-v1')`,
      [ids.orgA, userId, weekStart, timeZone],
    );
  }

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await seedInsight(ids.userOrgA, '2026-09-14', 'Europe/Warsaw');
    await seedInsight(ids.userOrgA, '2026-10-05', 'UTC');
    await seedInsight(ids.userOrgA, '2026-10-12', 'UTC');
    await seedInsight(ids.userStranger, '2026-10-05', 'UTC');
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM weekly_insights').catch(() => undefined);
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await ownerPool?.query('DELETE FROM daily_metrics').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await ownerPool?.end();
  });

  const asOwner = <Result>(work: Parameters<typeof withAuthenticatedTenantTransaction<Result>>[3]) =>
    withAuthenticatedTenantTransaction(runtimePool, owner, ids.orgA, work);

  async function insights(): Promise<string[]> {
    const result = await ownerPool.query<{ user_id: string; week_start: string }>(
      `SELECT user_id, to_char(week_start, 'YYYY-MM-DD') AS week_start FROM weekly_insights ORDER BY user_id, week_start`,
    );
    return result.rows.map((row) => `${row.user_id === ids.userOrgA ? 'owner' : 'other'}@${row.week_start}`).sort();
  }

  const all = ['other@2026-10-05', 'owner@2026-09-14', 'owner@2026-10-05', 'owner@2026-10-12'];
  const without = (...removed: string[]) => all.filter((entry) => !removed.includes(entry));

  async function seedActivity(startedAt: string): Promise<{ createdAt: string }> {
    const result = await ownerPool.query<{ created_at: string }>(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s)
       VALUES ($1, $2, $3, 'walk', $4::timestamptz, 1800)
       RETURNING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
      [ids.orgA, activityId, ids.userOrgA, startedAt],
    );
    return { createdAt: result.rows[0]!.created_at };
  }

  async function seedDay(localDate: string): Promise<void> {
    await asOwner((client) => putDailyMetrics(client, owner, ids.orgA, localDate, { mood: 3, note: 'n', timeZone: 'UTC' }, systemClock));
  }

  it('deleting an activity deletes the insight of its week only, in the owner\'s own rows only', async () => {
    await seedActivity('2026-10-07T10:00:00Z');
    await asOwner((client) => deleteActivity(client, owner, ids.orgA, activityId));
    expect(await insights()).toEqual(without('owner@2026-10-05'));
  });

  it('places an activity by its start instant within the half-open week range', async () => {
    await seedActivity('2026-10-12T00:00:00Z'); // exactly where the week of 2026-10-12 begins
    await asOwner((client) => deleteActivity(client, owner, ids.orgA, activityId));
    expect(await insights()).toEqual(without('owner@2026-10-12'));
  });

  it('deleting a check-in day deletes the insight of the week that contains its date', async () => {
    await seedDay('2026-10-11'); // a Sunday
    await asOwner((client) => deleteDailyMetrics(client, owner, ids.orgA, '2026-10-11'));
    expect(await insights()).toEqual(without('owner@2026-10-05'));
  });

  it('changing the values of a check-in deletes the week\'s insight; an exact retry or a note-only change does not', async () => {
    await seedDay('2026-10-12');
    expect(await insights()).toEqual(all);
    await asOwner((client) => putDailyMetrics(client, owner, ids.orgA, '2026-10-12', { mood: 3, note: 'n', timeZone: 'UTC' }, systemClock));
    await asOwner((client) => putDailyMetrics(client, owner, ids.orgA, '2026-10-12', { mood: 3, note: 'changed', timeZone: 'UTC' }, systemClock));
    expect(await insights()).toEqual(all);
    await asOwner((client) => putDailyMetrics(client, owner, ids.orgA, '2026-10-12', { mood: 4, note: 'changed', timeZone: 'UTC' }, systemClock));
    expect(await insights()).toEqual(without('owner@2026-10-12'));
  });

  it('deleting a GPS run through the owner deletion deletes the insight of its week', async () => {
    await asOwner((client) => deleteRun(client, owner, ids.orgA, ids.runFinishedHistory, systemClock));
    expect(await insights()).toEqual(without('owner@2026-09-14'));
  });

  it('keeps the insight when the deleting transaction rolls back', async () => {
    await seedActivity('2026-10-07T10:00:00Z');
    await expect(
      asOwner(async (client) => {
        await deleteActivity(client, owner, ids.orgA, activityId);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await insights()).toEqual(all);
  });

  it('the erasure replay deletes the insight of an erased activity\'s week, and a second replay is a no-op', async () => {
    const { createdAt } = await seedActivity('2026-10-07T10:00:00Z');
    const replay = () =>
      ownerPool.query<{ outcome: string }>('SELECT app_private.reapply_erasure($1, $2, $3, $4, $5) AS outcome', [
        'activity',
        ids.orgA,
        activityId,
        ids.userOrgA,
        createdAt,
      ]);
    expect((await replay()).rows[0]?.outcome).toBe('erased');
    expect(await insights()).toEqual(without('owner@2026-10-05'));
    expect((await replay()).rows[0]?.outcome).toBe('absent');
    expect(await insights()).toEqual(without('owner@2026-10-05'));
  });

  it('the erasure replay deletes the insight of an erased check-in day\'s week', async () => {
    await seedDay('2026-10-06');
    const day = await ownerPool.query<{ created_at: string; id: string }>(
      `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM daily_metrics WHERE org_id = $1 AND user_id = $2 AND local_date = $3`,
      [ids.orgA, ids.userOrgA, '2026-10-06'],
    );
    const replay = () =>
      ownerPool.query<{ outcome: string }>('SELECT app_private.reapply_erasure($1, $2, $3, $4, $5) AS outcome', [
        'daily_metric',
        ids.orgA,
        day.rows[0]!.id,
        ids.userOrgA,
        day.rows[0]!.created_at,
      ]);
    expect((await replay()).rows[0]?.outcome).toBe('erased');
    expect(await insights()).toEqual(without('owner@2026-10-05'));
    expect((await replay()).rows[0]?.outcome).toBe('absent');
    expect(await insights()).toEqual(without('owner@2026-10-05'));
  });

  it('the run deletion journal replay deletes the insight of a journaled run\'s week', async () => {
    const outcome = await ownerPool.query<{ outcome: string }>(
      'SELECT app_private.reapply_journaled_deletion($1, $2, $3, $4, $5) AS outcome',
      [ids.orgA, ids.runFinishedBoth, ids.userOrgA, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'],
    );
    expect(outcome.rows[0]?.outcome).toBe('deleted');
    expect(await insights()).toEqual(without('owner@2026-09-14'));
  });
});
