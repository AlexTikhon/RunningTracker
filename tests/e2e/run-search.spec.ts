import type { Locator, Page, Request } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { createFinishedRuns, setMembershipActive, shareRunHistory } from './support/database.js';
import type { FinishedRunSeed } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectSignedIn, organizationRegion } from './support/session.js';

// A fixed browser zone makes the displayed dates and the zone line the same on every machine.
test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });

const ZONE = 'Europe/Warsaw';
const day = (dayOfMonth: number, hour = 6) =>
  `2026-03-${String(dayOfMonth).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

// 26 runs between 5 and 15 km (so two pages of 20 and 6), three runs outside that, one with no summary yet.
function runnersMarch(userId: string): FinishedRunSeed[] {
  const bulk = Array.from({ length: 22 }, (_, index) => ({
    distanceM: 6_000 + index * 100,
    startedAt: day(3 + index),
    userId,
  }));
  return [
    ...bulk,
    { distanceM: 5_000, startedAt: day(1, 6), userId },
    { distanceM: 5_000, startedAt: day(1, 7), userId },
    { distanceM: 10_000, startedAt: day(2, 6), userId },
    { distanceM: 12_000, startedAt: day(2, 7), userId },
    { distanceM: 3_000, startedAt: day(26, 6), userId },
    { distanceM: 4_999.96, startedAt: day(27, 6), userId },
    { distanceM: 21_097.5, startedAt: day(28, 6), quality: 'insufficient', userId },
    { distanceM: null, startedAt: day(29, 6), userId },
  ];
}

function panelOf(page: Page): Locator {
  return page.getByRole('region', { name: 'My runs' });
}

function cardsOf(page: Page): Locator {
  return panelOf(page).getByRole('list', { name: 'My runs' }).getByRole('listitem');
}

async function openArchive(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('heading', { name: 'My runs' })).toBeVisible();
}

async function applyFilters(
  page: Page,
  filters: { from?: string; max?: string; min?: string; sort?: string; to?: string; units?: string },
): Promise<void> {
  const panel = panelOf(page);
  if (filters.from !== undefined && filters.to !== undefined) {
    await panel.getByLabel('Period').selectOption('dates');
    await panel.getByLabel('From', { exact: true }).fill(filters.from);
    await panel.getByLabel('To (included)').fill(filters.to);
  }
  if (filters.min !== undefined) await panel.getByLabel('Minimum distance').fill(filters.min);
  if (filters.max !== undefined) await panel.getByLabel('Maximum distance').fill(filters.max);
  if (filters.units !== undefined) await panel.getByLabel('Units').selectOption(filters.units);
  if (filters.sort !== undefined) await panel.getByLabel('Sort').selectOption(filters.sort);
  await panel.getByRole('button', { name: 'Apply filters' }).click();
}

function searchRequests(page: Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (request: Request) => {
    if (request.url().includes('/runs/search')) {
      seen.push(new URL(request.url()));
    }
  });
  return seen;
}

test.describe('searching my runs in the archive', () => {
  test('applies filters, loads another page, and shows nothing of the first organization after switching', async ({
    context,
    environment,
    organizations,
    page,
    scenario,
  }) => {
    const second = await organizations.memberOf(scenario.runnerUserId);
    await createFinishedRuns(environment, scenario.orgId, runnersMarch(scenario.runnerUserId));
    await createFinishedRuns(environment, second, [
      { distanceM: 30_000, startedAt: day(5), userId: scenario.runnerUserId },
      { distanceM: 31_000, startedAt: day(6), userId: scenario.runnerUserId },
      { distanceM: 32_000, startedAt: day(7), userId: scenario.runnerUserId },
    ]);
    await signIn(context, environment, scenario.runnerUserId);
    const requests = searchRequests(page);

    await page.goto('/');
    await expectSignedIn(page);
    const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });
    await picker.selectOption(scenario.orgId);
    await openArchive(page);

    const panel = panelOf(page);
    const applied = panel.getByRole('region', { name: 'Applied filters' });

    // The default search is this month, in the browser's zone, and none of these runs is from this month.
    await expect(panel.getByText('No finished runs of yours match these filters.')).toBeVisible();
    await expect(applied).toContainText('This month');
    await expect(applied).toContainText(ZONE);
    await expect(panel.getByText(`Dates and times use your time zone: ${ZONE}`)).toBeVisible();
    // Development mode mounts effects twice, so the first screen may have asked twice; what matters is that
    // editing sends nothing more.
    await page.waitForTimeout(300);
    const asked = requests.length;
    expect(asked).toBeGreaterThanOrEqual(1);

    // Editing the draft changes nothing that is shown and sends nothing.
    await panel.getByLabel('Period').selectOption('dates');
    await panel.getByLabel('From', { exact: true }).fill('2026-03-01');
    await panel.getByLabel('To (included)').fill('2026-03-31');
    await panel.getByLabel('Minimum distance').fill('5');
    await panel.getByLabel('Maximum distance').fill('15');
    await panel.getByLabel('Sort').selectOption('longest');
    await expect(panel.getByText('Changes are not applied yet.')).toBeVisible();
    await expect(applied).toContainText('This month');
    await expect(applied).not.toContainText('5–15 km');
    await expect(panel.getByText('No finished runs of yours match these filters.')).toBeVisible();
    expect(requests).toHaveLength(asked);

    // Applying produces the first page of 20, longest first, in the selected zone and unit.
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(cardsOf(page)).toHaveCount(20);
    await expect(applied).toContainText('1 Mar 2026 – 31 Mar 2026');
    await expect(applied).toContainText('5–15 km');
    await expect(applied).toContainText('Longest first');
    await expect(applied).toContainText(ZONE);
    await expect(panel.getByText('Changes are not applied yet.')).toHaveCount(0);
    await expect(cardsOf(page).first()).toContainText('12.00 km');
    await expect(cardsOf(page).first()).toContainText('2 Mar 2026, 08:00');
    await expect(cardsOf(page).first()).toContainText('Observed duration');
    await expect(cardsOf(page).first()).toContainText('30:00');
    await expect(cardsOf(page).first()).toContainText('GPS data good');
    // The run with no summary is explained, and nothing says it matches.
    await expect(panel.getByText('1 finished run in this period is still being processed.')).toBeVisible();
    await expect(panel.getByText(/It is not known whether it matches your distance filter\./u)).toBeVisible();

    // The next page is added to the first, in order, with nothing repeated.
    await panel.getByRole('button', { name: 'Load more runs' }).click();
    await expect(cardsOf(page)).toHaveCount(26);
    await expect(panel.getByRole('button', { name: 'Load more runs' })).toHaveCount(0);
    const distances = await cardsOf(page).evaluateAll((items) =>
      items.map((item) => Number((/(\d+\.\d{2}) km/u.exec(item.textContent ?? '') ?? [])[1])),
    );
    expect(distances).toHaveLength(26);
    expect([...distances].sort((a, b) => b - a)).toEqual(distances);
    // 4999.96 m would show as 5.00 km, but it is below the 5 km minimum and is not among the 26.
    expect(distances.at(-1)).toBe(5);
    expect(distances.filter((value) => value === 5)).toHaveLength(2);

    // A further edit again leaves the shown results alone until it is applied.
    await panel.getByLabel('Minimum distance').fill('6');
    await expect(panel.getByText('Changes are not applied yet.')).toBeVisible();
    await expect(cardsOf(page)).toHaveCount(26);
    await expect(applied).toContainText('5–15 km');
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(cardsOf(page)).toHaveCount(20);
    await expect(applied).toContainText('6–15 km');

    // Hold the second page of this organization's search, then change organization while it is outstanding.
    let arrived!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/orgs/${scenario.orgId}/runs/search?*cursor=*`, async (route) => {
      arrived();
      await gate;
      await route.continue().catch(() => undefined);
    });
    await panel.getByRole('button', { name: 'Load more runs' }).click();
    await waiting;
    await expect(panel.getByRole('button', { name: 'Loading more…' })).toBeDisabled();

    await picker.selectOption(second);
    // The other organization starts clean: no card, no filter and no pending notice of the first.
    await expect(page.getByRole('heading', { name: 'My runs' })).toBeVisible();
    await expect(panelOf(page).getByText('No finished runs of yours match these filters.')).toBeVisible();
    await expect(cardsOf(page)).toHaveCount(0);
    await expect(panelOf(page).getByRole('region', { name: 'Applied filters' })).toContainText('This month');

    // The held answer for the first organization arrives late and changes nothing.
    release();
    await page.waitForTimeout(500);
    await expect(cardsOf(page)).toHaveCount(0);
    await expect(panelOf(page).getByText('No finished runs of yours match these filters.')).toBeVisible();

    await applyFilters(page, { from: '2026-03-01', sort: 'shortest', to: '2026-03-31' });
    await expect(cardsOf(page)).toHaveCount(3);
    await expect(cardsOf(page).nth(0)).toContainText('30.00 km');
    await expect(cardsOf(page).nth(2)).toContainText('32.00 km');
    await expect(panelOf(page).getByText('12.00 km')).toHaveCount(0);
    await expect(panelOf(page).getByText(/still being processed/u)).toHaveCount(0);

    // Every request asked as the person: an organization in the path and filter fields only, never an owner.
    const allowed = new Set([
      'cursor',
      'distanceUnit',
      'fromDate',
      'maxDistance',
      'minDistance',
      'preset',
      'sort',
      'timeZone',
      'toDate',
    ]);
    for (const url of requests) {
      expect(url.pathname).toMatch(new RegExp(`^/api/orgs/(${scenario.orgId}|${second})/runs/search$`, 'u'));
      for (const key of url.searchParams.keys()) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(url.searchParams.get('timeZone')).toBe(ZONE);
    }
  });

  test('converts miles for the filter and for the cards', async ({ context, environment, page, scenario }) => {
    await createFinishedRuns(environment, scenario.orgId, [
      { distanceM: 10_000, startedAt: day(10), userId: scenario.runnerUserId },
      { distanceM: 4_988.9, startedAt: day(11), userId: scenario.runnerUserId },
      { distanceM: 4_989, startedAt: day(12), userId: scenario.runnerUserId },
    ]);
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');
    await expectSignedIn(page);
    await openArchive(page);

    // 3.1 miles is 4988.9664 m: 4988.9 m is below it, 4989 m is not.
    await applyFilters(page, {
      from: '2026-03-01',
      min: '3.1',
      sort: 'shortest',
      to: '2026-03-31',
      units: 'mi',
    });
    await expect(cardsOf(page)).toHaveCount(2);
    await expect(cardsOf(page).nth(0)).toContainText('3.10 mi');
    await expect(cardsOf(page).nth(1)).toContainText('6.21 mi');
    await expect(panelOf(page).getByRole('region', { name: 'Applied filters' })).toContainText('at least 3.1 mi');
  });

  test('lists only my own runs although the map can show runs shared with me', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await createFinishedRuns(environment, scenario.orgId, [
      { distanceM: 8_000, startedAt: day(10), userId: scenario.runnerUserId },
    ]);
    const [coachRun] = await createFinishedRuns(environment, scenario.orgId, [
      { distanceM: 99_000, startedAt: day(11), userId: scenario.coachUserId },
    ]);
    await shareRunHistory(environment, scenario.orgId, coachRun!, scenario.runnerUserId);
    await signIn(context, environment, scenario.runnerUserId);

    // The coach's run is readable by the runner through the ordinary list: this is the case the search must exclude.
    const api = await authedApi(context, environment);
    expect(await api.listRunIds(scenario.orgId)).toContain(coachRun);

    await page.goto('/');
    await expectSignedIn(page);
    await openArchive(page);
    await applyFilters(page, { from: '2026-03-01', to: '2026-03-31' });
    await expect(cardsOf(page)).toHaveCount(1);
    await expect(cardsOf(page).first()).toContainText('8.00 km');
    await expect(panelOf(page).getByText('99.00 km')).toHaveCount(0);
    await expect(panelOf(page).getByText(/only runs you recorded/iu)).toBeVisible();
  });

  test('shows an error with a retry, then the results', async ({ context, environment, page, scenario }) => {
    await createFinishedRuns(environment, scenario.orgId, [
      { distanceM: 8_000, startedAt: day(10), userId: scenario.runnerUserId },
    ]);
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');
    await expectSignedIn(page);
    await openArchive(page);
    await expect(panelOf(page).getByText('No finished runs of yours match these filters.')).toBeVisible();

    let failures = 1;
    await page.route(`**/api/orgs/${scenario.orgId}/runs/search?*`, async (route) => {
      if (failures > 0) {
        failures -= 1;
        await route.fulfill({
          body: JSON.stringify({
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'The service is busy',
              requestId: '11111111-1111-4111-8111-111111111111',
            },
          }),
          contentType: 'application/json',
          status: 503,
        });
        return;
      }
      await route.continue();
    });

    await applyFilters(page, { from: '2026-03-01', to: '2026-03-31' });
    const alert = panelOf(page).getByRole('alert').filter({ hasText: 'The search failed' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('The service is busy');
    await expect(cardsOf(page)).toHaveCount(0);

    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(cardsOf(page)).toHaveCount(1);
    await expect(alert).toHaveCount(0);
  });

  test('says access was lost when the membership ends, and shows no results', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await createFinishedRuns(environment, scenario.orgId, [
      { distanceM: 8_000, startedAt: day(10), userId: scenario.runnerUserId },
    ]);
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');
    await expectSignedIn(page);
    await openArchive(page);
    await applyFilters(page, { from: '2026-03-01', to: '2026-03-31' });
    await expect(cardsOf(page)).toHaveCount(1);

    await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, false);
    await panelOf(page).getByRole('button', { name: 'Apply filters' }).click();

    const alert = panelOf(page).getByRole('alert').filter({ hasText: 'Your runs are unavailable' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('no longer have access');
    await expect(cardsOf(page)).toHaveCount(0);
  });
});
