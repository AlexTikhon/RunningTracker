import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import pg from 'pg';

import { authedApi, signIn } from './support/api.js';
import { countScenarioRows, createScenarioData, removeScenarioData } from './support/database.js';
import type { E2eEnvironment } from './support/environment.js';
import { expect, test } from './support/fixtures.js';

// The failed-test record. A test that fails on purpose cannot hand data to the next test through a
// variable: Playwright may restart the worker after a failure, so the hand-over goes through a file.
const failedTestRecord = resolve(import.meta.dirname, 'test-results', 'harness-failed-test.json');

interface FailedTestRecord {
  readonly orgId: string;
  readonly rowsBeforeFailure: { readonly memberships: number; readonly organizations: number; readonly runs: number };
}

test('harness: fixtures and API helper work against the real stack', async ({ browser, environment }) => {
  const data = await createScenarioData(environment);
  const runnerContext = await browser.newContext();
  const coachContext = await browser.newContext();

  try {
    await signIn(runnerContext, environment, data.runnerUserId);
    const runner = await authedApi(runnerContext, environment);
    const runId = randomUUID();

    const created = await runner.createRun(data.orgId, runId);
    expect(created.status).toBe('recording');
    expect(await runner.listRunIds(data.orgId)).toContain(runId);

    await runner.putShare(data.orgId, runId, data.coachUserId, { canReadHistory: true, canReadLive: true });

    await signIn(coachContext, environment, data.coachUserId);
    const coach = await authedApi(coachContext, environment);
    expect((await coach.getRun(data.orgId, runId)).runId).toBe(runId);

    await runner.deleteShare(data.orgId, runId, data.coachUserId);
    await expect(coach.getRun(data.orgId, runId)).rejects.toThrow(/404/);

    expect(await runner.getAllPoints(data.orgId, runId)).toEqual([]);
  } finally {
    // Cleanup first: a close that throws must not skip it.
    try {
      await removeScenarioData(environment, data);
    } finally {
      await runnerContext.close().catch(() => undefined);
      await coachContext.close().catch(() => undefined);
    }
  }

  expect(await countScenarioRows(environment, data.orgId)).toEqual({
    memberships: 0,
    organizations: 0,
    runShares: 0,
    runs: 0,
  });
});

// The two tests below run in this order with one worker (see playwright.config.ts). They are in a serial
// group so the order is part of the contract and a failure of the first one cannot silently skip the second.
test.describe.serial('harness: cleanup after a failed test', () => {
  test('harness: a deliberately failing test leaves data behind for the cleanup to remove', async ({
    browser,
    environment,
    scenario,
  }) => {
    // The failure below is expected. Anything that goes wrong earlier would also count as the expected
    // failure, so the record is written only after the data is proven to exist: the next test then fails
    // loudly if the record is missing or the data it describes never existed.
    test.fail();
    rmSync(failedTestRecord, { force: true });

    const context = await browser.newContext();
    try {
      await signIn(context, environment, scenario.runnerUserId);
      const runner = await authedApi(context, environment);
      await runner.createRun(scenario.orgId, randomUUID());

      const rowsBeforeFailure = await countScenarioRows(environment, scenario.orgId);
      mkdirSync(dirname(failedTestRecord), { recursive: true });
      writeFileSync(
        failedTestRecord,
        JSON.stringify({
          orgId: scenario.orgId,
          rowsBeforeFailure: {
            memberships: rowsBeforeFailure.memberships,
            organizations: rowsBeforeFailure.organizations,
            runs: rowsBeforeFailure.runs,
          },
        } satisfies FailedTestRecord),
      );
    } finally {
      await context.close();
    }

    throw new Error('deliberate failure: the scenario fixture must still remove the data');
  });

  test('harness: the data of the failed test is gone', async ({ environment }) => {
    const record = JSON.parse(readFileSync(failedTestRecord, 'utf8')) as FailedTestRecord;
    // A record is consumed once, so a stale one from an earlier run can never satisfy a later run.
    rmSync(failedTestRecord, { force: true });

    expect(record.rowsBeforeFailure).toEqual({ memberships: 2, organizations: 1, runs: 1 });
    expect(await countScenarioRows(environment, record.orgId)).toEqual({
      memberships: 0,
      organizations: 0,
      runShares: 0,
      runs: 0,
    });
  });
});

