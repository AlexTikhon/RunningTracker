import type { Locator, Page, Route } from '@playwright/test';

import { signIn } from './support/api.js';
import { createActivities, createFinishedRuns, setArchiveTrackFixture, shareRunHistory } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectSignedIn, expectSignedOut } from './support/session.js';

// The Activity section of Trends (ADR-0089) in Chromium, against the real API and the _test database: one source and
// one activity type over the 28 local dates ending on the chosen date, with labelled durations, coverage, a chart and a
// table of every date; requests that never outlive their filters or the session; Retry; a 375 px layout. Every row is
// synthetic and removed with the scenario's organization.

const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

function dateIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(new Date(instantMs));
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
/** 10:00 UTC on a date: 11:00 or 12:00 in Warsaw, the same calendar date there. */
const middayOf = (date: string, minutes = 0) => new Date(Date.parse(`${date}T10:00:00Z`) + minutes * 60_000).toISOString();
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const activityRequest = '**/api/orgs/*/activity-trends**';

function section(page: Page) {
  const root = page.getByRole('region', { exact: true, name: 'Trends' }).getByRole('region', { exact: true, name: 'Activity' });
  return {
    chart: root.locator('.activity-chart svg'),
    root,
    row: (localDate: string) => root.locator(`tr[data-activity-date="${localDate}"]`),
    source: root.getByLabel('Source'),
    state: root.locator('[data-activity-trends-state]'),
    summary: root.locator('.activity-trends__summary'),
    type: root.getByLabel('Activity type'),
  };
}

