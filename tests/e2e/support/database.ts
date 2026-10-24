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

export interface ScenarioPeople {
  readonly coachUserId: string;
  readonly runnerUserId: string;
}

// The fixed people this suite owns in the _test database, a runner and a coach per pair: the suite users, and the
// demo people the web app's demo sign-in buttons send. Each pair has its own stored external identities.
function suitePairs(environment: E2eEnvironment): ReadonlyArray<ScenarioPeople & { readonly identityPrefix: string }> {
  return [
    { coachUserId: environment.coachUserId, identityPrefix: 'e2e|', runnerUserId: environment.runnerUserId },
    { coachUserId: environment.demoCoachUserId, identityPrefix: 'e2e|demo-', runnerUserId: environment.demoRunnerUserId },
  ];
}

function suitePair(environment: E2eEnvironment, people: ScenarioPeople) {
  const pair = suitePairs(environment).find(
    (candidate) => candidate.runnerUserId === people.runnerUserId && candidate.coachUserId === people.coachUserId,
  );
  if (pair === undefined) {
    throw new Error('A scenario can only be made of one of the fixed suite pairs');
  }
  return pair;
}

// Organizations whose members are all one of the two people of a pair. Only this suite creates such an
// organization (a scenario whose cleanup never ran, for instance after the process was killed), so they
// can be removed without touching another test's or a developer's rows. An organization with any other
// member, and an organization with no member, is never matched; nor is one of the other pair.
async function findStaleScenarioOrganizations(client: pg.Client, people: ScenarioPeople): Promise<string[]> {
  const result = await client.query<{ org_id: string }>(
    `SELECT org_id FROM memberships
     GROUP BY org_id
     HAVING bool_and(user_id IN ($1, $2))`,
    [people.runnerUserId, people.coachUserId],
  );
  return result.rows.map((row) => row.org_id);
}

// Removes what a killed or crashed earlier run left behind for one pair (the suite users unless told otherwise).
// The shared runner may have only one active run across all organizations (runs_one_active_per_user_idx), so one
// leaked recording run would make every later createRun fail with a conflict.
export async function removeStaleScenarioData(
  environment: E2eEnvironment,
  people: ScenarioPeople = environment,
): Promise<void> {
  await withOwnerTransaction(environment, async (client) => {
    await deleteOrganizations(client, await findStaleScenarioOrganizations(client, people));
  });
}

