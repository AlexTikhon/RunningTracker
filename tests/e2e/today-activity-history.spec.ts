import type { Page, Route } from '@playwright/test';

import { signIn } from './support/api.js';
import { createActivities, createFinishedRuns, setArchiveTrackFixture, shareRunHistory } from './support/database.js';
import type { E2eEnvironment } from './support/environment.js';
import { expect, test } from './support/fixtures.js';
import { expectSignedIn } from './support/session.js';

// ADR-0088 in Chromium, against the real API and the _test database: Today's manual, GPX and GPS run cards open the
// activity history on the overview's own day, zone and source; run details and "Back to Today" return on the same date;
// ordinary navigation never re-applies the Today intent; a late answer for a previous day is never shown. Every row is
// synthetic and removed with the scenario's organization.

test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const todayScreen = (page: Page) => page.getByRole('region', { exact: true, name: 'Today' });
const history = (page: Page) => page.getByRole('region', { name: 'Your activity history' });
const filters = (page: Page) => history(page).getByRole('form', { name: 'History filters' });
const dayInput = (page: Page) => filters(page).getByLabel('Day');
const cards = (page: Page) => history(page).getByRole('list', { name: 'Your activity history' }).locator(':scope > li');
const details = (page: Page) => page.getByRole('region', { name: 'Run details', exact: true });
const historyRequest = '**/api/orgs/*/activity-history**';
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

interface Scenario {
  coachUserId: string;
  orgId: string;
  runnerUserId: string;
}

/**
 * The Warsaw spring-forward date 2026-03-29 (23 hours) and its neighbours. In the day: a run at 03:30 CEST, a ride, a
 * GPX hike and a walk that starts at 23:30 and continues past midnight. Outside it: a run at 23:30 the evening before,
 * a swim at midnight after it, and the coach's run on the day, shared with the runner for history.
 */
async function seedSpringForward(environment: E2eEnvironment, scenario: Scenario): Promise<void> {
  const [dayRun, eveRun] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 5_000, durationS: 1_800, startedAt: '2026-03-29T01:30:00Z', userId: scenario.runnerUserId },
    { distanceM: 6_000, durationS: 1_800, startedAt: '2026-03-28T22:30:00Z', userId: scenario.runnerUserId },
  ]);
  await setArchiveTrackFixture(environment, scenario.orgId, dayRun!, 'ready', null);
  await setArchiveTrackFixture(environment, scenario.orgId, eveRun!, 'ready', null);
  const [shared] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 9_000, startedAt: '2026-03-29T09:00:00Z', userId: scenario.coachUserId },
  ]);
  await shareRunHistory(environment, scenario.orgId, shared!, scenario.runnerUserId);
  await createActivities(environment, scenario.orgId, [
    { durationS: 3_600, notes: 'DAY-RIDE', source: 'manual', startedAt: '2026-03-29T08:00:00Z', type: 'ride', userId: scenario.runnerUserId },
    { durationS: 10_800, notes: 'LATE-WALK', source: 'manual', startedAt: '2026-03-29T21:30:00Z', type: 'walk', userId: scenario.runnerUserId },
    { durationS: 1_200, notes: 'NEXT-SWIM', source: 'manual', startedAt: '2026-03-29T22:00:00Z', type: 'swim', userId: scenario.runnerUserId },
    { distanceM: 10_400, durationS: 4_000, source: 'gpx', startedAt: '2026-03-29T10:00:00Z', type: 'hike', userId: scenario.runnerUserId },
  ]);
}

