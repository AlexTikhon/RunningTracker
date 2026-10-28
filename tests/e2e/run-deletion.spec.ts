import type { Locator, Page, Request, Route } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { createFinishedRuns } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectSignedIn } from './support/session.js';

// Deleting a finished run from Archive → My runs. The DELETE is the existing owner route (ADR-0035/0036); these
// tests prove the browser side: nothing is sent before Confirm delete, one request at a time, a failure is never
// shown as a deletion, a retry reuses the same run ID, and a confirmed deletion holds after a reload.

// A fixed browser zone makes the displayed dates the same on every machine.
test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });

const day = (dayOfMonth: number) => `2026-03-${String(dayOfMonth).padStart(2, '0')}T06:00:00.000Z`;
// 06:00 UTC in Warsaw in March (UTC+1).
const label = (dayOfMonth: number) => `${dayOfMonth} Mar 2026, 07:00`;

class MyRuns {
  constructor(private readonly page: Page) {}

  panel(): Locator {
    return this.page.getByRole('region', { name: 'My runs' });
  }

  cards(): Locator {
    return this.panel().getByRole('list', { name: 'My runs' }).locator(':scope > li');
  }

  card(startedAt: string): Locator {
    return this.cards().filter({ has: this.page.locator('time', { hasText: startedAt }) });
  }

  deleteButton(startedAt: string): Locator {
    return this.panel().getByRole('button', { exact: true, name: `Delete your run of ${startedAt}` });
  }

  manage(startedAt: string): Locator {
    return this.panel().getByRole('button', { exact: true, name: `Manage sharing for your run of ${startedAt}` });
  }

  confirmation(startedAt: string): Locator {
    return this.panel().getByRole('region', { name: `Delete your run of ${startedAt}?` });
  }

  confirmations(): Locator {
    return this.panel().getByRole('region', { name: /^Delete your run of / });
  }

  status(): Locator {
    return this.panel().locator('p.search-panel__notice[role="status"]');
  }

  alert(): Locator {
    return this.panel().locator('p.search-panel__notice[role="alert"]');
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
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(panel.getByText('Searching your runs…')).toHaveCount(0);
  }
}

// Every request of one method to one run's own path (not its shares, points or commands).
function runRequests(page: Page, runId: string, method: string): { count: () => number } {
  let seen = 0;
  page.on('request', (request: Request) => {
    if (request.method() === method && new URL(request.url()).pathname.endsWith(`/runs/${runId}`)) seen += 1;
  });
  return { count: () => seen };
}

