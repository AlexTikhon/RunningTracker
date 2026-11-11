import type { Page, Route } from '@playwright/test';

import { signIn } from './support/api.js';
import { createActivities, createFinishedRuns, setArchiveTrackFixture, setMembershipActive, shareRunHistory } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectOrganizationChosen, expectSignedIn, organizationRegion } from './support/session.js';

// The unified activity history (ADR-0087) in Chromium, against the real API and the _test database: manual entries,
// GPX imports and the runner's own finished runs in one list, with provenance, filters, run details, and requests that
// never outlive their filters or organization. Every row is synthetic and removed with the scenario's organization.

test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });

const history = (page: Page) => page.getByRole('region', { name: 'Your activity history' });
const cards = (page: Page) => history(page).getByRole('list', { name: 'Your activity history' }).locator(':scope > li');
const details = (page: Page) => page.getByRole('region', { name: 'Run details', exact: true });
const historyRequest = '**/api/orgs/*/activity-history**';

async function openActivity(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
}

/**
 * Holds every matching history request until released; the page may abort them meanwhile. Every one, not only the first:
 * the development build mounts under StrictMode, which starts and aborts a first request before the real one.
 */
function holdMatching(matches: (url: URL) => boolean) {
  let release!: () => void;
  let isReleased = false;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (!isReleased && matches(url)) {
      held = true;
      await released;
      // The page aborted this request when its filters or organization changed; continuing it then fails harmlessly.
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

test('one history of manual entries, GPX imports and own recorded runs, with provenance, filters and run details', async ({ context, environment, page, scenario }) => {
  const [current, , stale] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 5_000, durationS: 1_800, startedAt: '2026-03-03T06:00:00Z', userId: scenario.runnerUserId },
    { distanceM: null, startedAt: '2026-03-02T06:00:00Z', userId: scenario.runnerUserId },
    { distanceM: 7_000, startedAt: '2026-02-28T06:00:00Z', userId: scenario.runnerUserId },
  ]);
  await setArchiveTrackFixture(environment, scenario.orgId, stale!, 'stale', null);
  await setArchiveTrackFixture(environment, scenario.orgId, current!, 'ready', null);
  // The coach's own run, shared with the runner for history: readable on the archive map, never in this history.
  const [shared] = await createFinishedRuns(environment, scenario.orgId, [
    { distanceM: 9_000, startedAt: '2026-03-04T06:00:00Z', userId: scenario.coachUserId },
  ]);
  await shareRunHistory(environment, scenario.orgId, shared!, scenario.runnerUserId);
  await createActivities(environment, scenario.orgId, [
    { distanceM: 32_500, durationS: 4_500, notes: 'Hilly loop', rpe: 6, source: 'manual', startedAt: '2026-03-05T06:00:00Z', type: 'ride', userId: scenario.runnerUserId },
    { distanceM: 10_400, durationS: 4_000, source: 'gpx', startedAt: '2026-03-01T06:00:00Z', type: 'hike', userId: scenario.runnerUserId },
  ]);
  // The coach's activities are owner-only too.
  await createActivities(environment, scenario.orgId, [
    { durationS: 600, notes: 'COACH-ONLY', source: 'manual', startedAt: '2026-03-06T06:00:00Z', type: 'walk', userId: scenario.coachUserId },
  ]);

  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/activity-history')) requests.push(request.url()); });
  await signIn(context, environment, scenario.runnerUserId);
  await page.goto('/');
  await expectSignedIn(page, scenario.runnerUserId);
  await openActivity(page);

  // Newest first, five items, the shared run and the coach's activity absent.
  await expect(cards(page)).toHaveCount(5);
  const expected = [
    ['Ride', '5 Mar 2026, 07:00', 'Duration1:15:00', 'Distance32.50 km', 'Effort6/10', 'SourceEntered manually', 'Hilly loop'],
    ['Run', '3 Mar 2026, 07:00', 'Distance5.00 km', 'Observed duration30:00', 'GPS qualityGood', 'SourceRecorded run', 'Capture sourceNot recorded'],
    ['Run', '2 Mar 2026, 07:00', 'SourceRecorded run', 'still being prepared'],
    ['Hike', '1 Mar 2026, 07:00', 'Elapsed time1:06:40', 'Distance10.40 km', 'SourceGPX import'],
    ['Run', '28 Feb 2026, 07:00', 'SourceRecorded run', 'summary is being updated'],
  ];
  for (const [index, texts] of expected.entries()) {
    for (const text of texts) await expect(cards(page).nth(index)).toContainText(text);
  }
  await expect(history(page)).not.toContainText('4 Mar 2026');
  await expect(history(page)).not.toContainText('COACH-ONLY');
  for (const index of [2, 4]) await expect(cards(page).nth(index).getByRole('term')).toHaveText(['Source', 'Capture source']);
  await expect(cards(page).nth(4)).not.toContainText('7.00 km');
  await expect(history(page)).toContainText('never added together');
  await expect(cards(page).nth(1).getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // Filters: each request carries exactly the chosen filters, and the list shows only what matches.
  const filters = history(page).getByRole('form', { name: 'History filters' });
  await filters.getByLabel('Source').selectOption('recorded_run');
  await expect(cards(page)).toHaveCount(3);
  for (const index of [0, 1, 2]) await expect(cards(page).nth(index)).toContainText('SourceRecorded run');
  await filters.getByLabel('Activity type').selectOption('ride');
  await expect(history(page).getByText('Nothing in your history matches these filters.')).toBeVisible();
  await filters.getByLabel('Source').selectOption('');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('SourceEntered manually');
  await filters.getByLabel('Activity type').selectOption('');
  await filters.getByLabel('Source').selectOption('gpx');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Hike');
  await filters.getByLabel('Source').selectOption('');
  await expect(cards(page)).toHaveCount(5);
  // The development build's StrictMode mount sends the first page twice (the first is aborted); collapse that repeat.
  const queries = requests.map((url) => new URL(url).search).filter((query, index, all) => index === 0 || query !== all[index - 1]);
  expect(queries).toEqual(['', '?source=recorded_run', '?source=recorded_run&type=ride', '?type=ride', '', '?source=gpx', '']);

  // Run details reuse the archive's details view and come back to the same list with focus on the trigger.
  const trigger = cards(page).nth(1).getByRole('button', { name: 'Run details of your run of 3 Mar 2026, 07:00' });
  await trigger.click();
  await expect(details(page).getByRole('heading', { name: 'Run details' })).toBeFocused();
  await expect(details(page).getByRole('definition').filter({ hasText: '5.00 km' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add an activity' })).toBeHidden();
  await details(page).getByRole('button', { name: 'Back to activity history' }).click();
  await expect(trigger).toBeFocused();
  await expect(cards(page)).toHaveCount(5);

  // Phone width: no horizontal scroll.
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a slow answer for earlier filters is never shown; errors retry; lost access is said and recovers', async ({ context, environment, page, scenario }) => {
  await createActivities(environment, scenario.orgId, [
    { durationS: 1_800, source: 'manual', startedAt: '2026-03-05T06:00:00Z', type: 'ride', userId: scenario.runnerUserId },
    { durationS: 2_000, source: 'gpx', startedAt: '2026-03-04T06:00:00Z', type: 'hike', userId: scenario.runnerUserId },
  ]);
  await signIn(context, environment, scenario.runnerUserId);
  await page.goto('/');
  await expectSignedIn(page, scenario.runnerUserId);

  // The unfiltered first page is held while the person picks GPX imports; when it finally answers, it is dropped.
  const hold = holdMatching((url) => !url.searchParams.has('source'));
  await page.route(historyRequest, hold.handler);
  await openActivity(page);
  await expect(history(page).getByText('Loading your activity history…')).toBeVisible();
  await expect.poll(hold.wasHeld).toBe(true);
  await history(page).getByLabel('Source').selectOption('gpx');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('SourceGPX import');
  hold.release();
  await page.waitForTimeout(300);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Hike');
  await page.unroute(historyRequest, hold.handler);

  // A failed first page says so and retries.
  let fail = true;
  await page.route(historyRequest, async (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'The server failed', requestId: '22222222-2222-4222-8222-222222222222' } }), contentType: 'application/json', status: 500 });
    }
    return route.continue();
  });
  await history(page).getByLabel('Source').selectOption('');
  await expect(history(page).getByRole('alert')).toContainText('The server failed. Reference 22222222-2222-4222-8222-222222222222.');
  await history(page).getByRole('alert').getByRole('button', { name: 'Retry' }).click();
  await expect(cards(page)).toHaveCount(2);
  await page.unroute(historyRequest);

  // Membership ended: the history is withdrawn and the screen says access was lost; restored, Retry shows it again.
  await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, false);
  try {
    await history(page).getByRole('button', { name: 'Refresh history' }).click();
    await expect(history(page).getByRole('alert')).toContainText('You no longer have access to your activity history in this organization.');
    await expect(cards(page)).toHaveCount(0);
  } finally {
    await setMembershipActive(environment, scenario.orgId, scenario.runnerUserId, true);
  }
  await history(page).getByRole('alert').getByRole('button', { name: 'Retry' }).click();
  await expect(cards(page)).toHaveCount(2);
});

