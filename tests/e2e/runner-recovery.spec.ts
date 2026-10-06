import type { Route } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a committed lifecycle transition survives a newer upload ACK and reload', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  const commandReached = deferred();
  const releaseCommand = deferred();
  let committed = false;
  await page.route('**/commands', async (route) => {
    const response = await route.fetch();
    committed = true;
    commandReached.resolve();
    await releaseCommand.promise;
    await route.fulfill({ response });
  });
  const uploadAfterCommand = deferred();
  await page.route('**/points', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    await route.fulfill({ response });
    if (committed) uploadAfterCommand.resolve();
  });
  await runner.start();
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await commandReached.promise;
  await uploadAfterCommand.promise;
  releaseCommand.resolve();
  await expect(runner.card('Recording').value).toHaveText('paused');
  await runner.reload();
  await expect(runner.card('Recording').value).toHaveText('paused');
  await expect(runner.card('Capture').value).toHaveText('idle');
  const runId = await runner.runId(api, scenario.orgId);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('paused');
});

for (const code of ['UPLOAD_WINDOW_CLOSED', 'RUN_POINT_LIMIT']) {
  test(`${code}: export, reload and explicit discard unblock the next run`, async ({ context, environment, page, scenario }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const runner = new RunnerPage(page);
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    let rejected = 0;
    await page.route('**/points', async (route: Route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      rejected += 1;
      await route.fulfill({ status: code === 'RUN_POINT_LIMIT' ? 422 : 409, contentType: 'application/json', body: JSON.stringify({ error: { code, message: 'Points rejected', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }) });
    });
    await runner.start();
    await expect(runner.card('Upload').value).toHaveText('blocked');
    await expect(runner.card('Capture').value).toHaveText('idle');
    await runner.reload();
    await expect(runner.card('Upload').value).toHaveText('blocked');
    await expect(runner.card('Capture').value).toHaveText('idle');
    expect(rejected).toBe(1);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export buffered points' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^run-.*-buffer\.json$/);
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    await expect(page.getByRole('button', { name: 'New run', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Discard buffered points and clear run' }).click();
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
    await page.unroute('**/points');
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    await runner.waitForEmptyBuffer();
  });
}

test('401 suspends recording without reload and fresh session credentials resume retained points', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  let unauthorized = 0;
  await page.route('**/points', async (route) => {
    unauthorized += 1;
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SESSION_REQUIRED', message: 'Sign in', requestId: null } }) });
  });
  await runner.start();
  await expect(page.getByText('Sign in required', { exact: true })).toBeVisible();
  await expect(runner.card('Capture').value).toHaveText('idle');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  await expect(runner.card('Upload').value).toHaveText('suspended');
  await page.unroute('**/points');
  await signIn(context, environment, scenario.runnerUserId);
  await page.getByRole('button', { name: 'Retry session' }).click();
  await expect(page.getByText(/^Session ready/)).toBeVisible();
  await runner.waitForEmptyBuffer();
  await expect(runner.card('Capture').value).toHaveText('capturing');
  expect(unauthorized).toBe(1);
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');
});

test('a timed-out command retains its exact identity and succeeds on idempotent retry', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  const bodies: string[] = [];
  await page.route('**/commands', async (route) => {
    bodies.push(route.request().postData() ?? '');
    const response = await route.fetch();
    if (bodies.length === 1) return; // Commit on the API, withhold the response.
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(runner.card('Recording').value).toHaveText('error', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(runner.card('Recording').value).toHaveText('paused');
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
});
