import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { authedApi, signIn } from './support/api.js';
import { countScenarioRows, createScenarioData, removeScenarioData } from './support/database.js';
import { loadE2eEnvironment } from './support/environment.js';
import { expect, test } from './support/fixtures.js';

const environment = loadE2eEnvironment();

// The failed-test record. A test that fails on purpose cannot hand data to the next test through a
// variable: Playwright may restart the worker after a failure, so the hand-over goes through a file.
const failedTestRecord = resolve(import.meta.dirname, 'test-results', 'harness-failed-test.json');

interface FailedTestRecord {
  readonly orgId: string;
  readonly rowsBeforeFailure: { readonly memberships: number; readonly organizations: number; readonly runs: number };
}

test('harness: fixtures and API helper work against the real stack', async ({ browser }) => {
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
    await runnerContext.close();
    await coachContext.close();
    await removeScenarioData(environment, data);
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

  test('harness: the data of the failed test is gone', async () => {
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
