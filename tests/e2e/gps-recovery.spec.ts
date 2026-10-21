import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { expectUniqueAndGapFree, sortedSeqs } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';
import { installSimulatedReceiver, receiver } from './support/simulated-receiver.js';

// ADR-0061 in the browser: the real app, native IndexedDB and the real API, with Device GPS. The location receiver
// is SIMULATED at the Geolocation API boundary (support/simulated-receiver.ts); these tests show how the app
// handles the W3C callbacks, not how any physical device or mobile browser produces them.

// Every request the page sends that could change the run on the server: anything but a read or a point upload.
function recordLifecycleMutations(page: Page): string[] {
  const mutations: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET' && !url.pathname.endsWith('/points')) {
      mutations.push(`${request.method()} ${url.pathname}`);
    }
  });
  return mutations;
}

// The number of points the current capture controller saved ("segment N · M buffered"), or -1 while not capturing.
async function captured(runner: RunnerPage): Promise<number> {
  try {
    return await runner.capturedCount();
  } catch {
    return -1;
  }
}

// Waits until the page's own one-second clock has moved on twice: at least one full tick in which anything
// scheduled by the page would have run. It polls the page; it never sleeps a fixed time.
async function waitForPageTicks(page: Page): Promise<void> {
  const timer = page.getByLabel(/^Elapsed time/u);
  const first = await timer.getAttribute('aria-label');
  await expect(timer).not.toHaveAttribute('aria-label', first ?? '');
  const second = await timer.getAttribute('aria-label');
  await expect(timer).not.toHaveAttribute('aria-label', second ?? '');
}

async function startDeviceGpsRun(page: Page, orgId: string): Promise<RunnerPage> {
  const runner = new RunnerPage(page);
  await runner.open(orgId);
  await expect(page.getByLabel('Capture source')).toHaveValue('geolocation');
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(page.getByLabel('Capture health')).toContainText('No fix yet');
  return runner;
}

test('a TIMEOUT and a POSITION_UNAVAILABLE keep the one watch, and the next fix is saved with no lifecycle request', async ({ context, environment, page, scenario }) => {
  await installSimulatedReceiver(context);
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = await startDeviceGpsRun(page, scenario.orgId);
  const watching = await receiver.calls(page);
  expect(await receiver.active(page)).toBe(1);
  const mutations = recordLifecycleMutations(page);

  await receiver.fix(page);
  await expect.poll(() => captured(runner)).toBe(1);
  await expect(page.getByLabel('Capture health')).toContainText('Capturing');

  await receiver.fail(page, 3);
  const waiting = page.getByRole('status').filter({ hasText: 'Waiting for location' });
  await expect(waiting).toContainText('timed out');
  await expect(waiting).toContainText('(stale)');
  await expect(waiting.getByRole('button', { name: 'Retry GPS' })).toBeEnabled();
  await receiver.fail(page, 2);
  await expect(waiting).toContainText('2 attempts without a fix; still listening.');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(page.getByText('Capture stopped')).toHaveCount(0);

  // Upload is a separate concern: offline, the recovered fix is still captured and waits in IndexedDB.
  await context.setOffline(true);
  await expect(runner.card('Network').value).toHaveText('offline');
  await receiver.fix(page);
  await expect.poll(() => captured(runner)).toBe(2);
  await expect(waiting).toHaveCount(0);
  await expect(page.getByLabel('Capture health')).toContainText('Capturing');
  await runner.waitForPendingAtLeast(1);
  await context.setOffline(false);
  await runner.waitForEmptyBuffer();

  const runId = await runner.runId(api, scenario.orgId);
  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(points).toHaveLength(2);
  expectUniqueAndGapFree(points);
  expect(new Set(points.map((point) => point.segmentId)).size).toBe(1);
  expect(await receiver.calls(page)).toEqual(watching);
  expect(await receiver.active(page)).toBe(1);
  expect(mutations).toEqual([]);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('recording');
});

test('a permission denial stops the watch until an explicit Retry GPS, which starts one new watch in a new segment', async ({ context, environment, page, scenario }) => {
  await installSimulatedReceiver(context);
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = await startDeviceGpsRun(page, scenario.orgId);
  const watching = await receiver.calls(page);
  const mutations = recordLifecycleMutations(page);
  await receiver.fix(page);
  await expect.poll(() => captured(runner)).toBe(1);

  await receiver.fail(page, 1);
  const blocked = page.getByRole('alert').filter({ hasText: 'Location permission blocked' });
  await expect(blocked).toContainText('Allow location for this site in the browser settings, then choose Retry GPS.');
  await expect(runner.card('Capture').value).toHaveText('error');
  expect(await receiver.active(page)).toBe(0);

  // A stale callback reaches the removed watch, and the page keeps ticking: nothing is saved and no watch starts.
  await receiver.lateFix(page);
  await waitForPageTicks(page);
  expect((await receiver.calls(page)).watchPosition).toBe(watching.watchPosition);
  expect(await receiver.active(page)).toBe(0);
  await expect(blocked).toBeVisible();

  // Two clicks in one task, before the page can re-render: one new watch.
  await blocked.getByRole('button', { name: 'Retry GPS' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(blocked).toHaveCount(0);
  expect((await receiver.calls(page)).watchPosition).toBe(watching.watchPosition + 1);
  expect(await receiver.active(page)).toBe(1);

  await receiver.fix(page);
  await expect.poll(() => captured(runner)).toBe(2);
  await runner.waitForEmptyBuffer();

  const runId = await runner.runId(api, scenario.orgId);
  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(points).toHaveLength(2);
  expectUniqueAndGapFree(points);
  const bySeq = [...points].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  expect(bySeq[1]?.segmentId).toBeGreaterThan(bySeq[0]?.segmentId ?? Number.POSITIVE_INFINITY);
  expect(mutations).toEqual([]);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('recording');
});

test('Pause while waiting for a fix clears the watch and a late callback saves nothing', async ({ context, environment, page, scenario }) => {
  await installSimulatedReceiver(context);
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = await startDeviceGpsRun(page, scenario.orgId);
  await receiver.fix(page);
  await expect.poll(() => captured(runner)).toBe(1);
  await receiver.fail(page, 3);
  await expect(page.getByRole('status').filter({ hasText: 'Waiting for location' })).toBeVisible();

  await page.getByRole('button', { exact: true, name: 'Pause' }).click();
  await expect(runner.card('Recording').value).toHaveText('paused');
  await expect(runner.card('Capture').value).toHaveText('idle');
  expect(await receiver.active(page)).toBe(0);
  await receiver.lateFix(page);
  await waitForPageTicks(page);
  await runner.waitForEmptyBuffer();
  await expect(runner.card('Capture').value).toHaveText('idle');
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');

  const runId = await runner.runId(api, scenario.orgId);
  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(sortedSeqs(points)).toHaveLength(1);
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('finished');
});
