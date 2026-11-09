import type { Locator, Page } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// Meal log (ADR-0083): the demo runner opens the Meal log from Today on a selected date, logs entries (one of them
// title-only, one whose first POST answer is lost), reloads, edits and deletes, and returns to Today, which shows the
// exact recorded totals with their own coverage. The demo people and their organization are created in the _test
// database by the demoScenario fixture, whose cleanup removes the organization's meals with it.

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

async function signInDemoRunner(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

async function openToday(page: Page): Promise<Locator> {
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  const screen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(screen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  return screen;
}

interface Entry {
  carbohydrate?: string;
  energy?: string;
  fat?: string;
  protein?: string;
  title: string;
  type: string;
}

async function fillEntry(form: Locator, entry: Entry): Promise<void> {
  await form.getByLabel('Meal type').selectOption({ label: entry.type });
  await form.getByLabel('Title').fill(entry.title);
  await form.getByLabel('Food energy (kcal)').fill(entry.energy ?? '');
  await form.getByLabel('Protein (g)').fill(entry.protein ?? '');
  await form.getByLabel('Carbohydrate (g)').fill(entry.carbohydrate ?? '');
  await form.getByLabel('Fat (g)').fill(entry.fat ?? '');
}

test('Meal log: adds, reloads, edits and deletes entries; Today shows exact totals with independent coverage on the selected date', async ({
  demoScenario,
  environment,
  page,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 600_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const yesterday = daysBefore(today, 1);
  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);

  // Today on yesterday: no meal yet; its action opens the Meal log on that date.
  let todayScreen = await openToday(page);
  await todayScreen.getByLabel('Date').fill(yesterday);
  await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  const mealsCard = todayScreen.getByRole('region', { exact: true, name: 'Meals' });
  await expect(mealsCard.getByText('No meal or snack logged for this day.')).toBeVisible();
  await mealsCard.getByRole('button', { name: /^Add a meal for / }).click();

  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  await expect(page.getByRole('heading', { level: 1, name: 'Meal log' })).toBeVisible();
  await expect(mealLog.getByLabel('Date')).toHaveValue(yesterday);
  const form = mealLog.locator('form.meal-form');
  const list = mealLog.locator('[data-meal-list-state]');
  const cards = mealLog.locator('.run-cards > li');
  await expect(list).toHaveAttribute('data-meal-list-state', 'ready');
  await expect(mealLog.getByText(/^Nothing is logged for .+ yet\./u)).toBeVisible();
  await expect(form.getByText('Manually entered')).toBeVisible();

  // Validation: a title is required, and a value with two decimals is refused before anything is sent.
  await fillEntry(form, { energy: '12.55', title: '', type: 'Breakfast' });
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByRole('list', { name: 'Problems with the entry' })).toContainText('Enter a short title');
  await expect(form.getByRole('list', { name: 'Problems with the entry' })).toContainText('Food energy must be from 0 to 20,000 kcal');
  await expect(cards).toHaveCount(0);

  // 1. A complete entry, with a recorded zero.
  await fillEntry(form, { carbohydrate: '60', energy: '350.5', fat: '0', protein: '12', title: 'Porridge', type: 'Breakfast' });
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByText('Entry saved.')).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(form.getByLabel('Title')).toHaveValue('');

  // 2. The first POST reaches the server but its answer is lost: the retry reuses the form session's key, so one entry.
  let posts = 0;
  await page.route('**/api/orgs/*/meals', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    if (posts === 1) {
      await route.fetch(); // the server stores the entry...
      return route.abort('connectionfailed'); // ...and the browser never hears about it
    }
    return route.continue();
  });
  await fillEntry(form, { energy: '410.6', title: 'Soup', type: 'Lunch' });
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByText(/^The save was not confirmed: .* Saving again is safe and will not create a duplicate\.$/u)).toBeVisible();
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByText('Entry saved.')).toBeVisible();
  await page.unroute('**/api/orgs/*/meals');
  expect(posts).toBe(2);
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'Soup' })).toHaveCount(1);

  // 3. Title only: valid, every value not recorded. A double click sends one request.
  await fillEntry(form, { title: 'Apple', type: 'Snack' });
  await form.getByRole('button', { name: 'Add entry' }).dblclick();
  await expect(form.getByText('Entry saved.')).toBeVisible();
  await expect(cards).toHaveCount(3);
  const apple = cards.filter({ hasText: 'Apple' });
  await expect(apple.getByText('Not recorded')).toHaveCount(4);

  // 4. One more, to delete later.
  await fillEntry(form, { energy: '0', title: 'Tea', type: 'Other' });
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(cards).toHaveCount(4);

  // Reload: the entries come from the server, in the order they were logged.
  await page.reload();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  await expect(mealLog.getByLabel('Date')).toHaveValue(today);
  await mealLog.getByLabel('Date').fill(yesterday);
  await expect(list).toHaveAttribute('data-meal-list-state', 'ready');
  await expect(cards).toHaveCount(4);
  await expect(cards.locator('h3')).toHaveText(['Porridge', 'Soup', 'Apple', 'Tea']);
  const porridge = cards.filter({ hasText: 'Porridge' });
  await expect(porridge.getByText('350.5 kcal')).toBeVisible();
  await expect(porridge.getByText('0 g', { exact: true })).toBeVisible();
  await expect(porridge.getByText('Manually entered')).toBeVisible();

  // Edit the soup: title and energy change, the date stays.
  await cards.filter({ hasText: 'Soup' }).getByRole('button', { name: /^Edit / }).click();
  await expect(form.getByRole('heading', { name: 'Edit "Soup"' })).toBeFocused();
  await expect(form.getByLabel('Food energy (kcal)')).toHaveValue('410.6');
  await form.getByLabel('Title').fill('Lentil soup');
  await form.getByLabel('Food energy (kcal)').fill('410.4');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(mealLog.getByText('Your changes to "Lentil soup" were saved.')).toBeVisible();
  await expect(cards.locator('h3')).toHaveText(['Porridge', 'Lentil soup', 'Apple', 'Tea']);
  await expect(cards.filter({ hasText: 'Lentil soup' }).getByText('410.4 kcal')).toBeVisible();

  // Delete the tea, after a confirmation, while it is open in the form: the edit ends and its values leave the form.
  const tea = cards.filter({ hasText: 'Tea' });
  await tea.getByRole('button', { name: /^Edit / }).click();
  await expect(form.getByLabel('Title')).toHaveValue('Tea');
  await tea.getByRole('button', { name: /^Delete / }).click();
  await expect(tea.getByRole('heading', { name: 'Delete this entry?' })).toBeVisible();
  await tea.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(mealLog.getByText('The entry was deleted.')).toBeVisible();
  await expect(cards).toHaveCount(3);
  await expect(form.getByRole('heading', { name: /^Add an entry for / })).toBeVisible();
  await expect(form.getByLabel('Title')).toHaveValue('');
  await expect(form.getByLabel('Food energy (kcal)')).toHaveValue('');

  // Back to Today on the same date: read again, exact totals, each with its own coverage. Energy is recorded for 2 of the
  // 3 entries (350.5 + 410.4 = 760.9, never 760.9000000000001); the title-only entry is unknown, not zero.
  await mealLog.getByRole('button', { name: 'Back to Today' }).click();
  todayScreen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await expect(todayScreen.getByLabel('Date')).toHaveValue(yesterday);
  await expect(todayScreen.getByText(/^Nothing is recorded/u)).toHaveCount(0);
  await expect(mealsCard.getByText('3 entries logged for this day.')).toBeVisible();
  const row = (label: string) => mealsCard.locator('.today-meal-totals > div').filter({ has: page.getByText(label, { exact: true }) });
  await expect(row('Food energy recorded (kcal)')).toContainText('760.9');
  await expect(row('Food energy recorded (kcal)')).toContainText('Recorded for 2 of 3 logged entries; 1 entry is unknown');
  await expect(row('Protein recorded (g)')).toContainText('12');
  await expect(row('Protein recorded (g)')).toContainText('Recorded for 1 of 3 logged entries');
  await expect(row('Carbohydrate recorded (g)')).toContainText('60');
  // The fat total is a recorded zero, shown as 0, covering the one entry that recorded it.
  await expect(row('Fat recorded (g)').locator('dd').first()).toHaveText('0');
  await expect(row('Fat recorded (g)')).toContainText('Recorded for 1 of 3 logged entries');
  // Food energy is not active energy: the movement card is untouched, and nothing is balanced or advised.
  await expect(todayScreen.getByRole('region', { exact: true, name: 'Steps and active energy' }).getByText('No movement recorded for this day.')).toBeVisible();
  // ("it sets no targets and gives no advice" is the screen's own statement; the unit tests scan the full wording.)
  await expect(todayScreen).not.toContainText(/balance|deficit|surplus|recommend|requirement/iu);
  await expect(todayScreen).not.toContainText('Porridge');

  // The Meal log navigation button opens on today, not on Today's date; Today keeps its date.
  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  await expect(mealLog.getByLabel('Date')).toHaveValue(today);
  await expect(mealLog.getByText(/^Nothing is logged for .+ yet\./u)).toBeVisible();
  todayScreen = await openToday(page);
  await expect(todayScreen.getByLabel('Date')).toHaveValue(yesterday);
  // Opening the Meal log from Today again lands on the kept date, with its entries.
  await mealsCard.getByRole('button', { name: /^Open meal log for / }).click();
  await expect(mealLog.getByLabel('Date')).toHaveValue(yesterday);
  await expect(cards).toHaveCount(3);
});

