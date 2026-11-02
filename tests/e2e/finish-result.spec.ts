import { archiveTrackResponseSchema } from '@running-tracker/contracts';
import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState } from './support/browser-storage.js';
import { publishFinishedRunSummary } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectUniqueAndGapFree } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';
import { expectSignedOut } from './support/session.js';

test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });
const details = (page: Page) => page.getByRole('region', { name: 'Run details', exact: true });
const statistics = (page: Page) => details(page).getByLabel('Run statistics');
const synchronization = (page: Page) => details(page).getByRole('region', { name: 'GPS synchronization' });
const trackRequest = /\/runs\/[^/]+\/track\?mode=archive$/;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('Finish -> result: pending/stale publication, refresh, Back focus and New run preserve the recorded run', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId); await runner.useSimulator(); await runner.start();
  await runner.waitForCaptureComplete(); await runner.waitForEmptyBuffer();
  await expect(page.getByRole('button', { name: 'View result', exact: true })).toHaveCount(0);
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');
  const runId = await runner.runId(api, scenario.orgId);
  await publishFinishedRunSummary(environment, scenario.orgId, runId);
  const before = await readDurableRunnerState(page, scenario.runnerUserId);
  // Hold the represented worker state independently of the periodic worker's scheduling. Ready uses the real
  // production SQL result; only pending/stale presentation is substituted at the browser transport boundary.
  let representation: 'pending' | 'stale' | 'actual' = 'pending';
  await page.route(trackRequest, async (route) => {
    const response = await route.fetch();
    if (representation === 'actual') { await route.fulfill({ response }); return; }
    const feature = archiveTrackResponseSchema.parse(await response.json());
    await route.fulfill({ response, json: {
      ...feature, geometry: null,
      properties: {
        ...feature.properties, algorithmVersion: representation === 'pending' ? null : 'v1',
        distanceM: null, observedDurationS: null, qualityStats: null,
        sourceRevision: representation === 'pending' ? null : '0', summaryState: representation,
      },
    } });
  });
  const trigger = page.getByRole('button', { name: 'View result', exact: true });
  await trigger.click();
  await expect(details(page).getByRole('heading', { name: 'Run details' })).toBeFocused();
  await expect(synchronization(page)).toContainText('No GPS measurements are waiting');
  await expect(details(page)).toContainText('summary is still being prepared');
  await expect(statistics(page)).toHaveCount(0);
  representation = 'stale';
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(details(page)).toContainText('summary is being updated');
  await expect(statistics(page)).toHaveCount(0);
  representation = 'actual';
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(statistics(page)).toBeVisible();
  await expect(details(page)).toContainText('route map is unavailable');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../.local/finish-result-mobile.png', fullPage: true });
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(before);
  await details(page).getByRole('button', { name: 'Back to Runner' }).click();
  await expect(trigger).toBeFocused();
  await expect(runner.card('Recording').value).toHaveText('finished');
  // A saved finished lifecycle is recovery data. Reload must confirm it again before opening the result.
  await runner.reload();
  await expect(trigger).toBeEnabled();
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(before);
  await trigger.click();
  await expect(statistics(page)).toBeVisible();
  await details(page).getByRole('button', { name: 'Back to Runner' }).click();
  const follower = await context.newPage();
  try {
    const otherRunner = new RunnerPage(follower);
    await otherRunner.openRestoredRun();
    await expect(otherRunner.card('Writer').value).toHaveText('conflict');
    await follower.getByRole('button', { name: 'View result', exact: true }).click();
    await expect(synchronization(follower)).toContainText('no longer owns synchronization');
    await expect(statistics(follower)).toHaveCount(0);
    expect(await readDurableRunnerState(follower, scenario.runnerUserId)).toEqual(before);
  } finally { await follower.close(); }
  await context.setOffline(true);
  await expect(runner.card('Network').value).toHaveText('offline');
  await expect(trigger).toBeDisabled();
  await context.setOffline(false);
  await expect(trigger).toBeEnabled();
  await page.getByRole('button', { name: 'New run', exact: true }).click();
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('finished');
  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(points).toHaveLength(6); expectUniqueAndGapFree(points);
});

