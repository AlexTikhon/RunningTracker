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
