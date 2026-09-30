import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { planDataset, smokeProfile, type DatasetPlan } from '../src/loadtest/dataset-plan.js';
import {
  cleanupLoadRuns,
  readDatabaseVersions,
  resolveDatasetAsOf,
  verifyDatasetMatchesPlan,
} from '../src/loadtest/load-dataset-check.js';
import { planLoadScenario, workloadProfiles } from '../src/loadtest/load-scenario.js';
import { seedDataset } from '../src/loadtest/seed-dataset.js';

const seed = 9_001;
const asOf = new Date(Date.UTC(2032, 2, 1));

describe('P11.3 dataset identity checks against real PostgreSQL', () => {
  let ownerPool: Pool;
  let plan: DatasetPlan;

  async function removeDataset(): Promise<void> {
    await ownerPool.query('DELETE FROM runs WHERE org_id = $1', [plan.organizationId]);
    await ownerPool.query('DELETE FROM memberships WHERE org_id = $1', [plan.organizationId]);
    await ownerPool.query('DELETE FROM organizations WHERE id = $1', [plan.organizationId]);
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [plan.users.map((user) => user.id)]);
  }

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    ownerPool = new Pool({
      application_name: 'running-tracker-p113-check',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    plan = planDataset(smokeProfile, seed, asOf);
    await removeDataset();
    await seedDataset(ownerPool, {
      allowedDatabaseSuffixes: ['_test'],
      asOf,
      profile: smokeProfile,
      requireEmptyDatabase: false,
      seed,
    });
  });

  afterEach(async () => {
    const scenario = planLoadScenario(plan, workloadProfiles.smoke as never);
    await cleanupLoadRuns(ownerPool, scenario);
  });

  afterAll(async () => {
    await removeDataset();
    await ownerPool.end();
  });

  it('derives the dataset instant from the seeded rows and refuses a wrong seed', async () => {
    await expect(resolveDatasetAsOf(ownerPool, smokeProfile, seed)).resolves.toEqual(asOf);
    await expect(resolveDatasetAsOf(ownerPool, smokeProfile, seed + 1)).rejects.toThrow(/dataset/iu);
  });

  it('accepts the untouched dataset', async () => {
    await expect(verifyDatasetMatchesPlan(ownerPool, plan)).resolves.toBeUndefined();
  });

  it('refuses a dataset of another instant, a leftover active run, and stray points', async () => {
    await expect(verifyDatasetMatchesPlan(ownerPool, planDataset(smokeProfile, seed, new Date(asOf.getTime() + 1)))).rejects.toThrow(
      /runs/iu,
    );

    const scenario = planLoadScenario(plan, workloadProfiles.smoke as never);
    const active = scenario.activeRuns[0];
    if (!active) {
      throw new Error('missing run');
    }
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, 'recording', now(), now(), 0, 0, 'available')`,
      [plan.organizationId, active.runId, active.userId],
    );
    await expect(verifyDatasetMatchesPlan(ownerPool, plan)).rejects.toThrow(/runs|active/iu);

    await ownerPool.query(
      `INSERT INTO run_points (org_id, run_id, seq, segment_id, recorded_at, received_at, geom, accuracy_m, ingested_revision)
       VALUES ($1, $2, 1, 0, now(), now(), ST_SetSRID(ST_MakePoint(1, 1), 4326), 5, 1)`,
      [plan.organizationId, active.runId],
    );
    await expect(verifyDatasetMatchesPlan(ownerPool, plan)).rejects.toThrow();
  });

  it('cleans up exactly the runs the load scenario owns and nothing else', async () => {
    const scenario = planLoadScenario(plan, workloadProfiles.smoke as never);
    const active = scenario.activeRuns[0];
    if (!active) {
      throw new Error('missing run');
    }
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, 'recording', now(), now(), 0, 0, 'available')`,
      [plan.organizationId, active.runId, active.userId],
    );
    await expect(cleanupLoadRuns(ownerPool, scenario)).resolves.toBe(1);
    await expect(cleanupLoadRuns(ownerPool, scenario)).resolves.toBe(0);
    await expect(verifyDatasetMatchesPlan(ownerPool, plan)).resolves.toBeUndefined();
  });

  it('reports the server versions', async () => {
    const versions = await readDatabaseVersions(ownerPool);
    expect(versions.postgres).toMatch(/^PostgreSQL /u);
    expect(versions.postgis).toMatch(/^\d/u);
  });
});
