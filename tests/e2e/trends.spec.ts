import type { Locator, Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// Trends (ADR-0084): the demo runner records values through the existing editors (check-in, movement, meal log), opens
// Trends from Today, inspects four series with their coverage, gaps and recorded zero, opens a date on Today, edits and
// deletes sources there, and returns to the same range to see the changed values. The demo people and their organization
// are created in the _test database by the demoScenario fixture, whose cleanup removes the organization's records.

const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

function dateIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(
    new Date(instantMs),
  );
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function signInDemoRunner(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

async function openToday(page: Page): Promise<Locator> {
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  const screen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(screen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  return screen;
}

function trendsScreen(page: Page) {
  const screen = page.getByRole('region', { exact: true, name: 'Trends' });
  return {
    chart: screen.locator('.trends-chart svg'),
    // The health series' table ("Every date"); the Activity section (ADR-0089) has its own table below it.
    healthRows: screen.getByRole('region', { exact: true, name: 'Every date' }).locator('tbody tr'),
    row: (localDate: string) => screen.locator(`tr[data-date="${localDate}"]`),
    screen,
    series: screen.locator('.trends-card').first(),
    state: screen.locator('[data-trends-state]'),
  };
}

async function saveCheckIn(page: Page, values: { hours?: string; minutes?: string; weight?: string }, saved: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily check-in' });
  if (values.weight !== undefined) await form.getByLabel('Weight in kg (optional)').fill(values.weight);
  if (values.hours !== undefined) await form.getByLabel('Hours').fill(values.hours);
  if (values.minutes !== undefined) await form.getByLabel('Minutes').fill(values.minutes);
  await form.getByRole('button', { name: 'Save check-in' }).click();
  await expect(form.getByText(saved)).toBeVisible();
}

async function saveSteps(page: Page, steps: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily movement' });
  await form.getByLabel('Steps (optional)').fill(steps);
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByText('Movement saved.')).toBeVisible();
}

test('Trends: values recorded through the editors, coverage and gaps, a day opened on Today, and edits reflected in the kept range', async ({
  demoScenario,
  environment,
  page,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 600_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const early = daysBefore(today, 3);
  const yesterday = daysBefore(today, 1);
  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);

  // Three days ago: weight and sleep in the check-in, and a recorded zero for steps.
  let todayScreen = await openToday(page);
  await todayScreen.getByLabel('Date').fill(early);
  await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await todayScreen.getByRole('button', { name: /^Add check-in for / }).click();
  await saveCheckIn(page, { hours: '7', minutes: '30', weight: '72.4' }, 'Check-in saved.');
  todayScreen = await openToday(page);
  await todayScreen.getByRole('button', { name: /^Add movement for / }).click();
  await saveSteps(page, '0');

  // Yesterday: a weight, and two meal entries, one of them title-only.
  todayScreen = await openToday(page);
  await todayScreen.getByLabel('Date').fill(yesterday);
  await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await todayScreen.getByRole('button', { name: /^Add check-in for / }).click();
  await saveCheckIn(page, { weight: '72.1' }, 'Check-in saved.');
  todayScreen = await openToday(page);
  await todayScreen.getByRole('button', { name: /^Add a meal for / }).click();
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  const mealForm = mealLog.locator('form.meal-form');
  await expect(mealLog.getByLabel('Date')).toHaveValue(yesterday);
  await mealForm.getByLabel('Title').fill('Soup');
  await mealForm.getByLabel('Food energy (kcal)').fill('350.5');
  await mealForm.getByRole('button', { name: 'Add entry' }).click();
  await expect(mealForm.getByText('Entry saved.')).toBeVisible();
  await mealForm.getByLabel('Title').fill('Apple');
  await mealForm.getByRole('button', { name: 'Add entry' }).click();
  await expect(mealLog.locator('.run-cards > li')).toHaveCount(2);

  // Today: steps.
  todayScreen = await openToday(page);
  await todayScreen.getByRole('button', { name: 'Go to today' }).click();
  await expect(todayScreen.getByLabel('Date')).toHaveValue(today);
  await todayScreen.getByRole('button', { name: /^Add movement for / }).click();
  await saveSteps(page, '4200');

  // Open Trends from Today: the range ends on Today's date.
  todayScreen = await openToday(page);
  await todayScreen.getByRole('button', { name: /^Open 28-day trends ending on / }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeVisible();
  const trends = trendsScreen(page);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.screen.getByLabel('End date')).toHaveValue(today);
  await expect(trends.screen.getByText(/^Range: 28 days, .+, ending today\./u)).toBeVisible();

  // Steps: two recorded days, one of them a recorded zero; never joined across the gap between them.
  await trends.screen.getByRole('radio', { name: 'Steps' }).check();
  await expect(trends.series.getByRole('heading', { level: 2 })).toHaveText('Manually entered steps');
  await expect(trends.series.getByText('Recorded on 2 of 28 days. The other 26 days have no value: unknown, not zero.')).toBeVisible();
  await expect(trends.series.getByText('Recorded total 4,200 steps on 2 days; the total covers only those days.')).toBeVisible();
  await expect(trends.row(early)).toContainText('0 steps');
  await expect(trends.row(today)).toContainText('4,200 steps');
  await expect(trends.row(yesterday)).toContainText('Not recorded');
  await expect(trends.chart.locator('circle')).toHaveCount(2);
  await expect(trends.chart.locator('polyline')).toHaveCount(0);
  await expect(trends.chart.locator('[data-missing-date]')).toHaveCount(26);
  await expect(trends.healthRows).toHaveCount(28);

  // Weight: two recorded dates give a difference; sleep: one recorded date, averaged over it alone.
  await trends.screen.getByRole('radio', { name: 'Weight' }).check();
  await expect(trends.series.getByText('Difference between those two dates: −0.3 kg (2 dates have a weight).')).toBeVisible();
  await expect(trends.chart.locator('polyline')).toHaveCount(0); // three days ago and yesterday are not neighbours
  await trends.screen.getByRole('radio', { name: 'Sleep' }).check();
  await expect(trends.series.getByText(/^Average 7 h 30 min over the 1 date with a recorded duration/u)).toBeVisible();

  // Food energy: day coverage and entry coverage apart; no title anywhere.
  await trends.screen.getByRole('radio', { name: 'Food energy' }).check();
  await expect(trends.series.getByText('Recorded on 1 of 28 days. Energy is recorded on 1 of 2 logged entries. The other 27 days have no value: unknown, not zero.')).toBeVisible();
  await expect(trends.row(yesterday)).toContainText('350.5 kcal');
  await expect(trends.row(yesterday)).toContainText('1 of 2 entries with energy');
  await expect(trends.series.getByText(/it is not a complete food diary/u)).toBeVisible();
  await expect(trends.screen).not.toContainText(/Soup|Apple/u);
  // ("makes no predictions and gives no advice" is the screen's own statement; the loaded content is scanned.)
  await expect(trends.screen.locator('.trends-content')).not.toContainText(/balance|deficit|surplus|recommend|predict|target|goal/iu);

  // Open yesterday on Today from the table.
  await trends.row(yesterday).getByRole('button', { name: /^Open Today on / }).click();
  todayScreen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await expect(todayScreen.getByLabel('Date')).toHaveValue(yesterday);

  // Delete the soup and change yesterday's weight through the existing editors.
  await todayScreen.getByRole('button', { name: /^Open meal log for / }).click();
  const soup = mealLog.locator('.run-cards > li').filter({ hasText: 'Soup' });
  await soup.getByRole('button', { name: /^Delete / }).click();
  await soup.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(mealLog.getByText('The entry was deleted.')).toBeVisible();
  await mealLog.getByRole('button', { name: 'Back to Today' }).click();
  await expect(todayScreen.getByLabel('Date')).toHaveValue(yesterday);
  await todayScreen.getByRole('button', { name: /^Edit check-in for / }).click();
  await saveCheckIn(page, { weight: '71.9' }, 'Check-in updated.');

  // Back to Trends through the navigation: the same range and series, read again with the changes.
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.screen.getByLabel('End date')).toHaveValue(today);
  await expect(trends.screen.getByRole('radio', { name: 'Food energy' })).toBeChecked();
  await expect(trends.series.getByText('Recorded on 0 of 28 days. Energy is recorded on 0 of 1 logged entry. The other 28 days have no value: unknown, not zero.')).toBeVisible();
  await expect(trends.series.getByText('1 entry logged on 1 day, none with food energy recorded.')).toBeVisible();
  await expect(trends.row(yesterday)).toContainText('1 entry logged, no energy recorded');
  await expect(trends.screen).not.toContainText('350.5');
  await trends.screen.getByRole('radio', { name: 'Weight' }).check();
  await expect(trends.series.getByText('Difference between those two dates: −0.5 kg (2 dates have a weight).')).toBeVisible();

  // Another end date is kept during ordinary navigation, too.
  await trends.screen.getByLabel('End date').fill(yesterday);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.row(today)).toHaveCount(0);
  await expect(trends.row(yesterday)).toHaveCount(1);
  await navigation(page).getByRole('button', { name: 'Check-in' }).click();
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  await expect(trends.screen.getByLabel('End date')).toHaveValue(yesterday);
  await expect(trends.screen.getByRole('radio', { name: 'Weight' })).toBeChecked();

  // Signing out forgets the kept range.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  await expect(trends.screen.getByLabel('End date')).toHaveValue(today);
});

