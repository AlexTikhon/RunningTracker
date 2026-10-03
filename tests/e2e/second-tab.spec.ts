import { signIn, authedApi } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { expectUniqueAndGapFree, sortedSeqs } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';

test('second tab: a competing tab cannot record', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const first = new RunnerPage(page);

  await first.open(scenario.orgId);
  await first.useSimulator();
  await first.start();
  await expect(first.card('Recording').value).toHaveText('recording');
  await expect(first.card('Writer').value).toHaveText('owned');

  const runId = await first.runId(api, scenario.orgId);
  await expect
    .poll(async () => (await api.getAllPoints(scenario.orgId, runId)).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);

  // A second tab in the same context shares cookies and the browser's local storage with the first. Only the
  // method and path of its requests are kept, never a body or a header.
  const secondPage = await context.newPage();
  const secondRequests: string[] = [];
  secondPage.on('request', (request) => {
    secondRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const second = new RunnerPage(secondPage);
  await second.openRestoredRun();
  await second.expectReadOnly();

  // While the first tab is still capturing, the second tab is read-only and idle, and the first still owns the lease.
  await expect(second.card('Writer').value).toHaveText('conflict');
  await expect(second.card('Capture').value).toHaveText('idle');
  await expect(first.card('Capture').value).toHaveText('capturing');
  await expect(first.card('Writer').value).toHaveText('owned');

  // The first tab finishes the run alone.
  await first.waitForCaptureComplete();
  await first.waitForEmptyBuffer();
  const captured = await first.capturedCount();
  await first.finish();
  await expect(first.card('Recording').value).toHaveText('finished');
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('finished');

  // The second tab stayed read-only to the end: it never took the lease and never captured.
  await expect(second.card('Writer').value).toHaveText('conflict');
  await expect(second.card('Capture').value).toHaveText('idle');

  // Exactly what the first tab captured, once each: the second tab contributed no point and no second run.
  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(points).toHaveLength(6);
  expect(points).toHaveLength(captured);
  expectUniqueAndGapFree(points);
  expect(sortedSeqs(points)[0]).toBe(1n);
  expect(await api.listRunIds(scenario.orgId)).toEqual([runId]);

  // The server set cannot show the second tab re-sending the first tab's points from the shared IndexedDB, so
  // check its own traffic: no request to any points endpoint, and no mutation of the run at all.
  expect(secondRequests.filter((request) => /\/runs\/[^/]+\/points$/.test(request))).toEqual([]);
  expect(secondRequests.filter((request) => !request.startsWith('GET '))).toEqual([]);
});
