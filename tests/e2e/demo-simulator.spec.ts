import { authedApi, signIn } from './support/api.js';
import type { AuthedApi } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { expectUniqueAndGapFree, sortedSeqs } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';

// The local demo's Simulator (apps/web/src/demo-simulator.ts) on a dev server started with VITE_LOCAL_DEMO_ENABLED=true,
// as `npm run demo:up` starts it, for the fixed demo runner the demoScenario fixture creates in the _test database. Its
// full two minutes, cadence and completion are covered with fake timers in demo-simulator.spec.ts; this test stays
// short and checks what only a browser shows: the same capture, IndexedDB and upload path, and a real offline switch.

async function pointCount(api: AuthedApi, orgId: string, runId: string): Promise<number> {
  return (await api.getAllPoints(orgId, runId)).length;
}

// The Capture card's count, or 0 while it shows none yet (the source name while starting).
async function capturedSoFar(runner: RunnerPage): Promise<number> {
  return await runner.capturedCount().catch(() => 0);
}

test('the demo simulator keeps capturing past six points, buffers offline, drains on reconnect and stops at Finish', async ({
  browser,
  context,
  demoScenario,
  environment,
  page,
}) => {
  const { orgId, runnerUserId } = demoScenario;
  await signIn(context, environment, runnerUserId);

  // A second context for the same runner stays online, so the server can be read while the page is offline.
  const observer = await browser.newContext();
  try {
    await signIn(observer, environment, runnerUserId);
    const api = await authedApi(observer, environment);
    const runner = new RunnerPage(page);

    await runner.open(orgId, environment.demoWebOrigin);
    await expect(page.getByLabel('Capture source').getByRole('option', { name: /^Simulator/ }))
      .toHaveText('Simulator · local demo · about 2 min');
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    const runId = await runner.runId(api, orgId);

    // Past the six points the ordinary simulator stops at, and still capturing.
    await expect.poll(() => capturedSoFar(runner), { timeout: 30_000 }).toBeGreaterThan(6);
    await expect(runner.card('Capture').value).toHaveText('capturing');

    // Offline with no Pause or Resume: the same capture session goes on and its points wait on this device.
    await context.setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
    // By two pending points any request in flight when the page went offline has settled, so this is the baseline.
    await runner.waitForPendingAtLeast(2);
    const baseline = await pointCount(api, orgId, runId);
    await runner.waitForPendingAtLeast(3);
    expect(await pointCount(api, orgId, runId)).toBe(baseline);
    await expect(runner.card('Capture').value).toHaveText('capturing');

    // Back online the buffer drains, while the simulator keeps capturing.
    await context.setOffline(false);
    await runner.waitForEmptyBuffer();
    const drained = await api.getAllPoints(orgId, runId);
    expect(drained.length).toBeGreaterThanOrEqual(baseline + 3);
    expectUniqueAndGapFree(drained);
    expect(sortedSeqs(drained)[0]).toBe(1n);
    // One capture session from Start to here: a single segment.
    expect(new Set(drained.map((point) => point.segmentId)).size).toBe(1);
    await expect(runner.card('Capture').value).toHaveText('capturing');

    // Finish long before the simulator's two minutes are up: capture stops with the run.
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    await expect(runner.card('Capture').value).toHaveText('idle');
    await runner.waitForEmptyBuffer();
    const atFinish = await api.getAllPoints(orgId, runId);
    expect(atFinish.length).toBeLessThan(60);
    expectUniqueAndGapFree(atFinish);
    expect(sortedSeqs(atFinish)[0]).toBe(1n);
    expect((await api.getRun(orgId, runId)).status).toBe('finished');

    // More than two simulator intervals later, nothing more was captured or sent.
    await page.waitForTimeout(4_500);
    expect(await pointCount(api, orgId, runId)).toBe(atFinish.length);
    await expect(runner.card('Capture').value).toHaveText('idle');
    await expect(runner.card('Upload').detail).toHaveText('No buffered points');
  } finally {
    await observer.close();
  }
});
