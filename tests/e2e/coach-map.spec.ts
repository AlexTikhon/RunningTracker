import type { Browser, BrowserContext, Page, Request } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import type { AuthedApi } from './support/api.js';
import { CoachPage } from './support/coach-page.js';
import type { ScenarioData } from './support/database.js';
import type { E2eEnvironment } from './support/environment.js';
import {
  features,
  installFakeMapbox,
  isMapboxRequest,
  markerSourceId,
  readProbe,
  trackSourceId,
} from './support/fake-mapbox.js';
import { expect, test } from './support/fixtures.js';
import { dropLiveStream, restoreLiveStream, trackLiveStreams } from './support/live-stream-fault.js';
import { RunnerPage } from './support/runner-page.js';
import { expectSignedOut } from './support/session.js';

// The live stream polls every LIVE_SSE_POLL_INTERVAL_MS (2000 by default).
const liveUpdateTimeoutMs = 10_000;
const pollIntervals = [250, 500];

interface SharedRun {
  readonly coach: CoachPage;
  readonly coachContext: BrowserContext;
  readonly coachPage: Page;
  readonly runId: string;
  readonly runnerApi: AuthedApi;
}

async function closeAll(contexts: readonly BrowserContext[]): Promise<void> {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
}

// A runner records a simulated run and shares it; the coach watches from `origin` and sees its position card.
// `prepare` runs on the coach's context before the page exists, so its routes see every request.
async function shareRunWithCoach(
  browser: Browser,
  environment: E2eEnvironment,
  scenario: ScenarioData,
  contexts: BrowserContext[],
  options: { origin?: string; prepare?: (context: BrowserContext) => Promise<void> } = {},
): Promise<SharedRun> {
  const runnerContext = await browser.newContext();
  contexts.push(runnerContext);
  const coachContext = await browser.newContext();
  contexts.push(coachContext);
  await signIn(runnerContext, environment, scenario.runnerUserId);
  // The session cookie belongs to 127.0.0.1 and is sent to every local port, so the map origin shares it.
  await signIn(coachContext, environment, scenario.coachUserId);
  const runnerApi = await authedApi(runnerContext, environment);
  await options.prepare?.(coachContext);

  const coachPage = await coachContext.newPage();
  const coach = new CoachPage(coachPage);
  await coach.open(scenario.orgId, options.origin);
  await expect(coach.streamStatus()).toContainText('live');

  const runner = new RunnerPage(await runnerContext.newPage());
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  const runId = await runner.runId(runnerApi, scenario.orgId);
  await expect
    .poll(async () => (await runnerApi.getAllPoints(scenario.orgId, runId)).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(3);

  await runnerApi.putShare(scenario.orgId, runId, scenario.coachUserId, { canReadHistory: false, canReadLive: true });
  await expect(coach.markers()).toHaveCount(1, { timeout: liveUpdateTimeoutMs });
  return { coach, coachContext, coachPage, runId, runnerApi };
}

async function selectTrack(coach: CoachPage): Promise<void> {
  await coach.trackOptions().first().check();
  await expect(coach.trackLabel(coach.trackOptions().first())).toHaveText(/^[1-9]\d* points · rev \d+$/, {
    timeout: liveUpdateTimeoutMs,
  });
}

// A drawn line of the run: at least two connected coordinates, each a [longitude, latitude] pair.
async function expectTrackLine(page: Page, runId: string): Promise<void> {
  await expect
    .poll(async () => {
      const lines = features(await readProbe(page), trackSourceId).filter(
        (feature) => feature.geometry.type === 'LineString' && feature.properties['runId'] === runId,
      );
      return lines.some((line) => {
        const coordinates = line.geometry.coordinates as [number, number][];
        return coordinates.length >= 2
          && coordinates.every(([longitude, latitude]) => Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90);
      });
    }, { intervals: pollIntervals, timeout: liveUpdateTimeoutMs })
    .toBe(true);
}

async function markerRunIds(page: Page): Promise<unknown[]> {
  return features(await readProbe(page), markerSourceId).map((feature) => feature.properties['runId']);
}

async function trackRunIds(page: Page): Promise<unknown[]> {
  return features(await readProbe(page), trackSourceId).map((feature) => feature.properties['runId']);
}

test('coach map: without a token the cards and picker work, the map says it is unavailable and no map code loads', async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  const mapboxRequests: string[] = [];
  try {
    const { coach } = await shareRunWithCoach(browser, environment, scenario, contexts, {
      prepare: (context) => {
        context.on('request', (request: Request) => {
          if (isMapboxRequest(request)) mapboxRequests.push(new URL(request.url()).pathname);
        });
        return Promise.resolve();
      },
    });

    await expect(coach.mapUnavailable()).toBeVisible();
    await expect(coach.fitVisibleRuns()).toHaveCount(0);
    await selectTrack(coach);
    await expect(coach.markers().first()).toContainText('recording');
    expect(mapboxRequests).toEqual([]);
  } finally {
    await closeAll(contexts);
  }
});

