import type { Locator, Page } from '@playwright/test';

import { readMeals } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// "Draft from text" in the Meal log (ADR-0092), against the suite API's deterministic FAKE provider (no model is ever
// configured in the suite). These tests prove the route, the screen and every guard; they say nothing about the quality
// of any real model. The demo people and their organization are created by the demoScenario fixture, whose cleanup
// removes the organization's meals with it.

const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

const DRAFTS = '**/api/orgs/*/meals/draft-proposals';

function dateIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(new Date(instantMs));
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });

async function signIn(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

interface MealLogParts {
  form: Locator;
  mealLog: Locator;
  panel: Locator;
  review: Locator;
  state: Locator;
  text: Locator;
}

async function openMealLog(page: Page): Promise<MealLogParts> {
  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  await expect(mealLog.locator('[data-meal-list-state]')).toHaveAttribute('data-meal-list-state', 'ready');
  const panel = mealLog.getByRole('region', { name: 'Draft from text (optional)' });
  return {
    form: mealLog.locator('form.meal-form'),
    mealLog,
    panel,
    review: panel.getByRole('region', { name: 'Proposed draft (not saved)' }),
    state: panel.locator('[data-meal-draft-state]'),
    text: panel.getByLabel('Describe one meal in your own words (English or Russian)'),
  };
}

const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('Draft from text: a proposal with its evidence, applied to the form, edited, and saved once as a manual entry', async ({ demoScenario, environment, page }) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 600_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  const { form, mealLog, panel, review, text } = await openMealLog(page);

  let proposals = 0;
  let creates = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/meals/draft-proposals')) proposals += 1;
    else if (/\/meals$/u.test(request.url())) creates += 1;
  });

  await text.fill('Dinner: chicken and rice, total 650 kcal, protein 40 g');
  // A double click asks once.
  await panel.getByRole('button', { name: 'Propose draft' }).dblclick();
  await expect(review).toBeVisible();
  expect(proposals).toBe(1);

  // The proposal and its evidence are shown before anything happens to the form.
  await expect(review).toContainText('chicken and rice');
  await expect(review).toContainText('From your text: “Dinner”');
  await expect(review.locator('[data-draft-field="energyKcal"]')).toContainText('650 kcal');
  await expect(review.locator('[data-draft-field="energyKcal"]')).toContainText('From your text: “650 kcal”');
  await expect(review.locator('[data-draft-field="proteinG"]')).toContainText('From your text: “protein 40 g”');
  await expect(review.locator('[data-draft-field="carbohydrateG"]')).toContainText('Not in your text; it stays empty (unknown).');
  await expect(form.getByLabel('Title')).toHaveValue('');
  expect(await readMeals(environment, demoScenario.orgId)).toEqual([]);

  // Applying only fills the editable form; nothing is saved.
  await review.getByRole('button', { name: 'Apply to form' }).click();
  await expect(review).toHaveCount(0);
  await expect(form.getByLabel('Title')).toHaveValue('chicken and rice');
  await expect(form.getByLabel('Meal type')).toHaveValue('dinner');
  await expect(form.getByLabel('Food energy (kcal)')).toHaveValue('650');
  await expect(form.getByLabel('Protein (g)')).toHaveValue('40');
  await expect(form.getByLabel('Carbohydrate (g)')).toHaveValue('');
  await expect(form.getByLabel('Fat (g)')).toHaveValue('');
  await expect(form.getByText('Filled in from your text and not saved yet.')).toBeVisible();
  await expect(form.getByText('Manually entered', { exact: true })).toBeVisible();
  expect(await readMeals(environment, demoScenario.orgId)).toEqual([]);

  // The person edits, then saves with the existing form; a double click sends one create.
  await form.getByLabel('Title').fill('Chicken and rice');
  await form.getByLabel('Fat (g)').fill('12');
  await form.getByRole('button', { name: 'Add entry' }).dblclick();
  await expect(form.getByText('Entry saved.')).toBeVisible();
  expect(creates).toBe(1);
  await expect(form.getByText('Filled in from your text and not saved yet.')).toHaveCount(0);
  const card = mealLog.locator('.run-cards > li').filter({ hasText: 'Chicken and rice' });
  await expect(card.getByText('Manually entered')).toBeVisible();
  expect(await readMeals(environment, demoScenario.orgId)).toEqual([
    { energy_kcal: '650', fat_g: '12', meal_type: 'dinner', protein_g: '40', source: 'manual', title: 'Chicken and rice' },
  ]);
});

