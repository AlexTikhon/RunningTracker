import type { Pool } from 'pg';

import { planDataset, type DatasetPlan, type DatasetProfile } from './dataset-plan.js';
import type { LoadScenarioPlan } from './load-scenario.js';

type Queryable = Pick<Pool, 'query'>;

/**
 * The run that exists in every dataset (member 0, most recent day) has a start time equal to the dataset
 * instant plus a constant that depends only on the profile and seed. Reading it back recovers the instant
 * the seeder used; `verifyDatasetMatchesPlan` then checks the whole dataset against it, so a wrong guess
 * cannot slip through.
 */
export async function resolveDatasetAsOf(
  pool: Queryable,
  profile: DatasetProfile,
  seed: number,
): Promise<Date> {
  const reference = planDataset(profile, seed, new Date(0));
  const run = reference.runs[0];
  if (!run) {
    throw new Error('The dataset plan is empty');
  }
  const result = await pool.query<{ started_at: Date }>(
    'SELECT started_at FROM runs WHERE org_id = $1 AND id = $2',
    [reference.organizationId, run.id],
  );
  const stored = result.rows[0]?.started_at;
  if (!stored) {
    throw new Error(
      `The ${profile.name} dataset for seed ${seed} is not in this database; seed it with npm run load:seed first`,
    );
  }
  return new Date(stored.getTime() - Date.parse(run.startedAt));
}

interface CheckOutcome {
  actual: number;
  expected: number;
  name: string;
}

/** Counts only; the message never names data values. */
export class DatasetMismatchError extends Error {
  public constructor(public readonly failed: readonly CheckOutcome[]) {
    super(
      `The database does not hold exactly the planned dataset (${failed
        .map(({ actual, expected, name }) => `${name}: found ${actual}, expected ${expected}`)
        .join('; ')}). ` +
        'Leftover load-run data can be removed with --cleanup-only; otherwise reseed with npm run load:seed -- --reset.',
    );
    this.name = 'DatasetMismatchError';
  }
}

async function count(pool: Queryable, text: string, values: unknown[]): Promise<number> {
  const result = await pool.query<{ count: string }>(text, values);
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * Proves the database is the planned dataset and nothing else: identities, run set and start times, raw
 * point and summary totals, and no active run. Leftovers of an earlier load run therefore fail the check.
 */
export async function verifyDatasetMatchesPlan(pool: Queryable, plan: DatasetPlan): Promise<void> {
  const organizationId = plan.organizationId;
  const userIds = plan.users.map((user) => user.id);
  const runIds = plan.runs.map((run) => run.id);
  const startedAt = plan.runs.map((run) => run.startedAt);

  const outcomes: CheckOutcome[] = [
    {
      actual: await count(pool, 'SELECT count(*) FROM organizations WHERE id = $1', [organizationId]),
      expected: 1,
      name: 'organizations',
    },
    {
      actual: await count(
        pool,
        'SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = ANY($2::uuid[])',
        [organizationId, userIds],
      ),
      expected: userIds.length,
      name: 'planned members',
    },
    {
      actual: await count(pool, 'SELECT count(*) FROM memberships WHERE org_id = $1', [organizationId]),
      expected: userIds.length,
      name: 'members',
    },
    {
      actual: await count(
        pool,
        `SELECT count(*)
         FROM runs AS run
         JOIN unnest($2::uuid[], $3::timestamptz[]) AS planned(id, started_at)
           ON planned.id = run.id AND planned.started_at = run.started_at
         WHERE run.org_id = $1`,
        [organizationId, runIds, startedAt],
      ),
      expected: runIds.length,
      name: 'planned runs',
    },
    {
      actual: await count(pool, 'SELECT count(*) FROM runs WHERE org_id = $1', [organizationId]),
      expected: runIds.length,
      name: 'runs',
    },
    {
      actual: await count(pool, `SELECT count(*) FROM runs WHERE org_id = $1 AND status <> 'finished'`, [
        organizationId,
      ]),
      expected: 0,
      name: 'active runs',
    },
    {
      actual: await count(pool, 'SELECT count(*) FROM run_points WHERE org_id = $1', [organizationId]),
      expected: plan.profile.rawPointBudget,
      name: 'raw points',
    },
    {
      actual: await count(pool, 'SELECT count(*) FROM run_summaries WHERE org_id = $1', [organizationId]),
      expected: runIds.length,
      name: 'summaries',
    },
  ];
  const failed = outcomes.filter(({ actual, expected }) => actual !== expected);
  if (failed.length > 0) {
    throw new DatasetMismatchError(failed);
  }
}

/**
 * Removes exactly the runs the load scenario creates (identified by their deterministic IDs) and what
 * cascades from them. This is test tooling run as the object owner; it leaves no tombstone or journal row,
 * so the deterministic IDs stay reusable. Returns the number of runs removed.
 */
export async function cleanupLoadRuns(pool: Queryable, scenario: LoadScenarioPlan): Promise<number> {
  const runIds = [...scenario.activeRuns, scenario.summaryRun].map((run) => run.runId);
  const result = await pool.query('DELETE FROM runs WHERE org_id = $1 AND id = ANY($2::uuid[])', [
    scenario.organizationId,
    runIds,
  ]);
  return result.rowCount ?? 0;
}

export async function readDatabaseVersions(pool: Queryable): Promise<{ postgis: string; postgres: string }> {
  const result = await pool.query<{ postgis: string; postgres: string }>(
    'SELECT version() AS postgres, postgis_version() AS postgis',
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('The database did not report its version');
  }
  return row;
}

const warningDayMs = 24 * 60 * 60 * 1_000;

/**
 * The scenario browses an archive window of 366 days ending an hour after now. A dataset seeded for a much
 * older or later instant is only partly (or not at all) inside it, so tile bursts would mostly hit empty tiles.
 */
export function datasetInstantWarning(asOf: Date, now: Date): string | null {
  const offset = asOf.getTime() - now.getTime();
  if (offset > warningDayMs) {
    return `The dataset instant ${asOf.toISOString()} is in the future; seeded runs fall outside the archive window used by the tile bursts. Reseed with the default instant.`;
  }
  if (offset < -2 * warningDayMs) {
    return `The dataset instant ${asOf.toISOString()} is more than two days older than now; the oldest seeded runs fall outside the archive window used by the tile bursts.`;
  }
  return null;
}
