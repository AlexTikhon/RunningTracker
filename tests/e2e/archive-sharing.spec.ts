import type { BrowserContext, Locator, Page, Request, Route } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { readDurableRunnerState } from './support/browser-storage.js';
import { createFinishedRuns } from './support/database.js';
import type { E2eEnvironment } from './support/environment.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';
import { expectSignedIn, expectSignedOut, organizationRegion } from './support/session.js';

// Sharing a finished run from Archive → My runs (ADR-0064). The panel is the Runner tab's (ADR-0063), opened for
// one card at a time; nothing about sharing is read before it is opened, and it never becomes the active run.

// A fixed browser zone makes the displayed dates the same on every machine.
test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });

const day = (dayOfMonth: number) => `2026-03-${String(dayOfMonth).padStart(2, '0')}T06:00:00.000Z`;
// 06:00 UTC in Warsaw in March (UTC+1).
const label = (dayOfMonth: number) => `${dayOfMonth} Mar 2026, 07:00`;

function coachLabel(userId: string): string {
  return `Coach …${userId.slice(-8)}`;
}

class MyRuns {
  constructor(private readonly page: Page) {}

  panel(): Locator {
    return this.page.getByRole('region', { name: 'My runs' });
  }

  // The cards themselves, not the rows of a sharing panel inside one of them.
  cards(): Locator {
    return this.panel().getByRole('list', { name: 'My runs' }).locator(':scope > li');
  }

  card(startedAt: string): Locator {
    return this.cards().filter({ has: this.page.locator('time', { hasText: startedAt }) });
  }

  manage(card: Locator): Locator {
    return card.getByRole('button', { name: /^Manage sharing for your run of / });
  }

  sharePanels(): Locator {
    return this.page.getByRole('region', { name: /^Sharing for your run of / });
  }

  shareRow(coachUserId: string): Locator {
    return this.sharePanels().getByRole('listitem', { name: coachLabel(coachUserId) });
  }

  shareAccess(coachUserId: string): Locator {
    return this.shareRow(coachUserId).getByText(/^(Not shared|Live and history|Live only|History only|No access)$/);
  }

  shareButton(coachUserId: string): Locator {
    return this.shareRow(coachUserId).getByRole('button', { exact: true, name: `Share with ${coachLabel(coachUserId)}` });
  }

  revokeButton(coachUserId: string): Locator {
    return this.shareRow(coachUserId).getByRole('button', { name: `Revoke ${coachLabel(coachUserId)}` });
  }

  async open(): Promise<void> {
    await this.page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Archive' }).click();
    await expect(this.page.getByRole('heading', { name: 'My runs' })).toBeVisible();
  }

  async applyMarch(): Promise<void> {
    const panel = this.panel();
    await panel.getByLabel('Period').selectOption('dates');
    await panel.getByLabel('From', { exact: true }).fill('2026-03-01');
    await panel.getByLabel('To (included)').fill('2026-03-31');
    await this.apply();
  }

  async apply(): Promise<void> {
    await this.panel().getByRole('button', { name: 'Apply filters' }).click();
    await expect(this.panel().getByText('Searching your runs…')).toHaveCount(0);
  }
}

// Every sharing read the page sends, by run ("coaches" for the organization's coach list).
function sharingReads(page: Page): { count: (key: string) => number; total: () => number } {
  const seen: string[] = [];
  page.on('request', (request: Request) => {
    if (request.method() !== 'GET') return;
    const path = new URL(request.url()).pathname;
    const shares = /^\/api\/orgs\/[^/]+\/runs\/([^/]+)\/shares$/u.exec(path);
    if (shares?.[1] !== undefined) seen.push(shares[1]);
    else if (/^\/api\/orgs\/[^/]+\/coaches$/u.test(path)) seen.push('coaches');
  });
  return { count: (key) => seen.filter((entry) => entry === key).length, total: () => seen.length };
}

// Holds matching requests until released: only the first (a click sends one change), or every one until then
// (development mode mounts effects twice, so opening a panel reads twice). `continue` lets the late answers come
// back; `drop` fails them as a lost connection would. The page may have given up on them by then, so either may
// fail, which is fine.
async function hold(
  page: Page,
  url: string,
  method: string,
  which: 'all' | 'first' = 'first',
): Promise<{ arrived: Promise<Request>; release: (mode?: 'continue' | 'drop') => void }> {
  let arrive!: (request: Request) => void;
  let release!: (mode: 'continue' | 'drop') => void;
  const arrived = new Promise<Request>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<'continue' | 'drop'>((resolve) => {
    release = resolve;
  });
  let held = false;
  let released = false;
  void gate.then(() => {
    released = true;
  });
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method || released || (held && which === 'first')) {
      await route.continue().catch(() => undefined);
      return;
    }
    held = true;
    arrive(route.request());
    const mode = await gate;
    await (mode === 'drop' ? route.abort('connectionreset') : route.continue()).catch(() => undefined);
  });
  return { arrived, release: (mode = 'continue') => release(mode) };
}

