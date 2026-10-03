import { signIn, authedApi } from './support/api.js';
import type { AuthedApi } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { watchGeolocationUse } from './support/geolocation-spy.js';
import { expectUniqueAndGapFree, sortedSeqs } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';

async function pointCount(api: AuthedApi, orgId: string, runId: string): Promise<number> {
  return (await api.getAllPoints(orgId, runId)).length;
}

// Drains the buffer, finishes the run and checks the server: finished, at least `minimumCount` points, and every
// seq unique and gap-free. Returns the points for further checks.
async function drainFinishAndVerify(
  runner: RunnerPage,
  api: AuthedApi,
  orgId: string,
  runId: string,
  minimumCount: number,
): Promise<Array<{ seq: string }>> {
  await runner.waitForEmptyBuffer();
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');
  expect((await api.getRun(orgId, runId)).status).toBe('finished');

  const points = await api.getAllPoints(orgId, runId);
  expect(points.length).toBeGreaterThanOrEqual(minimumCount);
  expectUniqueAndGapFree(points);
  return points;
}

test('reload: a recording Simulator run recovers on its own and keeps its sequence', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  // Any use of Device GPS, in any page of the context and across the reload, is recorded: the restored run must
  // never start it, not even briefly before the stored Simulator choice is applied.
  const geolocationUse = await watchGeolocationUse(context);
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);

  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');

  const runId = await runner.runId(api, scenario.orgId);
  await expect.poll(() => pointCount(api, scenario.orgId, runId), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const acknowledgedBeforeReload = await api.getAllPoints(scenario.orgId, runId);

  // The previous page is destroyed with its lease still live in IndexedDB. The reloaded page must own the lease
  // again without a click and long before that lease could expire.
  await runner.reload();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await runner.expectNoOwnershipRetryOffered();
  await runner.expectSimulatorSelected();

  await runner.waitForCaptureComplete();
  const capturedAfterReload = await runner.capturedCount();
  const points = await drainFinishAndVerify(
    runner,
    api,
    scenario.orgId,
    runId,
    acknowledgedBeforeReload.length + capturedAfterReload,
  );

  // Nothing acknowledged before the reload was lost or rewritten: that range is intact at the start.
  expect(sortedSeqs(points).slice(0, acknowledgedBeforeReload.length)).toEqual(sortedSeqs(acknowledgedBeforeReload));
  expect(geolocationUse).toEqual([]);
  await runner.expectNoOwnershipRetryOffered();
});

test('offline: points buffered while offline are delivered exactly once after reconnection', async ({
  browser,
  context,
  environment,
  page,
  scenario,
}) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);

  // A second context for the same runner stays online, so the server can be read while the page is offline.
  const observer = await browser.newContext();
  try {
    await signIn(observer, environment, scenario.runnerUserId);
    const observerApi = await authedApi(observer, environment);
    const runner = new RunnerPage(page);

    await runner.open(scenario.orgId);
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');

    const runId = await runner.runId(api, scenario.orgId);
    await expect
      .poll(() => pointCount(observerApi, scenario.orgId, runId), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);

    await context.setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();

    // By two pending points any request that was in flight when the page went offline has long settled,
    // so the count read now is the baseline for the rest of the offline window.
    await runner.waitForPendingAtLeast(2);
    const baseline = await pointCount(observerApi, scenario.orgId, runId);

    await runner.waitForPendingAtLeast(3);
    expect(await pointCount(observerApi, scenario.orgId, runId)).toBe(baseline);

    // The capture finishes while still offline, so the number of points it took is final. The Capture card counts
    // every point of the session, uploaded or not.
    await runner.waitForCaptureComplete();
    const captured = await runner.capturedCount();
    expect(await pointCount(observerApi, scenario.orgId, runId)).toBe(baseline);

    await context.setOffline(false);
    await runner.waitForEmptyBuffer();

    // Exactly the captured set, once each: a dropped head or tail point changes the count or the ends. The
    // server numbers a run's points from 1.
    const points = await observerApi.getAllPoints(scenario.orgId, runId);
    expect(baseline).toBeLessThan(captured);
    expect(points).toHaveLength(captured);
    expectUniqueAndGapFree(points);
    const seqs = sortedSeqs(points);
    expect(seqs[0]).toBe(1n);
    expect(seqs.at(-1)).toBe(BigInt(captured));
  } finally {
    await observer.close();
  }
});
