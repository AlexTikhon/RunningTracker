import { signIn, authedApi } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

test('record: a simulated run is uploaded in full and finished', async ({
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

  await runner.waitForCaptureComplete();
  await runner.waitForEmptyBuffer();

  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');

  const runId = await runner.runId(api, scenario.orgId);
  const run = await api.getRun(scenario.orgId, runId);
  expect(run.status).toBe('finished');

  const points = await api.getAllPoints(scenario.orgId, runId);
  expect(points).toHaveLength(6);
  const seqs = points.map((point) => BigInt(point.seq)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const first = seqs[0];
  expect(seqs).toEqual(Array.from({ length: 6 }, (_, index) => (first ?? 0n) + BigInt(index)));
});
