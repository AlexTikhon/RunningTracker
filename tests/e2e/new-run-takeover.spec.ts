import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState } from './support/browser-storage.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// "New run" in a tab whose writer epoch has silently ended must not clear another epoch's active run. Two live
// pages share the browser's real IndexedDB. Page A finishes run A and keeps showing it with "New run" enabled; its
// writer renewal is then held (below), so its lease expires while its screen still says "owned". Page B takes the
// lease over by the normal claim path after that expiry, clears run A, starts run B and buffers points that cannot
// upload yet. A's stale "New run" then runs. Without the fence it cleared B's pointer: B's points stayed in
// IndexedDB but recovery no longer showed them.
//
// Limitation: the held renewal stands in for a tab whose timers stopped (a backgrounded or suspended tab). The
// click here is caught when the clear proves the lease again before its transaction; the interleaving where the
// takeover lands between that proof and the transaction is covered by apps/web/src/finished-run-clear.spec.ts.

const RENEW_INTERVAL_MS = 5_000;

// Page A only: while the flag is set, a timer with exactly the writer's renewal interval is pushed out of the
// test's reach, so the lease is neither renewed nor found lost by the timer. Nothing else in the page runs a
// 5 s timer in this scenario (the authority retry only runs when the server is unreachable).
async function installRenewalHold(page: Page): Promise<void> {
  await page.addInitScript((interval: number) => {
    const original = window.setTimeout.bind(window);
    const hold = { on: false };
    Object.defineProperty(window, '__writerRenewalHold', { value: hold });
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
      original(handler, hold.on && timeout === interval ? 2_147_483_647 : timeout, ...rest)) as typeof window.setTimeout;
  }, RENEW_INTERVAL_MS);
}

async function holdRenewal(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __writerRenewalHold: { on: boolean } }).__writerRenewalHold.on = true; });
}

test('the writer\'s New run clears its uploaded finished run, survives a reload and starts the next run', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  const first = await runner.runId(api, scenario.orgId);
  await runner.waitForCaptureComplete();
  await runner.waitForEmptyBuffer();
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');

  await page.getByRole('button', { name: 'New run' }).click();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
  await page.reload();
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();

  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  const next = (await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId;
  expect(next).not.toBeNull();
  expect(next).not.toBe(first);
  await runner.reload();
  await expect(runner.card('Recording').value).toHaveText('recording');
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(next);
  expect((await api.getRun(scenario.orgId, first)).status).toBe('finished');
});

test('a stale tab\'s New run cannot clear the run another writer epoch started', async ({ context, environment, page, scenario }) => {
  test.setTimeout(120_000);
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  await installRenewalHold(page);
  const tabA = new RunnerPage(page);
  await tabA.open(scenario.orgId);
  await tabA.useSimulator();
  await tabA.start();
  await expect(tabA.card('Recording').value).toHaveText('recording');
  const runA = await tabA.runId(api, scenario.orgId);
  await tabA.waitForCaptureComplete();
  await tabA.waitForEmptyBuffer();
  await tabA.finish();
  await expect(tabA.card('Recording').value).toHaveText('finished');
  const newRunA = page.getByRole('button', { name: 'New run' });
  await expect(newRunA).toBeEnabled();
  await holdRenewal(page);

  // Page B, a live second tab whose points cannot reach the server yet.
  const second = await context.newPage();
  await second.route(/\/runs\/[^/]+\/points$/, (route) => route.abort('internetdisconnected'));
  const tabB = new RunnerPage(second);
  await tabB.openRestoredRun();
  await expect(tabB.card('Writer').value).toHaveText('conflict', { timeout: 20_000 });
  // A's lease expires (15 s after its last renewal); B's next claim then takes the next fencing epoch.
  await expect(async () => {
    await second.getByRole('button', { name: 'Retry ownership' }).click({ timeout: 1_000 }).catch(() => undefined);
    await expect(tabB.card('Writer').value).toHaveText('owned', { timeout: 5_000 });
  }).toPass({ timeout: 45_000 });

  // B legitimately clears A, starts run B and buffers points.
  await expect(second.getByRole('button', { name: 'New run' })).toBeEnabled({ timeout: 20_000 });
  await second.getByRole('button', { name: 'New run' }).click();
  await expect(second.getByRole('button', { name: 'Start run' })).toBeVisible();
  await tabB.useSimulator();
  await tabB.start();
  await expect(tabB.card('Recording').value).toHaveText('recording');
  await expect.poll(async () => (await readDurableRunnerState(second, scenario.runnerUserId)).bufferedSeqKeys.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const runB = (await readDurableRunnerState(second, scenario.runnerUserId)).activeRunId;
  expect(runB).not.toBeNull();
  expect(runB).not.toBe(runA);

  // A still shows its finished run, "owned" and an enabled "New run": the screen alone cannot stop the click.
  await expect(tabA.card('Writer').value).toHaveText('owned');
  await expect(newRunA).toBeEnabled();
  await newRunA.click();
  await expect(newRunA).toHaveCount(0);

  // The durable state is B's: its run is still active and its points are still buffered for it.
  const durable = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(durable.activeRunId).toBe(runB);
  expect(durable.bufferedSeqKeys.length).toBeGreaterThan(0);
  // A found out it is no longer the writer and follows B's run read-only: its claim on that run meets B's live lease.
  // B is untouched and still recording.
  await expect(tabA.card('Recording').value).toHaveText('recording');
  await expect(tabA.card('Writer').value).toHaveText('conflict', { timeout: 20_000 });
  await expect(tabB.card('Writer').value).toHaveText('owned');
  await expect(tabB.card('Recording').value).toHaveText('recording');

  // After a reload A recovers B's run, not an empty pointer, and the points are still there.
  await page.reload();
  await expect(tabA.card('Recording').value).toHaveText('recording');
  await expect(tabA.card('Writer').value).toHaveText('conflict', { timeout: 20_000 });
  const reloaded = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(reloaded.activeRunId).toBe(runB);
  expect(reloaded.bufferedSeqKeys.length).toBeGreaterThanOrEqual(durable.bufferedSeqKeys.length);
  expect((await api.getRun(scenario.orgId, runB ?? '')).status).toBe('recording');
  expect((await api.getRun(scenario.orgId, runA)).status).toBe('finished');

  await second.unroute(/\/runs\/[^/]+\/points$/);
  await second.close();
});
