import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState } from './support/browser-storage.js';
import { setMembershipActive } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// A run the server will not give back (deleted, or the membership that allowed it ended) must not trap the
// browser: capture stays stopped and nothing is deleted by the refusal itself, but the person can export what is
// unsent, discard the local recovery on purpose, and start again (ADR-0052).

const pointsPath = /\/api\/orgs\/[^/]+\/runs\/[^/]+\/points$/;
const runReadPath = /\/api\/orgs\/[^/]+\/runs\/[^/]+$/;
const discardButton = /^Discard local recovery…$/;

// Every request that could change the server's run, which is what a local recovery must never send. The point
// uploads are the uploader's own traffic and are held by the test, so they are not part of this list.
function watchForRunMutations(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && !pointsPath.test(pathname)) seen.push(`${request.method()} ${pathname}`);
  });
  return seen;
}

// A capturing run whose points cannot be delivered: they stay buffered in IndexedDB, which is what a refused run
// has to keep. The held uploads fail like a dead connection, so they are retried and never concluded.
async function startRunWithBufferedPoints(page: Page, runner: RunnerPage, orgId: string, userId: string): Promise<void> {
  await page.route(pointsPath, (route) => route.abort('connectionrefused'));
  await runner.open(orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  // The held upload shows a retry message, not a count, so the buffer itself is what is polled.
  await expect
    .poll(async () => (await readDurableRunnerState(page, userId)).bufferedSeqKeys.length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

async function expectRefusedAndKept(page: Page, runner: RunnerPage, userId: string, runId: string, code: string): Promise<number> {
  await expect(runner.card('Server state').value).toHaveText('refused');
  await expect(page.getByText('Run not confirmed by the server')).toBeVisible();
  await expect(page.getByText(`(${code})`).first()).toBeVisible();
  await expect(runner.card('Capture').value).toHaveText('idle');
  // The refusal alone deleted nothing: the run is still the active one, with its points.
  const durable = await readDurableRunnerState(page, userId);
  expect(durable.activeRunId).toBe(runId);
  expect(durable.bufferedSeqKeys.length).toBeGreaterThanOrEqual(1);
  return durable.bufferedSeqKeys.length;
}

async function exportPoints(page: Page): Promise<{ runId: string; points: Array<{ seq: string }> }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export buffered points' }).click(),
  ]);
  return JSON.parse(await readFile(await download.path(), 'utf8')) as { runId: string; points: Array<{ seq: string }> };
}

async function discardLocalRecovery(page: Page): Promise<void> {
  await page.getByRole('button', { name: discardButton }).click();
  const confirmation = page.getByRole('group', { name: 'Confirm discarding local recovery' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('only clears this browser');
  await expect(confirmation).toContainText('does not restore the run or delete anything on the server');
  await page.getByRole('button', { name: 'Discard local recovery and start over' }).click();
}

test('a run deleted on the server keeps its points until the person discards the local recovery, then a new run starts', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await startRunWithBufferedPoints(page, runner, scenario.orgId, scenario.runnerUserId);
  const runId = await runner.runId(api, scenario.orgId);

  await api.deleteRun(scenario.orgId, runId);
  const mutations = watchForRunMutations(page);
  await runner.reload();

  const buffered = await expectRefusedAndKept(page, runner, scenario.runnerUserId, runId, 'RUN_DELETED');
  // The explicit way out is offered; the blocked-upload notice that cannot apply to this run is not.
  await expect(page.getByRole('button', { name: discardButton })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(page.getByText('Buffered points were rejected')).toHaveCount(0);

  // Still nothing is lost by waiting, and the unsent points can be exported first.
  const exported = await exportPoints(page);
  expect(exported.runId).toBe(runId);
  expect(exported.points).toHaveLength(buffered);
  expect(exported.points[0]?.seq).toBe('1');
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).bufferedSeqKeys).toHaveLength(buffered);

  // The first press only asks; keeping the recovery changes nothing.
  await page.getByRole('button', { name: discardButton }).click();
  await page.getByRole('button', { name: 'Keep local recovery' }).click();
  await expect(page.getByRole('button', { name: discardButton })).toBeVisible();
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(runId);

  await discardLocalRecovery(page);
  await expect(runner.card('Recording').value).toHaveText('idle');
  await expect(page.getByText('No active run')).toBeVisible();
  await expect(page.getByText('Run not confirmed by the server')).toHaveCount(0);
  const cleared = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(cleared).toEqual({ activeRunId: null, bufferedSeqKeys: [], pendingCommandIds: [] });
  // A local cleanup: no finish, no delete, no command, nothing that changes the server's run.
  expect(mutations).toEqual([]);

  // The trap is gone: a new run starts from the idle screen.
  await page.unroute(pointsPath);
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  const newRunId = await runner.runId(api, scenario.orgId);
  expect(newRunId).not.toBe(runId);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(newRunId);
});

