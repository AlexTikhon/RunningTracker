import type { Locator, Page } from '@playwright/test';

import { seedInterruptedInsight } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { addDays, failingInsightWeek, INSIGHT_ZONE, mondayWeeksAgo } from './support/insight-weeks.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// The optional AI insight section on the Check-in tab (ADR-0076), against the suite's API with the deterministic
// FakeProvider (WEEKLY_INSIGHTS_PROVIDER=fake: no model, no network). Weeks are computed from the real clock in the
// browser zone, the same way the panel's week picker does.
test.use({ locale: 'en-GB', timezoneId: INSIGHT_ZONE });

const settled = { timeout: 30_000 };

async function signInAndOpen(page: Page, environment: { demoWebOrigin: string }, scenario: { orgId: string; runnerUserId: string }) {
  await page.goto(environment.demoWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, scenario.runnerUserId);
  await expectOrganizationSelected(page, scenario.orgId);
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Check-in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check-in' })).toBeVisible();
  return page.getByRole('region', { name: 'AI insight (optional)' });
}

async function checkIn(page: Page, date: string, hours: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily check-in' });
  await form.getByLabel('Date').fill(date);
  await expect(form.getByText(/^(Nothing recorded|Showing what you recorded) for /u)).toBeVisible();
  await form.getByLabel('Hours').fill(hours);
  await form.getByLabel('Minutes').fill('0');
  await form.getByRole('button', { name: 'Save check-in' }).click();
  await expect(form.getByText('Check-in saved.')).toBeVisible();
}

// The week is chosen in the Weekly review section; the optional AI section follows it.
const selectWeek = (page: Page, week: string) => page.getByRole('region', { name: 'Weekly review' }).getByLabel('Week').selectOption(week);

const facts = (panel: Locator) => panel.getByRole('list', { name: 'Facts from your data' }).getByRole('listitem');

test('generates an insight, marks it stale when the week changes, regenerates it, and loses it when a source is deleted', async ({
  demoScenario,
  environment,
  page,
}) => {
  test.skip(mondayWeeksAgo(1) !== mondayWeeksAgo(1, Date.now() + 300_000), 'Too close to the start of a week in Warsaw');
  const week = mondayWeeksAgo(1);
  const statuses: string[] = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/insights/weekly') && response.request().method() === 'GET' && response.status() === 200) {
      statuses.push(((await response.json()) as { status: string }).status);
    }
  });
  const panel = await signInAndOpen(page, environment, demoScenario);
  await checkIn(page, week, '7');

  await selectWeek(page, week);
  await expect(panel.getByText(/^No insight for /u)).toBeVisible();
  await panel.getByRole('button', { name: 'Generate insight' }).click();
  await expect(panel.locator('[data-insight-state="ready"]')).toBeVisible(settled);
  // The queued or running state was shown on the way (the fake answers after a delay).
  expect(statuses.some((status) => status === 'queued' || status === 'running')).toBe(true);
  await expect(panel.getByText('AI-generated text')).toBeVisible();
  await expect(panel.getByText(/It is not medical advice/u)).toBeVisible();
  await expect(facts(panel)).toContainText(['Days with a check-in: 1 of 7', 'Average sleep: 420 min']);
  await expect(panel.getByRole('region', { name: 'Data gaps and limitations' })).toContainText('No check-in values on 6 of 7 days');
  await expect(panel.getByRole('button', { name: 'Regenerate' })).toBeDisabled();

  // A new check-in in the same week does not delete the insight, but makes it stale.
  await checkIn(page, addDays(week, 1), '8');
  await expect(panel.getByText(/^Out of date: your data for this week changed/u)).toBeVisible(settled);
  await panel.getByRole('button', { name: 'Regenerate' }).click();
  await expect(facts(panel)).toContainText(['Days with a check-in: 2 of 7', 'Average sleep: 450 min'], settled);
  await expect(panel.getByText(/^Out of date/u)).toHaveCount(0);

  // Deleting one of the week's check-ins deletes the insight (derived-data erasure).
  const form = page.getByRole('form', { name: 'Daily check-in' });
  await form.getByRole('button', { name: /^Delete the check-in of /u }).click();
  await page.getByRole('region', { name: /^Delete the check-in of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(panel.getByText(/removed because one of the week's records was deleted or changed/u)).toBeVisible(settled);
  await expect(panel.getByRole('button', { name: 'Generate insight' })).toBeEnabled();
});

test('shows a generation failure without model text and lets the person retry, counting the attempts', async ({ demoScenario, environment, page }) => {
  const week = failingInsightWeek();
  test.skip(week !== failingInsightWeek(Date.now() + 300_000), 'Too close to the start of a week in Warsaw');
  const panel = await signInAndOpen(page, environment, demoScenario);
  await selectWeek(page, week);
  await panel.getByRole('button', { name: 'Generate insight' }).click();
  await expect(panel.getByText(/did not answer in time or could not be reached/u)).toBeVisible(settled);
  await expect(panel.getByText(/You can try again\./u)).toBeVisible();
  await expect(panel.getByText('AI-generated text')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Regenerate' }).click();
  await expect(panel.getByText(/attempt 2/u)).toBeVisible(settled);
  await expect(panel.locator('[data-insight-state="generation_failed"]')).toBeVisible(settled);
});

test('shows work lost with its process as interrupted, and regenerates it', async ({ demoScenario, environment, page }) => {
  const week = mondayWeeksAgo(2);
  test.skip(week !== mondayWeeksAgo(2, Date.now() + 300_000), 'Too close to the start of a week in Warsaw');
  await seedInterruptedInsight(environment, demoScenario.orgId, demoScenario.runnerUserId, week);
  const panel = await signInAndOpen(page, environment, demoScenario);
  await selectWeek(page, week);
  await expect(panel.getByText(/Generation was interrupted/u)).toBeVisible(settled);
  await panel.getByRole('button', { name: 'Regenerate' }).click();
  await expect(panel.locator('[data-insight-state="ready"]')).toBeVisible(settled);
  await expect(facts(panel)).toContainText(['Days with a check-in: 0 of 7']);
});
