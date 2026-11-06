import type { Page } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { createFinishedRuns, setArchiveTrackFixture } from './support/database.js';
import { features, installFakeMapbox, isMapboxRequest, readProbe } from './support/fake-mapbox.js';
import { expect, test } from './support/fixtures.js';
import { expectSignedIn, expectSignedOut, organizationRegion } from './support/session.js';
import { installLocalMapbox, mapRuntimeDiagnostics } from './support/real-mapbox.js';

test.use({ locale: 'en-GB', timezoneId: 'Europe/Warsaw' });
const geometry = { type: 'MultiLineString' as const, coordinates: [[[21.0, 52.0], [21.01, 52.01]], [[21.02, 52.01], [21.03, 52.0]]] };
const details = (page: Page) => page.getByRole('region', { name: 'Run details', exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'My runs', exact: true });
const cards = (page: Page) => panel(page).getByRole('list', { name: 'My runs' }).locator(':scope > li');
const trackRequest = /\/runs\/[^/]+\/track\?mode=archive$/;

async function openMarch(page: Page, origin?: string): Promise<void> {
  await page.goto(origin ?? '/');
  await expectSignedIn(page);
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Archive' }).click();
  await panel(page).getByLabel('Period').selectOption('dates');
  await panel(page).getByLabel('From', { exact: true }).fill('2026-03-01');
  await panel(page).getByLabel('To (included)').fill('2026-03-31');
  await panel(page).getByRole('button', { name: 'Apply filters' }).click();
  await expect(cards(page).first()).toBeVisible();
}

test('run details: preserves applied filters, draft, loaded pages and focus; tokenless mobile view works after raw purge', async ({ context, environment, page, scenario }) => {
  const runIds = await createFinishedRuns(environment, scenario.orgId, Array.from({ length: 23 }, (_, index) => ({
    distanceM: 5000 + index * 100, durationS: 1800, startedAt: `2026-03-${String(index + 1).padStart(2, '0')}T06:00:00Z`, userId: scenario.runnerUserId,
  })));
  for (const runId of runIds) await setArchiveTrackFixture(environment, scenario.orgId, runId, 'ready', geometry);
  await signIn(context, environment, scenario.runnerUserId);
  const mapRequests: string[] = []; const searches: string[] = [];
  context.on('request', (request) => { if (isMapboxRequest(request)) mapRequests.push(request.url()); });
  page.on('request', (request) => { if (request.url().includes('/runs/search?')) searches.push(request.url()); });
  await openMarch(page);
  await panel(page).getByLabel('Units').selectOption('mi');
  await panel(page).getByLabel('Minimum distance').fill('1');
  await panel(page).getByRole('button', { name: 'Apply filters' }).click();
  await expect(cards(page)).toHaveCount(20);
  await panel(page).getByRole('button', { name: 'Load more runs' }).click();
  await expect(cards(page)).toHaveCount(23);
  await panel(page).getByLabel('Minimum distance').fill('999');
  await panel(page).getByLabel('Units').selectOption('km');
  const count = searches.length;
  const trigger = cards(page).last().getByRole('button', { name: /View details/ });
  await trigger.click();
  await expect(details(page).getByRole('heading', { name: 'Run details' })).toBeFocused();
  await expect(details(page).getByRole('definition').filter({ hasText: '3.11 mi' })).toBeVisible();
  await expect(details(page).getByText('30:00', { exact: true })).toBeVisible();
  await expect(details(page).getByText('The route map is unavailable.', { exact: false })).toBeVisible();
  await details(page).getByText('Processing details', { exact: true }).click();
  await expect(details(page)).toContainText('have expired');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '../../.local/run-details-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '../../.local/run-details-desktop.png', fullPage: true });
  await details(page).getByRole('button', { name: 'Back to My runs' }).click();
  await expect(cards(page)).toHaveCount(23);
  await expect(trigger).toBeFocused();
  await expect(panel(page).getByLabel('Minimum distance')).toHaveValue('999');
  await expect(panel(page).getByLabel('Units')).toHaveValue('km');
  await expect(panel(page).getByRole('region', { name: 'Applied filters' })).toContainText('at least 1 mi');
  expect(searches).toHaveLength(count);
  expect(mapRequests).toEqual([]);
});

