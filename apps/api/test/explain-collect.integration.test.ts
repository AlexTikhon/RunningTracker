import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { planDataset, smokeProfile, type DatasetPlan } from '../src/loadtest/dataset-plan.js';
import { collectExplain } from '../src/loadtest/explain-collect.js';
import { collectRelationStats } from '../src/loadtest/explain-relations.js';
import { planExplainStatements, type ExplainPlan, type ExplainStatement } from '../src/loadtest/explain-statements.js';
import { verifyDatasetMatchesPlan } from '../src/loadtest/load-dataset-check.js';
import { assertSafeResult } from '../src/loadtest/load-result.js';
import { seedDataset } from '../src/loadtest/seed-dataset.js';

const seed = 9_003;

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

describe('P11.4 EXPLAIN collection against real PostgreSQL/PostGIS (smoke profile)', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let maintenancePool: Pool;
  let dataset: DatasetPlan;
  let plan: ExplainPlan;

  async function removeDataset(): Promise<void> {
    await ownerPool.query('DELETE FROM runs WHERE org_id = $1', [dataset.organizationId]);
    await ownerPool.query('DELETE FROM memberships WHERE org_id = $1', [dataset.organizationId]);
    await ownerPool.query('DELETE FROM organizations WHERE id = $1', [dataset.organizationId]);
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [dataset.users.map((user) => user.id)]);
  }

  async function count(text: string): Promise<number> {
    const result = await ownerPool.query<{ count: string }>(text, [dataset.organizationId]);
    return Number(result.rows[0]?.count);
  }

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const asOf = utcMidnight(new Date());
    dataset = planDataset(smokeProfile, seed, asOf);
    plan = planExplainStatements(dataset, { now: new Date() });
    ownerPool = new Pool({ connectionString: integration.migration.connectionString, max: 2 });
    runtimePool = new Pool({ connectionString: integration.runtime.connectionString, max: 2 });
    maintenancePool = new Pool({ connectionString: integration.maintenance.connectionString, max: 2 });
    await removeDataset();
    await seedDataset(ownerPool, {
      allowedDatabaseSuffixes: ['_test'],
      asOf,
      profile: smokeProfile,
      requireEmptyDatabase: false,
      seed,
    });
  }, 120_000);

  afterAll(async () => {
    await removeDataset();
    await Promise.all([ownerPool.end(), runtimePool.end(), maintenancePool.end()]);
  });

  it('measures every planned statement under its own role with a plan summary per repetition', async () => {
    const collection = await collectExplain({ maintenancePool, ownerPool, plan, repetitions: 2, runtimePool });

    expect(collection.statements.map(({ name }) => name)).toEqual(plan.statements.map(({ name }) => name));
    for (const measurement of collection.statements) {
      expect(measurement.error, measurement.name).toBeNull();
      expect(measurement.executions, measurement.name).toHaveLength(2);
      expect(measurement.executions[0]?.executionMs, measurement.name).toBeGreaterThan(0);
      expect(measurement.executedAs, measurement.name).toBe(
        { maintenance: 'running_tracker_maintenance', owner: 'running_tracker_owner', runtime: 'running_tracker_runtime' }[
          measurement.role
        ],
      );
    }
    assertSafeResult(collection, []);
  }, 120_000);

  it('keeps the raw first plan of each statement only when asked, so plans with literal values stay opt-in', async () => {
    const only: ExplainPlan = { ...plan, statements: plan.statements.filter(({ name }) => name === 'live-changes/one-batch') };

    const without = await collectExplain({ maintenancePool, ownerPool, plan: only, repetitions: 1, runtimePool });
    const withPlans = await collectExplain({ keepPlans: true, maintenancePool, ownerPool, plan: only, repetitions: 1, runtimePool });

    expect(without.statements[0]?.plan).toBeNull();
    const document = withPlans.statements[0]?.plan as { Plan?: { 'Node Type'?: string } }[] | null;
    expect(document?.[0]?.Plan?.['Node Type']).toEqual(expect.any(String));
  }, 120_000);

  it('reports response bytes and elapsed time from the real service call for first pages and tiles', async () => {
    const collection = await collectExplain({ maintenancePool, ownerPool, plan, repetitions: 2, runtimePool });
    const byName = new Map(collection.statements.map((measurement) => [measurement.name, measurement]));

    for (const name of [
      'run-list/coach-page',
      'raw-history/first-page',
      'live-snapshot/first-page',
      'live-changes/one-batch',
      'live-state/ten-active-runs',
    ]) {
      const response = byName.get(name)?.response;
      expect(response?.bytes, name).toBeGreaterThan(2);
      expect(response?.elapsedMs, name).toHaveLength(2);
    }
    expect(byName.get('raw-history/deep-page')?.response).toBeNull();
    // A tile response is a byte count that may legitimately be zero for a region with no run in view.
    const tile = byName.get('tile/taveuni-antimeridian/z9')?.response;
    expect(tile?.bytes).toBeGreaterThanOrEqual(0);
    expect(tile?.serializeMs).toEqual([]);
  }, 120_000);

  it('reads the live state of ten recording runs and leaves the dataset exactly as it was found', async () => {
    const collection = await collectExplain({ maintenancePool, ownerPool, plan, repetitions: 1, runtimePool });

    expect(collection.activatedRuns).toBe(dataset.users.length);
    await verifyDatasetMatchesPlan(ownerPool, dataset);
    expect(await count(`SELECT count(*) FROM runs WHERE org_id = $1 AND status <> 'finished'`)).toBe(0);
    const liveState = collection.statements.find(({ name }) => name === 'live-state/ten-active-runs');
    expect(liveState?.response?.bytes).toBeGreaterThan(dataset.users.length * 100);
  }, 120_000);

  it('rolls back the ingest and publish statements without leaving a row, revision, or summary change', async () => {
    const points = await count('SELECT count(*) FROM run_points WHERE org_id = $1');
    const revisions = await ownerPool.query<{ id: string; data_revision: string }>(
      'SELECT id, data_revision::text FROM runs WHERE org_id = $1 ORDER BY id',
      [dataset.organizationId],
    );
    const summaries = await ownerPool.query<{ run_id: string; computed_at: Date }>(
      'SELECT run_id, computed_at FROM run_summaries WHERE org_id = $1 ORDER BY run_id',
      [dataset.organizationId],
    );

    const collection = await collectExplain({ maintenancePool, ownerPool, plan, repetitions: 2, runtimePool });

    const ingest = collection.statements.find(({ name }) => name === 'ingest/batch-of-100');
    expect(ingest?.executions[0]?.wal.records).toBeGreaterThan(0);
    expect(ingest?.executions[0]?.triggers.length).toBeGreaterThan(0);
    expect(await count('SELECT count(*) FROM run_points WHERE org_id = $1')).toBe(points);
    expect(
      (
        await ownerPool.query<{ id: string; data_revision: string }>(
          'SELECT id, data_revision::text FROM runs WHERE org_id = $1 ORDER BY id',
          [dataset.organizationId],
        )
      ).rows,
    ).toEqual(revisions.rows);
    expect(
      (
        await ownerPool.query<{ run_id: string; computed_at: Date }>(
          'SELECT run_id, computed_at FROM run_summaries WHERE org_id = $1 ORDER BY run_id',
          [dataset.organizationId],
        )
      ).rows,
    ).toEqual(summaries.rows);
  }, 120_000);

  it('records a failing statement by SQLSTATE and class only, keeps measuring, and still restores the dataset', async () => {
    const failing: ExplainStatement = {
      description: 'Deliberately invalid statement',
      group: 'live-state',
      mode: 'read',
      name: 'test/invalid-cast',
      needs: 'active-runs',
      role: 'runtime',
      sql: `SELECT 'secret-looking-value'::integer`,
      staticValues: [],
      tenant: plan.statements.find(({ group }) => group === 'live-state')?.tenant ?? null,
    };
    const tail = plan.statements.find(({ group }) => group === 'ingest');
    const custom: ExplainPlan = { ...plan, statements: [failing, ...(tail ? [tail] : [])] };

    const collection = await collectExplain({ maintenancePool, ownerPool, plan: custom, repetitions: 1, runtimePool });

    const [broken, following] = collection.statements;
    expect(broken?.error).toEqual({ code: '22P02', errorClass: 'DatabaseError' });
    expect(JSON.stringify(broken)).not.toContain('secret-looking-value');
    expect(following?.error).toBeNull();
    await verifyDatasetMatchesPlan(ownerPool, dataset);
  }, 120_000);

  it('restores the recording fixture when collection is aborted between statements', async () => {
    const controller = new AbortController();
    const activeOnly: ExplainPlan = {
      ...plan,
      statements: plan.statements.filter(({ needs }) => needs === 'active-runs'),
    };
    let activeAtAbort = 0;

    await expect(
      collectExplain({
        maintenancePool,
        onProgress: async (name) => {
          // The first statement announced here already runs with the fixture in place.
          activeAtAbort = await count(`SELECT count(*) FROM runs WHERE org_id = $1 AND status = 'recording'`);
          if (name === 'ingest/batch-of-100') {
            controller.abort(new Error('cancelled'));
          }
        },
        ownerPool,
        plan: activeOnly,
        repetitions: 1,
        runtimePool,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(activeAtAbort).toBe(dataset.users.length);
    await verifyDatasetMatchesPlan(ownerPool, dataset);
  }, 120_000);

  it('reports relation and index sizes, live and dead tuples, and the settings that shape plans', async () => {
    const stats = await collectRelationStats(ownerPool);

    const points = stats.tables.find(({ name }) => name === 'run_points');
    expect(points?.liveTuples).toBeGreaterThan(0);
    expect(points?.deadTuples).toBeGreaterThanOrEqual(0);
    expect(points?.totalBytes).toBeGreaterThan(points?.heapBytes ?? Number.MAX_SAFE_INTEGER);
    expect(points?.indexBytes).toBeGreaterThan(0);
    const primaryKey = stats.indexes.find(({ name }) => name === 'run_points_pkey');
    expect(primaryKey?.table).toBe('run_points');
    expect(primaryKey?.bytes).toBeGreaterThan(0);
    expect(stats.indexes.some(({ name }) => name.startsWith('run_summaries') && name.includes('geom'))).toBe(true);
    expect(stats.settings.map(({ name }) => name)).toEqual(expect.arrayContaining(['shared_buffers', 'work_mem', 'jit']));
    assertSafeResult(stats, []);
  });
});
