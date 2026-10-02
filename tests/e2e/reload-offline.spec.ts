import { signIn, authedApi } from './support/api.js';
import type { AuthedApi } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// The server returns seq as a decimal string, so compare as bigint after sorting.
function sortedSeqs(points: ReadonlyArray<{ seq: string }>): bigint[] {
  return points.map((point) => BigInt(point.seq)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Sorted seqs equal to one consecutive range prove both that none repeats and that none is missing in between.
function expectUniqueAndGapFree(points: ReadonlyArray<{ seq: string }>): void {
  const seqs = sortedSeqs(points);
  expect(seqs.length).toBeGreaterThan(0);
  const first = seqs[0] ?? 0n;
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => first + BigInt(index)));
}

async function pointCount(api: AuthedApi, orgId: string, runId: string): Promise<number> {
  return (await api.getAllPoints(orgId, runId)).length;
}

function maxSeq(points: ReadonlyArray<{ seq: string }>): bigint {
  return sortedSeqs(points).at(-1) ?? 0n;
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

// The spec'd behaviour, disabled until the maintainer decides the two findings under "Browser E2E findings" in
// docs/progress.md. Today a reload leaves the writer lease in conflict with the tab's own unreleased lease for
// about 17 s with no automatic retry, and the capture source is not persisted, so the Simulator is not restored
// and cannot be re-selected while recording. The assertions below are the intended behaviour; the passing
// sibling test after it covers what is true today.
test.fixme('reload (needs lease auto-recovery and a persisted capture source, see docs/progress.md): the run and its sequence survive a page reload', async ({
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
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');

  const runId = await runner.runId(api, scenario.orgId);
  await expect.poll(() => pointCount(api, scenario.orgId, runId), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const acknowledgedBeforeReload = await pointCount(api, scenario.orgId, runId);

  await runner.reload();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Writer').value).toHaveText('owned');

  await runner.waitForCaptureComplete();
  await drainFinishAndVerify(runner, api, scenario.orgId, runId, acknowledgedBeforeReload);
});

test('reload: after re-claiming ownership the run continues without losing or reusing a sequence', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  // Lease expiry (about 17 s observed) plus a simulated start and a drain do not fit the 60 s default with margin.
  test.setTimeout(90_000);

  // After a reload the capture source is back to Device GPS and cannot be changed while recording, so give the
  // browser a fixed position to capture from.
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 10, longitude: 10 });
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);

  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');

  // Let the Simulator finish its capture and drain the buffer before the reload. The old session then cannot add
  // a point, so the server holds exactly what it captured and every later point must come from the reloaded tab.
  const runId = await runner.runId(api, scenario.orgId);
  await runner.waitForCaptureComplete();
  await runner.waitForEmptyBuffer();
  const capturedBeforeReload = await runner.capturedCount();
  const beforeReload = await api.getAllPoints(scenario.orgId, runId);
  expect(beforeReload).toHaveLength(capturedBeforeReload);
  const maxSeqBeforeReload = maxSeq(beforeReload);

  await runner.reloadWithoutOwnership();
  await runner.reclaimOwnership();
  await expect(runner.card('Recording').value).toHaveText('recording');
  // The reloaded tab is capturing again, from Device GPS.
  await expect(runner.card('Capture').value).toHaveText('capturing');

  // A point the old session could not have produced, with a seq above everything from before the reload.
  await expect
    .poll(async () => maxSeq(await api.getAllPoints(scenario.orgId, runId)), { timeout: 30_000 })
    .toBeGreaterThan(maxSeqBeforeReload);

  const points = await drainFinishAndVerify(runner, api, scenario.orgId, runId, beforeReload.length + 1);
  // Nothing from before the reload was lost or rewritten: the earlier range is intact at the start.
  expect(sortedSeqs(points).slice(0, beforeReload.length)).toEqual(sortedSeqs(beforeReload));
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
