import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState, readDurableRunStatus, takeOverWriterBehindThePage } from './support/browser-storage.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// ADR-0059 in the browser, against the real IndexedDB: a lifecycle answer belongs to the writer epoch that sent the
// request. The Pause below is sent and committed while this tab owns the lease, its answer is held, another epoch
// takes over and leaves no active run, and this same tab then owns the lease again under a newer epoch. The held
// answer arrives last. A boolean "do I own it now?" check says yes at that moment; the acknowledgement transaction
// must still refuse it, because it is checked against the epoch the Pause began with.

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fence(page: Page): Promise<number> {
  const runner = new RunnerPage(page);
  return Number(/fence (\d+)/.exec((await runner.card('Writer').detail.textContent()) ?? '')?.[1]);
}

test('a Pause answer held across a takeover cannot restore the run that another writer epoch moved off', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Writer').value).toHaveText('owned');
  const runId = await runner.runId(api, scenario.orgId);
  const firstFence = await fence(page);
  expect(firstFence).toBeGreaterThan(0);

  // The server commits the Pause; its answer is held in the browser.
  const committed = deferred();
  const release = deferred();
  const commands: string[] = [];
  await page.route('**/commands', async (route) => {
    commands.push(route.request().method());
    const response = await route.fetch();
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await committed.promise;
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).pendingCommandIds).toHaveLength(1);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('paused');

  // Another epoch takes over, settles the queued Pause, leaves no active run and closes.
  await takeOverWriterBehindThePage(page, scenario.runnerUserId);
  await expect(runner.card('Writer').value).toHaveText('lost', { timeout: 20_000 });

  // This tab, the same owner, takes the lease again: an epoch newer than both earlier ones. Ownership is now true.
  await page.getByRole('button', { name: 'Retry ownership' }).click();
  await expect(runner.card('Writer').value).toHaveText('owned');
  expect(await fence(page)).toBeGreaterThan(firstFence + 1);

  // The old answer arrives. It is not acknowledged: the pointer stays empty and nothing is queued again.
  release.resolve();
  await expect(runner.card('Recording').value).toHaveText('idle');
  await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
  await expect(page.getByText('Request not confirmed')).toHaveCount(0);
  const durable = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(durable.activeRunId).toBeNull();
  expect(durable.pendingCommandIds).toEqual([]);
  expect(await readDurableRunStatus(page, scenario.runnerUserId)).toBeNull();

  // A reload restores what the new epoch left, not the old answer.
  await page.reload();
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
  // The Pause was sent once, before the takeover; the server keeps it under its own revision.
  expect(commands).toEqual(['POST']);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('paused');
});
