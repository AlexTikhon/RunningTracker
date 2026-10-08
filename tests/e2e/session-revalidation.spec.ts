import type { Page, Route } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState } from './support/browser-storage.js';
import { expect, test } from './support/fixtures.js';
import { expectUniqueAndGapFree } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';
import { expectSignedIn, expectSignedOut } from './support/session.js';

// Re-checking the session when the page regains focus or visibility (ADR-0054). "The server could not be reached"
// and "the server said the session is gone" are different answers: only the second ends the session.

const sessionPath = /\/api\/session$/;
const unavailableNote = 'Cannot confirm your session right now';

function isSessionCheck(route: Route): boolean {
  return route.request().method() === 'GET' && sessionPath.test(new URL(route.request().url()).pathname);
}

// Answers every session check with `answer` and counts the checks that reached the route.
async function answerSessionChecks(page: Page, answer: (route: Route) => Promise<void>): Promise<{ count: () => number }> {
  let count = 0;
  await page.route('**/api/session', async (route) => {
    if (!isSessionCheck(route)) {
      await route.continue();
      return;
    }
    count += 1;
    await answer(route);
  });
  return { count: () => count };
}

// The same two events a browser raises when a tab comes back to the foreground.
async function comeBackToForeground(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function startCapturingRun(page: Page, runner: RunnerPage, orgId: string): Promise<void> {
  await runner.open(orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(page.getByText(unavailableNote)).toHaveCount(0);
}

async function expectRunUndisturbed(runner: RunnerPage): Promise<void> {
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Capture').value).not.toHaveText('idle');
  await expect(runner.card('Writer').value).toHaveText('owned');
}

const unavailableAnswers: ReadonlyArray<readonly [string, (route: Route) => Promise<void>]> = [
  ['a 503', (route) => route.fulfill({
    body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Try again later', requestId: crypto.randomUUID() } }),
    contentType: 'application/json',
    status: 503,
  })],
  ['a network failure', (route) => route.abort('failed')],
  ['a 429 with Retry-After', (route) => route.fulfill({
    body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Slow down', requestId: crypto.randomUUID() } }),
    contentType: 'application/json',
    headers: { 'retry-after': '1' },
    status: 429,
  })],
];

test.describe('session revalidation', () => {
  for (const [name, answer] of unavailableAnswers) {
    test(`${name} on focus does not end the session or stop a recording run, and the next good answer confirms it`, async ({
      context,
      environment,
      page,
      scenario,
    }) => {
      await signIn(context, environment, scenario.runnerUserId);
      const api = await authedApi(context, environment);
      const runner = new RunnerPage(page);
      await startCapturingRun(page, runner, scenario.orgId);
      const runId = await runner.runId(api, scenario.orgId);
      const checks = await answerSessionChecks(page, answer);

      await comeBackToForeground(page);

      // The note is the signal that the failed answer was processed; everything asserted after it is not racing it.
      await expect(page.getByText(unavailableNote)).toBeVisible();
      expect(checks.count()).toBeGreaterThanOrEqual(1);
      await expectSignedIn(page, scenario.runnerUserId);
      await expect(page.getByText('Not signed in', { exact: true })).toHaveCount(0);
      await expectRunUndisturbed(runner);
      // The points the run took are still being kept and delivered; nothing was dropped on the way.
      await expect.poll(async () => (await api.getAllPoints(scenario.orgId, runId)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

      // The server answers again: the same session is confirmed, with no sign-in and no restart of the run.
      await page.unroute('**/api/session');
      await comeBackToForeground(page);
      await expect(page.getByText(unavailableNote)).toHaveCount(0);
      await expectSignedIn(page, scenario.runnerUserId);
      await expectRunUndisturbed(runner);
      await runner.waitForCaptureComplete();
      await runner.waitForEmptyBuffer();
      await runner.finish();
      await expect(runner.card('Recording').value).toHaveText('finished');
    });
  }

  test('coming back online re-checks the session once the server answers, with one capture controller and gap-free points', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const api = await authedApi(context, environment);
    const runner = new RunnerPage(page);
    await startCapturingRun(page, runner, scenario.orgId);
    const runId = await runner.runId(api, scenario.orgId);
    await answerSessionChecks(page, (route) => route.abort('internetdisconnected'));

    await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
    await expect(page.getByText(unavailableNote)).toBeVisible();
    await expectRunUndisturbed(runner);

    await page.unroute('**/api/session');
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
    await expect(page.getByText(unavailableNote)).toHaveCount(0);
    await expectSignedIn(page, scenario.runnerUserId);
    await expectRunUndisturbed(runner);

    await runner.waitForCaptureComplete();
    await runner.waitForEmptyBuffer();
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    expectUniqueAndGapFree(await api.getAllPoints(scenario.orgId, runId));
  });

  test('a reload while the session cannot be checked claims no session and resumes nothing; the run recovers once it can', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const api = await authedApi(context, environment);
    const runner = new RunnerPage(page);
    await startCapturingRun(page, runner, scenario.orgId);
    const runId = await runner.runId(api, scenario.orgId);
    await expect.poll(async () => (await api.getAllPoints(scenario.orgId, runId)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await answerSessionChecks(page, (route) => route.abort('failed'));

    await page.reload();

    // Nothing was confirmed on this page, so it is not signed in, and it says why in words that are not "expired".
    await expect(page.getByText('Not signed in', { exact: true })).toBeVisible();
    await expect(page.getByText(/could not be reached to check your session/)).toBeVisible();
    await expect(page.getByText(/Your session ended/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    // The run is neither resumed nor touched: no capture, and everything durable is still there.
    await expect(runner.card('Capture').value).toHaveText('idle');
    expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(runId);

    // The server answers: the person is signed in as before, and the run comes back through the run's own authority.
    await page.unroute('**/api/session');
    await page.getByRole('button', { name: 'Retry session' }).click();
    await expectSignedIn(page, scenario.runnerUserId);
    await expect(runner.card('Recording').value).toHaveText('recording');
    await expect(runner.card('Server state').value).toHaveText('confirmed');
    await runner.waitForCaptureComplete();
    await runner.waitForEmptyBuffer();
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    expectUniqueAndGapFree(await api.getAllPoints(scenario.orgId, runId));
  });

  test('a real 401 on focus still signs the person out and keeps the unsent points on the device', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const runner = new RunnerPage(page);
    await startCapturingRun(page, runner, scenario.orgId);

    // The server forgets the session: the cookie is gone, so the next check is answered 401 by the real API.
    await context.clearCookies();
    await comeBackToForeground(page);

    await expectSignedOut(page);
    await expect(page.getByText(/Your session ended\./)).toBeVisible();
    await expect(page.getByText(unavailableNote)).toHaveCount(0);
    const durable = await readDurableRunnerState(page, scenario.runnerUserId);
    expect(durable.activeRunId).not.toBeNull();
  });
});