test('an organization change drops the previous organization’s answer and shows only the new one’s history', async ({ context, environment, organizations, page, scenario }) => {
  const second = await organizations.memberOf(scenario.runnerUserId);
  await createActivities(environment, scenario.orgId, [
    { durationS: 1_800, notes: 'FIRST-ORG', source: 'manual', startedAt: '2026-03-05T06:00:00Z', type: 'ride', userId: scenario.runnerUserId },
  ]);
  await createActivities(environment, second, [
    { durationS: 1_200, notes: 'SECOND-ORG', source: 'manual', startedAt: '2026-03-04T06:00:00Z', type: 'swim', userId: scenario.runnerUserId },
  ]);
  await signIn(context, environment, scenario.runnerUserId);
  await page.goto('/');
  await expectSignedIn(page, scenario.runnerUserId);
  const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });
  await picker.selectOption(scenario.orgId);
  await expectOrganizationChosen(page, scenario.orgId);

  const hold = holdMatching((url) => url.pathname.includes(scenario.orgId));
  await page.route(historyRequest, hold.handler);
  await openActivity(page);
  await expect.poll(hold.wasHeld).toBe(true);
  await picker.selectOption(second);
  await expectOrganizationChosen(page, second);
  await openActivity(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('SECOND-ORG');
  hold.release();
  await page.waitForTimeout(300);
  await expect(cards(page)).toHaveCount(1);
  await expect(history(page)).not.toContainText('FIRST-ORG');
  await page.unroute(historyRequest, hold.handler);

  await picker.selectOption(scenario.orgId);
  await openActivity(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('FIRST-ORG');
});
