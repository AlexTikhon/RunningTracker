import type { Page, Route } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState, readQueuedStarts } from './support/browser-storage.js';
import { setMembershipActive } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// A Start the server definitively rejects (403 ORG_ACCESS_DENIED) never became a run, so the refused-run discard
// cannot apply and the queued Start used to be retried for ever. The person can now abandon exactly that request,
// locally and on purpose (ADR-0058); every unknown outcome keeps the identical request for a retry.

const runPath = /\/api\/orgs\/[^/]+\/runs\/[^/]+$/;
const abandonButton = 'Abandon this Start';

interface SentStart {
  readonly body: string | null;
  readonly path: string;
}

// Every Start the page sends, with the exact path (which carries the run id) and body (which carries startedAt),
// and every other write the page makes, which an abandonment must never add to. The point uploads of a recording
// run are the uploader's own traffic and are not part of that list.
function watchWrites(page: Page): { otherWrites: string[]; starts: SentStart[] } {
  const watched = { otherWrites: [] as string[], starts: [] as SentStart[] };
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith('/api/') || request.method() === 'GET' || pathname.endsWith('/points')) return;
    if (request.method() === 'PUT' && runPath.test(pathname)) {
      watched.starts.push({ body: request.postData(), path: pathname });
    } else {
      watched.otherWrites.push(`${request.method()} ${pathname}`);
    }
  });
  return watched;
}

function notConfirmed(page: Page) {
  return page.getByRole('alert').filter({ hasText: 'Request not confirmed' });
}

test('a Start rejected for a lost membership is abandoned on purpose, survives a reload, and the next Start succeeds', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  const watched = watchWrites(page);

  // The membership ends while the page still shows the organization it discovered: the server answers 403.
  await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, false);
  await runner.start();
  await expect(notConfirmed(page)).toContainText('(ORG_ACCESS_DENIED)');
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: abandonButton })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry same request' })).toBeEnabled();
  const [queued] = await readQueuedStarts(page, scenario.runnerUserId);
  expect(queued).toBeDefined();
  expect(await readQueuedStarts(page, scenario.runnerUserId)).toHaveLength(1);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();

  // After a reload the request is restored with no answer attached: the abandonment is not offered on a guess.
  await runner.reload();
  await expect(notConfirmed(page)).toContainText('Recovered an unacknowledged request');
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: abandonButton })).toHaveCount(0);
  expect(await readQueuedStarts(page, scenario.runnerUserId)).toEqual([queued]);

  // Asking again is a fresh definitive answer; the retry is the identical request and only then is it offered.
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(notConfirmed(page)).toContainText('(ORG_ACCESS_DENIED)');
  await expect(page.getByRole('button', { name: abandonButton })).toBeEnabled();
  expect(watched.starts).toHaveLength(2);
  expect(watched.starts[1]).toEqual(watched.starts[0]);
  expect(watched.starts[0]?.path.endsWith(`/runs/${queued?.runId}`)).toBe(true);
  expect(JSON.parse(watched.starts[0]?.body ?? '{}')).toEqual({ startedAt: queued?.startedAt });

  // The explicit action: idle, nothing queued, nothing active, and organization discovery asked again.
  await page.getByRole('button', { name: abandonButton }).click();
  await expect(notConfirmed(page)).toHaveCount(0);
  await expect(runner.card('Recording').value).toHaveText('idle');
  await expect(page.getByText('No active run')).toBeVisible();
  expect(await readQueuedStarts(page, scenario.runnerUserId)).toEqual([]);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
  await expect(page.getByText('You are not a member of any organization yet.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  // Local only: no second Start, no command, no delete.
  expect(watched.starts).toHaveLength(2);
  expect(watched.otherWrites).toEqual([]);

  // The abandonment survives a reload, and with the membership back a new Start is a new run.
  await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, true);
  await runner.open(scenario.orgId);
  await expect(notConfirmed(page)).toHaveCount(0);
  expect(await readQueuedStarts(page, scenario.runnerUserId)).toEqual([]);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  const runId = await runner.runId(api, scenario.orgId);
  expect(runId).not.toBe(queued?.runId);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(runId);
});

test('a Start whose outcome is unknown keeps the identical request and never offers the abandonment', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  const watched = watchWrites(page);

  // Each attempt gets an answer that is not a definitive rejection: a dead connection, a 503, and the membership
  // code under a status that says nothing about the membership.
  const answers: Array<(route: Route) => Promise<void>> = [
    (route) => route.abort('connectionrefused'),
    (route) => route.fulfill({ body: '{}', contentType: 'application/json', status: 503 }),
    (route) => route.fulfill({
      body: JSON.stringify({ error: { code: 'ORG_ACCESS_DENIED', message: 'Slow down', requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }),
      contentType: 'application/json',
      status: 429,
    }),
  ];
  let attempt = 0;
  await page.route(runPath, async (route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    const answer = answers[attempt];
    attempt += 1;
    if (answer === undefined) { await route.continue(); return; }
    await answer(route);
  });

  await runner.start();
  await expect(notConfirmed(page)).toBeVisible();
  const [queued] = await readQueuedStarts(page, scenario.runnerUserId);
  expect(queued).toBeDefined();
  for (let retry = 1; retry < answers.length; retry += 1) {
    await expect(page.getByRole('button', { name: abandonButton })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry same request' }).click();
    await expect.poll(() => watched.starts.length).toBe(retry + 1);
    await expect(notConfirmed(page)).toBeVisible();
    expect(await readQueuedStarts(page, scenario.runnerUserId)).toEqual([queued]);
  }
  await expect(page.getByRole('button', { name: abandonButton })).toHaveCount(0);

  // After a reload the same request is still there, and its retry is accepted: one run, under the original id.
  await runner.reload();
  await expect(page.getByRole('button', { name: abandonButton })).toHaveCount(0);
  expect(await readQueuedStarts(page, scenario.runnerUserId)).toEqual([queued]);
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Server state').value).toHaveText('confirmed');

  expect(new Set(watched.starts.map((start) => start.path)).size).toBe(1);
  expect(new Set(watched.starts.map((start) => start.body)).size).toBe(1);
  expect(await runner.runId(api, scenario.orgId)).toBe(queued?.runId);
  expect(await readQueuedStarts(page, scenario.runnerUserId)).toEqual([]);
  expect(watched.otherWrites).toEqual([]);
});