test('coach map: the shared position and the selected track are drawn; deselect keeps the marker, revoke removes both', async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    const { coach, coachPage, runId, runnerApi } = await shareRunWithCoach(browser, environment, scenario, contexts, {
      origin: environment.mapWebOrigin,
      prepare: installFakeMapbox,
    });

    await expect.poll(() => markerRunIds(coachPage), { intervals: pollIntervals, timeout: liveUpdateTimeoutMs })
      .toEqual([runId]);
    // The first geometry fits the camera once.
    await expect.poll(async () => (await readProbe(coachPage))?.fitBounds).toBe(1);
    expect(await trackRunIds(coachPage)).toEqual([]);

    await selectTrack(coach);
    await expectTrackLine(coachPage, runId);
    await expect(coach.mapTrackStatuses()).toHaveCount(1);
    await expect(coach.mapTrackStatuses().first()).toHaveText(/^Run #[0-9a-f]{8}: rev \d+, latest$/u, {
      timeout: liveUpdateTimeoutMs,
    });

    // Further snapshots update the sources but keep the one map instance and leave the camera alone.
    await coach.waitForSnapshots(2);
    expect(await readProbe(coachPage)).toMatchObject({ created: 1, fitBounds: 1, removed: 0 });
    await coach.fitVisibleRuns().click();
    expect((await readProbe(coachPage))?.fitBounds).toBe(2);

    await coach.trackOptions().first().uncheck();
    await expect.poll(() => trackRunIds(coachPage)).toEqual([]);
    expect(await markerRunIds(coachPage)).toEqual([runId]);

    await coach.trackOptions().first().check();
    await expectTrackLine(coachPage, runId);

    await runnerApi.deleteShare(scenario.orgId, runId, scenario.coachUserId);
    await expect(coach.markers()).toHaveCount(0, { timeout: liveUpdateTimeoutMs });
    await expect.poll(() => markerRunIds(coachPage)).toEqual([]);
    expect(await trackRunIds(coachPage)).toEqual([]);
    await expect(coach.mapTrackStatuses()).toHaveCount(0);
    expect(await readProbe(coachPage)).toMatchObject({ created: 1, removed: 0 });
  } finally {
    await closeAll(contexts);
  }
});