// A fresh organization with an active runner and an active coach, by default the suite users. The users of a pair
// are shared by the whole suite, so they are inserted with ON CONFLICT DO NOTHING and never removed per scenario.
export async function createScenarioData(
  environment: E2eEnvironment,
  people: ScenarioPeople = environment,
): Promise<ScenarioData> {
  const pair = suitePair(environment, people);
  const data: ScenarioData = {
    coachUserId: pair.coachUserId,
    orgId: randomUUID(),
    runnerUserId: pair.runnerUserId,
  };

  // Sweeps first so a test never depends on a clean database. This also removes the organization of any
  // scenario of the same pair still open in this process, so such scenarios must not overlap (one worker, see
  // playwright.config.ts). A scenario of the other pair is left alone.
  await removeStaleScenarioData(environment, pair);

  await withOwnerTransaction(environment, async (client) => {
    await client.query(
      `INSERT INTO users (id, external_identity)
       VALUES ($1, $3), ($2, $4)
       ON CONFLICT DO NOTHING`,
      [data.runnerUserId, data.coachUserId, `${pair.identityPrefix}runner`, `${pair.identityPrefix}coach`],
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

export interface ExtraOrganizations {
  readonly organizationIds: readonly string[];
  readonly outsiderUserIds: readonly string[];
}

// Organizations for the discovery scenarios, next to the scenario's own. Each is created with explicit
// memberships and removed by exact id (see removeExtraOrganizations), so nothing here can touch another row.
export async function createExtraOrganization(
  environment: E2eEnvironment,
  memberships: ReadonlyArray<{ readonly active: boolean; readonly userId: string }>,
): Promise<string> {
  const orgId = randomUUID();
  await withOwnerTransaction(environment, async (client) => {
    await client.query('INSERT INTO organizations (id) VALUES ($1)', [orgId]);
    for (const membership of memberships) {
      await client.query(
        "INSERT INTO memberships (org_id, user_id, role, active) VALUES ($1, $2, 'runner', $3)",
        [orgId, membership.userId, membership.active],
      );
    }
  });
  return orgId;
}

export interface FinishedRunSeed {
  // null: no summary at all, so the run is "still being processed" as far as search is concerned.
  readonly distanceM: number | null;
  readonly durationS?: number;
  readonly quality?: 'good' | 'insufficient' | 'poor';
  readonly startedAt: string;
  readonly userId: string;
}

// Finished runs with a published summary, written directly as the owner role in the scenario's organization, so a
// browser test does not wait for GPS ingestion and the summary worker. The summary carries the algorithm version the
// worker itself would write, otherwise the worker would rebuild it from the (absent) points. A run without a
// summary is marked purged so the worker, which only takes runs whose raw points are available, leaves it
// pending for the whole test. Removed with the organization (cascades), like every other row here.
export async function createFinishedRuns(
  environment: E2eEnvironment,
  orgId: string,
  runs: readonly FinishedRunSeed[],
): Promise<string[]> {
  return withOwnerTransaction(environment, async (client) => {
    const version = await client.query<{ version: string }>(
      'SELECT app_private.current_track_algorithm_version() AS version',
    );
    const algorithmVersion = version.rows[0]?.version;
    if (algorithmVersion === undefined) {
      throw new Error('The current algorithm version is unknown');
    }
    const ids: string[] = [];
    for (const run of runs) {
      const id = randomUUID();
      ids.push(id);
      const durationS = run.durationS ?? 1_800;
      const finishedAt = new Date(Date.parse(run.startedAt) + Math.max(durationS, 60) * 1_000).toISOString();
      await client.query(
        `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, raw_state)
         VALUES ($1, $2, $3, 'finished', $4, $4, $5, 1, $6)`,
        [orgId, id, run.userId, run.startedAt, finishedAt, run.distanceM === null ? 'purged' : 'available'],
      );
      if (run.distanceM !== null) {
        const quality = run.quality ?? 'good';
        const raw = quality === 'insufficient' ? 6 : Math.max(Math.round(durationS / 2), 2);
        const accepted = quality === 'insufficient' ? 0 : quality === 'poor' ? Math.round(raw * 0.7) : raw;
        await client.query(
          `INSERT INTO run_summaries (
             org_id, run_id, source_revision, algorithm_version, distance_m, observed_duration_s, quality_stats
           ) VALUES ($1, $2, 1, $3, $4, $5, $6::jsonb)`,
          [
            orgId,
            id,
            algorithmVersion,
            run.distanceM,
            durationS,
            JSON.stringify({
              acceptedEdgeCount: Math.max(accepted - 1, 0),
              acceptedPointCount: accepted,
              excessiveSpeedCount: 0,
              excessiveTimeGapCount: 0,
              insufficientData: quality === 'insufficient',
              nonpositiveTimeDeltaCount: 0,
              poorAccuracyPointCount: raw - accepted,
              rawPointCount: raw,
              segmentBreakCount: 0,
              seqGapCount: 0,
            }),
          ],
        );
      }
    }
    return ids;
  });
}

// An ordinary history share, written directly so a test can make a run readable to someone who is not its owner.
export async function shareRunHistory(
  environment: E2eEnvironment,
  orgId: string,
  runId: string,
  granteeUserId: string,
): Promise<void> {
  await withOwnerTransaction(environment, async (client) => {
    await client.query(
      `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_history, can_read_live)
       VALUES ($1, $2, $3, true, false)`,
      [orgId, runId, granteeUserId],
    );
  });
}

// Ends or restores one membership in place. The row is the scenario's own, so it is removed with the organization.
export async function setMembershipActive(
  environment: E2eEnvironment,
  orgId: string,
  userId: string,
  active: boolean,
): Promise<void> {
  await withOwnerTransaction(environment, async (client) => {
    const result = await client.query(
      'UPDATE memberships SET active = $3 WHERE org_id = $1 AND user_id = $2',
      [orgId, userId, active],
    );
    if (result.rowCount !== 1) {
      throw new Error('The membership does not exist');
    }
  });
}

// A person who is not a suite user, for an organization the suite users must never be shown.
export async function createOutsider(environment: E2eEnvironment): Promise<string> {
  const userId = randomUUID();
  await withOwnerTransaction(environment, async (client) => {
    await client.query('INSERT INTO users (id, external_identity) VALUES ($1, $2)', [
      userId,
      `e2e|outsider-${userId}`,
    ]);
  });
  return userId;
}

export async function removeExtraOrganizations(
  environment: E2eEnvironment,
  extra: ExtraOrganizations,
): Promise<void> {
  await withOwnerTransaction(environment, async (client) => {
    await deleteOrganizations(client, [...extra.organizationIds]);
    if (extra.outsiderUserIds.length > 0) {
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[...extra.outsiderUserIds]]);
    }
  });
}

// Provisions a person for OpenID Connect sign-in, the way the runbook does: the stored identity is
// `<issuer>|<subject>`. Only the two fixed suite users can be changed, so nothing else's identity is touched.
export async function setSuiteUserIdentity(
  environment: E2eEnvironment,
  userId: string,
  externalIdentity: string,
): Promise<void> {
  if (userId !== environment.runnerUserId && userId !== environment.coachUserId) {
    throw new Error('Only the fixed suite users can be given an identity');
  }
  await withOwnerTransaction(environment, async (client) => {
    const result = await client.query('UPDATE users SET external_identity = $2 WHERE id = $1', [
      userId,
      externalIdentity,
    ]);
    if (result.rowCount !== 1) {
      throw new Error('The suite user does not exist; create the scenario first');
    }
  });
}

// Deletes by the exact organization id this scenario created and nothing else.
export async function removeScenarioData(environment: E2eEnvironment, data: ScenarioData): Promise<void> {
  await withOwnerTransaction(environment, (client) => deleteOrganizations(client, [data.orgId]));
}

// Used by the Playwright global teardown. Sweeps stale scenario organizations of each pair, then deletes only
// the fixed suite users of both pairs. A suite user that still has a membership in an organization with another
// member is not this suite's data: it is reported by organization id, not worked around by deleting rows this
// call did not create.
export async function removeSuiteUsers(environment: E2eEnvironment): Promise<void> {
  const pairs = suitePairs(environment);
  const userIds = pairs.flatMap((pair) => [pair.runnerUserId, pair.coachUserId]);
  await withOwnerTransaction(environment, async (client) => {
    for (const pair of pairs) {
      await deleteOrganizations(client, await findStaleScenarioOrganizations(client, pair));
    }

    const remaining = await client.query<{ org_id: string }>(
      'SELECT DISTINCT org_id FROM memberships WHERE user_id = ANY($1::uuid[])',
      [userIds],
    );
    if (remaining.rows.length > 0) {
      throw new Error(
        'The e2e suite users still have memberships in organizations that have other members: ' +
          remaining.rows.map((row) => row.org_id).join(', '),
      );
    }

    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
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

// The server's own 24-hour auto-finish (app_private.auto_finish_runs, run by the maintenance role) with the clock
// moved 25 hours ahead, so every run still recording or paused becomes finished the way it does in production:
// status and data revision change, control revision does not. The function is global by design; this runs only
// against the disposable _test database, which the live connection confirms before anything is called.
export async function autoFinishRuns(environment: E2eEnvironment): Promise<number> {
  const client = new pg.Client({
    application_name: 'running-tracker-e2e-auto-finish',
    connectionString: environment.maintenanceDatabaseUrl,
  });
  await client.connect();
  try {
    const database = await client.query<{ name: string }>('SELECT current_database() AS name');
    const name = database.rows[0]?.name ?? '';
    if (!name.endsWith('_test')) {
      throw new Error(`Connected database "${name}" does not end in _test: the browser suite refuses to touch it`);
    }
    const result = await client.query<{ finished_count: number }>(
      "SELECT app_private.auto_finish_runs(now() + interval '25 hours') AS finished_count",
    );
    return result.rows[0]?.finished_count ?? 0;
  } finally {
    await client.end();
  }
}