async function openTodayOn(page: Page, localDate: string): Promise<void> {
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await todayScreen(page).getByLabel('Date').fill(localDate);
  await expect(todayScreen(page).locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
}

/** Consecutive repeats collapsed: the development build's StrictMode mount sends a first page twice (one is aborted). */
const distinct = (queries: string[]) => queries.filter((query, index, all) => index === 0 || query !== all[index - 1]);

for (const viewport of [
  { height: 900, name: 'desktop', width: 1280 },
  { height: 812, name: '375 px', width: 375 },
]) {
  test(`Today to the day's history, run details, back to the history and back to Today (${viewport.name})`, async ({ context, environment, page, scenario }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await seedSpringForward(environment, scenario);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/activity-history')) requests.push(new URL(request.url()).search);
    });
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');
    await expectSignedIn(page, scenario.runnerUserId);
    // Linux CI fonts are wider than Windows ones: measure with a wide font.
    await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });

    await openTodayOn(page, '2026-03-29');
    const gpsCard = todayScreen(page).getByRole('region', { exact: true, name: 'GPS runs' });
    await expect(gpsCard.getByRole('button', { name: 'Open Runner' })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);

    // The GPS runs card opens the history on that day, zone and source, with focus on the history.
    await gpsCard.getByRole('button', { name: 'Show in history: your GPS runs of Sun, 29 Mar 2026' }).click();
    await expect(history(page).getByRole('heading', { name: 'Your activity history' })).toBeFocused();
    await expect(filters(page).getByLabel('Source')).toHaveValue('recorded_run');
    await expect(dayInput(page)).toHaveValue('2026-03-29');
    await expect(history(page)).toContainText('Showing what started on Sun, 29 Mar 2026 in the time zone Europe/Warsaw');
    await expect(history(page)).toContainText('This date has 23 hours in Europe/Warsaw because the clocks change.');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('29 Mar 2026, 03:30');
    await expect(cards(page).first()).toContainText('SourceRecorded run');
    await expect(history(page)).not.toContainText('28 Mar 2026');
    expect(requests.at(-1)).toBe('?source=recorded_run&localDate=2026-03-29&timeZone=Europe%2FWarsaw');
    // Creation and import stay on the screen.
    await expect(page.getByRole('form', { name: 'Add an activity' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Import a GPX file' })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);

    // Run details, and back to the same filtered list with focus on the trigger.
    const trigger = cards(page).first().getByRole('button', { name: 'Run details of your run of 29 Mar 2026, 03:30' });
    await trigger.click();
    await expect(details(page).getByRole('heading', { name: 'Run details' })).toBeFocused();
    await expect(details(page).getByRole('definition').filter({ hasText: '5.00 km' })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await details(page).getByRole('button', { name: 'Back to activity history' }).click();
    await expect(trigger).toBeFocused();
    await expect(cards(page)).toHaveCount(1);
    await expect(dayInput(page)).toHaveValue('2026-03-29');

    // Back to Today on the originating date.
    await history(page).getByRole('button', { name: 'Back to Today on Sun, 29 Mar 2026' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(todayScreen(page).getByLabel('Date')).toHaveValue('2026-03-29');
    await expect(todayScreen(page).locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
    expect(await noHorizontalScroll(page)).toBe(true);

    // The manual card: the ride and the walk that continued past midnight; the swim at midnight is the next date's.
    await todayScreen(page)
      .getByRole('region', { exact: true, name: 'Manual activities' })
      .getByRole('button', { name: 'Show in history: your manual activities of Sun, 29 Mar 2026' })
      .click();
    await expect(filters(page).getByLabel('Source')).toHaveValue('manual');
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(page).nth(0)).toContainText('LATE-WALK');
    await expect(cards(page).nth(0)).toContainText('29 Mar 2026, 23:30');
    await expect(cards(page).nth(1)).toContainText('DAY-RIDE');
    // Another day from the history itself, then every date.
    await dayInput(page).fill('2026-03-30');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('NEXT-SWIM');
    await expect(history(page)).toContainText('Showing what started on Mon, 30 Mar 2026 in the time zone Europe/Warsaw');
    await expect(history(page)).not.toContainText('because the clocks change');
    await history(page).getByRole('button', { name: 'All dates' }).click();
    await expect(cards(page)).toHaveCount(3);
    await expect(dayInput(page)).toHaveValue('');
    await expect(history(page)).not.toContainText('Showing what started on');
    expect(distinct(requests).slice(-3)).toEqual([
      '?source=manual&localDate=2026-03-29&timeZone=Europe%2FWarsaw',
      '?source=manual&localDate=2026-03-30&timeZone=Europe%2FWarsaw',
      '?source=manual',
    ]);

    // The GPX card exists only with imports, and opens on them.
    await history(page).getByRole('button', { name: 'Back to Today on Sun, 29 Mar 2026' }).click();
    await todayScreen(page)
      .getByRole('region', { exact: true, name: 'Imported from GPX' })
      .getByRole('button', { name: 'Show in history: your GPX imports of Sun, 29 Mar 2026' })
      .click();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('SourceGPX import');
    await expect(cards(page).first()).toContainText('Elapsed time1:06:40');

    // Ordinary navigation never re-applies the Today intent: Activity from the view switcher is the whole history.
    await navigation(page).getByRole('button', { name: 'Archive' }).click();
    await navigation(page).getByRole('button', { name: 'Activity' }).click();
    await expect(filters(page).getByLabel('Source')).toHaveValue('');
    await expect(dayInput(page)).toHaveValue('');
    await expect(history(page).getByRole('button', { name: /Back to Today/u })).toHaveCount(0);
    // Six own items: two runs and four activities. The coach's shared run never appears.
    await expect(cards(page)).toHaveCount(6);
    await expect(history(page)).not.toContainText('9.00 km');
    expect(await noHorizontalScroll(page)).toBe(true);
  });
}

/** Holds every history request for one date until released; the page aborts it meanwhile. */
function holdDay(localDate: string) {
  let release!: () => void;
  let held = false;
  let isReleased = false;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    if (!isReleased && new URL(route.request().url()).searchParams.get('localDate') === localDate) {
      held = true;
      await released;
      await route.continue().catch(() => undefined);
      return;
    }
    await route.continue();
  };
  return {
    handler,
    release: () => {
      isReleased = true;
      release();
    },
    wasHeld: () => held,
  };
}

test('a late answer for the previous day is never shown once the day has changed', async ({ context, environment, page, scenario }) => {
  await seedSpringForward(environment, scenario);
  await signIn(context, environment, scenario.runnerUserId);
  await page.goto('/');
  await expectSignedIn(page, scenario.runnerUserId);
  await openTodayOn(page, '2026-03-29');

  const hold = holdDay('2026-03-29');
  await page.route(historyRequest, hold.handler);
  await todayScreen(page)
    .getByRole('region', { exact: true, name: 'Manual activities' })
    .getByRole('button', { name: /^Show in history/u })
    .click();
  await expect(history(page).getByText('Loading your activity history…')).toBeVisible();
  await expect.poll(hold.wasHeld).toBe(true);
  await dayInput(page).fill('2026-03-30');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('NEXT-SWIM');
  hold.release();
  await page.waitForTimeout(300);
  await expect(cards(page)).toHaveCount(1);
  await expect(history(page)).not.toContainText('DAY-RIDE');
  await expect(history(page)).not.toContainText('LATE-WALK');
  await page.unroute(historyRequest, hold.handler);
});
