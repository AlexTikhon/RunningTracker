import type { Locator, Page, Request } from '@playwright/test';

import { signIn } from './support/api.js';
import { createFinishedRuns } from './support/database.js';
import type { FinishedRunSeed } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectSignedIn, organizationRegion } from './support/session.js';

// Describing a search in words, against the real API with the deterministic in-process interpreter
// (RUN_SEARCH_AI_PROVIDER=fake in playwright.config.ts): no network, no provider. What the real model does with
// text is not judged here; it is what the opt-in live evaluation is for (docs/runbooks/run-search-ai.md).
test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });

const day = (dayOfMonth: number, hour = 6) =>
  `2026-03-${String(dayOfMonth).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

// 27 runs of at least 5 km (two pages of 20 and 7), the longest 21.10 km, and three that are shorter or unsummarized.
function runnersMarch(userId: string): FinishedRunSeed[] {
  const bulk = Array.from({ length: 22 }, (_, index) => ({
    distanceM: 6_000 + index * 100,
    startedAt: day(3 + index),
    userId,
  }));
  return [
    ...bulk,
    { distanceM: 5_000, startedAt: day(1, 6), userId },
    { distanceM: 5_000, startedAt: day(1, 7), userId },
    { distanceM: 10_000, startedAt: day(2, 6), userId },
    { distanceM: 12_000, startedAt: day(2, 7), userId },
    { distanceM: 3_000, startedAt: day(26, 6), userId },
    { distanceM: 4_999.96, startedAt: day(27, 6), userId },
    { distanceM: 21_097.5, startedAt: day(28, 6), quality: 'insufficient', userId },
    { distanceM: null, startedAt: day(29, 6), userId },
  ];
}

const MARCH = 'from 2026-03-01 to 2026-03-31';

function panelOf(page: Page): Locator {
  return page.getByRole('region', { name: 'My runs' });
}

function cardsOf(page: Page): Locator {
  return panelOf(page).getByRole('list', { name: 'My runs' }).getByRole('listitem');
}

function describeBox(page: Page): Locator {
  return panelOf(page).getByRole('textbox', { name: /Describe the runs you want/u });
}

async function openArchive(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('heading', { name: 'My runs' })).toBeVisible();
}

function watch(page: Page) {
  const searches: URL[] = [];
  const interpretations: Request[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/runs/search/interpretations')) {
      interpretations.push(request);
    } else if (url.includes('/runs/search')) {
      searches.push(new URL(url));
    }
  });
  return { interpretations, searches };
}

async function openMyRuns(
  page: Page,
  context: Parameters<typeof signIn>[0],
  environment: Parameters<typeof signIn>[1],
  userId: string,
  // The picker exists only for a person with more than one organization; with one, it is selected already.
  pickOrganization: string | null,
): Promise<void> {
  await signIn(context, environment, userId);
  await page.goto('/');
  await expectSignedIn(page);
  if (pickOrganization !== null) {
    await organizationRegion(page)
      .getByRole('combobox', { name: 'Organization' })
      .selectOption(pickOrganization);
  }
  await openArchive(page);
}

test.describe('describing a search in words', () => {
  test('proposes filters, leaves results alone until applied, then searches through the existing endpoint', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await createFinishedRuns(environment, scenario.orgId, runnersMarch(scenario.runnerUserId));
    const seen = watch(page);
    await openMyRuns(page, context, environment, scenario.runnerUserId, null);

    const panel = panelOf(page);
    const applied = panel.getByRole('region', { name: 'Applied filters' });
    await expect(panel.getByText('No finished runs of yours match these filters.')).toBeVisible();
    // The disclosure is on the screen before anything is sent.
    await expect(panel.getByText(/The text you enter here is sent to OpenAI/u)).toBeVisible();
    await page.waitForTimeout(300);
    const searchesBefore = seen.searches.length;
    expect(seen.interpretations).toHaveLength(0);

    await describeBox(page).fill(`Show my runs of at least 5 km ${MARCH}, longest first.`);
    // Typing is not sending.
    expect(seen.interpretations).toHaveLength(0);
    await panel.getByRole('button', { name: 'Interpret' }).click();

    // One request carries the text and the zone, nothing else; the editable form is replaced as a whole.
    await expect(panel.getByText(/Filters filled in from your text/u)).toBeVisible();
    expect(seen.interpretations).toHaveLength(1);
    expect(seen.interpretations[0]!.postDataJSON()).toEqual({
      text: `Show my runs of at least 5 km ${MARCH}, longest first.`,
      timeZone: 'Europe/Warsaw',
    });
    await expect(panel.getByLabel('Period')).toHaveValue('dates');
    await expect(panel.getByLabel('From', { exact: true })).toHaveValue('2026-03-01');
    await expect(panel.getByLabel('To (included)')).toHaveValue('2026-03-31');
    await expect(panel.getByLabel('Minimum distance')).toHaveValue('5');
    await expect(panel.getByLabel('Maximum distance')).toHaveValue('');
    await expect(panel.getByLabel('Units')).toHaveValue('km');
    await expect(panel.getByLabel('Sort')).toHaveValue('longest');

    // Nothing was searched: the applied filters and the shown results are still the earlier ones.
    expect(seen.searches).toHaveLength(searchesBefore);
    await expect(applied).toContainText('This month');
    await expect(applied).not.toContainText('Longest first');
    await expect(cardsOf(page)).toHaveCount(0);
    await expect(panel.getByText('No finished runs of yours match these filters.')).toBeVisible();
    await expect(panel.getByText('Changes are not applied yet.')).toBeVisible();

    // The person applies it through the ordinary button.
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(cardsOf(page)).toHaveCount(20);
    await expect(applied).toContainText('1 Mar 2026 – 31 Mar 2026');
    await expect(applied).toContainText('at least 5 km');
    await expect(applied).toContainText('Longest first');
    await expect(cardsOf(page).first()).toContainText('21.10 km');
    expect(seen.interpretations).toHaveLength(1);
    // Applying cleared the notice: the proposal is spent.
    await expect(panel.getByText(/Filters filled in from your text/u)).toHaveCount(0);
  });

  test('reviews and edits a proposal before applying it', async ({ context, environment, page, scenario }) => {
    await createFinishedRuns(environment, scenario.orgId, runnersMarch(scenario.runnerUserId));
    const seen = watch(page);
    await openMyRuns(page, context, environment, scenario.runnerUserId, null);
    const panel = panelOf(page);

    await describeBox(page).fill(`runs of at least 5 km ${MARCH}`);
    await panel.getByRole('button', { name: 'Interpret' }).click();
    await expect(panel.getByText(/Filters filled in from your text/u)).toBeVisible();

    // Editing by hand makes the proposal the person's own: the notice goes and the edit is kept.
    await panel.getByLabel('Maximum distance').fill('8');
    await expect(panel.getByText(/Filters filled in from your text/u)).toHaveCount(0);
    await expect(panel.getByLabel('Minimum distance')).toHaveValue('5');
    const searchesBefore = seen.searches.length;
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(panel.getByRole('region', { name: 'Applied filters' })).toContainText('5–8 km');
    await expect(cardsOf(page)).toHaveCount(20);
    expect(seen.searches.length).toBeGreaterThan(searchesBefore);
  });

  test('explains an unclear request in fixed words and keeps the manual filters working', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await createFinishedRuns(environment, scenario.orgId, runnersMarch(scenario.runnerUserId));
    const seen = watch(page);
    await openMyRuns(page, context, environment, scenario.runnerUserId, null);
    const panel = panelOf(page);
    await expect(panel.getByText('No finished runs of yours match these filters.')).toBeVisible();
    await page.waitForTimeout(300);
    const searchesBefore = seen.searches.length;

    await describeBox(page).fill(`runs of more than 5 km ${MARCH}`);
    await panel.getByRole('button', { name: 'Interpret' }).click();

    // A strict bound is not turned into an inclusive one: the person is told what to say instead.
    await expect(panel.getByText(/Distance limits here include the number you give/u)).toBeVisible();
    await expect(panel.getByText(/Say "at least 5 km" or "at most 10 km" instead/u)).toBeVisible();
    // The form was not touched and nothing was searched.
    await expect(panel.getByLabel('Period')).toHaveValue('this-month');
    await expect(panel.getByLabel('Minimum distance')).toHaveValue('');
    expect(seen.searches).toHaveLength(searchesBefore);

    // Missing period, and something the search cannot do, each in its own fixed wording.
    await describeBox(page).fill('runs of at least 5 km');
    await panel.getByRole('button', { name: 'Interpret' }).click();
    await expect(panel.getByText(/Your text does not say when/u)).toBeVisible();
    await describeBox(page).fill(`runs in Berlin ${MARCH}`);
    await panel.getByRole('button', { name: 'Interpret' }).click();
    await expect(panel.getByText(/cannot filter by place or route/u)).toBeVisible();

    // The manual filters are untouched by all of it.
    await panel.getByLabel('Period').selectOption('dates');
    await panel.getByLabel('From', { exact: true }).fill('2026-03-01');
    await panel.getByLabel('To (included)').fill('2026-03-31');
    await panel.getByLabel('Minimum distance').fill('10');
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(cardsOf(page).first()).toBeVisible();
    await expect(panel.getByRole('region', { name: 'Applied filters' })).toContainText('at least 10 km');
  });

  test('shows a provider failure and keeps the manual filters fully working', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await createFinishedRuns(environment, scenario.orgId, runnersMarch(scenario.runnerUserId));
    const seen = watch(page);
    await openMyRuns(page, context, environment, scenario.runnerUserId, null);
    const panel = panelOf(page);

    await describeBox(page).fill(`runs ${MARCH} [fail]`);
    await panel.getByRole('button', { name: 'Interpret' }).click();

    const alert = panel.getByRole('alert').filter({ hasText: 'could not be turned into filters' });
    await expect(alert).toBeVisible();
    // One click was one request: no automatic retry, however long we wait.
    await page.waitForTimeout(600);
    expect(seen.interpretations).toHaveLength(1);
    // The form was not changed by the failure.
    await expect(panel.getByLabel('Period')).toHaveValue('this-month');

    await panel.getByLabel('Period').selectOption('dates');
    await panel.getByLabel('From', { exact: true }).fill('2026-03-01');
    await panel.getByLabel('To (included)').fill('2026-03-31');
    await panel.getByLabel('Minimum distance').fill('5');
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(cardsOf(page)).toHaveCount(20);
    expect(seen.interpretations).toHaveLength(1);
  });

  test('treats a server without the feature as information, not as a broken page', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await createFinishedRuns(environment, scenario.orgId, runnersMarch(scenario.runnerUserId));
    await page.route('**/runs/search/interpretations', async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: 'INTERPRETATION_DISABLED',
            message: 'Natural-language search is not enabled on this server',
            requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          },
        }),
        contentType: 'application/json',
        status: 503,
      });
    });
    await openMyRuns(page, context, environment, scenario.runnerUserId, null);
    const panel = panelOf(page);

    await describeBox(page).fill(`runs ${MARCH}`);
    await panel.getByRole('button', { name: 'Interpret' }).click();
    await expect(panel.getByText(/not turned on for this server/u)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Interpret' })).toBeDisabled();

    await panel.getByLabel('Period').selectOption('dates');
    await panel.getByLabel('From', { exact: true }).fill('2026-03-01');
    await panel.getByLabel('To (included)').fill('2026-03-31');
    await panel.getByRole('button', { name: 'Apply filters' }).click();
    await expect(cardsOf(page)).toHaveCount(20);
  });

  test('drops a delayed answer that arrives after a manual edit, and one that arrives in another organization', async ({
    context,
    environment,
    organizations,
    page,
    scenario,
  }) => {
    const second = await organizations.memberOf(scenario.runnerUserId);
    await createFinishedRuns(environment, scenario.orgId, runnersMarch(scenario.runnerUserId));
    const seen = watch(page);
    await openMyRuns(page, context, environment, scenario.runnerUserId, scenario.orgId);
    const panel = panelOf(page);
    const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });

    // 1. The person edits the draft by hand while the interpreter is still working.
    await describeBox(page).fill(`runs of at least 7 km ${MARCH} [delay=2500]`);
    await panel.getByRole('button', { name: 'Interpret' }).click();
    await expect(panel.getByText('Interpreting your text…')).toBeVisible();
    await panel.getByLabel('Maximum distance').fill('9');
    // The edit made the pending interpretation obsolete at once.
    await expect(panel.getByText('Interpreting your text…')).toHaveCount(0);
    await page.waitForTimeout(3_200);
    await expect(panel.getByLabel('Maximum distance')).toHaveValue('9');
    await expect(panel.getByLabel('Minimum distance')).toHaveValue('');
    await expect(panel.getByLabel('Period')).toHaveValue('this-month');
    await expect(panel.getByText(/Filters filled in from your text/u)).toHaveCount(0);

    // 2. A new interpretation is held back, and the organization is changed while it is outstanding.
    await describeBox(page).fill(`runs of at least 7 km ${MARCH} [delay=2500]`);
    await panel.getByRole('button', { name: 'Interpret' }).click();
    await expect(panel.getByText('Interpreting your text…')).toBeVisible();
    await picker.selectOption(second);
    await expect(page.getByRole('heading', { name: 'My runs' })).toBeVisible();
    await expect(describeBox(page)).toHaveValue('');
    await expect(panelOf(page).getByLabel('Minimum distance')).toHaveValue('');

    await page.waitForTimeout(3_200);
    // The late answer for the first organization changed nothing in the second.
    await expect(panelOf(page).getByLabel('Minimum distance')).toHaveValue('');
    await expect(panelOf(page).getByLabel('Period')).toHaveValue('this-month');
    await expect(panelOf(page).getByText(/Filters filled in from your text/u)).toHaveCount(0);
    await expect(panelOf(page).getByText('Interpreting your text…')).toHaveCount(0);
    expect(seen.interpretations).toHaveLength(2);
  });
});
