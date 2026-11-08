import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// The Movement section of the Check-in tab (ADR-0078): the demo runner enters steps and active energy by hand for
// today, sees them with the "Manually entered" source in the 14-day history, reloads, edits them (a recorded zero and
// an emptied field), adds an earlier day, and deletes today's after confirming. The check-in above is never written.
// The demo people and their organization are created in the _test database by the demoScenario fixture, whose cleanup
// removes the organization's movement days with it.

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

test('the demo runner saves movement, reloads, edits it, inspects the history and deletes it', async ({ demoScenario, environment, page }) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 180_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');

  const mutations: Array<{ body: string | null; method: string; path: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.pathname.includes('/daily-movement') || url.pathname.includes('/daily-metrics')) && request.method() !== 'GET') {
      mutations.push({ body: request.postData(), method: request.method(), path: url.pathname });
    }
  });
  const todayPath = `/api/orgs/${demoScenario.orgId}/daily-movement/${today}`;

  await page.goto(environment.demoWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);
  await openCheckIn(page);

  const section = page.getByRole('region', { exact: true, name: 'Movement' });
  const form = page.getByRole('form', { name: 'Daily movement' });
  const history = page.getByRole('list', { name: 'Movement history' });
  const days = history.locator(':scope > li');

  // Defaults to today, nothing recorded, 14 empty days, and the absent integration is stated.
  await expect(section.getByText(/Phone and watch synchronization is not connected yet/u)).toBeVisible();
  await expect(form.getByLabel('Date')).toHaveValue(today);
  await expect(form.getByLabel('Date')).toHaveAttribute('max', today);
  await expect(form.getByText(/^No movement recorded for .+ yet\.$/u)).toBeVisible();
  await expect(days).toHaveCount(14);
  await expect(history.getByText('No movement recorded')).toHaveCount(14);
  await expect(days.first().locator('time')).toHaveAttribute('datetime', today);

  // Validation: nothing to save, nothing sent.
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByRole('list', { name: 'Problems with the movement' })).toContainText('Enter steps, active energy or both.');
  await form.getByLabel('Active energy (kcal)').fill('412.55');
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByRole('list', { name: 'Problems with the movement' })).toContainText('at most one decimal');
  expect(mutations).toEqual([]);

  // Save.
  await form.getByLabel('Steps (optional)').fill('8 042');
  await form.getByLabel('Active energy (kcal)').fill('412,5');
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByText('Movement saved.')).toBeVisible();
  await expect(form.getByText('Source: Manually entered')).toBeVisible();
  await expect(history.getByText('No movement recorded')).toHaveCount(13);
  for (const text of ['8,042 steps', '412.5 kcal', 'Manually entered']) {
    await expect(days.first()).toContainText(text);
  }
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({ method: 'PUT', path: todayPath });
  // The whole day and the browser's zone; no owner, organization, date or source in the body.
  expect(JSON.parse(mutations[0]?.body ?? '{}')).toEqual({ activeEnergyKcal: 412.5, steps: 8042, timeZone });

  // Stored on the server: after a reload the form shows today's values again.
  await page.reload();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openCheckIn(page);
  await expect(form.getByText(/^Showing what you entered for .+\. Saving replaces it\.$/u)).toBeVisible();
  await expect(form.getByLabel('Steps (optional)')).toHaveValue('8042');
  await expect(form.getByLabel('Active energy (kcal)')).toHaveValue('412.5');
  await expect(days.first()).toContainText('8,042 steps');

  // Edit: a recorded zero and an emptied field are different things.
  await form.getByLabel('Steps (optional)').fill('0');
  await form.getByLabel('Active energy (kcal)').fill('');
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByText('Movement updated.')).toBeVisible();
  await expect(days.first()).toContainText('0 steps');
  await expect(days.first()).toContainText('Not recorded');
  await expect(history.getByText('No movement recorded')).toHaveCount(13);
  expect(JSON.parse(mutations[1]?.body ?? '{}')).toEqual({ activeEnergyKcal: null, steps: 0, timeZone });

  // An earlier, empty day from the history opens empty; today's values are not carried over.
  await days.nth(1).getByRole('button', { name: /^Add movement for / }).click();
  await expect(form.getByLabel('Date')).not.toHaveValue(today);
  await expect(form.getByText(/^No movement recorded for .+ yet\.$/u)).toBeVisible();
  await expect(form.getByLabel('Steps (optional)')).toHaveValue('');
  await expect(days.nth(1)).toHaveAttribute('aria-current', 'date');
  await form.getByLabel('Active energy (kcal)').fill('250');
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByText('Movement saved.')).toBeVisible();
  await expect(days.nth(1)).toContainText('250 kcal');
  await expect(history.getByText('No movement recorded')).toHaveCount(12);

  // Back to today through the history, then delete it after confirming; Cancel deletes nothing.
  await days.first().getByRole('button', { name: /^Edit the movement of / }).click();
  await expect(form.getByLabel('Steps (optional)')).toHaveValue('0');
  await form.getByRole('button', { name: /^Delete the movement of / }).click();
  const confirmation = form.getByRole('region', { name: /^Delete the movement of .+\?$/u });
  await expect(confirmation.getByText(/removed permanently\. This cannot be undone\.$/u)).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toHaveCount(0);
  await form.getByRole('button', { name: /^Delete the movement of / }).click();
  await confirmation.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(form.getByText('Movement deleted.')).toBeVisible();
  await expect(form.getByText(/^No movement recorded for .+ yet\.$/u)).toBeVisible();
  await expect(form.getByLabel('Steps (optional)')).toHaveValue('');
  await expect(form.getByRole('button', { name: /^Delete the movement of / })).toHaveCount(0);
  await expect(section.getByRole('heading', { level: 2, name: 'Movement' })).toBeFocused();
  await expect(days.first()).toContainText('No movement recorded');
  await expect(days.nth(1)).toContainText('250 kcal');

  // Deleted on the server, not only on the screen; the earlier day stays.
  await page.reload();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openCheckIn(page);
  await expect(form.getByText(/^No movement recorded for .+ yet\.$/u)).toBeVisible();
  await expect(days.first()).toContainText('No movement recorded');
  await expect(days.nth(1)).toContainText('250 kcal');

  // Only movement requests were sent; the check-in of the same screen was never written.
  const yesterdayPath = `/api/orgs/${demoScenario.orgId}/daily-movement/${dateIn('UTC', Date.parse(`${today}T12:00:00Z`) - 86_400_000)}`;
  expect(mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toEqual([
    `PUT ${todayPath}`,
    `PUT ${todayPath}`,
    `PUT ${yesterdayPath}`,
    `DELETE ${todayPath}`,
  ]);
  await expect(page.getByRole('form', { name: 'Daily check-in' }).getByText(/^Nothing recorded for .+ yet\.$/u)).toBeVisible();
});