async function openTrends(page: Page): Promise<void> {
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeVisible();
  await expect(page.locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready');
}

/** Holds every matching request until released (StrictMode starts and aborts a first one); the page may abort them. */
function holdMatching(matches: (url: URL) => boolean) {
  let release!: () => void;
  let isReleased = false;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (!isReleased && matches(url)) {
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

test('activity trends: one source and type per view, labelled durations and coverage, shared runs never counted, kept while navigating', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 600_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const yesterday = daysBefore(today, 1);
  const twoDaysAgo = daysBefore(today, 2);
  const fourDaysAgo = daysBefore(today, 4);
  const runner = scenario.runnerUserId;
  await createActivities(environment, scenario.orgId, [
    { distanceM: 20_000, durationS: 3_600, source: 'manual', startedAt: middayOf(yesterday), type: 'ride', userId: runner },
    { distanceM: null, durationS: 1_800, source: 'manual', startedAt: middayOf(daysBefore(today, 3)), type: 'ride', userId: runner },
    { distanceM: 5_000, durationS: 1_500, source: 'manual', startedAt: middayOf(yesterday, 30), type: 'run', userId: runner },
    { distanceM: 10_400, durationS: 4_000, source: 'gpx', startedAt: middayOf(twoDaysAgo), type: 'ride', userId: runner },
    // The coach's own activity: owner-only, never in the runner's figures.
    { distanceM: 99_000, durationS: 9_999, source: 'manual', startedAt: middayOf(yesterday), type: 'ride', userId: scenario.coachUserId },
  ]);
  const [current] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 5_000, durationS: 1_800, startedAt: middayOf(fourDaysAgo), userId: runner },
    { distanceM: null, startedAt: middayOf(fourDaysAgo, 60), userId: runner },
  ]);
  await setArchiveTrackFixture(environment, scenario.orgId, current!, 'ready', null);
  // The coach's run, shared with the runner for history: readable in the archive, never in these figures.
  const [shared] = await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 9_000, startedAt: middayOf(fourDaysAgo, 120), userId: scenario.coachUserId }]);
  await shareRunHistory(environment, scenario.orgId, shared!, runner);

  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/orgs/') && url.pathname.endsWith('/activity-trends')) requests.push(url.search);
  });
  await signIn(context, environment, runner);
  await page.goto('/');
  await expectSignedIn(page, runner);
  await openTrends(page);
  const activity = section(page);

  // The default selection: manually entered runs.
  await expect(activity.state).toHaveAttribute('data-activity-trends-state', 'ready');
  await expect(activity.source).toHaveValue('manual');
  await expect(activity.type).toHaveValue('run');
  await expect(activity.summary).toContainText('1 entry on 1 of 28 days.');
  await expect(activity.root.locator('tbody tr')).toHaveCount(28);

  // Manual rides: entered duration for every entry, a distance for one of two; the coach's ride is absent.
  await activity.type.selectOption('ride');
  await expect(activity.summary).toContainText('2 entries on 2 of 28 days. On the other 26 days none was logged, which does not mean you were inactive.');
  await expect(activity.summary).toContainText('Entered duration: 1:30:00 in total, from all 2 entries.');
  await expect(activity.summary).toContainText('Distance: 20.00 km from 1 of 2 entries. The other entry is unknown, not zero, and adds nothing.');
  await expect(activity.root.getByRole('columnheader', { name: 'Entered duration' })).toBeVisible();
  await expect(activity.row(yesterday)).toContainText('1:00:00');
  await expect(activity.row(yesterday)).toContainText('20.00 km');
  await expect(activity.row(daysBefore(today, 3))).toContainText('Unknown');
  await expect(activity.row(today)).toContainText('None logged');
  await expect(activity.root).not.toContainText('99.00 km');

  // Measures: counts and distances as bars; an unknown distance is an open marker, never a bar.
  await expect(activity.chart.locator('[data-bar-date]')).toHaveCount(2);
  await activity.root.getByRole('radio', { name: 'Distance' }).check();
  await expect(activity.chart.locator('[data-bar-date]')).toHaveCount(1);
  await expect(activity.chart.locator(`[data-unknown-date="${daysBefore(today, 3)}"]`)).toHaveCount(1);
  await expect(activity.chart.locator('[data-none-date]')).toHaveCount(26);

  // GPX imports keep the type and name their duration as elapsed time.
  await activity.source.selectOption('gpx');
  await expect(activity.summary).toContainText('1 import on 1 of 28 days.');
  await expect(activity.summary).toContainText('Elapsed time: 1:06:40 in total, from the 1 import.');
  await expect(activity.root.getByRole('columnheader', { name: 'Elapsed time' })).toBeVisible();
  await expect(activity.root).toContainText('pauses included; it is not moving time');

  // Recorded runs: the type is run; one current and one pending summary; the shared run is never counted.
  await activity.source.selectOption('recorded_run');
  await expect(activity.type).toHaveValue('run');
  await expect(activity.type).toBeDisabled();
  await expect(activity.summary).toContainText('2 runs on 1 of 28 days.');
  await expect(activity.summary).toContainText('Observed duration: 30:00 from 1 of 2 runs. The other run is unknown, not zero, and adds nothing.');
  await expect(activity.summary).toContainText('GPS summaries: 1 current, 1 still being prepared, 0 being updated after new data.');
  await expect(activity.row(fourDaysAgo)).toContainText('Summary 1 being prepared');
  await expect(activity.root).not.toContainText('9.00 km');
  await expect(activity.root.locator('.activity-trends-content')).not.toContainText(/goal|target|recommend|predict|streak|lazy/iu);

  // Every request carried exactly one source and one type (StrictMode's aborted first mount collapsed).
  const sources = requests.map((search) => new URLSearchParams(search)).map((query) => `${query.get('source')}/${query.get('type')}`);
  expect(sources.filter((value, index, all) => index === 0 || value !== all[index - 1])).toEqual(['manual/run', 'manual/ride', 'gpx/ride', 'recorded_run/run']);
  for (const search of requests) {
    const query = new URLSearchParams(search);
    expect([...query.keys()].toSorted()).toEqual(['endDate', 'source', 'timeZone', 'type']);
    expect(query.get('timeZone')).toBe(timeZone);
  }

  // The health series still work beside it.
  await page.getByRole('region', { exact: true, name: 'Trends' }).getByRole('radio', { name: 'Steps' }).check();
  await expect(page.locator('.trends-card').first().getByRole('heading', { level: 2 })).toHaveText('Manually entered steps');

  // An earlier end date moves both sections; the selection is kept during ordinary navigation.
  await page.getByRole('region', { exact: true, name: 'Trends' }).getByLabel('End date').fill(yesterday);
  await expect(activity.state).toHaveAttribute('data-activity-trends-state', 'ready');
  await expect(activity.row(today)).toHaveCount(0);
  await expect(activity.row(yesterday)).toHaveCount(1);
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  await openTrends(page);
  await expect(activity.source).toHaveValue('recorded_run');
  await expect(activity.root.getByRole('radio', { name: 'Distance' })).toBeChecked();
  await expect(activity.summary).toContainText('2 runs on 1 of 28 days.');
});

