import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from '../support/session.js';
import { loadLanPilot } from './pilot-environment.js';

// The iPhone LAN pilot through its real HTTPS proxy (docs/runbooks/iphone-lan-pilot.md), in desktop Chromium at a
// phone-sized viewport: the existing demo sign-in, Today, a check-in, movement and a meal saved, edited and deleted
// through the existing editors, Trends, a reload, and sign-out. The pilot's own database holds only the synthetic demo
// people; this test removes what it writes on its date. It is not evidence about Safari on an iPhone.

const pilot = loadLanPilot();
const organizationId = 'dddddddd-dddd-4ddd-8ddd-dddddddd0000';
const runnerId = 'dddddddd-dddd-4ddd-8ddd-dddddddd0001';
const timeZone = 'Europe/Warsaw';

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

async function openToday(page: Page): Promise<Locator> {
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  const screen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(screen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  return screen;
}

// Same-origin requests from the page itself, so they carry its session cookie, its Origin and its CSRF token exactly as
// the app's own requests do. Used only to make the chosen date empty before the test and after a failure.
async function clearDate(page: Page, localDate: string): Promise<void> {
  await page.evaluate(
    async ({ date, orgId }) => {
      const session = (await (await fetch('/api/session')).json()) as { csrf: { token: string } };
      const headers = { 'x-csrf-token': session.csrf.token };
      const expectOk = (response: Response) => {
        if (!response.ok) throw new Error(`${response.url} answered ${response.status}`);
      };
      expectOk(await fetch(`/api/orgs/${orgId}/daily-metrics/${date}`, { headers, method: 'DELETE' }));
      expectOk(await fetch(`/api/orgs/${orgId}/daily-movement/${date}`, { headers, method: 'DELETE' }));
      const meals = (await (await fetch(`/api/orgs/${orgId}/meals?localDate=${date}`)).json()) as { items: { mealId: string }[] };
      for (const meal of meals.items) expectOk(await fetch(`/api/orgs/${orgId}/meals/${meal.mealId}`, { headers, method: 'DELETE' }));
    },
    { date: localDate, orgId: organizationId },
  );
}

test('LAN pilot over its HTTPS proxy: demo sign-in, Today, editors, Trends, reload and sign-out', async ({ context, page }) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 900_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const day = daysBefore(today, 12);
  const otherOrigins = new Set<string>();
  page.on('request', (request) => {
    const requestOrigin = new URL(request.url()).origin;
    if (requestOrigin !== pilot.origin && !request.url().startsWith('data:')) otherOrigins.add(requestOrigin);
  });

  // The page comes from the pilot proxy over TLS, with the certificate the pilot authority issued, in a secure context
  // (which Geolocation needs).
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  const security = await response?.securityDetails();
  expect(security?.issuer).toBe(pilot.caCommonName);
  expect(security?.subjectName).toBe('Running Tracker LAN pilot server');
  expect(security?.protocol).toBe('TLS 1.3');
  expect(new URL(page.url()).origin).toBe(pilot.origin);
  expect(await page.evaluate(() => window.isSecureContext && 'geolocation' in navigator)).toBe(true);

  // The existing demo sign-in: no console, nothing typed.
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerId);
  await expectOrganizationSelected(page, organizationId);
  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'running_tracker_session');
  expect(sessionCookie).toMatchObject({ domain: pilot.host, httpOnly: true, sameSite: 'Strict', secure: true });
  await clearDate(page, day);

  try {
    // Today on the chosen date: empty.
    let todayScreen = await openToday(page);
    await todayScreen.getByLabel('Date').fill(day);
    await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
    await expect(todayScreen.getByText(/^Nothing is recorded for .+ yet\.$/u)).toBeVisible();
    expect(await fits(page)).toBe(true);

    // Check-in: save, then edit.
    await todayScreen.getByRole('button', { name: /^Add check-in for / }).click();
    const checkInForm = page.getByRole('form', { name: 'Daily check-in' });
    await expect(checkInForm.getByLabel('Date')).toHaveValue(day);
    await checkInForm.getByLabel('Hours').fill('7');
    await checkInForm.getByLabel('Minutes').fill('30');
    await checkInForm.getByLabel('Weight in kg (optional)').fill('72.4');
    await checkInForm.getByRole('button', { name: 'Save check-in' }).click();
    await expect(checkInForm.getByText('Check-in saved.')).toBeVisible();
    todayScreen = await openToday(page);
    const checkInCard = todayScreen.getByRole('region', { exact: true, name: 'Check-in' });
    await expect(checkInCard.getByText('7 h 30 min')).toBeVisible();
    await checkInCard.getByRole('button', { name: /^Edit check-in for / }).click();
    await checkInForm.getByLabel('Weight in kg (optional)').fill('72.1');
    await checkInForm.getByRole('button', { name: 'Save check-in' }).click();
    await expect(checkInForm.getByText('Check-in updated.')).toBeVisible();

    // Movement: save, then edit.
    todayScreen = await openToday(page);
    const movementCard = todayScreen.getByRole('region', { exact: true, name: 'Steps and active energy' });
    await movementCard.getByRole('button', { name: /^Add movement for / }).click();
    const movementForm = page.getByRole('form', { name: 'Daily movement' });
    await expect(movementForm.getByLabel('Date')).toHaveValue(day);
    await movementForm.getByLabel('Steps (optional)').fill('4200');
    await movementForm.getByRole('button', { name: 'Save movement' }).click();
    await expect(movementForm.getByText('Movement saved.')).toBeVisible();
    todayScreen = await openToday(page);
    await expect(movementCard.getByText('4,200 steps')).toBeVisible();
    await movementCard.getByRole('button', { name: /^Edit movement for / }).click();
    await movementForm.getByLabel('Steps (optional)').fill('5100');
    await movementForm.getByRole('button', { name: 'Save movement' }).click();
    await expect(movementForm.getByText('Movement updated.')).toBeVisible();

    // Meal: add from Today on the date, then edit.
    todayScreen = await openToday(page);
    const mealsCard = todayScreen.getByRole('region', { exact: true, name: 'Meals' });
    await mealsCard.getByRole('button', { name: /^Add a meal for / }).click();
    const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
    const mealForm = mealLog.locator('form.meal-form');
    await expect(mealLog.getByLabel('Date')).toHaveValue(day);
    await mealForm.getByLabel('Meal type').selectOption({ label: 'Lunch' });
    await mealForm.getByLabel('Title').fill('Pilot soup');
    await mealForm.getByLabel('Food energy (kcal)').fill('350.5');
    await mealForm.getByRole('button', { name: 'Add entry' }).click();
    await expect(mealForm.getByText('Entry saved.')).toBeVisible();
    const soup = mealLog.locator('.run-cards > li').filter({ hasText: 'Pilot soup' });
    await soup.getByRole('button', { name: /^Edit / }).click();
    await mealForm.getByLabel('Food energy (kcal)').fill('360.5');
    await mealForm.getByRole('button', { name: 'Save changes' }).click();
    await expect(mealLog.getByText('Your changes to "Pilot soup" were saved.')).toBeVisible();
    await mealLog.getByRole('button', { name: 'Back to Today' }).click();
    await expect(todayScreen.getByLabel('Date')).toHaveValue(day);
    await expect(mealsCard.getByText('1 entry logged for this day.')).toBeVisible();
    await expect(movementCard.getByText('5,100 steps')).toBeVisible();

    // Trends from Today, ending on the date: the edited values, in the table and the chart, at phone width.
    await todayScreen.getByRole('button', { name: /^Open 28-day trends ending on / }).click();
    const trends = page.getByRole('region', { exact: true, name: 'Trends' });
    await expect(trends.locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready');
    await expect(trends.getByLabel('End date')).toHaveValue(day);
    const row = trends.locator(`tr[data-date="${day}"]`);
    await expect(trends.locator('tbody tr')).toHaveCount(28);
    await trends.getByRole('radio', { name: 'Steps' }).check();
    await expect(row).toContainText('5,100 steps');
    await expect(trends.locator('.trends-chart svg circle')).toHaveCount(1);
    await trends.getByRole('radio', { name: 'Weight' }).check();
    await expect(row).toContainText('72.1');
    await trends.getByRole('radio', { name: 'Food energy' }).check();
    await expect(row).toContainText('360.5 kcal');
    await expect(trends).not.toContainText('Pilot soup');
    expect(await fits(page)).toBe(true);

    // A reload keeps the session (the Secure cookie over this origin).
    await page.reload();
    await expectSignedIn(page, runnerId);
    await expectOrganizationSelected(page, organizationId);

    // Delete all three through the editors, from Today on the date.
    todayScreen = await openToday(page);
    await todayScreen.getByLabel('Date').fill(day);
    await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
    await mealsCard.getByRole('button', { name: /^Open meal log for / }).click();
    await soup.getByRole('button', { name: /^Delete / }).click();
    await soup.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(mealLog.getByText('The entry was deleted.')).toBeVisible();
    await mealLog.getByRole('button', { name: 'Back to Today' }).click();
    await movementCard.getByRole('button', { name: /^Edit movement for / }).click();
    await movementForm.getByRole('button', { name: /^Delete the movement of / }).click();
    await movementForm.getByRole('region', { name: /^Delete the movement of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
    await expect(movementForm.getByText('Movement deleted.')).toBeVisible();
    todayScreen = await openToday(page);
    await checkInCard.getByRole('button', { name: /^Edit check-in for / }).click();
    await checkInForm.getByRole('button', { name: /^Delete the check-in of / }).click();
    await checkInForm.getByRole('region', { name: /^Delete the check-in of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
    await expect(checkInForm.getByText(/^Nothing recorded for .+ yet\.$/u)).toBeVisible();
    todayScreen = await openToday(page);
    await expect(todayScreen.getByLabel('Date')).toHaveValue(day);
    await expect(todayScreen.getByText(/^Nothing is recorded for .+ yet\.$/u)).toBeVisible();
  } catch (error) {
    await clearDate(page, day).catch(() => undefined);
    throw error;
  }

  // Sign out: the session ends on the server and stays ended after a reload.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await page.reload();
  await expectSignedOut(page);
  expect((await context.cookies()).filter((cookie) => cookie.name === 'running_tracker_session' && cookie.value !== '')).toEqual([]);

  // Everything came from the pilot origin: no other host was contacted.
  expect([...otherOrigins]).toEqual([]);
});