async function csrfTokenOf(context: BrowserContext, environment: E2eEnvironment): Promise<string> {
  const response = await context.request.get(`${environment.webOrigin}/api/session`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { csrf: { token: string } }).csrf.token;
}

async function closeAll(contexts: readonly BrowserContext[]): Promise<void> {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
}

test('archive sharing: a run shared from the Runner tab is still managed from My runs after New run and a reload', async ({
  browser,
  environment,
  scenario,
}) => {
  // The summary worker publishes a finished run's summary within its interval (60 s by default); only then is the
  // run searchable.
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  try {
    const runnerContext = await browser.newContext();
    contexts.push(runnerContext);
    const coachContext = await browser.newContext();
    contexts.push(coachContext);
    await signIn(runnerContext, environment, scenario.runnerUserId);
    await signIn(coachContext, environment, scenario.coachUserId);
    const ownerApi = await authedApi(runnerContext, environment);
    const coachApi = await authedApi(coachContext, environment);

    const page = await runnerContext.newPage();
    const runner = new RunnerPage(page);
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    const runId = await runner.runId(ownerApi, scenario.orgId);
    await runner.shareWith(scenario.coachUserId);
    await expect(runner.shareAccess(scenario.coachUserId)).toHaveText('Live and history');

    await runner.waitForCaptureComplete();
    await runner.waitForEmptyBuffer();
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    await page.getByRole('button', { name: 'New run' }).click();
    await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
    await expect(runner.sharePanel()).toHaveCount(0);
    // The grant outlives the Runner tab's panel.
    expect(await coachApi.getRunStatus(scenario.orgId, runId)).toBe(200);

    const reads = sharingReads(page);
    const myRuns = new MyRuns(page);
    await myRuns.open();
    // The run is listed once its summary is published; the default search (this month) includes it.
    await expect
      .poll(async () => {
        await myRuns.apply();
        return myRuns.cards().count();
      }, { intervals: [2_000], timeout: 120_000 })
      .toBe(1);
    // Nothing about sharing is read for a card nobody opened.
    await page.waitForTimeout(300);
    expect(reads.total()).toBe(0);

    const card = myRuns.cards().first();
    await myRuns.manage(card).click();
    await expect(myRuns.sharePanels()).toHaveCount(1);
    await expect(myRuns.sharePanels()).toContainText(`#${runId.slice(0, 8)}`);
    await expect(myRuns.sharePanels().getByRole('heading')).toBeFocused();
    await expect(myRuns.sharePanels()).toContainText('This run is finished');
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Live and history');

    await myRuns.revokeButton(scenario.coachUserId).click();
    // Read again from the server after the change, not taken from the click.
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
    expect(await coachApi.getRunStatus(scenario.orgId, runId)).toBe(404);
    expect(await ownerApi.getRunStatus(scenario.orgId, runId)).toBe(200);

    // After a reload the run is still not the active run, and still managed from My runs.
    await page.reload();
    await expect(runner.card('Recording').value).toHaveText('idle');
    expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
    await myRuns.open();
    await expect(myRuns.cards()).toHaveCount(1);
    await myRuns.manage(myRuns.cards().first()).click();
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
    await myRuns.sharePanels().getByRole('button', { name: 'Close' }).click();
    await expect(myRuns.sharePanels()).toHaveCount(0);
    await expect(myRuns.manage(myRuns.cards().first())).toBeFocused();

    expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
    await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Runner' }).click();
    await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
    await expect(runner.sharePanel()).toHaveCount(0);
  } finally {
    await closeAll(contexts);
  }
});