test('Draft from text: withholds per-serving values, never replaces unsaved details silently, and drops a proposal after the date changes', async ({
  demoScenario,
  environment,
  page,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 600_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  const { form, mealLog, panel, review, state, text } = await openMealLog(page);

  await form.getByLabel('Title').fill('My own note');
  await text.fill('Lunch: lentil soup, 300 kcal per serving; fat 0 g in total');
  await panel.getByRole('button', { name: 'Propose draft' }).click();
  await expect(review).toBeVisible();
  await expect(review.locator('[data-draft-field="energyKcal"]')).toHaveAttribute('data-draft-status', 'withheld');
  await expect(review.locator('[data-draft-field="energyKcal"]')).toContainText('per 100 g, per serving or per piece');
  // A written zero, stated as a total in its own sentence, is a value (the per-serving qualifier does not reach it).
  await expect(review.locator('[data-draft-field="fatG"]')).toContainText('0 g');
  expect(await fitsWidth(page)).toBe(true);

  // Unsaved details are not replaced without a second, explicit choice.
  await review.getByRole('button', { name: 'Apply to form' }).click();
  await expect(review.getByRole('alert')).toContainText('The form already has details you have not saved.');
  await review.getByRole('button', { name: 'Keep my details' }).click();
  await expect(form.getByLabel('Title')).toHaveValue('My own note');
  await review.getByRole('button', { name: 'Apply to form' }).click();
  await review.getByRole('button', { name: 'Replace form details' }).click();
  await expect(form.getByLabel('Title')).toHaveValue('lentil soup');
  await expect(form.getByLabel('Meal type')).toHaveValue('lunch');
  await expect(form.getByLabel('Food energy (kcal)')).toHaveValue('');
  await expect(form.getByLabel('Fat (g)')).toHaveValue('0');

  // A proposal held by the network while the date changes is never shown or applied on the new date.
  let release: () => void = () => undefined;
  await page.route(DRAFTS, async (route) => {
    await new Promise<void>((resolve) => (release = resolve));
    await route.continue().catch(() => undefined);
  });
  await text.fill('Snack: apple, 95 kcal');
  await panel.getByRole('button', { name: 'Propose draft' }).click();
  await expect(state).toHaveAttribute('data-meal-draft-state', 'proposing');
  await mealLog.getByLabel('Date').fill(daysBefore(today, 1));
  await expect(state).toHaveAttribute('data-meal-draft-state', 'idle');
  release();
  await page.unroute(DRAFTS);
  // Asking again on the new date shows only the new answer; the form still holds what was applied before.
  await text.fill('Snack: pear, 60 kcal');
  await panel.getByRole('button', { name: 'Propose draft' }).click();
  await expect(review).toContainText('pear');
  await expect(review).not.toContainText('apple');
  await expect(form.getByLabel('Title')).toHaveValue('lentil soup');
  expect(await readMeals(environment, demoScenario.orgId)).toEqual([]);
});

test('Draft from text: a proposal pending at sign-out never reaches the next session', async ({ demoScenario, environment, page }) => {
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  let parts = await openMealLog(page);
  let release: () => void = () => undefined;
  await page.route(DRAFTS, async (route) => {
    await new Promise<void>((resolve) => (release = resolve));
    await route.continue().catch(() => undefined);
  });
  await parts.text.fill('Breakfast: porridge, 350 kcal');
  await parts.panel.getByRole('button', { name: 'Propose draft' }).click();
  await expect(parts.state).toHaveAttribute('data-meal-draft-state', 'proposing');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  release();
  await page.unroute(DRAFTS);

  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  parts = await openMealLog(page);
  await expect(parts.state).toHaveAttribute('data-meal-draft-state', 'idle');
  await expect(parts.text).toHaveValue('');
  await expect(parts.review).toHaveCount(0);
  await expect(parts.form.getByLabel('Title')).toHaveValue('');
  expect(await readMeals(environment, demoScenario.orgId)).toEqual([]);
});

test('Draft from text is off on a server that does not enable it; the manual form works as always', async ({ demoScenario, environment, page }) => {
  await signIn(page, environment.reviewWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  const { form, panel, text } = await openMealLog(page);
  await text.fill('Dinner: soup, 300 kcal');
  await panel.getByRole('button', { name: 'Propose draft' }).click();
  await expect(panel.getByRole('status')).toHaveText('Drafting from text is not turned on for this server. The form below works as always.');
  await expect(panel.getByRole('textbox')).toHaveCount(0);

  await form.getByLabel('Title').fill('Soup');
  await form.getByLabel('Food energy (kcal)').fill('300');
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByText('Entry saved.')).toBeVisible();
  expect(await readMeals(environment, demoScenario.orgId)).toEqual([
    { energy_kcal: '300', fat_g: null, meal_type: 'lunch', protein_g: null, source: 'manual', title: 'Soup' },
  ]);
});
