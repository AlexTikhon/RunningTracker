import type { Browser, BrowserContext } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import type { AuthedApi } from './support/api.js';
import { CoachPage } from './support/coach-page.js';
import type { CoachMarkerQuality } from './support/coach-page.js';
import type { ScenarioData } from './support/database.js';
import type { E2eEnvironment } from './support/environment.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// The live stream polls every LIVE_SSE_POLL_INTERVAL_MS (2000 by default), so a grant or a revocation reaches
// the coach within a few polls.
const liveUpdateTimeoutMs = 10_000;

interface SharedRun {
  readonly coach: CoachPage;
  readonly qualitiesSeen: ReadonlySet<CoachMarkerQuality>;
  readonly runnerApi: AuthedApi;
  readonly runId: string;
}

// Closes every context even if one close throws, so a failing close cannot leave the other browser open.
async function closeAll(contexts: readonly BrowserContext[]): Promise<void> {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
}

// A runner records a simulated run while a coach watches the organization. Returns once the coach sees the
// run as one confirmed marker, after proving that nothing was visible before the grant.
async function runSharedWithCoach(
  browser: Browser,
  environment: E2eEnvironment,
  scenario: ScenarioData,
  contexts: BrowserContext[],
): Promise<SharedRun> {
  const runnerContext = await browser.newContext();
  contexts.push(runnerContext);
  const coachContext = await browser.newContext();
  contexts.push(coachContext);
  await signIn(runnerContext, environment, scenario.runnerUserId);
  await signIn(coachContext, environment, scenario.coachUserId);
  const runnerApi = await authedApi(runnerContext, environment);

  // The coach is connected to the live stream and holds an empty board before the run exists.
  const coach = new CoachPage(await coachContext.newPage());
  await coach.open(scenario.orgId);
  await expect(coach.streamStatus()).toContainText('live');
  await expect(coach.emptyBoard()).toBeVisible();
  await expect(coach.markers()).toHaveCount(0);

  const runner = new RunnerPage(await runnerContext.newPage());
  await runner.open(scenario.orgId);
  await runner.useSimulator();
  await runner.start();
  await expect(runner.card('Recording').value).toHaveText('recording');
  const runId = await runner.runId(runnerApi, scenario.orgId);
  await expect
    .poll(async () => (await runnerApi.getAllPoints(scenario.orgId, runId)).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);

  // The run is active with a stored position. The coach polls a snapshot every few seconds; waiting for two
  // snapshots that arrive after this point makes "no marker yet" a statement about the server, not a race.
  await coach.waitForSnapshots(2);
  await expect(coach.markers()).toHaveCount(0);
  await expect(coach.emptyBoard()).toBeVisible();

  await runnerApi.putShare(scenario.orgId, runId, scenario.coachUserId, {
    canReadHistory: false,
    canReadLive: true,
  });
  await expect(coach.markers()).toHaveCount(1, { timeout: liveUpdateTimeoutMs });

  // The quality may pass through unconfirmed on the way; only the final state is required.
  const qualitiesSeen = new Set<CoachMarkerQuality>();
  await expect
    .poll(
      async () => {
        const quality = await coach.markerQuality(coach.markers().first());
        qualitiesSeen.add(quality);
        return quality;
      },
      { intervals: [250, 500], timeout: liveUpdateTimeoutMs },
    )
    .toBe('confirmed');

  return { coach, qualitiesSeen, runId, runnerApi };
}

test('coach: a shared run appears live and becomes confirmed', async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    const { coach, qualitiesSeen } = await runSharedWithCoach(browser, environment, scenario, contexts);

    await expect(coach.markers()).toHaveCount(1);
    await expect(coach.markers().first()).toContainText('recording');
    await expect(coach.emptyBoard()).toHaveCount(0);
    // Recorded for the report, never required: whether unconfirmed was seen depends on timing.
    test.info().annotations.push({ description: [...qualitiesSeen].join(', '), type: 'qualities observed' });
  } finally {
    await closeAll(contexts);
  }
});

test('coach: revoking the share removes the run and its last-known data', async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    const { coach, runId, runnerApi } = await runSharedWithCoach(browser, environment, scenario, contexts);

    // Select the track and see its data arrive, so there is last-known data to lose.
    await expect(coach.trackOptions()).toHaveCount(1);
    await coach.trackOptions().first().check();
    await expect(coach.trackOptions().first()).toBeChecked();
    await expect(coach.trackSelectionCount()).toHaveText('1 selected');
    await expect(coach.trackLabel(coach.trackOptions().first())).toHaveText(/^[1-9]\d* points · rev \d+$/, {
      timeout: liveUpdateTimeoutMs,
    });

    await runnerApi.deleteShare(scenario.orgId, runId, scenario.coachUserId);

    await expect(coach.markers()).toHaveCount(0, { timeout: liveUpdateTimeoutMs });
    await expect(coach.trackOptions()).toHaveCount(0, { timeout: liveUpdateTimeoutMs });
    await expect(coach.emptyBoard()).toBeVisible({ timeout: liveUpdateTimeoutMs });
    await expect(coach.trackSelectionCount()).toHaveText('0 selected');
    await expect(coach.streamStatus()).toContainText('live');
  } finally {
    await closeAll(contexts);
  }
});
