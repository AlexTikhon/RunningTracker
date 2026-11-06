import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// The Activity tab (ADR-0072): the demo runner logs a manual activity, sees it in the list, and deletes it. The
// demo people and their organization are created in the _test database by the demoScenario fixture, and the
// fixture's cleanup removes the organization's activities with it.

// A fixed browser zone and locale make the displayed date the same on every machine.
test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });

// 07:30 on 5 October in Warsaw is 05:30 UTC (summer time).
const label = '5 Oct 2026, 07:30';

async function openActivity(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
}

test('the demo runner adds an activity, sees it in the list after a reload, and deletes it', async ({
  demoScenario,
  environment,
  page,
}) => {
  const mutations: Array<{ body: string | null; method: string; path: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/activities') && request.method() !== 'GET') {
      mutations.push({ body: request.postData(), method: request.method(), path: url.pathname });
    }
  });

  await page.goto(environment.demoWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);

  await openActivity(page);
  const list = page.getByRole('region', { name: 'Your activities' });
  await expect(list.getByText('No activities yet.')).toBeVisible();

  const form = page.getByRole('form', { name: 'Add an activity' });
  await form.getByLabel('Type').selectOption('ride');
  await form.getByLabel('Started').fill('2026-10-05T07:30');
  await form.getByLabel('Hours').fill('1');
  await form.getByLabel('Minutes').fill('15');
  await form.getByLabel('Distance (optional)').fill('32.5');
  await form.getByLabel('Effort (RPE, optional)').selectOption('6');
  await form.getByLabel('Notes (optional)').fill('Hilly loop');
  await form.getByRole('button', { name: 'Save activity' }).click();

  await expect(form.getByRole('status')).toHaveText('Activity saved.');
  const cards = list.getByRole('list', { name: 'Your activities' }).locator(':scope > li');
  await expect(cards).toHaveCount(1);
  for (const text of ['Ride', label, '1:15:00', '32.50 km', '6/10', 'Hilly loop']) {
    await expect(cards.first()).toContainText(text);
  }

  // Exactly one PUT, to a client-generated id, carrying the form session's idempotency key (ADR-0073) and no owner,
  // organization or source.
  expect(mutations).toHaveLength(1);
  const [put] = mutations;
  expect(put?.method).toBe('PUT');
  expect(put?.path).toMatch(new RegExp(`^/api/orgs/${demoScenario.orgId}/activities/[0-9a-f-]{36}$`, 'u'));
  const { idempotencyKey, ...sent } = JSON.parse(put?.body ?? '{}') as Record<string, unknown>;
  expect(idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(put?.path.endsWith(String(idempotencyKey))).toBe(false);
  expect(sent).toEqual({
    distanceM: 32_500,
    durationS: 4_500,
    notes: 'Hilly loop',
    rpe: 6,
    startedAt: '2026-10-05T05:30:00.000Z',
    type: 'ride',
  });

  // Stored on the server, not only shown.
  await page.reload();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openActivity(page);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(label);

  await list.getByRole('button', { exact: true, name: `Delete your ride of ${label}` }).click();
  const confirmation = list.getByRole('region', { name: `Delete your ride of ${label}?` });
  await expect(confirmation).toContainText('This cannot be undone.');
  await confirmation.getByRole('button', { name: 'Confirm delete' }).click();

  await expect(list.getByRole('status')).toHaveText(`Your ride of ${label} was deleted.`);
  await expect(list.getByText('No activities yet.')).toBeVisible();
  expect(mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toEqual([
    `PUT ${put?.path}`,
    `DELETE ${put?.path}`,
  ]);

  await page.reload();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openActivity(page);
  await expect(list.getByText('No activities yet.')).toBeVisible();
});