test('run details: ready, stale and pending are distinct, and refresh failure removes old statistics', async ({ context, environment, page, scenario }) => {
  const [runId] = await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 5000, startedAt: '2026-03-01T06:00:00Z', userId: scenario.runnerUserId }]);
  await setArchiveTrackFixture(environment, scenario.orgId, runId!, 'ready', geometry);
  await signIn(context, environment, scenario.runnerUserId); await openMarch(page);
  await cards(page).first().getByRole('button', { name: /View details/ }).click();
  await expect(details(page)).toContainText('5.00 km');
  await setArchiveTrackFixture(environment, scenario.orgId, runId!, 'stale', geometry);
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(details(page)).toContainText('summary is being updated');
  await expect(details(page).getByRole('definition').filter({ hasText: '5.00 km' })).toHaveCount(0);
  await setArchiveTrackFixture(environment, scenario.orgId, runId!, 'pending', null);
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(details(page)).toContainText('summary is still being prepared');
  await page.route(trackRequest, (route) => route.fulfill({ body: '{}', contentType: 'application/json', status: 503 }));
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(details(page).getByRole('alert')).toContainText('Check your connection');
  await expect(details(page).getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(details(page).getByRole('definition')).toHaveCount(0);
});

test('run details: current empty geometry is usable statistics, not a pending summary', async ({ context, environment, page, scenario }) => {
  await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 0, durationS: 0, quality: 'insufficient', startedAt: '2026-03-01T06:00:00Z', userId: scenario.runnerUserId }]);
  await signIn(context, environment, scenario.runnerUserId); await openMarch(page);
  await cards(page).first().getByRole('button', { name: /View details/ }).click();
  await expect(details(page)).toContainText('0.00 km');
  await expect(details(page)).toContainText('Insufficient GPS data');
  await expect(details(page)).toContainText('No usable route was produced');
  await expect(details(page)).not.toContainText('still being prepared');
});

test('run details: a deleted run clears its route and metrics on refresh', async ({ context, environment, page, scenario }) => {
  const [runId] = await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 5000, startedAt: '2026-03-01T06:00:00Z', userId: scenario.runnerUserId }]);
  await signIn(context, environment, scenario.runnerUserId); await openMarch(page);
  await cards(page).first().getByRole('button', { name: /View details/ }).click();
  await expect(details(page)).toContainText('5.00 km');
  const api = await authedApi(context, environment);
  await api.deleteRun(scenario.orgId, runId!);
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(details(page).getByRole('alert')).toContainText('was deleted');
  await expect(details(page).getByRole('definition')).toHaveCount(0);
  await expect(details(page).getByRole('region', { name: 'Run route' })).toHaveCount(0);
});

test('run details: closing a pending request and switching organization cannot reopen the old run', async ({ context, environment, organizations, page, scenario }) => {
  const otherOrg = await organizations.memberOf(scenario.runnerUserId);
  await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 5000, startedAt: '2026-03-01T06:00:00Z', userId: scenario.runnerUserId }]);
  await signIn(context, environment, scenario.runnerUserId); await page.goto('/'); await expectSignedIn(page);
  await organizationRegion(page).getByRole('combobox', { name: 'Organization' }).selectOption(scenario.orgId);
  await openMarch(page);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void; const received = new Promise<void>((resolve) => { entered = resolve; });
  await page.route(trackRequest, async (route) => {
    const response = await route.fetch(); entered(); await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await cards(page).first().getByRole('button', { name: /View details/ }).click(); await received;
  await expect(details(page)).toContainText('Loading run details');
  await details(page).getByRole('button', { name: 'Back to My runs' }).click();
  await organizationRegion(page).getByRole('combobox', { name: 'Organization' }).selectOption(otherOrg);
  release();
  await expect(details(page)).toHaveCount(0);
  await expect(panel(page)).not.toContainText('5.00 km');
});

