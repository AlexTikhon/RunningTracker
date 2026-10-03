import { randomUUID } from 'node:crypto';

import pg from 'pg';

import type { E2eEnvironment } from './environment.js';

export interface ScenarioData {
  readonly orgId: string;
  readonly runnerUserId: string;
  readonly coachUserId: string;
}

export interface ScenarioRowCounts {
  readonly memberships: number;
  readonly organizations: number;
  readonly runShares: number;
  readonly runs: number;
}

// One short-lived owner connection per call, like scripts/demo-seed.mjs. The owner role is not subject to
// row-level security (no table forces it), so cleanup by exact organization id sees every row it created.
// The login is the migration role, which is why the database name is checked again on the live connection
// before anything else: the URL guard in environment.ts only looks at the text of the URL.
async function withOwnerClient<Result>(
  environment: E2eEnvironment,
  work: (client: pg.Client) => Promise<Result>,
): Promise<Result> {
  const client = new pg.Client({
    application_name: 'running-tracker-e2e',
    connectionString: environment.ownerDatabaseUrl,
  });
  await client.connect();
  try {
    const database = await client.query<{ name: string }>('SELECT current_database() AS name');
    const name = database.rows[0]?.name ?? '';
    if (!name.endsWith('_test')) {
      throw new Error(
        `Connected database "${name}" does not end in _test: the browser suite refuses to touch it`,
      );
    }
    return await work(client);
  } finally {
    await client.end();
  }
}

async function withOwnerTransaction<Result>(
  environment: E2eEnvironment,
  work: (client: pg.Client) => Promise<Result>,
): Promise<Result> {
  return withOwnerClient(environment, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

// Deletes the rows of the given organizations by exact id, children first. The cascading foreign keys on
// run_points and run_summaries (and on run_commands and run_shares) would cover most of this, but every
// table the suite can write to is named so the cleanup does not depend on that. The two journals have no
// foreign keys and are filled by triggers on the deletes below, so they are emptied after the memberships.
// Users are not touched here.
async function deleteOrganizations(client: pg.Client, orgIds: readonly string[]): Promise<void> {
  if (orgIds.length === 0) {
    return;
  }
  const ids = [orgIds];
  await client.query('DELETE FROM run_commands WHERE org_id = ANY($1::uuid[])', ids);
  await client.query('DELETE FROM run_shares WHERE org_id = ANY($1::uuid[])', ids);
  await client.query('DELETE FROM runs WHERE org_id = ANY($1::uuid[])', ids);
  await client.query('DELETE FROM run_tombstones WHERE org_id = ANY($1::uuid[])', ids);
  await client.query('DELETE FROM memberships WHERE org_id = ANY($1::uuid[])', ids);
  await client.query('DELETE FROM access_restriction_journal WHERE org_id = ANY($1::uuid[])', ids);
  await client.query('DELETE FROM run_deletion_journal WHERE org_id = ANY($1::uuid[])', ids);
  await client.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', ids);
}

// Organizations whose members are all one of the two fixed suite users. Only this suite creates such an
// organization (a scenario whose cleanup never ran, for instance after the process was killed), so they
// can be removed without touching another test's or a developer's rows. An organization with any other
// member, and an organization with no member, is never matched.
async function findStaleScenarioOrganizations(
  client: pg.Client,
  environment: E2eEnvironment,
): Promise<string[]> {
  const result = await client.query<{ org_id: string }>(
    `SELECT org_id FROM memberships
     GROUP BY org_id
     HAVING bool_and(user_id IN ($1, $2))`,
    [environment.runnerUserId, environment.coachUserId],
  );
  return result.rows.map((row) => row.org_id);
}

// Removes what a killed or crashed earlier run left behind. The shared runner may have only one active
// run across all organizations (runs_one_active_per_user_idx), so one leaked recording run would make every
// later createRun fail with a conflict.
export async function removeStaleScenarioData(environment: E2eEnvironment): Promise<void> {
  await withOwnerTransaction(environment, async (client) => {
    await deleteOrganizations(client, await findStaleScenarioOrganizations(client, environment));
  });
}

// A fresh organization with an active runner and an active coach. The two users are shared by the whole
// suite, so they are inserted with ON CONFLICT DO NOTHING and never removed per scenario.
export async function createScenarioData(environment: E2eEnvironment): Promise<ScenarioData> {
  const data: ScenarioData = {
    coachUserId: environment.coachUserId,
    orgId: randomUUID(),
    runnerUserId: environment.runnerUserId,
  };

  // Sweeps first so a test never depends on a clean database. This also removes the organization of any
  // scenario still open in this process, so scenarios must not overlap (one worker, see
  // playwright.config.ts).
  await removeStaleScenarioData(environment);

  await withOwnerTransaction(environment, async (client) => {
    await client.query(
      `INSERT INTO users (id, external_identity)
       VALUES ($1, 'e2e|runner'), ($2, 'e2e|coach')
       ON CONFLICT DO NOTHING`,
      [data.runnerUserId, data.coachUserId],
    );
    await client.query('INSERT INTO organizations (id) VALUES ($1)', [data.orgId]);
    await client.query(
      `INSERT INTO memberships (org_id, user_id, role, active)
       VALUES ($1, $2, 'runner', true), ($1, $3, 'coach', true)`,
      [data.orgId, data.runnerUserId, data.coachUserId],
    );
  });

  return data;
}

// Deletes by the exact organization id this scenario created and nothing else.
export async function removeScenarioData(environment: E2eEnvironment, data: ScenarioData): Promise<void> {
  await withOwnerTransaction(environment, (client) => deleteOrganizations(client, [data.orgId]));
}

// Used by the Playwright global teardown. Sweeps stale scenario organizations, then deletes only the two
// fixed suite users. A suite user that still has a membership in an organization with another member is
// not this suite's data: it is reported by organization id, not worked around by deleting rows this call
// did not create.
export async function removeSuiteUsers(environment: E2eEnvironment): Promise<void> {
  await withOwnerTransaction(environment, async (client) => {
    await deleteOrganizations(client, await findStaleScenarioOrganizations(client, environment));

    const remaining = await client.query<{ org_id: string }>(
      'SELECT DISTINCT org_id FROM memberships WHERE user_id IN ($1, $2)',
      [environment.runnerUserId, environment.coachUserId],
    );
    if (remaining.rows.length > 0) {
      throw new Error(
        'The e2e suite users still have memberships in organizations that have other members: ' +
          remaining.rows.map((row) => row.org_id).join(', '),
      );
    }

    await client.query('DELETE FROM users WHERE id IN ($1, $2)', [
      environment.runnerUserId,
      environment.coachUserId,
    ]);
  });
}

export async function countScenarioRows(
  environment: E2eEnvironment,
  orgId: string,
): Promise<ScenarioRowCounts> {
  return withOwnerClient(environment, async (client) => {
    const result = await client.query<Record<'memberships' | 'organizations' | 'run_shares' | 'runs', number>>(
      `SELECT (SELECT count(*)::int FROM runs WHERE org_id = $1) AS runs,
              (SELECT count(*)::int FROM run_shares WHERE org_id = $1) AS run_shares,
              (SELECT count(*)::int FROM memberships WHERE org_id = $1) AS memberships,
              (SELECT count(*)::int FROM organizations WHERE id = $1) AS organizations`,
      [orgId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('The row-count query returned no row');
    }
    return {
      memberships: row.memberships,
      organizations: row.organizations,
      runShares: row.run_shares,
      runs: row.runs,
    };
  });
}
