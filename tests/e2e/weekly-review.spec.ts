import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { addDays, INSIGHT_ZONE, mondayWeeksAgo } from './support/insight-weeks.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// The deterministic Weekly review on the Check-in tab, against an API with weekly insight generation explicitly off
// (WEEKLY_INSIGHTS_PROVIDER=off, the product default): the review is the primary view, it follows saves and deletions,
// and the optional AI section's disabled state does not affect it. Weeks come from the real clock in the browser zone.
test.use({ locale: 'en-GB', timezoneId: INSIGHT_ZONE });

const settled = { timeout: 30_000 };

async function checkIn(page: Page, date: string, values: { hours?: string; minutes?: string; mood?: string }): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily check-in' });
  await form.getByLabel('Date').fill(date);
  await expect(form.getByText(/^(Nothing recorded|Showing what you recorded) for /u)).toBeVisible();
  if (values.hours !== undefined) {
    await form.getByLabel('Hours').fill(values.hours);
    await form.getByLabel('Minutes').fill(values.minutes ?? '0');
  }
  if (values.mood !== undefined) await form.getByLabel('Mood').selectOption(values.mood);
  await form.getByRole('button', { name: 'Save check-in' }).click();
  await expect(form.getByText('Check-in saved.')).toBeVisible();
}

