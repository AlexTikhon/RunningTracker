import type { BrowserContext } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import { CoachPage } from './support/coach-page.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';

// The live stream polls every LIVE_SSE_POLL_INTERVAL_MS (2000 by default), so a grant or a revocation reaches
// the coach within a few polls.
const liveUpdateTimeoutMs = 10_000;

// Closes every context even if one close throws, so a failing close cannot leave the other browser open.
async function closeAll(contexts: readonly BrowserContext[]): Promise<void> {
  for (const context of contexts) {
    await context.close().catch(() => undefined);
  }
}

test('sharing: the runner shares from the Runner tab, the coach sees the run, and revoking removes it', async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    const runnerContext = await browser.newContext();
    contexts.push(runnerContext);
    const coachContext = await browser.newContext();
    contexts.push(coachContext);
    await signIn(runnerContext, environment, scenario.runnerUserId);
    await signIn(coachContext, environment, scenario.coachUserId);
    const runnerApi = await authedApi(runnerContext, environment);

    const coach = new CoachPage(await coachContext.newPage());
    await coach.open(scenario.orgId);
    await expect(coach.streamStatus()).toContainText('live');
    await expect(coach.emptyBoard()).toBeVisible();

    const runner = new RunnerPage(await runnerContext.newPage());
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    const runId = await runner.runId(runnerApi, scenario.orgId);
    await expect
      .poll(async () => (await runnerApi.getAllPoints(scenario.orgId, runId)).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);

    // The panel lists the organization's coach, not yet shared, and says what Share grants.
    await expect(runner.sharePanel()).toContainText('Share gives the coach live and history access');
    await expect(runner.shareAccess(scenario.coachUserId)).toHaveText('Not shared');

    // Nothing is visible to the coach before the grant: two fresh snapshots after the run has a position.
    await coach.waitForSnapshots(2);
    await expect(coach.markers()).toHaveCount(0);

    await runner.shareWith(scenario.coachUserId);
    // The panel reads the shares again after the change, so this is the server's answer, not the click.
    await expect(runner.shareAccess(scenario.coachUserId)).toHaveText('Live and history');

    await expect(coach.markers()).toHaveCount(1, { timeout: liveUpdateTimeoutMs });
    await expect(coach.trackOptions()).toHaveCount(1);
    await coach.trackOptions().first().check();
    await expect(coach.trackSelectionCount()).toHaveText('1 selected');
    await expect(coach.trackLabel(coach.trackOptions().first())).toHaveText(/^[1-9]\d* points · rev \d+$/, {
      timeout: liveUpdateTimeoutMs,
    });

    await runner.revokeShare(scenario.coachUserId);
    await expect(runner.shareAccess(scenario.coachUserId)).toHaveText('Not shared');

    // Position, track and selection all go, and the stream stays connected.
    await expect(coach.markers()).toHaveCount(0, { timeout: liveUpdateTimeoutMs });
    await expect(coach.trackOptions()).toHaveCount(0, { timeout: liveUpdateTimeoutMs });
    await expect(coach.emptyBoard()).toBeVisible({ timeout: liveUpdateTimeoutMs });
    await expect(coach.trackSelectionCount()).toHaveText('0 selected');
    await expect(coach.streamStatus()).toContainText('live');
    // And the run is still recording: sharing is not a lifecycle change.
    await expect(runner.card('Recording').value).toHaveText('recording');
  } finally {
    await closeAll(contexts);
  }
});

test('sharing: a partial grant made elsewhere is shown as it is and can be completed', async ({
  browser,
  environment,
  scenario,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    const runnerContext = await browser.newContext();
    contexts.push(runnerContext);
    await signIn(runnerContext, environment, scenario.runnerUserId);
    const runnerApi = await authedApi(runnerContext, environment);

    const runner = new RunnerPage(await runnerContext.newPage());
    await runner.open(scenario.orgId);
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    const runId = await runner.runId(runnerApi, scenario.orgId);

    await runnerApi.putShare(scenario.orgId, runId, scenario.coachUserId, { canReadHistory: false, canReadLive: true });
    await runner.reload();
    await expect(runner.shareAccess(scenario.coachUserId)).toHaveText('Live only');

    await runner.completeShareWith(scenario.coachUserId);
    await expect(runner.shareAccess(scenario.coachUserId)).toHaveText('Live and history');
    await runner.revokeShare(scenario.coachUserId);
    await expect(runner.shareAccess(scenario.coachUserId)).toHaveText('Not shared');
  } finally {
    await closeAll(contexts);
  }
});