test('activity trends at 375 px: usable without horizontal scrolling; late answers for abandoned filters are dropped; Retry; sign-out silences a request', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 300_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  await createActivities(environment, scenario.orgId, [
    { distanceM: 123_456, durationS: 36_000, source: 'manual', startedAt: middayOf(daysBefore(today, 1)), type: 'ride', userId: scenario.runnerUserId },
    { distanceM: 8_000, durationS: 2_000, source: 'gpx', startedAt: middayOf(daysBefore(today, 2)), type: 'ride', userId: scenario.runnerUserId },
  ]);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(context, environment, scenario.runnerUserId);
  await page.goto('/');
  await expectSignedIn(page, scenario.runnerUserId);
  // Linux CI fonts are wider than Windows ones: measure with a wide font.
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  const inside = async (locator: Locator, name: string) => {
    const box = await locator.boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 375, name).toBe(true);
  };
  await openTrends(page);
  const activity = section(page);
  await activity.type.selectOption('ride');
  await expect(activity.summary).toContainText('1 entry on 1 of 28 days.');
  for (const measure of ['Entries', 'Entered duration', 'Distance'] as const) {
    await activity.root.getByRole('radio', { name: measure }).check();
    expect(await fits(page), measure).toBe(true);
  }
  await inside(activity.source, 'Source');
  await inside(activity.type, 'Activity type');
  await inside(activity.chart, 'chart');
  await inside(activity.root.locator('table'), 'table');
  await expect(activity.row(daysBefore(today, 1))).toContainText('123.46 km');
  await expect(activity.row(daysBefore(today, 1))).toContainText('10:00:00');

  // Hold the answer for GPX rides, choose recorded runs, then let the GPX answer through: recorded runs stay.
  const held = holdMatching((url) => url.pathname.endsWith('/activity-trends') && url.searchParams.get('source') === 'gpx');
  await page.route(activityRequest, held.handler);
  await activity.source.selectOption('gpx');
  await expect(activity.state).toHaveAttribute('data-activity-trends-state', 'loading');
  await expect.poll(() => held.wasHeld()).toBe(true);
  await activity.source.selectOption('recorded_run');
  await expect(activity.state).toHaveAttribute('data-activity-trends-state', 'ready');
  await expect(activity.summary).toContainText('No recorded runs on any of these 28 days.');
  held.release();
  await page.waitForTimeout(500); // give the late answer every chance to be (wrongly) applied
  await expect(activity.source).toHaveValue('recorded_run');
  await expect(activity.summary).toContainText('No recorded runs on any of these 28 days.');
  await expect(activity.root).not.toContainText('8.00 km');
  await page.unroute(activityRequest, held.handler);

  // A failure shows Retry without any earlier answer; the health series are unaffected; Retry reads again.
  let fail = true;
  const failing = async (route: Route) => {
    if (fail) {
      await route.fulfill({
        body: JSON.stringify({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable', requestId: '33333333-3333-4333-8333-333333333333' } }),
        contentType: 'application/json',
        status: 503,
      });
      return;
    }
    await route.continue();
  };
  await page.route(activityRequest, failing);
  await activity.source.selectOption('gpx');
  await expect(activity.state).toHaveAttribute('data-activity-trends-state', 'error');
  await expect(activity.root.getByRole('alert')).toContainText('The database is unavailable. Reference 33333333-3333-4333-8333-333333333333.');
  await expect(activity.root.locator('table')).toHaveCount(0);
  await expect(page.locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready');
  expect(await fits(page)).toBe(true);
  fail = false;
  await activity.root.getByRole('button', { name: 'Retry' }).click();
  await expect(activity.state).toHaveAttribute('data-activity-trends-state', 'ready');
  await expect(activity.summary).toContainText('1 import on 1 of 28 days.');
  await page.unroute(activityRequest, failing);

  // Signing out while a request is held: the answer released afterwards reaches nothing.
  const pending = holdMatching((url) => url.pathname.endsWith('/activity-trends') && url.searchParams.get('type') === 'walk');
  await page.route(activityRequest, pending.handler);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await activity.source.selectOption('manual');
  await expect(activity.state).toHaveAttribute('data-activity-trends-state', 'ready');
  await activity.type.selectOption('walk');
  await expect.poll(() => pending.wasHeld()).toBe(true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  pending.release();
  await page.waitForTimeout(500);
  await expectSignedOut(page);
  await expect(page.locator('[data-activity-trends-state]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
