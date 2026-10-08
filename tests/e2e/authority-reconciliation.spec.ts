import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type { Page, Route } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { endWriterLeaseBehindThePage, readDurableRunnerState, readDurableRunStatus } from './support/browser-storage.js';
import { setMembershipActive } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// ADR-0055: what the server says about the run, and what an upload or a command is refused with, must never leave
// React, the durable recovery in IndexedDB and the writer lease contradicting each other. Every scenario here holds a
// real network answer and releases it after the page has moved on, or deletes the run behind an open page.

const pointsPath = /\/api\/orgs\/[^/]+\/runs\/[^/]+\/points$/;
const commandsPath = /\/api\/orgs\/[^/]+\/runs\/[^/]+\/commands$/;
const runReadPath = /\/api\/orgs\/[^/]+\/runs\/[^/]+$/;
const discardButton = /^Discard local recovery…$/;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const errorEnvelope = (code: string, message = 'The server said no') => ({ error: { code, message, requestId: randomUUID() } });

// Every GET of a run is fetched for real, at the moment the page asks, and then held. The answer is therefore the
// server's state of that moment; released later, it is an old answer. `shape` may replace it, to make it visible
// whenever something wrongly stores or shows it.
function holdRunReads(page: Page) {
  const reads: Array<{ release: (override?: object) => void }> = [];
  void page.route(runReadPath, async (route: Route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    try {
      const response = await route.fetch();
      const gate = deferred<object | undefined>();
      reads.push({ release: (override) => gate.resolve(override) });
      const override = await gate.promise;
      await route.fulfill(override === undefined ? { response } : { json: override, response });
    } catch {
      // The page abandoned the request; nothing is left to answer.
    }
  });
  return reads;
}

// After a held answer has been released, gives the page time to do whatever it wrongly would. A negative claim has
// to be bounded by something. The answer may never be delivered (the page aborted the request, which is the good
// outcome), so waiting for it is bounded too.
async function releaseAndSettle(page: Page, release: () => void): Promise<void> {
  const delivered = page
    .waitForResponse((response) => runReadPath.test(new URL(response.url()).pathname) && response.request().method() === 'GET', { timeout: 2_000 })
    .catch(() => undefined);
  release();
  await delivered;
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
}

function watchForRunMutations(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && !pointsPath.test(pathname)) seen.push(`${request.method()} ${pathname}`);
  });
  return seen;
}