// Rows of one organization, removed by its exact id. Used only by the stale-organization test, which
// plants rows with the owner login and so must remove them without relying on the code under test.
async function deleteOrganizationByExactId(client: pg.Client, orgId: string): Promise<void> {
  for (const table of ['run_commands', 'run_shares', 'runs', 'run_tombstones', 'memberships']) {
    await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await client.query('DELETE FROM access_restriction_journal WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM run_deletion_journal WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
}

async function plantStaleOrganization(
  client: pg.Client,
  environment: E2eEnvironment,
  orgId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, external_identity)
     VALUES ($1, 'e2e|runner'), ($2, 'e2e|coach')
     ON CONFLICT DO NOTHING`,
    [environment.runnerUserId, environment.coachUserId],
  );
  await client.query('INSERT INTO organizations (id) VALUES ($1)', [orgId]);
  await client.query(
    `INSERT INTO memberships (org_id, user_id, role, active)
     VALUES ($1, $2, 'runner', true), ($1, $3, 'coach', true)`,
    [orgId, environment.runnerUserId, environment.coachUserId],
  );
  // The shared runner has an active run in the leaked organization, as after a killed run.
  await client.query(`INSERT INTO runs (org_id, id, user_id, status) VALUES ($1, $2, $3, 'recording')`, [
    orgId,
    randomUUID(),
    environment.runnerUserId,
  ]);
}

test('harness: creating scenario data sweeps the organization a killed run leaked', async ({
  browser,
  environment,
}) => {
  const leakedOrgId = randomUUID();
  const unrelatedOrgId = randomUUID();
  const outsiderUserId = randomUUID();
  const owner = new pg.Client({ connectionString: environment.ownerDatabaseUrl });
  await owner.connect();
  let data: Awaited<ReturnType<typeof createScenarioData>> | undefined;
  const context = await browser.newContext();

  try {
    await plantStaleOrganization(owner, environment, leakedOrgId);

    // An organization that is not stale: a member who is not a suite user, next to the shared runner.
    await owner.query('INSERT INTO users (id, external_identity) VALUES ($1, $2)', [
      outsiderUserId,
      `e2e-unrelated|${outsiderUserId}`,
    ]);
    await owner.query('INSERT INTO organizations (id) VALUES ($1)', [unrelatedOrgId]);
    await owner.query(
      `INSERT INTO memberships (org_id, user_id, role, active)
       VALUES ($1, $2, 'runner', true), ($1, $3, 'coach', true)`,
      [unrelatedOrgId, environment.runnerUserId, outsiderUserId],
    );

    data = await createScenarioData(environment);

    // The leaked active run no longer blocks the shared runner: a new run is accepted.
    await signIn(context, environment, data.runnerUserId);
    const runner = await authedApi(context, environment);
    expect((await runner.createRun(data.orgId, randomUUID())).status).toBe('recording');

    expect(await countScenarioRows(environment, leakedOrgId)).toEqual({
      memberships: 0,
      organizations: 0,
      runShares: 0,
      runs: 0,
    });
    expect(await countScenarioRows(environment, unrelatedOrgId)).toEqual({
      memberships: 2,
      organizations: 1,
      runShares: 0,
      runs: 0,
    });
  } finally {
    try {
      if (data) {
        await removeScenarioData(environment, data);
      }
      await deleteOrganizationByExactId(owner, leakedOrgId);
      await deleteOrganizationByExactId(owner, unrelatedOrgId);
      await owner.query('DELETE FROM users WHERE id = $1', [outsiderUserId]);
    } finally {
      await context.close().catch(() => undefined);
      await owner.end();
    }
  }
});
