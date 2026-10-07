import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState } from './support/browser-storage.js';
import { autoFinishRuns } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// The server finishes a run that was left open for 24 hours (app_private.auto_finish_runs). That is not a control
// command, so it changes the status and the data revision and keeps the control revision. These scenarios put the
// browser in every position from which it could be talked back into an active run: a command response that was
// held across the finish, a reload, a reconnection, a server that does not answer.

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const runReadPath = /\/api\/orgs\/[^/]+\/runs\/[^/]+$/;

// The browser's own report of losing and regaining the connection, without touching any request in flight:
// navigator.onLine is overridden for the offline half and the real property comes back for the online half.
async function reconnect(page: Page, runner: RunnerPage): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(runner.card('Network').value).toHaveText('offline');
  await expect(runner.card('Server state').value).toHaveText('offline');
  await page.evaluate(() => {
    delete (navigator as unknown as { onLine?: boolean }).onLine;
    window.dispatchEvent(new Event('online'));
  });
  await expect(runner.card('Network').value).toHaveText('online');
}

async function startCapturingRun(page: Page, runner: RunnerPage, orgId: string): Promise<void> {
  await runner.open(orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
}

test('a delayed PAUSE response cannot undo an auto-finish the browser learned first', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await startCapturingRun(page, runner, scenario.orgId);
  const runId = await runner.runId(api, scenario.orgId);

  const committed = deferred();
  const release = deferred();
  await page.route('**/commands', async (route) => {
    const response = await route.fetch();
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await committed.promise;

  // The pause is committed (control revision 1, paused) but its response is held. The server then auto-finishes.
  expect(await autoFinishRuns(environment)).toBeGreaterThanOrEqual(1);
  const finished = await api.getRun(scenario.orgId, runId);
  expect(finished).toMatchObject({ controlRevision: '1', status: 'finished' });

  // The browser learns FINISHED while the pause is still pending: the lifecycle is already finished, capture stops.
  await reconnect(page, runner);
  await expect(runner.card('Recording').detail).toHaveText('finished');
  await expect(runner.card('Capture').value).toHaveText('idle');

  // The old PAUSE response is released: it carries control revision 1, the same as the finished run.
  release.resolve();
  await expect(runner.card('Recording').value).toHaveText('finished');
  await expect(runner.card('Recording').detail).toHaveText('finished');
  await expect(runner.card('Capture').value).toHaveText('idle');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);

  // A reload cannot bring it back either.
  await page.unroute('**/commands');
  await runner.reload();
  await expect(runner.card('Recording').value).toHaveText('finished');
  await expect(runner.card('Capture').value).toHaveText('idle');
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('finished');
});

test('refresh after an auto-finish: capture never starts, and the buffered points stay on this device', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await startCapturingRun(page, runner, scenario.orgId);
  const runId = await runner.runId(api, scenario.orgId);
  expect(await autoFinishRuns(environment)).toBeGreaterThanOrEqual(1);

  // The page is destroyed while still believing the run is recording; its answer from the server is held.
  const reached = deferred();
  const release = deferred();
  await page.route(runReadPath, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    reached.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await runner.reload();
  await reached.promise;

  // IndexedDB says recording, the writer lease is owned, nothing has told the page otherwise: capture must wait.
  await expect(runner.card('Server state').value).toHaveText('confirming');
  await expect(runner.card('Recording').detail).toHaveText('recording');
  await expect(runner.card('Capture').value).toHaveText('idle');
  await expect(page.getByRole('button', { name: 'Finish' })).toBeDisabled();

  release.resolve();
  await expect(runner.card('Recording').value).toHaveText('finished');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('idle');

  // Recoverable data is not deleted by not resuming: the run pointer stays until the person clears the run.
  const durable = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(durable.activeRunId).toBe(runId);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('finished');
});

test('refresh of a still-recording run: capture starts only after the server has confirmed it', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await startCapturingRun(page, runner, scenario.orgId);

  const reached = deferred();
  const release = deferred();
  await page.route(runReadPath, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    reached.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await runner.reload();
  await reached.promise;
  await expect(runner.card('Server state').value).toHaveText('confirming');
  await expect(runner.card('Capture').value).toHaveText('idle');

  release.resolve();
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(runner.card('Recording').value).toHaveText('recording');
});

test('an unreachable server is not a verdict: capture stays stopped, local data stays, and it resumes when the server answers', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await startCapturingRun(page, runner, scenario.orgId);
  const runId = await runner.runId(api, scenario.orgId);

  let failures = 0;
  await page.route(runReadPath, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    failures += 1;
    await route.fulfill({ body: '{}', contentType: 'application/json', status: 503 });
  });
  await runner.reload();
  await expect(runner.card('Server state').value).toHaveText('unreachable');
  await expect(page.getByText('Confirming this run with the server')).toBeVisible();
  await expect(runner.card('Capture').value).toHaveText('idle');
  // The page does not conclude anything: still the stored recording run, nothing cleared, nothing finished.
  await expect(runner.card('Recording').detail).toHaveText('recording');
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(runId);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('recording');
  expect(failures).toBeGreaterThanOrEqual(1);

  await page.unroute(runReadPath);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('capturing');
});

test('reconnection with the run still active confirms it without interrupting the capture', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await startCapturingRun(page, runner, scenario.orgId);
  await expect(runner.card('Capture').detail).toHaveText(/^segment 0 · /);

  await reconnect(page, runner);
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  // Still the first capture segment: the capture was not stopped and restarted around the confirmation.
  await expect(runner.card('Capture').detail).toHaveText(/^segment 0 · /);
  await expect(runner.card('Recording').value).toHaveText('recording');
});

test('reconnection after the server finished the run stops capture and ends FINISHED', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await startCapturingRun(page, runner, scenario.orgId);
  expect(await autoFinishRuns(environment)).toBeGreaterThanOrEqual(1);

  await reconnect(page, runner);
  await expect(runner.card('Recording').value).toHaveText('finished');
  await expect(runner.card('Capture').value).toHaveText('idle');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
});