// A capturing run whose points are held back: they stay buffered. `deliver.on` lets them through to the real server,
// which is how the next real upload (and its answer) happens while the page is open.
async function startRunWithHeldPoints(page: Page, runner: RunnerPage, orgId: string, userId: string) {
  const deliver = { on: false };
  await page.route(pointsPath, async (route) => {
    if (deliver.on) await route.continue();
    else await route.abort('connectionrefused');
  });
  await runner.open(orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect
    .poll(async () => (await readDurableRunnerState(page, userId)).bufferedSeqKeys.length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  return deliver;
}

async function expectRefusedWhileOpen(page: Page, runner: RunnerPage, userId: string, runId: string, code: string): Promise<number> {
  await expect(runner.card('Server state').value).toHaveText('refused', { timeout: 30_000 });
  await expect(page.getByText('Run not confirmed by the server')).toBeVisible();
  await expect(page.getByText(`(${code})`).first()).toBeVisible();
  await expect(runner.card('Capture').value).toHaveText('idle');
  await expect(page.getByRole('button', { name: discardButton })).toBeEnabled();
  await expect(page.getByText('Buffered points were rejected')).toHaveCount(0);
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
  await page.getByRole('button', { name: 'Discard local recovery and start over' }).click();
}

// Several scenarios wait for a retry timer, a lease renewal or a held answer in turn.
test.describe.configure({ timeout: 120_000 });

const empty = { activeRunId: null, bufferedSeqKeys: [], pendingCommandIds: [] };

test('an old read of run A released after A was finished, cleared and run B started cannot repoint recovery', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);

  // A's points are rejected for good (a 400 about the request, not about the run): the page asks the server what the
  // run is, and that answer is held. B's points go through.
  let rejectedRunId: string | null = null;
  await page.route(pointsPath, async (route) => {
    const id = /runs\/([^/]+)\/points/.exec(route.request().url())?.[1] ?? '';
    rejectedRunId ??= id;
    if (id === rejectedRunId) await route.fulfill({ json: errorEnvelope('INVALID_REQUEST'), status: 400 });
    else await route.continue();
  });
  const reads = holdRunReads(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Upload').value).toHaveText('blocked', { timeout: 30_000 });
  await expect.poll(() => reads.length).toBe(1);
  const runA = rejectedRunId as unknown as string;

  // The person finishes A, discards its rejected queue and starts B while A's read is still out.
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');
  await page.getByRole('button', { name: 'Discard buffered points and clear run' }).click();
  await expect(runner.card('Recording').value).toHaveText('idle');
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  const runB = (await api.listRunIds(scenario.orgId)).find((id) => id !== runA);
  expect(runB).toBeDefined();
  await expect.poll(async () => (await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(runB);

  await releaseAndSettle(page, () => reads[0]?.release());

  // B is still the page's run and the durable one; A's old answer changed neither.
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(runB);
  await expect(page.getByText(`#${(runB ?? '').slice(0, 8)}`)).toBeVisible();
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await runner.reload();
  await expect(page.getByText(`#${(runB ?? '').slice(0, 8)}`)).toBeVisible();
  await expect(runner.card('Recording').value).toHaveText('recording');
});

test('an older successful read released after the person discarded the refused run restores nothing', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  const deliver = await startRunWithHeldPoints(page, runner, scenario.orgId, scenario.runnerUserId);
  const runId = await runner.runId(api, scenario.orgId);

  // The page is reopened: its question about the run is answered successfully but held (A still exists).
  const reads = holdRunReads(page);
  await runner.reload();
  await expect.poll(() => reads.length).toBe(1);
  await expect(runner.card('Server state').value).toHaveText('confirming');

  // Then the run is deleted, and the next real upload is refused: the page learns it without any reload.
  await api.deleteRun(scenario.orgId, runId);
  deliver.on = true;
  await expectRefusedWhileOpen(page, runner, scenario.runnerUserId, runId, 'RUN_DELETED');

  await discardLocalRecovery(page);
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(empty);

  // The old successful answer for A is released only now.
  await releaseAndSettle(page, () => reads[0]?.release());
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(empty);
  expect(await readDurableRunStatus(page, scenario.runnerUserId)).toBeNull();
  await expect(runner.card('Recording').value).toHaveText('idle');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(page.getByText('No active run')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
});

test('a read held across a writer change, a lost lease and a newer epoch of the same owner writes nothing obsolete', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Capture').value).toHaveText('capturing');
  await expect(runner.card('Server state').value).toHaveText('confirmed');

  // Every answer is held and, if wrongly stored, would be visible: it says the run is finished.
  const reads = holdRunReads(page);
  await runner.reload();
  await expect.poll(() => reads.length).toBe(1);
  await expect(runner.card('Server state').value).toHaveText('confirming');
  const firstFence = Number(/fence (\d+)/.exec((await runner.card('Writer').detail.textContent()) ?? '')?.[1]);
  expect(firstFence).toBeGreaterThan(0);
  const forged = {
    controlRevision: '99', dataRevision: '999', finishedAt: new Date().toISOString(), rawState: 'available',
    runId: '', startedAt: new Date().toISOString(), status: 'finished', summary: null,
  };
  const forgedFor = async () => ({ ...forged, runId: (await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId });

  // The lease ends behind the page's back; the page notices at its next renewal and its read has to be asked again.
  await endWriterLeaseBehindThePage(page, scenario.runnerUserId);
  await expect(runner.card('Writer').value).toHaveText('lost', { timeout: 20_000 });
  await expect.poll(() => reads.length).toBe(2);

  // The same owner takes the lease again: a newer epoch, and a third question.
  await page.getByRole('button', { name: 'Retry ownership' }).click();
  await expect(runner.card('Writer').value).toHaveText('owned');
  expect(Number(/fence (\d+)/.exec((await runner.card('Writer').detail.textContent()) ?? '')?.[1])).toBeGreaterThan(firstFence);
  await expect.poll(() => reads.length).toBe(3);
  // One question per epoch, not one per render or per effect.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
  expect(reads).toHaveLength(3);

  // Out of order: the oldest answers arrive first, newest last. Neither may be shown or stored.
  const stale = await forgedFor();
  await releaseAndSettle(page, () => reads[0]?.release(stale));
  await releaseAndSettle(page, () => reads[1]?.release(stale));
  await expect(runner.card('Server state').value).toHaveText('confirming');
  await expect(runner.card('Recording').detail).toHaveText('recording');
  expect(await readDurableRunStatus(page, scenario.runnerUserId)).toBe('recording');

  // The answer for the current epoch is the only one that counts.
  await releaseAndSettle(page, () => reads[2]?.release());
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  expect(await readDurableRunStatus(page, scenario.runnerUserId)).toBe('recording');
  expect(reads).toHaveLength(3);
});

test('a run deleted behind an open page: the next upload refusal stops capture, keeps the points and offers the discard without a reload', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  const deliver = await startRunWithHeldPoints(page, runner, scenario.orgId, scenario.runnerUserId);
  const runId = await runner.runId(api, scenario.orgId);

  await api.deleteRun(scenario.orgId, runId);
  const mutations = watchForRunMutations(page);
  deliver.on = true;

  const buffered = await expectRefusedWhileOpen(page, runner, scenario.runnerUserId, runId, 'RUN_DELETED');
  const exported = await exportPoints(page);
  expect(exported.runId).toBe(runId);
  expect(exported.points.length).toBeGreaterThanOrEqual(buffered);
  expect(exported.points[0]?.seq).toBe('1');
  // Nothing was lost by the refusal, and nothing is sent to the server for the run.
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).bufferedSeqKeys.length).toBeGreaterThanOrEqual(buffered);
  expect(mutations).toEqual([]);

  await discardLocalRecovery(page);
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(empty);
  expect(mutations).toEqual([]);

  // The trap is gone: a new run starts on the same page.
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  await expect(runner.card('Capture').value).toHaveText('capturing');
  const newRunId = await runner.runId(api, scenario.orgId);
  expect(newRunId).not.toBe(runId);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBe(newRunId);
});