test('coach map: a lost stream clears the map, a fresh state redraws it, and signing out removes the map', async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    const { coach, coachPage, runId } = await shareRunWithCoach(browser, environment, scenario, contexts, {
      origin: environment.mapWebOrigin,
      prepare: async (context) => {
        await installFakeMapbox(context);
        await trackLiveStreams(context);
      },
    });
    await selectTrack(coach);
    await expectTrackLine(coachPage, runId);

    // The stream breaks and cannot be reopened: positions and the track leave the map at once.
    expect(await dropLiveStream(coachPage)).toBe(1);
    await expect(coach.streamStatus()).toContainText(/disconnected|connecting/u);
    await expect.poll(() => markerRunIds(coachPage)).toEqual([]);
    expect(await trackRunIds(coachPage)).toEqual([]);
    await expect(coach.markers()).toHaveCount(0);

    // Only a fresh authorized state brings them back, the selection with a fresh snapshot.
    await restoreLiveStream(coachPage);
    const reconnect = coachPage.getByRole('button', { name: 'Reconnect' });
    await expect
      .poll(async () => {
        if (await reconnect.isVisible()) await reconnect.click().catch(() => undefined);
        return coach.streamStatus().textContent();
      }, { intervals: [500, 1_000], timeout: 20_000 })
      .toContain('live');
    await expect.poll(() => markerRunIds(coachPage), { intervals: pollIntervals, timeout: liveUpdateTimeoutMs })
      .toEqual([runId]);
    await expectTrackLine(coachPage, runId);
    expect(await readProbe(coachPage)).toMatchObject({ created: 1, removed: 0 });

    // Ending the session removes the map instance and everything on it.
    await coachPage.getByRole('button', { name: 'Sign out' }).click();
    await expectSignedOut(coachPage);
    await expect.poll(async () => (await readProbe(coachPage))?.removed).toBe(1);
    expect(await readProbe(coachPage)).toMatchObject({ created: 1, listeners: 0, sources: {} });
  } finally {
    await closeAll(contexts);
  }
});

// The real mapbox-gl runtime in this Chromium, with WebGL, but no provider: the base style request is answered in
// the browser with an empty local style, and every other external request is aborted before it leaves.
const emptyStyle = JSON.stringify({
  layers: [{ id: 'background', paint: { 'background-color': '#121813' }, type: 'background' }],
  name: 'e2e-empty',
  sources: {},
  version: 8,
});

// Tagged so the bounded Firefox gate can leave it out; the Chromium project still runs it.
test('coach map smoke: the installed Mapbox runtime starts with a local empty style and draws without errors', {
  tag: '@real-map-runtime',
}, async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  const blocked: string[] = [];
  const localOrigins = new Set([environment.mapWebOrigin, environment.webOrigin, environment.apiOrigin]);
  try {
    const { coach, coachPage } = await shareRunWithCoach(browser, environment, scenario, contexts, {
      origin: environment.mapWebOrigin,
      prepare: async (context) => {
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (localOrigins.has(url.origin) || url.protocol === 'blob:' || url.protocol === 'data:') {
            await route.fallback();
          } else if (url.hostname === 'api.mapbox.com' && url.pathname === '/styles/v1/mapbox/dark-v11') {
            await route.fulfill({ body: emptyStyle, contentType: 'application/json', status: 200 });
          } else {
            blocked.push(`${url.hostname}${url.pathname}`);
            await route.abort('blockedbyclient');
          }
        });
      },
    });

    await expect(coachPage.getByRole('region', { name: 'Map', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(coach.mapPanel().getByText('Loading map…')).toHaveCount(0, { timeout: 20_000 });
    await selectTrack(coach);
    await expect(coach.mapTrackStatuses().first()).toHaveText(/, latest$/u, { timeout: liveUpdateTimeoutMs });
    await expect(coach.fitVisibleRuns()).toBeEnabled();
    await coach.fitVisibleRuns().click();
    await coach.waitForSnapshots(2);

    // An invalid source or layer is reported by the runtime as a map error, which the page would show.
    await expect(coach.mapPanel().getByRole('alert')).toHaveCount(0);
    await expect(coach.mapPanel().getByText('Part of the base map could not be loaded.')).toHaveCount(0);
    const screenshot = test.info().outputPath('coach-map.png');
    await coach.mapPanel().screenshot({ path: screenshot });
    await test.info().attach('coach-map.png', { contentType: 'image/png', path: screenshot });
    test.info().annotations.push({ description: [...new Set(blocked)].join(', ') || 'none', type: 'blocked external requests' });
  } finally {
    await closeAll(contexts);
  }
});
