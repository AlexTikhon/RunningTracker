import type { Page } from '@playwright/test';

import { countActivityRows } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// GPX import into the Activity tab (ADR-0086), against the real API and the _test database. The tracks are synthetic,
// built here on the equator: no real person's location. The demoScenario fixture's cleanup removes the organization's
// activities with it.

const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

// Two days ago, on a whole minute, so the start is inside every server bound and its date is stable for the test.
const startMs = Math.floor((Date.now() - 2 * 86_400_000) / 60_000) * 60_000;

/** Two segments of four points every 10 s, about 5.6 m/s, with a 5-minute pause between them: 370 s elapsed. */
function syntheticGpx(options: { namespace?: string; offsetS?: number } = {}): Buffer {
  let second = options.offsetS ?? 0;
  let lon = 20;
  const segments: string[] = [];
  for (let segment = 0; segment < 2; segment += 1) {
    const points: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      points.push(`<trkpt lat="0" lon="${lon.toFixed(6)}"><ele>3</ele><time>${new Date(startMs + second * 1_000).toISOString()}</time></trkpt>`);
      lon += 0.0005;
      second += 10;
    }
    segments.push(`<trkseg>${points.join('')}</trkseg>`);
    second += 300;
  }
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="e2e" xmlns="${options.namespace ?? 'http://www.topografix.com/GPX/1/1'}"><trk><name>Synthetic</name>${segments.join('')}</trk></gpx>`,
    'utf8',
  );
}

const label = (instantMs: number) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: 'short', timeZone, year: 'numeric' }).format(
    new Date(instantMs),
  );
const localDate = (instantMs: number) => new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone, year: 'numeric' }).format(new Date(instantMs));

async function signIn(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

async function openActivity(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
}

const importRegion = (page: Page) => page.getByRole('region', { name: 'Import a GPX file' });

async function choose(page: Page, buffer: Buffer, name = 'morning.gpx'): Promise<void> {
  await importRegion(page).getByLabel('GPX file').setInputFiles({ buffer, mimeType: 'application/gpx+xml', name });
}

test('previews a GPX file without saving, imports it once with the chosen type, and keeps it apart everywhere', async ({ demoScenario, environment, page }) => {
  const uploads: Array<{ method: string; url: string }> = [];
  page.on('request', (request) => {
    if (request.url().includes('/gpx-')) uploads.push({ method: request.method(), url: request.url() });
  });
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  await openActivity(page);
  const region = importRegion(page);
  const list = page.getByRole('region', { name: 'Your activity history' });
  await expect(list.getByText('No activities yet.')).toBeVisible();

  // 1. Preview: the server's numbers, nothing stored.
  await choose(page, syntheticGpx());
  const preview = region.getByRole('form', { name: 'Preview of the GPX file' });
  await expect(preview).toBeVisible();
  for (const text of [label(startMs), label(startMs + 370_000), '6:10', '0.33 km', 'Points8', 'Segments2']) {
    await expect(preview).toContainText(text);
  }
  await expect(preview).toContainText('it is not moving time');
  await expect(preview).toContainText('not compared with GPS runs recorded in SomaLane');
  await expect(preview.getByRole('button', { name: 'Import activity' })).toBeDisabled();
  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 0, manual: 0, runs: 0, tcx: 0 });
  await expect(list.getByText('No activities yet.')).toBeVisible();

  // 2. Confirm with an explicit type. The first answer is lost after the server stored it: the retry repeats the same
  //    attempt and the server answers the stored activity instead of storing a second one.
  let confirmations = 0;
  await page.route('**/api/orgs/*/activities/*/gpx-import*', async (route) => {
    confirmations += 1;
    if (confirmations === 1) {
      await route.fetch();
      return route.abort('connectionfailed');
    }
    return route.continue();
  });
  await preview.getByLabel('Activity type').selectOption('ride');
  await preview.getByRole('button', { name: 'Import activity' }).click();
  await expect(region.getByText(/^The import was not confirmed: .* Importing again is safe and will not create a duplicate\.$/u)).toBeVisible();
  await preview.getByRole('button', { name: 'Import again' }).click();
  await expect(region.getByRole('status')).toHaveText('GPX activity imported.');
  await page.unroute('**/api/orgs/*/activities/*/gpx-import*');
  expect(confirmations).toBe(2);
  const puts = uploads.filter((upload) => upload.method === 'PUT').map((upload) => upload.url);
  expect(puts).toHaveLength(2);
  expect(puts[1]).toBe(puts[0]);
  const query = new URL(puts[0]!).searchParams;
  expect([...query.keys()].toSorted()).toEqual(['idempotencyKey', 'type']);
  expect(query.get('type')).toBe('ride');
  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 1, manual: 0, runs: 0, tcx: 0 });

  // 3. Listed as a GPX import with elapsed time, never as manual, and no GPS run was created.
  const cards = list.getByRole('list', { name: 'Your activity history' }).locator(':scope > li');
  await expect(cards).toHaveCount(1);
  for (const text of ['Ride', label(startMs), 'Elapsed time6:10', '0.33 km', 'SourceGPX import']) {
    await expect(cards.first()).toContainText(text);
  }
  await expect(cards.first()).not.toContainText('Entered manually');

  // 4. The same file again: the preview says it is already imported, and nothing can be confirmed.
  await choose(page, syntheticGpx());
  await expect(preview).toContainText('You already imported this track');
  await preview.getByLabel('Activity type').selectOption('run');
  await expect(preview.getByRole('button', { name: 'Import activity' })).toBeDisabled();
  await preview.getByRole('button', { name: 'Cancel' }).click();
  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 1, manual: 0, runs: 0, tcx: 0 });

  // 5. Today shows it in its own card on the date it started; the manual card stays empty.
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Today' }).click();
  const today = page.getByRole('region', { exact: true, name: 'Today' });
  await today.getByLabel('Date').fill(localDate(startMs));
  await expect(today.getByRole('heading', { level: 2, name: 'Imported from GPX' })).toBeVisible();
  await expect(today.getByText('1 activity imported from GPX started on this day, 6 min 10 s elapsed in total.')).toBeVisible();
  await expect(today.getByText('No manual activity started on this day.')).toBeVisible();
  await expect(today.getByText('No finished GPS run started on this day.')).toBeVisible();
});

test('explains files it cannot import and stores nothing', async ({ demoScenario, environment, page }) => {
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  await openActivity(page);
  const region = importRegion(page);

  await choose(page, syntheticGpx({ namespace: 'http://www.topografix.com/GPX/1/0' }), 'old.gpx');
  await expect(region.getByRole('alert')).toHaveText(/^This file cannot be imported: The file is GPX 1\.0; only GPX 1\.1 is supported\./u);
  await expect(region.getByRole('form', { name: 'Preview of the GPX file' })).toHaveCount(0);
  await region.getByRole('button', { name: 'Choose another file' }).click();

  await choose(page, Buffer.from('date,distance\n2026-11-08,5\n'), 'export.csv');
  await expect(region.getByRole('alert')).toContainText('This file cannot be imported: The file is malformed XML');
  await choose(page, Buffer.from(`<!DOCTYPE gpx [<!ENTITY x SYSTEM "http://127.0.0.1:9/x">]>${syntheticGpx().toString('utf8').replace(/^<\?xml[^>]*>\n/u, '')}`), 'entity.gpx');
  await expect(region.getByRole('alert')).toContainText('DTDs are not supported');
  await choose(page, Buffer.alloc(0), 'empty.gpx');
  await expect(region.getByRole('alert')).toHaveText('This file is empty, so it cannot be imported.');

  expect(await countActivityRows(environment, demoScenario.orgId)).toEqual({ gpx: 0, manual: 0, runs: 0, tcx: 0 });
});

test('drops a preview and a confirmation answer that arrive after the session changed', async ({ demoScenario, environment, page }) => {
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  await openActivity(page);

  // A preview held until after sign-out: its answer must never appear in the next session.
  let releasePreview: () => void = () => undefined;
  await page.route('**/api/orgs/*/activities/gpx-preview', async (route) => {
    await new Promise<void>((resolve) => (releasePreview = resolve));
    await route.continue().catch(() => undefined);
  });
  await choose(page, syntheticGpx());
  await expect(importRegion(page).getByRole('status')).toHaveText('Checking morning.gpx…');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  releasePreview();
  await page.unroute('**/api/orgs/*/activities/gpx-preview');
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openActivity(page);
  const region = importRegion(page);
  await expect(region.getByRole('form', { name: 'Preview of the GPX file' })).toHaveCount(0);
  await expect(region.getByRole('status')).toHaveCount(0);

  // A confirmation held until after sign-out: the old session's answer is not reported in the new one.
  await choose(page, syntheticGpx({ offsetS: 3_600 }), 'later.gpx');
  const preview = region.getByRole('form', { name: 'Preview of the GPX file' });
  await expect(preview).toBeVisible();
  let releaseConfirm: () => void = () => undefined;
  await page.route('**/api/orgs/*/activities/*/gpx-import*', async (route) => {
    await new Promise<void>((resolve) => (releaseConfirm = resolve));
    await route.continue().catch(() => undefined);
  });
  await preview.getByLabel('Activity type').selectOption('walk');
  await preview.getByRole('button', { name: 'Import activity' }).click();
  await expect(preview.getByRole('button', { name: 'Importing…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  releaseConfirm();
  await page.unroute('**/api/orgs/*/activities/*/gpx-import*');
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await openActivity(page);
  await expect(importRegion(page).getByRole('status')).toHaveCount(0);
  await expect(importRegion(page).getByRole('alert')).toHaveCount(0);
  await expect(importRegion(page).getByRole('form', { name: 'Preview of the GPX file' })).toHaveCount(0);
  // The held request carried the signed-out session, so the server refused it: nothing was stored.
  await expect.poll(async () => (await countActivityRows(environment, demoScenario.orgId)).gpx).toBe(0);
});
