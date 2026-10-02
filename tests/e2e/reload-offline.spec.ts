import { signIn, authedApi } from './support/api.js';
import type { AuthedApi } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// The server returns seq as a decimal string, so compare as bigint after sorting.
function sortedSeqs(points: ReadonlyArray<{ seq: string }>): bigint[] {
  return points.map((point) => BigInt(point.seq)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function expectUniqueAndGapFree(points: ReadonlyArray<{ seq: string }>): void {
  const seqs = sortedSeqs(points);
  const first = seqs[0] ?? 0n;
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => first + BigInt(index)));
}

async function pointCount(api: AuthedApi, orgId: string, runId: string): Promise<number> {
  return (await api.getAllPoints(orgId, runId)).length;
}

function maxSeq(points: ReadonlyArray<{ seq: string }>): bigint {
  return sortedSeqs(points).at(-1) ?? 0n;
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
  await runner.waitForEmptyBuffer();

  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');

  const run = await api.getRun(scenario.orgId, runId);
  expect(run.status).toBe('finished');

  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(points.length).toBeGreaterThanOrEqual(acknowledgedBeforeReload);
  expect(new Set(points.map((point) => point.seq)).size).toBe(points.length);
  expectUniqueAndGapFree(points);
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

  const runId = await runner.runId(api, scenario.orgId);
  await expect.poll(() => pointCount(api, scenario.orgId, runId), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const beforeReload = await api.getAllPoints(scenario.orgId, runId);
  const maxSeqBeforeReload = maxSeq(beforeReload);

  await runner.reloadWithoutOwnership();
  await runner.reclaimOwnership();
  await expect(runner.card('Recording').value).toHaveText('recording');

  // A point beyond everything acknowledged before the reload: the sequence continued, it was not reused.
  await expect
    .poll(async () => maxSeq(await api.getAllPoints(scenario.orgId, runId)), { timeout: 30_000 })
    .toBeGreaterThan(maxSeqBeforeReload);

  await runner.waitForEmptyBuffer();
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('finished');

  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(points.length).toBeGreaterThanOrEqual(beforeReload.length);
  expect(new Set(points.map((point) => point.seq)).size).toBe(points.length);
  expectUniqueAndGapFree(points);
  expect(maxSeq(points)).toBeGreaterThan(maxSeqBeforeReload);
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

    await runner.waitForCaptureComplete();
    expect(await pointCount(observerApi, scenario.orgId, runId)).toBe(baseline);

    await context.setOffline(false);
    await runner.waitForEmptyBuffer();

    const points = await observerApi.getAllPoints(scenario.orgId, runId);
    expect(points.length).toBeGreaterThan(baseline);
    expect(new Set(points.map((point) => point.seq)).size).toBe(points.length);
    expectUniqueAndGapFree(points);
  } finally {
    await observer.close();
  }
});