test('membership revoked during recording: the same recovery applies, and the next run follows current organization discovery', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  const deliver = await startRunWithHeldPoints(page, runner, scenario.orgId, scenario.runnerUserId);
  const runId = await runner.runId(api, scenario.orgId);

  await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, false);
  const mutations = watchForRunMutations(page);
  deliver.on = true;

  const buffered = await expectRefusedWhileOpen(page, runner, scenario.runnerUserId, runId, 'ORG_ACCESS_DENIED');
  expect((await exportPoints(page)).points.length).toBeGreaterThanOrEqual(buffered);

  await discardLocalRecovery(page);
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(empty);
  expect(mutations).toEqual([]);

  // Without reloading the page: discovery is asked again and finds no membership.
  await expect(page.getByText('You are not a member of any organization yet.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();

  await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, true);
  await runner.open(scenario.orgId);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
});

test('a command that fails with an unknown outcome is retried with its exact identity, and nothing transient offers the discard', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const runner = new RunnerPage(page);
  await startRunWithHeldPoints(page, runner, scenario.orgId, scenario.runnerUserId);

  const bodies: Array<{ commandId: string; expectedControlRevision: string; type: string }> = [];
  const failures = [
    { json: errorEnvelope('SERVICE_UNAVAILABLE'), status: 503 },
    { json: errorEnvelope('RATE_LIMITED'), status: 429 },
  ];
  await page.route(commandsPath, async (route) => {
    bodies.push(route.request().postDataJSON() as (typeof bodies)[number]);
    const failure = failures.shift();
    if (failure === undefined) await route.continue();
    else await route.fulfill(failure);
  });

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('Request not confirmed')).toBeVisible();
  const queued = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(queued.pendingCommandIds).toHaveLength(1);
  await expect(runner.card('Server state').value).toHaveText('error');
  await expect(page.getByRole('button', { name: /Discard local recovery/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect.poll(() => bodies.length).toBe(2);
  await expect(page.getByText('Request not confirmed')).toBeVisible();
  await expect(page.getByRole('button', { name: /Discard local recovery/ })).toHaveCount(0);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).pendingCommandIds).toEqual(queued.pendingCommandIds);

  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(runner.card('Recording').value).toHaveText('paused');
  await expect(runner.card('Server state').value).toHaveText('confirmed');
  expect(bodies).toHaveLength(3);
  expect(new Set(bodies.map((body) => body.commandId)).size).toBe(1);
  expect(new Set(bodies.map((body) => body.expectedControlRevision)).size).toBe(1);
  expect(queued.pendingCommandIds).toEqual([bodies[0]?.commandId]);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).pendingCommandIds).toEqual([]);
});

test('a command the server refuses for a deleted run joins the refusal flow, keeps its exact request queued, and the discard clears it', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);
  await startRunWithHeldPoints(page, runner, scenario.orgId, scenario.runnerUserId);
  const runId = await runner.runId(api, scenario.orgId);

  const bodies: Array<{ commandId: string }> = [];
  await page.route(commandsPath, async (route) => {
    bodies.push(route.request().postDataJSON() as (typeof bodies)[number]);
    await route.continue();
  });
  await api.deleteRun(scenario.orgId, runId);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await expect(runner.card('Server state').value).toHaveText('refused', { timeout: 30_000 });
  await expect(page.getByText('Run not confirmed by the server')).toBeVisible();
  await expect(page.getByText('(RUN_DELETED)').first()).toBeVisible();
  await expect(runner.card('Capture').value).toHaveText('idle');
  await expect(page.getByRole('button', { name: discardButton })).toBeEnabled();
  expect(bodies).toHaveLength(1);
  // The request keeps its identity until the person acts: it is still the one queued command of this run.
  const kept = await readDurableRunnerState(page, scenario.runnerUserId);
  expect(kept.pendingCommandIds).toEqual([bodies[0]?.commandId]);
  expect(kept.activeRunId).toBe(runId);
  expect(kept.bufferedSeqKeys.length).toBeGreaterThanOrEqual(1);

  await discardLocalRecovery(page);
  await expect(runner.card('Recording').value).toHaveText('idle');
  expect(await readDurableRunnerState(page, scenario.runnerUserId)).toEqual(empty);
  expect(bodies).toHaveLength(1);
});