// Holds every DELETE of one run until `release` is called, then lets it through or drops the connection. `arrived`
// resolves when the first one reaches the route, so a test waits on the request itself rather than on time.
async function holdDeletes(
  page: Page,
  orgId: string,
  runId: string,
): Promise<{ arrived: Promise<void>; release: (outcome: 'continue' | 'drop') => void }> {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release!: (outcome: 'continue' | 'drop') => void;
  const released = new Promise<'continue' | 'drop'>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/orgs/${orgId}/runs/${runId}`, async (route: Route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    arrive();
    const outcome = await released;
    await (outcome === 'drop' ? route.abort('connectionreset') : route.continue());
  });
  return { arrived, release };
}

// The next search answer that lists the given run: the fresh results of a search applied after this was called.
function searchListing(page: Page, runId: string): Promise<void> {
  return page
    .waitForResponse(async (response) => {
      if (!new URL(response.url()).pathname.endsWith('/runs/search') || response.status() !== 200) return false;
      const body = (await response.json()) as { items?: Array<{ runId: string }> };
      return body.items?.some((item) => item.runId === runId) === true;
    })
    .then(() => undefined);
}

function metadataReads(page: Page): { count: () => number } {
  let seen = 0;
  page.on('request', (request: Request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/archive/metadata')) seen += 1;
  });
  return { count: () => seen };
}

test('run deletion: Cancel and Escape send nothing, and a confirmed deletion refreshes My runs and holds after a reload', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const [runA, runB] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 8_000, startedAt: day(3), userId: scenario.runnerUserId },
    { distanceM: 9_000, startedAt: day(4), userId: scenario.runnerUserId },
  ]);
  if (runA === undefined || runB === undefined) throw new Error('The runs were not created');
  await signIn(context, environment, scenario.runnerUserId);
  const ownerApi = await authedApi(context, environment);
  const deletes = runRequests(page, runA, 'DELETE');

  await page.goto('/');
  await expectSignedIn(page);
  const myRuns = new MyRuns(page);
  await myRuns.open();
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(2);
  await expect(myRuns.confirmations()).toHaveCount(0);

  // Opening asks; Cancel closes, returns focus to the card's button and sends nothing.
  await myRuns.deleteButton(label(3)).click();
  const confirmation = myRuns.confirmation(label(3));
  await expect(confirmation).toBeVisible();
  await expect(myRuns.confirmations()).toHaveCount(1);
  await expect(myRuns.deleteButton(label(3))).toHaveAttribute('aria-expanded', 'true');
  await expect(confirmation.getByRole('heading')).toBeFocused();
  await expect(confirmation).toContainText('permanently deletes');
  await expect(confirmation).toContainText('cannot be undone');
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(myRuns.confirmations()).toHaveCount(0);
  await expect(myRuns.deleteButton(label(3))).toBeFocused();

  // Escape from the keyboard closes it too.
  await page.keyboard.press('Enter');
  await expect(confirmation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(myRuns.confirmations()).toHaveCount(0);
  await expect(myRuns.deleteButton(label(3))).toBeFocused();
  await page.waitForTimeout(300);
  expect(deletes.count()).toBe(0);
  expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(200);
  await expect(myRuns.cards()).toHaveCount(2);

  // Opening the confirmation closes the run's own sharing panel and keeps it closed until the confirmation closes.
  await myRuns.manage(label(3)).click();
  await expect(page.getByRole('region', { name: /^Sharing for your run of / })).toHaveCount(1);
  await myRuns.deleteButton(label(3)).click();
  await expect(page.getByRole('region', { name: /^Sharing for your run of / })).toHaveCount(0);
  await expect(myRuns.manage(label(3))).toBeDisabled();
  await expect(myRuns.manage(label(4))).toBeEnabled();

  // A filter edited but not applied must survive the refresh that follows the deletion.
  await myRuns.panel().getByLabel('Minimum distance').fill('1');
  const metadata = metadataReads(page);
  const deleted = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.url().endsWith(`/runs/${runA}`),
  );
  await confirmation.getByRole('button', { name: 'Confirm delete' }).click();
  expect((await deleted).status()).toBe(204);

  await expect(myRuns.status()).toHaveText(`Your run of ${label(3)} was deleted.`);
  await expect(myRuns.cards()).toHaveCount(1);
  await expect(myRuns.card(label(4))).toHaveCount(1);
  await expect(myRuns.card(label(3))).toHaveCount(0);
  await expect(myRuns.confirmations()).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My runs' })).toBeFocused();
  expect(deletes.count()).toBe(1);
  // The archive metadata is read again at once, not at the next 30-second poll.
  await expect.poll(() => metadata.count()).toBeGreaterThanOrEqual(1);
  // The draft edit is still there and still unapplied; the list is the applied March search.
  await expect(myRuns.panel().getByLabel('Minimum distance')).toHaveValue('1');
  await expect(myRuns.panel().getByRole('region', { name: 'Applied filters' })).toContainText('any distance');
  await expect(myRuns.panel().getByText('Changes are not applied yet.')).toBeVisible();

  // The owner's read of a deleted run is 410 within the tombstone window; the other run is untouched.
  expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(410);
  expect(await ownerApi.getRunStatus(scenario.orgId, runB)).toBe(200);

  await page.reload();
  await expectSignedIn(page);
  await myRuns.open();
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(1);
  await expect(myRuns.card(label(4))).toHaveCount(1);
  await expect(myRuns.card(label(3))).toHaveCount(0);
});

test('run deletion: a failed DELETE is never shown as a deletion, sends nothing twice, and can be retried with the same run ID', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const [runA, runB] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 8_000, startedAt: day(3), userId: scenario.runnerUserId },
    { distanceM: 9_000, startedAt: day(4), userId: scenario.runnerUserId },
  ]);
  if (runA === undefined || runB === undefined) throw new Error('The runs were not created');
  await signIn(context, environment, scenario.runnerUserId);
  const ownerApi = await authedApi(context, environment);
  const deletes = runRequests(page, runA, 'DELETE');
  const searches = { count: 0 };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/runs/search')) searches.count += 1;
  });

  await page.goto('/');
  await expectSignedIn(page);
  const myRuns = new MyRuns(page);
  await myRuns.open();
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(2);

  // Attempt 1 never reaches the server: the connection fails. Attempt 2 reaches it and the server deletes the run,
  // but the answer is lost on the way back. Both are held until released, so the pending state can be checked.
  let attempt = 0;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const arrived: Array<() => void> = [];
  const arrivals = [0, 1].map((index) => new Promise<void>((resolve) => {
    arrived[index] = resolve;
  }));
  const runPath = `**/api/orgs/${scenario.orgId}/runs/${runA}`;
  await page.route(runPath, async (route: Route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    attempt += 1;
    if (attempt === 1) {
      arrived[0]?.();
      await held;
      await route.abort('connectionreset');
      return;
    }
    if (attempt === 2) {
      const response = await route.fetch();
      expect(response.status()).toBe(204);
      arrived[1]?.();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });

  await myRuns.deleteButton(label(3)).click();
  const confirmation = myRuns.confirmation(label(3));
  await confirmation.getByRole('button', { name: 'Confirm delete' }).click();
  await arrivals[0];
  // While it is on its way: nothing can be pressed again, no other deletion can start, and the run's sharing stays shut.
  await expect(confirmation.getByRole('status')).toHaveText('Deleting…');
  await expect(confirmation.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(myRuns.deleteButton(label(4))).toBeDisabled();
  await expect(myRuns.manage(label(3))).toBeDisabled();
  await confirmation.getByRole('button', { name: 'Deleting…' }).click({ force: true }).catch(() => undefined);
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeVisible();
  releaseHeld();

  const searchesBefore = searches.count;
  await expect(confirmation.getByRole('alert')).toContainText('The deletion was not confirmed');
  await expect(confirmation.getByRole('alert')).toContainText('Trying again is safe');
  await expect(myRuns.status()).toHaveText('');
  await expect(confirmation.getByRole('button', { name: 'Retry delete' })).toBeFocused();
  await expect(myRuns.cards()).toHaveCount(2);
  expect(deletes.count()).toBe(1);
  expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(200);

  // Attempt 2: the server deletes the run, but the browser never hears it, so it still says nothing was confirmed.
  await confirmation.getByRole('button', { name: 'Retry delete' }).click();
  await arrivals[1];
  await expect(confirmation.getByRole('alert')).toContainText('The run may already be deleted');
  await expect(myRuns.status()).toHaveText('');
  await expect(myRuns.card(label(3))).toHaveCount(1);
  expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(410);
  // Nothing refreshed the list after a failure.
  expect(searches.count).toBe(searchesBefore);

  // Attempt 3 reaches the server untouched: the same DELETE for the same run is 204 again, and only now is the run
  // shown as deleted.
  const confirmed = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.url().endsWith(`/runs/${runA}`),
  );
  await confirmation.getByRole('button', { name: 'Retry delete' }).click();
  expect((await confirmed).status()).toBe(204);
  await expect(myRuns.status()).toHaveText(`Your run of ${label(3)} was deleted.`);
  await expect(myRuns.cards()).toHaveCount(1);
  await expect(myRuns.card(label(3))).toHaveCount(0);
  expect(deletes.count()).toBe(3);
  expect(attempt).toBe(3);
  expect(await ownerApi.getRunStatus(scenario.orgId, runB)).toBe(200);
});

test('run deletion: a run the server will not delete for this person shows only that it is unavailable', async ({
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

  await page.goto('/');
  await expectSignedIn(page);
  const myRuns = new MyRuns(page);
  await myRuns.open();
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(1);

  // The answer another person's run, a run that never existed and an expired tombstone all get from the server.
  await page.route(`**/api/orgs/${scenario.orgId}/runs/${runA}`, async (route: Route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        error: { code: 'RUN_NOT_FOUND', message: 'Run not found.', requestId: '99999999-9999-4999-8999-999999999999' },
      }),
      contentType: 'application/json',
      status: 404,
    });
  });
  await myRuns.deleteButton(label(3)).click();
  const confirmation = myRuns.confirmation(label(3));
  await confirmation.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(confirmation.getByRole('alert')).toHaveText(
    'This run is not available to you, so it cannot be deleted. Search again to refresh the list.',
  );
  await expect(confirmation.getByRole('button')).toHaveText(['Close']);
  await expect(confirmation.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(myRuns.status()).toHaveText('');
  await confirmation.getByRole('button', { name: 'Close' }).click();
  await expect(myRuns.confirmations()).toHaveCount(0);
  await expect(myRuns.deleteButton(label(3))).toBeFocused();
});

test('run deletion: a run whose DELETE is on its way cannot be shared from a newer search listing it again', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const [runA, runB] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 8_000, startedAt: day(3), userId: scenario.runnerUserId },
    { distanceM: 9_000, startedAt: day(4), userId: scenario.runnerUserId },
  ]);
  if (runA === undefined || runB === undefined) throw new Error('The runs were not created');
  await signIn(context, environment, scenario.runnerUserId);
  const ownerApi = await authedApi(context, environment);
  const deletes = runRequests(page, runA, 'DELETE');
  const sharePanels = page.getByRole('region', { name: /^Sharing for your run of / });

  await page.goto('/');
  await expectSignedIn(page);
  const myRuns = new MyRuns(page);
  await myRuns.open();
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(2);

  const hold = await holdDeletes(page, scenario.orgId, runA);
  await myRuns.deleteButton(label(3)).click();
  await myRuns.confirmation(label(3)).getByRole('button', { name: 'Confirm delete' }).click();
  await hold.arrived;

  // A new search while the DELETE is held: its results list the same run, without the confirmation.
  const fresh = searchListing(page, runA);
  await myRuns.panel().getByRole('button', { name: 'Apply filters' }).click();
  await fresh;
  await expect(myRuns.cards()).toHaveCount(2);
  await expect(myRuns.confirmations()).toHaveCount(0);
  await expect(myRuns.status()).toHaveText(`Deleting your run of ${label(3)}…`);
  await expect(myRuns.manage(label(3))).toBeDisabled();
  await expect(myRuns.manage(label(4))).toBeEnabled();
  // No other deletion can start, but the filters stay usable.
  await expect(myRuns.deleteButton(label(3))).toBeDisabled();
  await expect(myRuns.deleteButton(label(4))).toBeDisabled();
  await expect(myRuns.panel().getByLabel('Minimum distance')).toBeEditable();
  await expect(myRuns.panel().getByRole('button', { name: 'Apply filters' })).toBeEnabled();

  // The other run's sharing still opens and closes; the pending run's never opens.
  await myRuns.manage(label(4)).click();
  await expect(sharePanels).toHaveCount(1);
  await expect(myRuns.card(label(4)).getByRole('region', { name: /^Sharing for your run of / })).toHaveCount(1);
  await myRuns.manage(label(4)).click();
  await expect(sharePanels).toHaveCount(0);
  await myRuns.manage(label(3)).dispatchEvent('click');
  await expect(sharePanels).toHaveCount(0);
  await expect(myRuns.manage(label(3))).toBeDisabled();

  // A draft edit made while it is pending is not applied by the refresh that follows the confirmed deletion.
  await myRuns.panel().getByLabel('Minimum distance').fill('1');
  const deleted = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.url().endsWith(`/runs/${runA}`),
  );
  hold.release('continue');
  expect((await deleted).status()).toBe(204);

  await expect(myRuns.status()).toHaveText(`Your run of ${label(3)} was deleted.`);
  await expect(myRuns.cards()).toHaveCount(1);
  await expect(myRuns.card(label(3))).toHaveCount(0);
  await expect(myRuns.manage(label(4))).toBeEnabled();
  await expect(myRuns.deleteButton(label(4))).toBeEnabled();
  await expect(myRuns.panel().getByLabel('Minimum distance')).toHaveValue('1');
  await expect(myRuns.panel().getByText('Changes are not applied yet.')).toBeVisible();
  expect(deletes.count()).toBe(1);
  expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(410);
  expect(await ownerApi.getRunStatus(scenario.orgId, runB)).toBe(200);
});

test('run deletion: a DELETE that fails after a newer search listed the run again leaves no control stuck', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const [runA, runB] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 8_000, startedAt: day(3), userId: scenario.runnerUserId },
    { distanceM: 9_000, startedAt: day(4), userId: scenario.runnerUserId },
  ]);
  if (runA === undefined || runB === undefined) throw new Error('The runs were not created');
  await signIn(context, environment, scenario.runnerUserId);
  const ownerApi = await authedApi(context, environment);
  const deletes = runRequests(page, runA, 'DELETE');
  const sharePanels = page.getByRole('region', { name: /^Sharing for your run of / });

  await page.goto('/');
  await expectSignedIn(page);
  const myRuns = new MyRuns(page);
  const alert = myRuns.alert();
  await myRuns.open();
  await myRuns.applyMarch();
  await expect(myRuns.cards()).toHaveCount(2);

  const hold = await holdDeletes(page, scenario.orgId, runA);
  await myRuns.deleteButton(label(3)).click();
  await myRuns.confirmation(label(3)).getByRole('button', { name: 'Confirm delete' }).click();
  await hold.arrived;
  const fresh = searchListing(page, runA);
  await myRuns.panel().getByRole('button', { name: 'Apply filters' }).click();
  await fresh;
  await expect(myRuns.status()).toHaveText(`Deleting your run of ${label(3)}…`);
  await expect(myRuns.manage(label(3))).toBeDisabled();

  // The connection drops: the outcome is unknown, said once at the panel, and nothing is shown as deleted.
  hold.release('drop');
  await expect(alert).toContainText(`Your run of ${label(3)}: The deletion was not confirmed`);
  await expect(alert).toContainText('Trying again is safe');
  await expect(myRuns.status()).toHaveText('');
  await expect(myRuns.cards()).toHaveCount(2);
  await expect(myRuns.confirmations()).toHaveCount(0);
  expect(deletes.count()).toBe(1);
  expect(await ownerApi.getRunStatus(scenario.orgId, runA)).toBe(200);

  // Every control is back: the run's sharing opens, and either run's deletion can be asked for again.
  await expect(myRuns.manage(label(3))).toBeEnabled();
  await expect(myRuns.deleteButton(label(3))).toBeEnabled();
  await expect(myRuns.deleteButton(label(4))).toBeEnabled();
  await myRuns.manage(label(3)).click();
  await expect(myRuns.card(label(3)).getByRole('region', { name: /^Sharing for your run of / })).toHaveCount(1);

  // Retrying from the card sends the same DELETE for the same run, which now reaches the server.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await myRuns.deleteButton(label(3)).click();
  await expect(sharePanels).toHaveCount(0);
  const deleted = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.url().endsWith(`/runs/${runA}`),
  );
  await myRuns.confirmation(label(3)).getByRole('button', { name: 'Confirm delete' }).click();
  expect((await deleted).status()).toBe(204);
  await expect(myRuns.status()).toHaveText(`Your run of ${label(3)} was deleted.`);
  await expect(myRuns.cards()).toHaveCount(1);
  await expect(myRuns.card(label(3))).toHaveCount(0);
  await expect(myRuns.deleteButton(label(4))).toBeEnabled();
  expect(deletes.count()).toBe(2);
  expect(await ownerApi.getRunStatus(scenario.orgId, runB)).toBe(200);
});
