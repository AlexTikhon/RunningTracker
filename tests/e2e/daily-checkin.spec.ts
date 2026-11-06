import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// The Check-in tab (ADR-0074): the demo runner records today's check-in, sees it in the 14-day history among empty
// days, replaces it after a reload, and opens an earlier day. The demo people and their organization are created in the
// _test database by the demoScenario fixture, whose cleanup removes the organization's check-ins with it.

// A fixed browser zone and locale. The API runs on the real clock, so "today" is computed here the same way.
const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

function dateIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(
    new Date(instantMs),
  );
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

async function openCheckIn(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Check-in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check-in' })).toBeVisible();
}

test('the demo runner checks in for today, sees it among empty days, replaces it after a reload, and opens an earlier day', async ({
  demoScenario,
  environment,
  page,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 120_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');

  const mutations: Array<{ body: string | null; method: string; path: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/daily-metrics') && request.method() !== 'GET') {
      mutations.push({ body: request.postData(), method: request.method(), path: url.pathname });
    }
  });

  await page.goto(environment.demoWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);

  await openCheckIn(page);
  const form = page.getByRole('form', { name: 'Daily check-in' });
  const history = page.getByRole('list', { name: 'Last 14 days' });
  const days = history.locator(':scope > li');

  // Defaults to today in the browser's zone, with nothing recorded and 14 empty days.
  await expect(form.getByLabel('Date')).toHaveValue(today);
  await expect(form.getByLabel('Date')).toHaveAttribute('max', today);
  await expect(form.getByText(/^Nothing recorded for .+ yet\.$/u)).toBeVisible();
  await expect(days).toHaveCount(14);
  await expect(history.getByText('No check-in')).toHaveCount(14);
  await expect(days.first().locator('time')).toHaveAttribute('datetime', today);

  await form.getByLabel('Weight in kg (optional)').fill('72,4');
  await form.getByLabel('Hours').fill('7');
  await form.getByLabel('Minutes').fill('30');
  await form.getByLabel('Mood (optional)').selectOption('4');
  await form.getByLabel('Soreness (optional)').selectOption('0');
  await form.getByLabel('Note (optional)').fill('Felt fresh');
  await form.getByRole('button', { name: 'Save check-in' }).click();

  await expect(form.getByText('Check-in saved.')).toBeVisible();
  await expect(history.getByText('No check-in')).toHaveCount(13);
  for (const text of ['72.4 kg', '7 h 30 min', '4/5', '0/10', 'Felt fresh']) {
    await expect(days.first()).toContainText(text);
  }

  // Exactly one PUT, to today's date, with the whole day and the browser's zone; no owner, organization or date in it.
  expect(mutations).toHaveLength(1);
  const [put] = mutations;
  expect(put?.method).toBe('PUT');
  expect(put?.path).toBe(`/api/orgs/${demoScenario.orgId}/daily-metrics/${today}`);
  expect(JSON.parse(put?.body ?? '{}')).toEqual({
    mood: 4,
    note: 'Felt fresh',
    sleepMinutes: 450,
    sleepQuality: null,
    soreness: 0,
    timeZone,
    weightKg: 72.4,
  });

  // Stored on the server: after a reload the form shows today's values again.
  await page.reload();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openCheckIn(page);
  await expect(form.getByText(/^Showing what you recorded for .+\. Saving replaces it\.$/u)).toBeVisible();
  await expect(form.getByLabel('Weight in kg (optional)')).toHaveValue('72.4');
  await expect(form.getByLabel('Hours')).toHaveValue('7');
  await expect(form.getByLabel('Minutes')).toHaveValue('30');
  await expect(form.getByLabel('Mood (optional)')).toHaveValue('4');
  await expect(form.getByLabel('Note (optional)')).toHaveValue('Felt fresh');

  // Replacing the day: the note is cleared and the mood changed; the same date, still one record.
  await form.getByLabel('Mood (optional)').selectOption('2');
  await form.getByLabel('Note (optional)').fill('');
  await form.getByRole('button', { name: 'Save check-in' }).click();
  await expect(form.getByText('Check-in updated.')).toBeVisible();
  await expect(days.first()).toContainText('2/5');
  await expect(days.first()).not.toContainText('Felt fresh');
  await expect(history.getByText('No check-in')).toHaveCount(13);
  expect(mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toEqual([`PUT ${put?.path}`, `PUT ${put?.path}`]);
  expect(JSON.parse(mutations[1]?.body ?? '{}')).toMatchObject({ mood: 2, note: null, timeZone });

  // An earlier, empty day opens with an empty form; today's values are not carried over.
  await days.nth(1).getByRole('button', { name: /^Add a check-in for / }).click();
  await expect(form.getByLabel('Date')).not.toHaveValue(today);
  await expect(form.getByText(/^Nothing recorded for .+ yet\.$/u)).toBeVisible();
  await expect(form.getByLabel('Weight in kg (optional)')).toHaveValue('');
  await expect(form.getByLabel('Mood (optional)')).toHaveValue('');
  await expect(days.nth(1)).toHaveAttribute('aria-current', 'date');
  expect(mutations).toHaveLength(2);
});