test('losing access to the organization is a refusal too: nothing is deleted until the discard, and the next run follows organization discovery', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await startRunWithBufferedPoints(page, runner, scenario.orgId, scenario.runnerUserId);
  const runId = await runner.runId(api, scenario.orgId);

  await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, false);
  const mutations = watchForRunMutations(page);
  await runner.reload();

  const buffered = await expectRefusedAndKept(page, runner, scenario.runnerUserId, runId, 'ORG_ACCESS_DENIED');
  expect((await exportPoints(page)).points).toHaveLength(buffered);

  await discardLocalRecovery(page);
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual({ activeRunId: null, bufferedSeqKeys: [], pendingCommandIds: [] });
  expect(mutations).toEqual([]);

  // No active membership: there is nothing to start a run in, exactly as for a person who never had one.
  await expect(page.getByText('You are not a member of any organization yet.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();

  // With the membership back, organization discovery offers the organization again and Start is available. (The
  // server still holds the old run as the person's one active run until it is finished or auto-finished; that is
  // the server's rule and not something a local discard can or should change.)
  await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, true);
  await runner.open(scenario.orgId);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
  expect((await api.getRun(scenario.orgId, runId)).status).toBe('recording');
});

test('a server that cannot be reached is not a refusal: the discard is never offered and nothing is lost', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await startRunWithBufferedPoints(page, runner, scenario.orgId, scenario.runnerUserId);
  const runId = await runner.runId(api, scenario.orgId);

  await page.route(runReadPath, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    await route.fulfill({ body: '{}', contentType: 'application/json', status: 503 });
  });
  await runner.reload();
  await expect(runner.card('Server state').value).toHaveText('unreachable');
  await expect(page.getByText('Confirming this run with the server')).toBeVisible();
  await expect(page.getByRole('button', { name: /Discard local recovery/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export buffered points' })).toHaveCount(0);
  const durable = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(durable.activeRunId).toBe(runId);
  expect(durable.bufferedSeqKeys.length).toBeGreaterThanOrEqual(1);

  // The periodic retry keeps asking and keeps not offering it; the server answering later resumes the run.
  await page.unroute(runReadPath);
  await page.unroute(pointsPath);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(page.getByRole('button', { name: /Discard local recovery/ })).toHaveCount(0);
});

test('only the tab that owns the writer lease can discard the local recovery of a refused run', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const first = new RunnerPage(page);
  await startRunWithBufferedPoints(page, first, scenario.orgId, scenario.runnerUserId);
  const runId = await first.runId(api, scenario.orgId);
  await api.deleteRun(scenario.orgId, runId);
  await first.reload();
  const buffered = await expectRefusedAndKept(page, first, scenario.runnerUserId, runId, 'RUN_DELETED');
  await expect(page.getByRole('button', { name: discardButton })).toBeEnabled();

  // A second tab sees the same refusal and can export, but it is read-only: the discard is there and disabled.
  const secondPage = await context.newPage();
  await secondPage.route(pointsPath, (route) => route.abort('connectionrefused'));
  const secondMutations = watchForRunMutations(secondPage);
  const second = new RunnerPage(secondPage);
  await second.openRestoredRun();
  await second.expectReadOnly();
  await expect(second.card('Server state').value).toHaveText('refused');
  await expect(secondPage.getByRole('button', { name: discardButton })).toBeDisabled();
  await expect(secondPage.getByRole('button', { name: 'Export buffered points' })).toBeEnabled();
  expect((await exportPoints(secondPage)).points).toHaveLength(buffered);
  expect((await readDurableRunnerState(secondPage, scenario.runnerUserId)).activeRunId).toBe(runId);

  // The first tab goes away; the second becomes the owner and only then can it discard.
  await page.close();
  await expect(async () => {
    const retry = secondPage.getByRole('button', { name: 'Retry ownership' });
    if (await retry.isVisible()) await retry.click();
    await expect(second.card('Writer').value).toHaveText('owned', { timeout: 2_000 });
  }).toPass({ timeout: 40_000 });
  await expect(second.card('Server state').value).toHaveText('refused');
  await expect(secondPage.getByRole('button', { name: discardButton })).toBeEnabled();
  expect((await readDurableRunnerState(secondPage, scenario.runnerUserId)).bufferedSeqKeys).toHaveLength(buffered);

  await discardLocalRecovery(secondPage);
  await expect(second.card('Recording').value).toHaveText('idle');
  expect(await readDurableRunnerState(secondPage, scenario.runnerUserId)).toEqual({ activeRunId: null, bufferedSeqKeys: [], pendingCommandIds: [] });
  expect(secondMutations).toEqual([]);
});
