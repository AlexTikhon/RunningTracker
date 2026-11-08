import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// Today (ADR-0082): a read-only overview of one day. The demo runner saves a check-in and movement through the existing
// editors opened from Today, inspects Today, edits and deletes values, returns to the same date and sees the updated and
// missing values. The demo people and their organization are created in the _test database by the demoScenario fixture,
// whose cleanup removes the organization's check-ins, movement and activities with it.

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

async function openToday(page: Page): Promise<void> {
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
}

async function signInDemoRunner(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

test('Today: saves through the existing editors, shows the day, keeps the date, and reflects edits and deletions', async ({ demoScenario, environment, page }) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 300_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const yesterday = daysBefore(today, 1);

  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);

  // Branding, and Today first in the navigation while Runner stays the start view.
  await expect(page).toHaveTitle('SomaLane');
  await expect(page.getByLabel('SomaLane', { exact: true })).toContainText('SomaLane');
  await expect(navigation(page).getByRole('button').first()).toHaveText('Today');
  await expect(navigation(page).getByRole('button', { name: 'Runner' })).toHaveAttribute('aria-current', 'page');

  await openToday(page);
  const screen = page.getByRole('region', { exact: true, name: 'Today' });
  const body = screen.locator('[data-overview-state]');
  const checkInCard = screen.getByRole('region', { exact: true, name: 'Check-in' });
  const movementCard = screen.getByRole('region', { exact: true, name: 'Steps and active energy' });
  await expect(screen.getByLabel('Date')).toHaveValue(today);
  await expect(screen.getByLabel('Date')).toHaveAttribute('max', today);
  await expect(screen.getByText(/ \(today\) in the time zone Europe\/Warsaw\.$/u)).toBeVisible();
  await expect(body).toHaveAttribute('data-overview-state', 'ready');
  await expect(screen.getByText(/^Nothing is recorded for .+ yet\.$/u)).toBeVisible();

  // Add a check-in for today through the existing editor, opened on today's date.
  await checkInCard.getByRole('button', { name: /^Add check-in for / }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check-in' })).toBeFocused();
  const checkInForm = page.getByRole('form', { name: 'Daily check-in' });
  await expect(checkInForm.getByLabel('Date')).toHaveValue(today);
  await checkInForm.getByLabel('Hours').fill('7');
  await checkInForm.getByLabel('Minutes').fill('30');
  await checkInForm.getByLabel('Mood (optional)').selectOption('4');
  await checkInForm.getByLabel('Note (optional)').fill('PRIVATE-NOTE-TEXT');
  await checkInForm.getByRole('button', { name: 'Save check-in' }).click();
  await expect(checkInForm.getByText('Check-in saved.')).toBeVisible();

  // Back on Today: read again, values shown, the note only mentioned.
  await openToday(page);
  await expect(checkInCard.getByText('7 h 30 min')).toBeVisible();
  await expect(checkInCard.getByText('4 of 5')).toBeVisible();
  await expect(checkInCard.getByText('Not recorded')).toHaveCount(3);
  await expect(checkInCard.getByText(/A note is saved with this check-in/u)).toBeVisible();
  await expect(screen).not.toContainText('PRIVATE-NOTE-TEXT');
  await expect(movementCard.getByText('No movement recorded for this day.')).toBeVisible();

  // An earlier date: empty; add movement for it through the existing movement editor, opened on that date.
  await screen.getByLabel('Date').fill(yesterday);
  await expect(screen.getByText(/^Nothing is recorded for .+ yet\.$/u)).toBeVisible();
  await movementCard.getByRole('button', { name: /^Add movement for / }).click();
  const movementForm = page.getByRole('form', { name: 'Daily movement' });
  await expect(page.getByRole('heading', { level: 2, name: 'Movement' })).toBeFocused();
  await expect(movementForm.getByLabel('Date')).toHaveValue(yesterday);
  await expect(checkInForm.getByLabel('Date')).toHaveValue(today);
  await movementForm.getByLabel('Steps (optional)').fill('0');
  await movementForm.getByLabel('Active energy (kcal)').fill('412.5');
  await movementForm.getByRole('button', { name: 'Save movement' }).click();
  await expect(movementForm.getByText('Movement saved.')).toBeVisible();

  // Today reopens on the same (kept) date with the recorded zero and the energy, labelled as manually entered.
  await openToday(page);
  await expect(screen.getByLabel('Date')).toHaveValue(yesterday);
  await expect(movementCard.getByText('0 steps')).toBeVisible();
  await expect(movementCard.getByText('412.5 kcal')).toBeVisible();
  await expect(movementCard.getByText('Manually entered')).toBeVisible();
  await expect(checkInCard.getByText('No check-in for this day.')).toBeVisible();
  await expect(screen.getByText(/^Nothing is recorded/u)).toHaveCount(0);

  // Edit the movement: steps recorded, energy emptied.
  await movementCard.getByRole('button', { name: /^Edit movement for / }).click();
  await expect(movementForm.getByLabel('Date')).toHaveValue(yesterday);
  await expect(movementForm.getByLabel('Steps (optional)')).toHaveValue('0');
  await movementForm.getByLabel('Steps (optional)').fill('8042');
  await movementForm.getByLabel('Active energy (kcal)').fill('');
  await movementForm.getByRole('button', { name: 'Save movement' }).click();
  await expect(movementForm.getByText('Movement updated.')).toBeVisible();
  await openToday(page);
  await expect(screen.getByLabel('Date')).toHaveValue(yesterday);
  await expect(movementCard.getByText('8,042 steps')).toBeVisible();
  await expect(movementCard.getByText('Not recorded')).toBeVisible();

  // Delete it: Today shows the date as empty again.
  await movementCard.getByRole('button', { name: /^Edit movement for / }).click();
  await movementForm.getByRole('button', { name: /^Delete the movement of / }).click();
  await movementForm.getByRole('region', { name: /^Delete the movement of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(movementForm.getByText('Movement deleted.')).toBeVisible();
  await openToday(page);
  await expect(screen.getByLabel('Date')).toHaveValue(yesterday);
  await expect(screen.getByText(/^Nothing is recorded for .+ yet\.$/u)).toBeVisible();

  // Back to today; edit the check-in (mood cleared, soreness 0) and then delete it.
  await screen.getByRole('button', { name: 'Go to today' }).click();
  await expect(screen.getByLabel('Date')).toHaveValue(today);
  await expect(checkInCard.getByText('4 of 5')).toBeVisible();
  await checkInCard.getByRole('button', { name: /^Edit check-in for / }).click();
  await expect(checkInForm.getByLabel('Date')).toHaveValue(today);
  await expect(checkInForm.getByLabel('Mood (optional)')).toHaveValue('4');
  await checkInForm.getByLabel('Mood (optional)').selectOption('');
  await checkInForm.getByLabel('Soreness (optional)').selectOption('0');
  await checkInForm.getByRole('button', { name: 'Save check-in' }).click();
  await expect(checkInForm.getByText('Check-in updated.')).toBeVisible();
  await openToday(page);
  await expect(checkInCard.getByText('0 of 10')).toBeVisible();
  await expect(checkInCard.getByText('Not recorded')).toHaveCount(3);
  await checkInCard.getByRole('button', { name: /^Edit check-in for / }).click();
  await checkInForm.getByRole('button', { name: /^Delete the check-in of / }).click();
  await checkInForm.getByRole('region', { name: /^Delete the check-in of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(checkInForm.getByText(/^Nothing recorded for .+ yet\.$/u)).toBeVisible();
  await openToday(page);
  await expect(screen.getByLabel('Date')).toHaveValue(today);
  await expect(screen.getByText(/^Nothing is recorded for .+ yet\.$/u)).toBeVisible();

  // The other actions open the existing views; an ordinary navigation button keeps Today's date.
  await screen.getByLabel('Date').fill(yesterday);
  await expect(body).toHaveAttribute('data-overview-state', 'ready');
  await screen.getByRole('button', { name: 'Open Activities' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
  await openToday(page);
  await expect(screen.getByLabel('Date')).toHaveValue(yesterday);
  await screen.getByRole('button', { name: 'Open Runner' }).click();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
  // The Check-in navigation button opens the editors on today, not on Today's date.
  await navigation(page).getByRole('button', { name: 'Check-in' }).click();
  await expect(checkInForm.getByLabel('Date')).toHaveValue(today);
  await expect(movementForm.getByLabel('Date')).toHaveValue(today);

  // Signing out forgets the kept date.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openToday(page);
  await expect(screen.getByLabel('Date')).toHaveValue(today);
});

test('Today at 375 px: usable without horizontal scrolling, and a late answer for an abandoned date is never shown', async ({ demoScenario, environment, page }) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 300_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const abandoned = daysBefore(today, 1);
  const chosen = daysBefore(today, 2);

  await page.setViewportSize({ width: 375, height: 812 });
  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  // Linux CI fonts are wider than Windows ones: measure with a wide font.
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  await openToday(page);
  const screen = page.getByRole('region', { exact: true, name: 'Today' });
  const body = screen.locator('[data-overview-state]');
  await expect(body).toHaveAttribute('data-overview-state', 'ready');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ['Check-in', 'Steps and active energy', 'Manual activities', 'GPS runs']) {
    await expect(screen.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  for (const name of ['Refresh', 'Go to today', 'Open Activities', 'Open Runner']) {
    const box = await screen.getByRole('button', { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 375, name).toBe(true);
  }

  // Hold the answer for one date, choose another, then let the first answer through: the chosen date stays.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldSeen = false;
  await page.route(`**/daily-overview/${abandoned}?*`, async (route) => {
    heldSeen = true;
    await held;
    await route.continue().catch(() => undefined); // the page has aborted it by now
  });
  await screen.getByLabel('Date').fill(abandoned);
  await expect(body).toHaveAttribute('data-overview-state', 'loading');
  await expect.poll(() => heldSeen).toBe(true);
  await screen.getByLabel('Date').fill(chosen);
  await expect(body).toHaveAttribute('data-overview-state', 'ready');
  release();
  await page.waitForTimeout(500); // give a late answer every chance to be (wrongly) applied
  await expect(screen.getByLabel('Date')).toHaveValue(chosen);
  await expect(body).toHaveAttribute('data-overview-state', 'ready');
  const shown = await screen.locator('.today-day strong').textContent();
  expect(shown).toBe(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC', weekday: 'short', year: 'numeric' }).format(new Date(`${chosen}T12:00:00Z`)));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Today while recording: capture, upload and the writer continue, and the finished run appears', async ({ context, environment, page, scenario }) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 300_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  await signIn(context, environment, scenario.runnerUserId);
  const api = await authedApi(context, environment);
  const runner = new RunnerPage(page);

  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Writer').value).toHaveText('owned');
  const runId = await runner.runId(api, scenario.orgId);

  // Switch to Today at once and stay there while the simulator records and the uploader sends every point.
  await openToday(page);
  // The simulator's six points are paced over about ten seconds, so most of them are captured and uploaded while Today
  // is the visible view.
  const uploadedWhenTodayOpened = (await api.getAllPoints(scenario.orgId, runId)).length;
  expect(uploadedWhenTodayOpened).toBeLessThan(6);
  const screen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(screen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await expect.poll(async () => (await api.getAllPoints(scenario.orgId, runId)).length, { timeout: 45_000 }).toBe(6);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();

  // Back on Runner: the same run, still recording, writer still owned, nothing left in the buffer.
  await navigation(page).getByRole('button', { name: 'Runner' }).click();
  await expect(runner.card('Recording').value).toHaveText('recording');
  await expect(runner.card('Writer').value).toHaveText('owned');
  await runner.waitForCaptureComplete();
  await runner.waitForEmptyBuffer();
  expect(await runner.runId(api, scenario.orgId)).toBe(runId);
  await runner.finish();
  await expect(runner.card('Recording').value).toHaveText('finished');
  const points = await api.getAllPoints(scenario.orgId, runId);
  const seqs = points.map((point) => BigInt(point.seq)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  expect(seqs).toEqual(Array.from({ length: 6 }, (_, index) => (seqs[0] ?? 0n) + BigInt(index)));

  // Today now counts the person's finished GPS run for the day it started.
  await openToday(page);
  const gps = screen.getByRole('region', { exact: true, name: 'GPS runs' });
  await expect(gps.getByText('1 finished GPS run started on this day.')).toBeVisible();
});