test('archive sharing: share and revoke an unshared finished run, one panel at a time, and a deleted run keeps no controls', async ({
  browser,
  environment,
  scenario,
}) => {
  const [runA, runB] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 8_000, startedAt: day(3), userId: scenario.runnerUserId },
    { distanceM: 9_000, startedAt: day(4), userId: scenario.runnerUserId },
  ]);
  if (runA === undefined || runB === undefined) throw new Error('The runs were not created');
  const contexts: BrowserContext[] = [];
  try {
    const runnerContext = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });
    contexts.push(runnerContext);
    const coachContext = await browser.newContext();
    contexts.push(coachContext);
    await signIn(runnerContext, environment, scenario.runnerUserId);
    await signIn(coachContext, environment, scenario.coachUserId);
    const ownerApi = await authedApi(runnerContext, environment);
    const coachApi = await authedApi(coachContext, environment);

    const page = await runnerContext.newPage();
    const reads = sharingReads(page);
    await page.goto('/');
    await expectSignedIn(page);
    const myRuns = new MyRuns(page);
    await myRuns.open();
    await myRuns.applyMarch();
    await expect(myRuns.cards()).toHaveCount(2);
    await expect(myRuns.manage(myRuns.cards().first())).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(300);
    expect(reads.total()).toBe(0);
    expect(await coachApi.getRunStatus(scenario.orgId, runA)).toBe(404);

    // Share run A from its card: the coach can then read its history.
    const cardA = myRuns.card(label(3));
    const cardB = myRuns.card(label(4));
    await myRuns.manage(cardA).click();
    await expect(myRuns.manage(cardA)).toHaveAttribute('aria-expanded', 'true');
    await expect(myRuns.sharePanels()).toHaveAccessibleName(`Sharing for your run of ${label(3)} #${runA.slice(0, 8)}`);
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
    await myRuns.shareButton(scenario.coachUserId).click();
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Live and history');
    expect(await coachApi.getRunStatus(scenario.orgId, runA)).toBe(200);
    expect(reads.count(runB)).toBe(0);

    // Opening B replaces A's panel: only one is ever open.
    await myRuns.manage(cardB).click();
    await expect(myRuns.sharePanels()).toHaveCount(1);
    await expect(myRuns.sharePanels()).toHaveAccessibleName(`Sharing for your run of ${label(4)} #${runB.slice(0, 8)}`);
    await expect(myRuns.manage(cardA)).toHaveAttribute('aria-expanded', 'false');
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');

    // Close from the keyboard returns focus to the card; Escape closes too.
    await myRuns.sharePanels().getByRole('button', { name: 'Close' }).focus();
    await page.keyboard.press('Enter');
    await expect(myRuns.sharePanels()).toHaveCount(0);
    await expect(myRuns.manage(cardB)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(myRuns.sharePanels()).toHaveCount(1);
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
    await page.keyboard.press('Escape');
    await expect(myRuns.sharePanels()).toHaveCount(0);
    await expect(myRuns.manage(cardB)).toBeFocused();

    // Revoke A from My runs: the coach's history read is refused again, the owner's still succeeds.
    await myRuns.manage(cardA).click();
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Live and history');
    await myRuns.revokeButton(scenario.coachUserId).click();
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
    expect(await coachApi.getRunStatus(scenario.orgId, runA)).toBe(404);
    expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(200);

    // Applying a search closes the panel, even when the run is still listed.
    await myRuns.apply();
    await expect(myRuns.cards()).toHaveCount(2);
    await expect(myRuns.sharePanels()).toHaveCount(0);

    // Run B is deleted while its panel is open: the change is refused, nothing is shown as shared and no share
    // or revoke control is left.
    await myRuns.manage(cardB).click();
    await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
    await ownerApi.deleteRun(scenario.orgId, runB);
    await myRuns.shareButton(scenario.coachUserId).click();
    await expect(myRuns.sharePanels().getByRole('alert')).toHaveText('This run has been deleted, so there is no sharing left to manage.');
    await expect(myRuns.sharePanels().getByRole('button')).toHaveText(['Close']);
    expect(await coachApi.getRunStatus(scenario.orgId, runB)).toBe(404);
  } finally {
    await closeAll(contexts);
  }
});