test('with AI generation off, the weekly review is shown, follows a save and loses deleted data', async ({ demoScenario, environment, page }) => {
  test.skip(mondayWeeksAgo(1) !== mondayWeeksAgo(1, Date.now() + 300_000), 'Too close to the start of a week in Warsaw');
  const week = mondayWeeksAgo(1);
  const insightRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/insights/weekly') && request.method() === 'POST') insightRequests.push(request.url());
  });

  await page.goto(environment.reviewWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Check-in' }).click();
  const review = page.getByRole('region', { name: 'Weekly review' });
  const ai = page.getByRole('region', { name: 'AI insight (optional)' });
  const statements = review.getByRole('list', { name: 'What your records show' });

  // Four days with values; sleep duration on three of them (one of 9 h 13 min), mood only on the fourth.
  await checkIn(page, week, { hours: '7' });
  await checkIn(page, addDays(week, 1), { hours: '6', minutes: '30' });
  await checkIn(page, addDays(week, 2), { hours: '9', minutes: '13' });
  await checkIn(page, addDays(week, 4), { mood: '3' });

  await review.getByLabel('Week').selectOption(week);
  await expect(statements).toContainText('Check-ins with values on 4 of 7 days of the week.', settled);
  await expect(statements).toContainText('Sleep duration was recorded on 3 of 4 days with check-in values.');
  await expect(review).not.toContainText(/every check-in day/u);
  await expect(review.getByText('Computed by the app')).toBeVisible();
  await expect(review).toContainText(`Days are read in ${INSIGHT_ZONE}, the time zone of your check-ins this week.`);
  await expect(review.getByRole('list', { name: 'Numbers from your data' })).toContainText('Longest sleep: 553 min');
  await expect(review.getByRole('region', { name: 'Coverage' })).toContainText('Sleep duration3 of 4 days with values');

  // The optional AI section follows the week, has no insight, and generation is off; the review stays as it is.
  await expect(ai.getByText(/^No insight for /u)).toBeVisible(settled);
  expect(insightRequests).toEqual([]);
  await ai.getByRole('button', { name: 'Generate insight' }).click();
  await expect(ai.getByText('Insight generation is turned off on this server. Stored insights are still shown.')).toBeVisible(settled);
  await expect(statements).toContainText('Sleep duration was recorded on 3 of 4 days with check-in values.');

  // A save in the shown week refreshes the review.
  await checkIn(page, addDays(week, 5), { hours: '8' });
  await expect(statements).toContainText('Sleep duration was recorded on 4 of 5 days with check-in values.', settled);

  // Deleting the 9 h 13 min day: the next review no longer contains it.
  const form = page.getByRole('form', { name: 'Daily check-in' });
  await form.getByLabel('Date').fill(addDays(week, 2));
  await expect(form.getByText(/^Showing what you recorded for /u)).toBeVisible();
  await form.getByRole('button', { name: /^Delete the check-in of /u }).click();
  await page.getByRole('region', { name: /^Delete the check-in of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(statements).toContainText('Sleep duration was recorded on 3 of 4 days with check-in values.', settled);
  await expect(review).not.toContainText('553 min');
  await expect(review).not.toContainText('9 h 13 min');
  await expect(review.getByRole('list', { name: 'Numbers from your data' })).toContainText('Longest sleep: 480 min');

  // Narrow screens: nothing of the review is wider than the page (a wide font, as on Linux CI, makes overflow show).
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

async function saveMovement(page: Page, date: string, values: { energy?: string; steps?: string }, saved: 'saved' | 'updated'): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily movement' });
  await form.getByLabel('Date').fill(date);
  await expect(form.getByText(/^(No movement recorded|Showing what you entered) for /u)).toBeVisible();
  await form.getByLabel('Steps (optional)').fill(values.steps ?? '');
  await form.getByLabel('Active energy (kcal)').fill(values.energy ?? '');
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByText(saved === 'saved' ? 'Movement saved.' : 'Movement updated.')).toBeVisible();
}

test('with AI generation off, the weekly review shows manual movement and follows its save, edit and delete in the selected week', async ({
  demoScenario,
  environment,
  page,
}) => {
  test.skip(mondayWeeksAgo(1) !== mondayWeeksAgo(1, Date.now() + 300_000), 'Too close to the start of a week in Warsaw');
  const week = mondayWeeksAgo(1);
  const insightRequests: string[] = [];
  const reviewReads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/insights/weekly')) insightRequests.push(`${request.method()} ${url.search}`);
    if (url.pathname.endsWith('/weekly-review')) reviewReads.push(url.searchParams.get('weekStart') ?? '');
  });

  await page.goto(environment.reviewWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Check-in' }).click();
  const review = page.getByRole('region', { name: 'Weekly review' });
  const statements = review.getByRole('list', { name: 'What your records show' });
  const movement = review.getByRole('region', { name: 'Steps and active energy' });
  const days = movement.getByRole('list', { name: 'Movement by day' }).locator(':scope > li');

  // Last week, with nothing recorded yet.
  await review.getByLabel('Week').selectOption(week);
  await expect(review.getByText(/^Nothing is recorded for /u)).toBeVisible(settled);
  await expect(movement).toContainText('Days with movement0 of 7');
  await expect(days).toHaveCount(7);
  await expect(movement.getByText('No movement recorded')).toHaveCount(7);
  // The AI section has read the selected week once (no insight, generation off); later changes must not ask it again.
  await expect(page.getByRole('region', { name: 'AI insight (optional)' }).getByText(/^No insight for /u)).toBeVisible(settled);
  const insightRequestsBefore = insightRequests.length;
  const readsBefore = reviewReads.length;

  // The required regression: Monday steps 0, Tuesday 8042 steps and 412.5 kcal, Wednesday 250 kcal only.
  await saveMovement(page, week, { steps: '0' }, 'saved');
  // A week with only a recorded zero is not empty.
  await expect(movement).toContainText('Steps, recorded total0 steps on 1 of 7 days', settled);
  await expect(review.getByText(/^Nothing is recorded for /u)).toHaveCount(0);
  await saveMovement(page, addDays(week, 1), { energy: '412,5', steps: '8042' }, 'saved');
  await saveMovement(page, addDays(week, 2), { energy: '250' }, 'saved');
  await expect(movement).toContainText('Days with movement3 of 7', settled);
  await expect(movement).toContainText('Steps, recorded total8,042 steps on 2 of 7 days');
  await expect(movement).toContainText('Active energy, recorded total662.5 kcal on 2 of 7 days');
  await expect(statements).toContainText('Steps were recorded on 2 of 7 days, 8,042 steps in total on those days; the other 5 days are unknown.');
  await expect(statements).toContainText('Active energy was recorded on 2 of 7 days, 662.5 kcal in total on those days; the other 5 days are unknown.');
  await expect(statements).toContainText('No check-ins were recorded this week.');
  await expect(days.nth(0)).toContainText('Steps0 steps');
  await expect(days.nth(0)).toContainText('Active energyNot recorded');
  await expect(days.nth(0)).toContainText('SourceManually entered');
  await expect(days.nth(2)).toContainText('StepsNot recorded');
  await expect(days.nth(3)).toContainText('No movement recorded');
  await expect(movement.getByText('Manually entered', { exact: true }).first()).toBeVisible();

  // Edit Tuesday's energy: the total follows, the selected week does not change.
  await saveMovement(page, addDays(week, 1), { energy: '100', steps: '8042' }, 'updated');
  await expect(movement).toContainText('Active energy, recorded total350 kcal on 2 of 7 days', settled);
  await expect(review.getByLabel('Week')).toHaveValue(week);

  // Delete Wednesday: the next review no longer has it.
  const form = page.getByRole('form', { name: 'Daily movement' });
  await form.getByLabel('Date').fill(addDays(week, 2));
  await expect(form.getByText(/^Showing what you entered for /u)).toBeVisible();
  await form.getByRole('button', { name: /^Delete the movement of / }).click();
  await form.getByRole('region', { name: /^Delete the movement of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(form.getByText('Movement deleted.')).toBeVisible();
  await expect(movement).toContainText('Days with movement2 of 7', settled);
  await expect(movement).toContainText('Active energy, recorded total100 kcal on 1 of 7 days');
  await expect(days.nth(2)).toContainText('No movement recorded');
  await expect(review).not.toContainText('250 kcal');
  await expect(review.getByLabel('Week')).toHaveValue(week);

  // Every refresh read the selected week; movement changes never asked the AI section for anything.
  expect(reviewReads.length).toBeGreaterThan(readsBefore);
  expect(reviewReads.slice(readsBefore).every((weekStart) => weekStart === week)).toBe(true);
  expect(insightRequests.slice(insightRequestsBefore)).toEqual([]);
  expect(insightRequests.some((entry) => entry.startsWith('POST'))).toBe(false);

  // Narrow screens: the movement block fits the page.
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  await page.setViewportSize({ width: 375, height: 812 });
  await movement.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