test('run details: fake map draws exact disconnected geometry, refresh clears it, and sign-out removes the instance', async ({ context, environment, page, scenario }) => {
  await installFakeMapbox(context);
  const [runId] = await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 5000, startedAt: '2026-03-01T06:00:00Z', userId: scenario.runnerUserId }]);
  await setArchiveTrackFixture(environment, scenario.orgId, runId!, 'ready', geometry);
  await signIn(context, environment, scenario.runnerUserId); await openMarch(page, environment.mapWebOrigin);
  await cards(page).first().getByRole('button', { name: /View details/ }).click();
  await expect.poll(async () => features(await readProbe(page), 'running-tracker-run-detail')[0]?.geometry).toEqual(geometry);
  await expect(details(page).getByRole('button', { name: 'Fit route' })).toBeEnabled();
  await details(page).getByRole('button', { name: 'Fit route' }).click();
  const removedBeforeRefresh = (await readProbe(page))?.removed ?? 0;
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect.poll(async () => (await readProbe(page))?.removed ?? 0).toBeGreaterThan(removedBeforeRefresh);
  await expect.poll(async () => features(await readProbe(page), 'running-tracker-run-detail')[0]?.geometry).toEqual(geometry);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expectSignedOut(page);
  await expect.poll(async () => features(await readProbe(page), 'running-tracker-run-detail')).toEqual([]);
  await expect(details(page)).toHaveCount(0);
});

test('run details: installed Mapbox runtime renders the published route with a local style', { tag: '@real-map-runtime' }, async ({ context, environment, page, scenario }) => {
  const unexpected = await installLocalMapbox(context, environment);
  const diagnostics = mapRuntimeDiagnostics(page);
  const [runId] = await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 5000, startedAt: '2026-03-01T06:00:00Z', userId: scenario.runnerUserId }]);
  await setArchiveTrackFixture(environment, scenario.orgId, runId!, 'ready', geometry);
  await signIn(context, environment, scenario.runnerUserId); await openMarch(page, environment.mapWebOrigin);
  const archiveCanvas = page.locator('.archive-map__canvas canvas.mapboxgl-canvas');
  await expect(archiveCanvas).toBeVisible();
  expect(await archiveCanvas.evaluate((canvas) => canvas.clientHeight)).toBeGreaterThan(300);
  await cards(page).first().getByRole('button', { name: /View details/ }).click();
  await expect(details(page).getByRole('button', { name: 'Fit route' })).toBeEnabled();
  await expect(details(page)).not.toContainText('could not be loaded');
  await details(page).screenshot({ path: '../../.local/run-details-real-map.png' });
  await details(page).getByRole('button', { name: 'Refresh run' }).click();
  await expect(details(page).getByRole('button', { name: 'Fit route' })).toBeEnabled();
  await expect(page.locator('canvas.mapboxgl-canvas')).toHaveCount(1);
  await details(page).getByRole('button', { name: 'Back to My runs' }).click();
  await expect(archiveCanvas).toBeVisible();
  await cards(page).first().getByRole('button', { name: /View details/ }).click();
  await expect(details(page).getByRole('button', { name: 'Fit route' })).toBeEnabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expectSignedOut(page);
  await expect(page.locator('canvas.mapboxgl-canvas')).toHaveCount(0);
  expect(unexpected).toEqual([]);
  expect(diagnostics).toEqual({ errors: [], containerWarnings: [] });
});

test('run details: a failed base style keeps statistics usable and leaving clears the map', { tag: '@real-map-runtime' }, async ({ context, environment, page, scenario }) => {
  const unexpected = await installLocalMapbox(context, environment);
  const diagnostics = mapRuntimeDiagnostics(page);
  await context.route('https://api.mapbox.com/styles/v1/mapbox/dark-v11?**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  const [runId] = await createFinishedRuns(environment, scenario.orgId, [{ distanceM: 5000, startedAt: '2026-03-01T06:00:00Z', userId: scenario.runnerUserId }]);
  await setArchiveTrackFixture(environment, scenario.orgId, runId!, 'ready', geometry);
  await signIn(context, environment, scenario.runnerUserId);
  await openMarch(page, environment.mapWebOrigin);
  await expect(page.getByRole('alert').filter({ hasText: 'base style' })).toBeVisible();
  await cards(page).first().getByRole('button', { name: /View details/ }).click();
  await expect(details(page)).toContainText('The route map could not be loaded.');
  await expect(details(page)).toContainText('5.00 km');
  await expect(details(page).getByRole('button', { name: 'Fit route' })).toBeDisabled();
  await expect(page.locator('canvas.mapboxgl-canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expectSignedOut(page);
  expect(unexpected).toEqual([]);
  expect(diagnostics).toEqual({ errors: [], containerWarnings: [] });
});
