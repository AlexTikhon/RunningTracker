import type { BrowserContext, Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState } from './support/browser-storage.js';
import type { E2eEnvironment } from './support/environment.js';
import { expect, test } from './support/fixtures.js';
import { expectUniqueAndGapFree, sortedSeqs } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';
import {
  expectOrganizationSelected,
  expectSignedIn,
  expectSignedOut,
  organizationRegion,
} from './support/session.js';

const sessionCookieName = 'running_tracker_session';

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
}

// A person coming back: a fresh session for the user, then the page notices it. Sign-in itself is the
// development session here; the provider journey is in the OpenID Connect project.
async function signInAgain(
  context: BrowserContext,
  environment: E2eEnvironment,
  page: Page,
  userId: string,
): Promise<void> {
  await signIn(context, environment, userId);
  await page.getByRole('button', { name: 'Retry session' }).click();
  await expectSignedIn(page, userId);
}

// Every point upload fails at the network, so what the runner captures stays buffered. Counts the attempts.
async function failPointUploads(page: Page): Promise<{ attempts: () => number }> {
  let attempts = 0;
  await page.route('**/points', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    attempts += 1;
    await route.abort('failed');
  });
  return { attempts: () => attempts };
}

// Points the runner has captured and that are still waiting in this browser. Read from the durable store: while the
// uploads fail, the Upload card shows the retry message instead of a count.
async function waitForBuffered(page: Page, userId: string, count: number): Promise<void> {
  await expect
    .poll(async () => (await readDurableRunnerState(page, userId)).bufferedSeqKeys.length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(count);
}

test.describe('explicit sign out', () => {
  test('ends the session on the server and in the browser, and every protected route says 401', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');
    await expectSignedIn(page, scenario.runnerUserId);
    await expectOrganizationSelected(page, scenario.orgId);
    expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(true);

    await signOut(page);

    // The person is told, in plain words, what happened and what comes next.
    await expect(page.getByText(/You are signed out\./)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    // The organization they had selected is no longer shown, and nothing can be started.
    await expect(organizationRegion(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
    // The cookie left the browser, and the server answers 401 to the session and to the protected reads.
    expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(false);
    for (const path of ['/api/session', '/api/organizations', `/api/orgs/${scenario.orgId}/archive/metadata?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`]) {
      expect((await context.request.get(`${environment.webOrigin}${path}`)).status(), path).toBe(401);
    }
    // Coach and Archive hold nothing either.
    const views = page.getByRole('navigation', { name: 'Application view' });
    await views.getByRole('button', { name: 'Coach' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'An active session is required' })).toBeVisible();

    // A reload does not bring it back.
    await page.reload();
    await expectSignedOut(page);
  });

  test('a failed sign-out leaves the person signed in and says so', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');
    await expectSignedIn(page, scenario.runnerUserId);
    await page.route('**/api/session', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'You are still signed in.' })).toBeVisible();
    await expectSignedIn(page, scenario.runnerUserId);
    expect((await context.cookies()).some((cookie) => cookie.name === sessionCookieName)).toBe(true);
    expect((await context.request.get(`${environment.webOrigin}/api/session`)).status()).toBe(200);

    // The same button works once the network does.
    await page.unroute('**/api/session');
    await signOut(page);
  });

  test('mid-run: the buffered points stay on this device, and the same person recovers and uploads each exactly once', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const api = await authedApi(context, environment);
    const runner = new RunnerPage(page);
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    const uploads = await failPointUploads(page);
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    await waitForBuffered(page, scenario.runnerUserId, 2);
    const runId = await runner.runId(api, scenario.orgId);
    // Before signing out the page says what it will leave behind.
    await expect(page.getByText(/Signing out stops recording\. Unsent points stay on this device/)).toBeVisible();
    const before = await readDurableRunnerState(page, scenario.runnerUserId);
    expect(before.activeRunId).toBe(runId);
    expect(before.bufferedSeqKeys.length).toBeGreaterThanOrEqual(2);

    await signOut(page);

    // Capture and upload stopped, and the page forgot the signed-out person's run.
    await expect(runner.card('Capture').value).toHaveText('idle');
    await expect(runner.card('Recording').value).toHaveText('idle');
    await expect(runner.card('Upload').detail).toHaveText('No buffered points');
    const attemptsAtSignOut = uploads.attempts();
    // Nothing durable was deleted: the same run pointer and every point buffered before are still there.
    const after = await readDurableRunnerState(page, scenario.runnerUserId);
    expect(after.activeRunId).toBe(runId);
    expect(after.bufferedSeqKeys.slice(0, before.bufferedSeqKeys.length)).toEqual(before.bufferedSeqKeys);

    // The same person signs in again: the run is restored, capture resumes, the retained points drain.
    await page.unroute('**/points');
    await signInAgain(context, environment, page, scenario.runnerUserId);
    await expect(page.getByText(/^#[0-9a-f]{8}$/)).toHaveText(`#${runId.slice(0, 8)}`);
    await expect(runner.card('Recording').value).toHaveText('recording');
    await runner.waitForCaptureComplete();
    await runner.waitForEmptyBuffer();
    expect(uploads.attempts()).toBe(attemptsAtSignOut);
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');

    const fresh = await authedApi(context, environment);
    const points = await fresh.getAllPoints(scenario.orgId, runId);
    expectUniqueAndGapFree(points);
    const delivered = new Set(sortedSeqs(points).map(String));
    for (const seqKey of before.bufferedSeqKeys) {
      expect(delivered.has(BigInt(seqKey).toString()), `buffered point ${seqKey} reached the server`).toBe(true);
    }
  });

  test('a lifecycle request pending at sign-out stays queued and is retried with its exact identity', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const runner = new RunnerPage(page);
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    const bodies: string[] = [];
    await page.route('**/commands', async (route) => {
      bodies.push(route.request().postData() ?? '');
      if (bodies.length === 1) {
        // Never answered: the request is in flight when the person signs out.
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => bodies.length).toBe(1);
    await expect(runner.card('Recording').value).toHaveText('pausing');
    const queued = await readDurableRunnerState(page, scenario.runnerUserId);
    expect(queued.pendingCommandIds).toHaveLength(1);

    await signOut(page);
    expect((await readDurableRunnerState(page, scenario.runnerUserId)).pendingCommandIds).toEqual(queued.pendingCommandIds);

    await signInAgain(context, environment, page, scenario.runnerUserId);
    await expect(page.getByRole('alert').filter({ hasText: 'Recovered an unacknowledged request' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect(runner.card('Recording').value).toHaveText('paused');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect((await readDurableRunnerState(page, scenario.runnerUserId)).pendingCommandIds).toEqual([]);
  });

  test('a rejected buffer is kept through sign-out and is still blocked, exportable and undeleted when the same person returns', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const runner = new RunnerPage(page);
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    await page.route('**/points', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        body: JSON.stringify({ error: { code: 'UPLOAD_WINDOW_CLOSED', message: 'Points rejected', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }),
        contentType: 'application/json',
        status: 409,
      });
    });
    await runner.start();
    await expect(runner.card('Upload').value).toHaveText('blocked');
    const before = await readDurableRunnerState(page, scenario.runnerUserId);
    expect(before.bufferedSeqKeys.length).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(/Unsent points stay on this device|Unsent data stays on this device|Signing out stops recording/)).toBeVisible();

    await signOut(page);
    expect(await readDurableRunnerState(page, scenario.runnerUserId)).toMatchObject({ bufferedSeqKeys: before.bufferedSeqKeys });

    await signInAgain(context, environment, page, scenario.runnerUserId);
    // Restored as blocked, not retried: capture stays off and the retained points can still be exported.
    await expect(runner.card('Upload').value).toHaveText('blocked');
    await expect(runner.card('Capture').value).toHaveText('idle');
    await expect(page.getByRole('alert').filter({ hasText: 'Buffered points were rejected' })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export buffered points' }).click();
    expect((await downloadPromise).suggestedFilename()).toMatch(/^run-.*-buffer.json$/);
    expect((await readDurableRunnerState(page, scenario.runnerUserId)).bufferedSeqKeys).toEqual(before.bufferedSeqKeys);
  });

  test('another person signing in on the same browser neither sees nor uploads the previous person’s run', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    const api = await authedApi(context, environment);
    const runner = new RunnerPage(page);
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    const uploads = await failPointUploads(page);
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    await waitForBuffered(page, scenario.runnerUserId, 2);
    const runId = await runner.runId(api, scenario.orgId);
    await signOut(page);
    const attemptsAtSignOut = uploads.attempts();
    const runnersState = await readDurableRunnerState(page, scenario.runnerUserId);
    expect(runnersState.bufferedSeqKeys.length).toBeGreaterThanOrEqual(2);

    // The coach signs in on this browser. Nothing of the runner's is shown or usable.
    await signInAgain(context, environment, page, scenario.coachUserId);
    await expectOrganizationSelected(page, scenario.orgId);
    await expect(runner.card('Recording').value).toHaveText('idle');
    await expect(runner.card('Upload').detail).toHaveText('No buffered points');
    await expect(runner.card('Capture').value).toHaveText('idle');
    await expect(page.getByText('No active run')).toBeVisible();
    await expect(page.getByText(`#${runId.slice(0, 8)}`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
    // The coach's own durable state is empty, the runner's is untouched, and the server run is not the coach's to read.
    expect(await readDurableRunnerState(page, scenario.coachUserId)).toEqual({
      activeRunId: null,
      bufferedSeqKeys: [],
      pendingCommandIds: [],
    });
    expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(runnersState);
    expect(await (await authedApi(context, environment)).listRunIds(scenario.orgId)).toEqual([]);
    expect(uploads.attempts()).toBe(attemptsAtSignOut);

    // Back as the runner: everything is still there and is delivered once.
    await signOut(page);
    await page.unroute('**/points');
    await signInAgain(context, environment, page, scenario.runnerUserId);
    await expect(runner.card('Recording').value).toHaveText('recording');
    await runner.waitForCaptureComplete();
    await runner.waitForEmptyBuffer();
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    expectUniqueAndGapFree(await (await authedApi(context, environment)).getAllPoints(scenario.orgId, runId));
  });
});