test('Trends at 375 px: usable without horizontal scrolling, and a late answer for an abandoned range is never shown', async ({
  demoScenario,
  environment,
  page,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 300_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const abandoned = daysBefore(today, 5);
  const chosen = daysBefore(today, 1);
  await page.setViewportSize({ width: 375, height: 812 });
  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  // Linux CI fonts are wider than Windows ones: measure with a wide font.
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  const inside = async (locator: Locator, name: string) => {
    const box = await locator.boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 375, name).toBe(true);
  };

  // A recorded value for today and a recorded zero for yesterday, through the movement editor.
  await navigation(page).getByRole('button', { name: 'Check-in' }).click();
  const movementForm = page.getByRole('form', { name: 'Daily movement' });
  await saveSteps(page, '123456');
  await movementForm.getByLabel('Date').fill(chosen);
  await saveSteps(page, '0');

  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  const trends = trendsScreen(page);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await trends.screen.getByRole('radio', { name: 'Steps' }).check();
  await expect(trends.chart.locator('circle')).toHaveCount(2);
  await expect(trends.chart.locator('polyline')).toHaveCount(1); // yesterday and today are neighbours
  expect(await fits(page)).toBe(true);
  await inside(trends.screen.getByLabel('End date'), 'End date');
  for (const name of ['End today', 'Refresh']) await inside(trends.screen.getByRole('button', { name, exact: true }), name);
  for (const name of ['Weight', 'Sleep', 'Steps', 'Food energy']) await inside(trends.screen.getByRole('radio', { name }), name);
  await inside(trends.chart, 'chart');
  await inside(trends.row(today).getByRole('button', { name: /^Open Today on / }), 'Open today');
  await expect(trends.row(today)).toContainText('123,456 steps');
  await expect(trends.row(chosen)).toContainText('0 steps');
  await trends.screen.getByRole('radio', { name: 'Food energy' }).check();
  expect(await fits(page)).toBe(true);
  await inside(navigation(page).getByRole('button', { name: 'Trends', exact: true }), 'Trends navigation');

  // Hold the answer for one end date, choose another, then let the first answer through: the chosen range stays.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldSeen = false;
  await page.route(
    (url) => url.pathname.endsWith('/daily-trends') && url.searchParams.get('endDate') === abandoned,
    async (route) => {
      heldSeen = true;
      await held;
      await route.continue().catch(() => undefined); // the page has aborted it by now
    },
  );
  await trends.screen.getByLabel('End date').fill(abandoned);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'loading');
  await expect.poll(() => heldSeen).toBe(true);
  await trends.screen.getByLabel('End date').fill(chosen);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  release();
  await page.waitForTimeout(500); // give a late answer every chance to be (wrongly) applied
  await expect(trends.screen.getByLabel('End date')).toHaveValue(chosen);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.healthRows.first()).toHaveAttribute('data-date', chosen);
  await expect(trends.row(today)).toHaveCount(0);
  expect(await fits(page)).toBe(true);
});

test('Trends while recording: capture, upload and the writer continue while Trends is open', async ({ context, environment, page, scenario }) => {
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);

  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Writer').value).toHaveText('owned');
  const runId = await runner.runId(api, scenario.orgId);

  // Switch to Trends at once and stay there while the simulator records and the uploader sends every point.
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  expect((await api.getAllPoints(scenario.orgId, runId)).length).toBeLessThan(6);
  await expect(trendsScreen(page).state).toHaveAttribute('data-trends-state', 'ready');
  await expect.poll(async () => (await api.getAllPoints(scenario.orgId, runId)).length, { timeout: 45_000 }).toBe(6);
  await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeVisible();

  // Back on Runner: the same run, still recording, writer still owned, nothing left in the buffer.
  await navigation(page).getByRole('button', { name: 'Runner' }).click();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Writer').value).toHaveText('owned');
  await runner.waitForCaptureComplete();
  await runner.waitForEmptyBuffer();
  expect(await runner.runId(api, scenario.orgId)).toBe(runId);
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');
});