test('result remains open through offline catch-up; an earlier ready summary stays hidden after the last upload ACK', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  const uploads = deferred();
  let deliver = false;
  await page.route('**/points', async (route) => {
    if (route.request().method() === 'POST' && !deliver) await uploads.promise;
    await route.continue().catch(() => undefined);
  });
  try {
    await runner.open(scenario.orgId); await runner.useSimulator(); await runner.start();
    await runner.waitForCaptureComplete(); await runner.waitForPendingAtLeast(6);
    await runner.finish(); await expect(runner.card('Recording').value).toHaveText('finished');
    const runId = await runner.runId(api, scenario.orgId);
    await publishFinishedRunSummary(environment, scenario.orgId, runId);
    const before = await readDurableRunnerState(page, scenario.runnerUserId);
    await page.getByRole('button', { name: 'View result', exact: true }).click();
    await expect(synchronization(page)).toContainText('6 GPS measurements');
    await expect(details(page).getByLabel('Run times')).toBeVisible();
    await expect(statistics(page)).toHaveCount(0);
    await context.setOffline(true);
    await expect(synchronization(page)).toContainText('connection returns');
    expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(before);
    deliver = true; uploads.resolve();
    await context.setOffline(false);
    await expect(synchronization(page)).toContainText('No GPS measurements are waiting', { timeout: 25_000 });
    // No refresh has occurred: this read predates the late points, even though the server marked it ready then.
    await expect(details(page)).toContainText('Refresh run to load their updated summary');
    await expect(statistics(page)).toHaveCount(0);
    const after = await readDurableRunnerState(page, scenario.runnerUserId);
    expect(after).toEqual({ activeRunId: runId, bufferedSeqKeys: [], pendingCommandIds: [] });
    const points = await api.getAllPoints(scenario.orgId, runId);
    expect(points).toHaveLength(6); expectUniqueAndGapFree(points);
    await publishFinishedRunSummary(environment, scenario.orgId, runId);
    await details(page).getByRole('button', { name: 'Refresh run' }).click();
    await expect(statistics(page)).toBeVisible();
    await details(page).getByRole('button', { name: 'Back to Runner' }).click();
    await expect(page.getByRole('button', { name: 'New run', exact: true })).toBeEnabled();
  } finally {
    deliver = true; uploads.resolve(); await context.setOffline(false);
  }
});

test('an offline Finish must be confirmed by retrying its saved command before result navigation', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId); await runner.useSimulator(); await runner.start();
  await runner.waitForCaptureComplete(); await runner.waitForEmptyBuffer();
  const runId = await runner.runId(api, scenario.orgId);
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/commands')) sent.push((request.postDataJSON() as { commandId: string }).commandId);
  });
  await context.setOffline(true);
  await expect(runner.card('Network').value).toHaveText('offline');
  await runner.finish();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  const queued = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(queued.pendingCommandIds).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'View result', exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await expect(runner.card('Network').value).toHaveText('online');
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(runner.card('Recording').value).toHaveText('finished');
  await page.getByRole('button', { name: 'View result', exact: true }).click();
  await expect(details(page)).toBeVisible();
  expect(sent).toEqual(queued.pendingCommandIds);
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual({ activeRunId: runId, bufferedSeqKeys: [], pendingCommandIds: [] });
});

test('rejected GPS work remains recoverable from the result and cannot look complete', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await page.route('**/points', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await route.fulfill({ status: 422, json: { error: { code: 'RUN_POINT_LIMIT', message: 'Points rejected', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } });
  });
  await runner.open(scenario.orgId); await runner.useSimulator(); await runner.start();
  await expect(runner.card('Upload').value).toHaveText('blocked');
  await runner.finish(); await expect(runner.card('Recording').value).toHaveText('finished');
  const before = await readDurableRunnerState(page, scenario.runnerUserId);
  await page.getByRole('button', { name: 'View result', exact: true }).click();
  await expect(synchronization(page).getByRole('alert')).toContainText('GPS upload was rejected');
  await expect(statistics(page)).toHaveCount(0);
  await details(page).getByRole('button', { name: 'Back to Runner' }).click();
  await expect(page.getByRole('button', { name: 'Export buffered points' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'New run', exact: true })).toBeDisabled();
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(before);
});

test('a result read arriving after leaving Runner or signing out cannot reopen the finished run', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId); await runner.useSimulator(); await runner.start();
  await runner.waitForCaptureComplete(); await runner.waitForEmptyBuffer();
  await runner.finish(); await expect(runner.card('Recording').value).toHaveText('finished');
  const entered = deferred(); const release = deferred();
  await page.route(trackRequest, async (route) => {
    const response = await route.fetch(); entered.resolve(); await release.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole('button', { name: 'View result', exact: true }).click(); await entered.promise;
    await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Coach' }).click();
    await expect(details(page)).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Runner' }).click();
    await expect(page.getByRole('button', { name: 'View result', exact: true })).toBeVisible();
    // A second opening uses the same scope but must still end when its session ends.
    await page.getByRole('button', { name: 'View result', exact: true }).click();
    await expect(details(page)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expectSignedOut(page);
    release.resolve();
    await signIn(context, environment, scenario.coachUserId); await page.reload();
    await expect(runner.card('Recording').value).toHaveText('idle');
    await expect(details(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'View result', exact: true })).toHaveCount(0);
  } finally { release.resolve(); }
});

test('deletion clears a directly opened result on refresh', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId); await runner.useSimulator(); await runner.start();
  await runner.waitForCaptureComplete(); await runner.waitForEmptyBuffer();
  await runner.finish(); await expect(runner.card('Recording').value).toHaveText('finished');
  const runId = await runner.runId(api, scenario.orgId);
  await publishFinishedRunSummary(environment, scenario.orgId, runId);
  await page.getByRole('button', { name: 'View result', exact: true }).click();
  await expect(statistics(page)).toBeVisible();
  await api.deleteRun(scenario.orgId, runId);
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(details(page).getByRole('alert')).toContainText('was deleted');
  await expect(statistics(page)).toHaveCount(0);
  await expect(details(page).getByRole('region', { name: 'Run route' })).toHaveCount(0);
});
