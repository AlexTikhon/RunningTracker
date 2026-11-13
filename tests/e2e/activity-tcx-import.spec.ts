import type { Page } from '@playwright/test';

import { countActivityRows } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// TCX import into the Activity tab (ADR-0091), against the real API and the _test database. The files are synthetic,
// built here without any position: no real person's activity or place. The demoScenario fixture's cleanup removes the
// organization's activities with it.

const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

// Two days ago, on a whole minute, so the start is inside every server bound and its date is stable for the test.
const startMs = Math.floor((Date.now() - 2 * 86_400_000) / 60_000) * 60_000;
const iso = (offsetS: number) => new Date(startMs + offsetS * 1_000).toISOString();

/** Two laps without trackpoints: 1200.25 + 1199.75 = 2400 s reported, 750.5 + 749.5 = 1500 m. */
function syntheticTcx(options: { firstTotal?: string; namespace?: string; offsetS?: number } = {}): Buffer {
  const offset = options.offsetS ?? 0;
  const lap = (start: string, total: string, distance: string) =>
    `<Lap StartTime="${start}"><TotalTimeSeconds>${total}</TotalTimeSeconds><DistanceMeters>${distance}</DistanceMeters><Calories>90</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod></Lap>`;
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="${options.namespace ?? 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2'}"><Activities><Activity Sport="Other"><Id>${iso(offset)}</Id>
${lap(iso(offset), options.firstTotal ?? '1200.25', '750.5')}${lap(iso(offset + 1_230), '1199.75', '749.5')}
<Creator><Name>e2e device</Name></Creator></Activity></Activities></TrainingCenterDatabase>`,
    'utf8',
  );
}

const label = (instantMs: number) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: 'short', timeZone, year: 'numeric' }).format(
    new Date(instantMs),
  );
const localDate = (instantMs: number) => new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone, year: 'numeric' }).format(new Date(instantMs));
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });

async function signIn(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

async function openActivity(page: Page): Promise<void> {
  await navigation(page).getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
}

const importRegion = (page: Page) => page.getByRole('region', { name: 'Import a TCX file' });

async function choose(page: Page, buffer: Buffer, name = 'swim.tcx'): Promise<void> {
  await importRegion(page).getByLabel('TCX file').setInputFiles({ buffer, mimeType: 'application/vnd.garmin.tcx+xml', name });
}

test('previews a TCX file without saving, imports it once with the chosen type, and keeps it apart with its reported duration', async ({
  demoScenario,
  environment,
  page,
}) => {
  const uploads: Array<{ contentType: string | null; method: string; url: string }> = [];
  page.on('request', (request) => {
    if (request.url().includes('/tcx-')) uploads.push({ contentType: request.headers()['content-type'] ?? null, method: request.method(), url: request.url() });
  });
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  await openActivity(page);
  const region = importRegion(page);
  const list = page.getByRole('region', { name: 'Your activity history' });
  await expect(list.getByText('No activities yet.')).toBeVisible();

  // 1. Preview: the server's numbers with the exact lap sums and the rounding; nothing stored.
  await choose(page, syntheticTcx({ firstTotal: '1200.75' }));
  const preview = region.getByRole('form', { name: 'Preview of the TCX file' });
  await expect(preview).toBeVisible();
  for (const text of [`Started${label(startMs)}`, 'Reported duration40:01', 'Distance1.50 km', 'Laps2']) {
    await expect(preview).toContainText(text);
  }
  await expect(preview.getByTestId('tcx-rounding')).toHaveText(
    /^The laps report 2 400\.5 s and 1 500 m in total\. Each total is added exactly and rounded once, to the nearest whole second and metre \(halves up\): 2 401 s and 1 500 m are saved\.$/u,
  );
  await expect(preview).toContainText('It is not elapsed time and not moving time');
  await expect(preview).not.toContainText('Elapsed time');
  await expect(preview).toContainText('not compared with GPX imports, manual entries or GPS runs');
  await expect(preview.getByRole('button', { name: 'Import activity' })).toBeDisabled();
  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 0, manual: 0, runs: 0, tcx: 0 });
  await preview.getByRole('button', { name: 'Cancel' }).click();
  await expect(preview).toHaveCount(0);

  // 2. Confirm with an explicit type. The first answer is lost after the server stored it: the retry repeats the same
  //    attempt and the server answers the stored activity instead of storing a second one.
  await choose(page, syntheticTcx());
  await expect(preview).toContainText('Reported duration40:00');
  let confirmations = 0;
  await page.route('**/api/orgs/*/activities/*/tcx-import*', async (route) => {
    confirmations += 1;
    if (confirmations === 1) {
      await route.fetch();
      return route.abort('connectionfailed');
    }
    return route.continue();
  });
  await preview.getByLabel('Activity type').selectOption('swim');
  await preview.getByRole('button', { name: 'Import activity' }).click();
  await expect(region.getByText(/^The import was not confirmed: .* Importing again is safe and will not create a duplicate\.$/u)).toBeVisible();
  await preview.getByRole('button', { name: 'Import again' }).click();
  await expect(region.getByRole('status')).toHaveText('TCX activity imported.');
  await page.unroute('**/api/orgs/*/activities/*/tcx-import*');
  expect(confirmations).toBe(2);
  const puts = uploads.filter((upload) => upload.method === 'PUT');
  expect(puts).toHaveLength(2);
  expect(puts[1]!.url).toBe(puts[0]!.url);
  expect(puts.every((upload) => upload.contentType === 'application/vnd.garmin.tcx+xml')).toBe(true);
  const query = new URL(puts[0]!.url).searchParams;
  expect([...query.keys()].toSorted()).toEqual(['idempotencyKey', 'type']);
  expect(query.get('type')).toBe('swim');
  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 0, manual: 0, runs: 0, tcx: 1 });

  // 3. Listed as a TCX import with its reported duration, never as GPX, manual or a recorded run.
  const cards = list.getByRole('list', { name: 'Your activity history' }).locator(':scope > li');
  await expect(cards).toHaveCount(1);
  for (const text of ['Swim', label(startMs), 'Reported duration40:00', '1.50 km', 'SourceTCX import']) {
    await expect(cards.first()).toContainText(text);
  }
  await expect(cards.first()).not.toContainText(/Entered manually|GPX import|Elapsed time/u);
  await list.getByLabel('Source').selectOption('tcx');
  await expect(cards).toHaveCount(1);
  await list.getByLabel('Source').selectOption('gpx');
  await expect(list.getByText('Nothing in your history matches these filters.')).toBeVisible();
  await list.getByLabel('Source').selectOption('');

  // 4. The same file again: the preview says it is already imported, and nothing can be confirmed. A re-export with
  //    another lap value spelling is the same activity.
  await choose(page, Buffer.from(syntheticTcx().toString('utf8').replace('>1200.25<', '>+1200.2500<')), 'reexport.tcx');
  await expect(preview).toContainText('You already imported this TCX activity');
  await preview.getByLabel('Activity type').selectOption('other');
  await expect(preview.getByRole('button', { name: 'Import activity' })).toBeDisabled();
  await preview.getByRole('button', { name: 'Cancel' }).click();
  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 0, manual: 0, runs: 0, tcx: 1 });

  // 5. Today shows it in its own card on the date it started; the GPX and manual parts stay empty.
  await navigation(page).getByRole('button', { name: 'Today' }).click();
  const today = page.getByRole('region', { exact: true, name: 'Today' });
  await today.getByLabel('Date').fill(localDate(startMs));
  await expect(today.getByRole('heading', { level: 2, name: 'Imported from TCX' })).toBeVisible();
  await expect(today.getByText('1 activity imported from TCX started on this day, 40 min reported by their laps in total.')).toBeVisible();
  await expect(today.getByRole('heading', { level: 2, name: 'Imported from GPX' })).toHaveCount(0);
  await expect(today.getByText('No manual activity started on this day.')).toBeVisible();

  // 6. Trends: TCX is its own source with the reported duration.
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  await expect(page.locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready');
  const activity = page.getByRole('region', { exact: true, name: 'Trends' }).getByRole('region', { exact: true, name: 'Activity' });
  await activity.getByLabel('Source').selectOption('tcx');
  await activity.getByLabel('Activity type').selectOption('swim');
  const summary = activity.locator('.activity-trends__summary');
  await expect(summary).toContainText('1 import on 1 of 28 days.');
  await expect(summary).toContainText('Reported duration: 40:00 in total, from the 1 import.');
  await expect(activity.getByRole('columnheader', { name: 'Reported duration' })).toBeVisible();
  await expect(activity).toContainText('neither elapsed time nor moving time');
  await activity.getByLabel('Source').selectOption('gpx');
  await expect(summary).toContainText('No GPX imports of type swim');
});

test('explains TCX files it cannot import and stores nothing', async ({ demoScenario, environment, page }) => {
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  await openActivity(page);
  const region = importRegion(page);

  await choose(page, syntheticTcx({ namespace: 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v1' }), 'old.tcx');
  await expect(region.getByRole('alert')).toHaveText(/^This file cannot be imported: The file does not declare the Training Center Database v2 namespace; only TCX v2 is supported\./u);
  await expect(region.getByRole('form', { name: 'Preview of the TCX file' })).toHaveCount(0);
  await region.getByRole('button', { name: 'Choose another file' }).click();

  await choose(page, syntheticTcx({ firstTotal: '-5' }), 'negative.tcx');
  await expect(region.getByRole('alert')).toHaveText(/^This file cannot be imported: lap 1: TotalTimeSeconds is not a non-negative decimal number/u);
  await choose(page, Buffer.from(`<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk/></gpx>`), 'track.gpx');
  await expect(region.getByRole('alert')).toContainText('The file is not a TCX document');
  await choose(page, Buffer.from(`<!DOCTYPE x [<!ENTITY e SYSTEM "http://127.0.0.1:9/x">]>${syntheticTcx().toString('utf8').replace(/^<\?xml[^>]*>\n/u, '')}`), 'entity.tcx');
  await expect(region.getByRole('alert')).toContainText('DTDs are not supported, export a plain TCX file');
  await choose(page, Buffer.alloc(0), 'empty.tcx');
  await expect(region.getByRole('alert')).toHaveText('This file is empty, so it cannot be imported.');

  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 0, manual: 0, runs: 0, tcx: 0 });
});

test('TCX import at 375 px: preview, history card and Today card fit without horizontal scrolling; a late answer after sign-out is dropped', async ({
  demoScenario,
  environment,
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  await openActivity(page);
  const region = importRegion(page);

  // A long exact lap sum still wraps inside the narrow preview.
  await choose(page, syntheticTcx({ firstTotal: '1200.1234567890123456789012345678901234' }));
  const preview = region.getByRole('form', { name: 'Preview of the TCX file' });
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('tcx-rounding')).toContainText('2 399.8734567890123456789012345678901234 s');
  expect(await fits(page)).toBe(true);
  const box = await preview.boundingBox();
  expect(box !== null && box.x >= 0 && box.x + box.width <= 375).toBe(true);
  await preview.getByLabel('Activity type').selectOption('swim');
  await preview.getByRole('button', { name: 'Import activity' }).click();
  await expect(region.getByRole('status')).toHaveText('TCX activity imported.');
  const card = page.getByRole('region', { name: 'Your activity history' }).getByRole('list', { name: 'Your activity history' }).locator(':scope > li').first();
  await expect(card).toContainText('Reported duration40:00');
  expect(await fits(page)).toBe(true);

  await navigation(page).getByRole('button', { name: 'Today' }).click();
  const today = page.getByRole('region', { exact: true, name: 'Today' });
  await today.getByLabel('Date').fill(localDate(startMs));
  await expect(today.getByRole('heading', { level: 2, name: 'Imported from TCX' })).toBeVisible();
  expect(await fits(page)).toBe(true);

  // A preview held until after sign-out: its answer never appears in the next session.
  await openActivity(page);
  let releasePreview: () => void = () => undefined;
  await page.route('**/api/orgs/*/activities/tcx-preview', async (route) => {
    await new Promise<void>((resolve) => (releasePreview = resolve));
    await route.continue().catch(() => undefined);
  });
  await choose(page, syntheticTcx({ offsetS: 7_200 }), 'later.tcx');
  await expect(importRegion(page).getByRole('status')).toHaveText('Checking later.tcx…');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  releasePreview();
  await page.unroute('**/api/orgs/*/activities/tcx-preview');
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openActivity(page);
  await expect(importRegion(page).getByRole('form', { name: 'Preview of the TCX file' })).toHaveCount(0);
  await expect(importRegion(page).getByRole('status')).toHaveCount(0);
  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 0, manual: 0, runs: 0, tcx: 1 });
});