test('archive sharing: a held answer for one run cannot reach another run, organization or session', async ({
  context,
  environment,
  organizations,
  page,
  scenario,
}) => {
  test.setTimeout(120_000);
  const second = await organizations.memberOf(scenario.runnerUserId);
  const [runA, runB] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 8_000, startedAt: day(3), userId: scenario.runnerUserId },
    { distanceM: 9_000, startedAt: day(4), userId: scenario.runnerUserId },
  ]);
  await createFinishedRuns(environment, second, [{ distanceM: 30_000, startedAt: day(5), userId: scenario.runnerUserId }]);
  if (runA === undefined || runB === undefined) throw new Error('The runs were not created');
  await signIn(context, environment, scenario.runnerUserId);
  const ownerApi = await authedApi(context, environment);
  const reads = sharingReads(page);

  await page.goto('/');
  await expectSignedIn(page);
  const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });
  await picker.selectOption(scenario.orgId);
  const myRuns = new MyRuns(page);
  await myRuns.open();
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(2);
  const cardA = myRuns.card(label(3));
  const cardB = myRuns.card(label(4));

  // A's share list is held; B is opened meanwhile, and A's late answer changes nothing.
  const loadA = await hold(page, `**/api/orgs/${scenario.orgId}/runs/${runA}/shares`, 'GET', 'all');
  await myRuns.manage(cardA).click();
  await loadA.arrived;
  await expect(myRuns.sharePanels().getByText('Loading coaches and current sharing…')).toBeVisible();
  await myRuns.manage(cardB).click();
  await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
  const readsOfA = reads.count(runA);
  loadA.release();
  await page.waitForTimeout(500);
  await expect(myRuns.sharePanels()).toHaveCount(1);
  await expect(myRuns.sharePanels()).toHaveAccessibleName(`Sharing for your run of ${label(4)} #${runB.slice(0, 8)}`);
  await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
  await expect(myRuns.manage(cardA)).toHaveAttribute('aria-expanded', 'false');
  expect(reads.count(runA)).toBe(readsOfA);

  // B's grant is held; the organization changes meanwhile. The late answer neither shows anything nor asks for
  // B's shares again.
  const grantB = await hold(page, `**/api/orgs/${scenario.orgId}/runs/${runB}/shares/${scenario.coachUserId}`, 'PUT');
  await myRuns.shareButton(scenario.coachUserId).click();
  await grantB.arrived;
  await expect(myRuns.shareRow(scenario.coachUserId).getByRole('button', { name: /Share/u })).toHaveText('Sharing…');
  const readsOfB = reads.count(runB);
  await picker.selectOption(second);
  await expect(myRuns.sharePanels()).toHaveCount(0);
  grantB.release();
  await page.waitForTimeout(500);
  expect(reads.count(runB)).toBe(readsOfB);
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(1);
  await expect(myRuns.sharePanels()).toHaveCount(0);

  // None of this touched the runner: there is no active run.
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Runner' }).click();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();

  // A grant is held, then the same person's session is replaced (a new sign-in, noticed on focus). The Archive
  // starts over under the new session, so the panel is gone; the held request is never sent again, nothing reads
  // A's shares for it, and the next change carries the new session's token.
  await picker.selectOption(scenario.orgId);
  await myRuns.open();
  await myRuns.applyMarch();
  await myRuns.manage(cardA).click();
  await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
  const oldToken = await csrfTokenOf(context, environment);
  const grants: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes(`/runs/${runA}/shares/`)) {
      grants.push(request.headers()['x-csrf-token'] ?? '');
    }
  });
  const grantA = await hold(page, `**/api/orgs/${scenario.orgId}/runs/${runA}/shares/${scenario.coachUserId}`, 'PUT');
  await myRuns.shareButton(scenario.coachUserId).click();
  await grantA.arrived;

  await signIn(context, environment, scenario.runnerUserId);
  const newToken = await csrfTokenOf(context, environment);
  expect(newToken).not.toBe(oldToken);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await expect(myRuns.sharePanels()).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My runs' })).toBeVisible();
  const readsAfterReplacement = reads.count(runA);
  grantA.release('drop');
  await page.waitForTimeout(500);
  expect(reads.count(runA)).toBe(readsAfterReplacement);
  expect(grants).toEqual([oldToken]);
  await expect(myRuns.sharePanels()).toHaveCount(0);

  await myRuns.applyMarch();
  await myRuns.manage(cardA).click();
  await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
  await myRuns.shareButton(scenario.coachUserId).click();
  await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Live and history');
  expect(grants).toEqual([oldToken, newToken]);
  expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(200);
  expect((await readDurableRunnerState(page, scenario.runnerUserId)).activeRunId).toBeNull();
});

test('archive sharing: ending the session while a change is held leaves nothing to act on', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const [runA] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 8_000, startedAt: day(3), userId: scenario.runnerUserId },
  ]);
  if (runA === undefined) throw new Error('The run was not created');
  await signIn(context, environment, scenario.runnerUserId);
  const reads = sharingReads(page);
  await page.goto('/');
  await expectSignedIn(page);
  const myRuns = new MyRuns(page);
  await myRuns.open();
  await myRuns.applyMarch();
  await myRuns.manage(myRuns.cards().first()).click();
  await expect(myRuns.shareAccess(scenario.coachUserId)).toHaveText('Not shared');

  const grant = await hold(page, `**/api/orgs/${scenario.orgId}/runs/${runA}/shares/${scenario.coachUserId}`, 'PUT');
  await myRuns.shareButton(scenario.coachUserId).click();
  await grant.arrived;
  const readsBefore = reads.count(runA);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await expect(myRuns.sharePanels()).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My runs' })).toHaveCount(0);
  grant.release();
  await page.waitForTimeout(500);
  expect(reads.count(runA)).toBe(readsBefore);
  await expect(myRuns.sharePanels()).toHaveCount(0);
});