test('Meal log at 375 px: usable without horizontal scrolling, and the Today meal card fits', async ({ demoScenario, environment, page }) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 300_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  await page.setViewportSize({ width: 375, height: 812 });
  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  // Linux CI fonts are wider than Windows ones: measure with a wide font.
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const inside = async (locator: Locator, name: string) => {
    const box = await locator.boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 375, name).toBe(true);
  };

  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  const form = mealLog.locator('form.meal-form');
  await expect(mealLog.locator('[data-meal-list-state]')).toHaveAttribute('data-meal-list-state', 'ready');
  expect(await fits()).toBe(true);
  // Not exact: a <select>'s wrapping label also contains its options' text.
  for (const label of ['Date', 'Meal type', 'Title', 'Food energy (kcal)', 'Protein (g)', 'Carbohydrate (g)', 'Fat (g)']) {
    await inside(mealLog.getByLabel(label), label);
  }
  await inside(form.getByRole('button', { name: 'Add entry' }), 'Add entry');

  // A long title without spaces still wraps inside the card.
  await fillEntry(form, { carbohydrate: '1999.9', energy: '19999.9', fat: '0', protein: '1999.9', title: `Overnight${'oats'.repeat(25)}`, type: 'Breakfast' });
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByText('Entry saved.')).toBeVisible();
  const card = mealLog.locator('.run-cards > li').first();
  await expect(card).toBeVisible();
  expect(await fits()).toBe(true);
  await inside(card.getByRole('button', { name: /^Edit / }), 'Edit');
  await inside(card.getByRole('button', { name: /^Delete / }), 'Delete');

  const todayScreen = await openToday(page);
  const mealsCard = todayScreen.getByRole('region', { exact: true, name: 'Meals' });
  await expect(mealsCard.getByText('1 entry logged for this day.')).toBeVisible();
  await expect(mealsCard.getByText('19,999.9')).toBeVisible();
  expect(await fits()).toBe(true);
  await inside(mealsCard.getByRole('button', { name: /^Open meal log for / }), 'Open meal log');
  // The navigation (now with Meal log) still wraps within the viewport.
  await inside(navigation(page).getByRole('button', { name: 'Meal log' }), 'Meal log navigation');
});
