import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import type { AuthedApi } from './api.js';

export type StateCardLabel = 'Capture' | 'Network' | 'Recording' | 'Server state' | 'Upload' | 'Writer';

export interface StateCard {
  readonly detail: Locator;
  readonly value: Locator;
}

// The capture is deterministic but paced in real time, so the waits below get a generous bound. They poll
// observable page state; nothing sleeps for a fixed time.
const captureTimeoutMs = 30_000;
const uploadTimeoutMs = 20_000;
// The writer lease lasts 15 s and the observed wait after a reload is about 17 s.
const leaseExpiryTimeoutMs = 30_000;

// Page object for the Runner view. Every locator uses roles, labels or visible text only.
export class RunnerPage {
  constructor(private readonly page: Page) {}

  async open(orgId: string): Promise<void> {
    await this.openRunnerView();
    await this.page.getByLabel('Organization ID').fill(orgId);
  }

  // Opens the Runner view of a tab that finds the user's run already active: the run is restored on load, so
  // there is no Organization ID field to fill.
  async openRestoredRun(): Promise<void> {
    await this.openRunnerView();
  }

  private async openRunnerView(): Promise<void> {
    await this.page.goto('/');
    await this.page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Runner' }).click();
  }

  async useSimulator(): Promise<void> {
    const source = this.page.getByLabel('Capture source');
    // selectOption matches a label exactly, so read the full label of the option that starts with Simulator.
    const label = await source.getByRole('option', { name: /^Simulator/ }).textContent();
    if (label === null) {
      throw new Error('The capture source has no Simulator option');
    }
    await source.selectOption({ label });
  }

  async start(): Promise<void> {
    await this.page.getByRole('button', { name: 'Start run' }).click();
  }

  async finish(): Promise<void> {
    await this.page.getByRole('button', { name: 'Finish' }).click();
  }

  card(label: StateCardLabel): StateCard {
    const article = this.page
      .getByLabel('Runner state')
      .getByRole('article')
      .filter({ has: this.page.getByText(label, { exact: true }) });
    return { detail: article.locator('span'), value: article.locator('strong') };
  }

  // The page shows only the first 8 characters of the run id, so the full id comes from the API. One user
  // has at most one active run, so the organization's list has one entry.
  async runId(api: AuthedApi, orgId: string): Promise<string> {
    const runIds = await api.listRunIds(orgId);
    const [runId] = runIds;
    if (runIds.length !== 1 || runId === undefined) {
      throw new Error(`Expected exactly one run in the organization, found ${runIds.length}`);
    }
    return runId;
  }

  async waitForCaptureComplete(): Promise<void> {
    await expect(this.card('Capture').value).toHaveText('complete', { timeout: captureTimeoutMs });
  }

  async waitForEmptyBuffer(): Promise<void> {
    await expect(this.card('Upload').detail).toHaveText('No buffered points', { timeout: uploadTimeoutMs });
  }

  // The number of points the current capture session has taken, from the Capture card ("segment 1 · 6 buffered").
  // It counts every point of the session, including those already uploaded, and starts again after a reload.
  async capturedCount(): Promise<number> {
    const text = (await this.card('Capture').detail.textContent()) ?? '';
    const match = /· (\d+) buffered$/.exec(text);
    if (match?.[1] === undefined) {
      throw new Error(`The Capture card does not show a captured count: "${text}"`);
    }
    return Number(match[1]);
  }

  // Reloads the page and waits until this tab owns the writer lease again. Whether the recording state comes
  // back is for the caller to assert afterwards; this method only waits for the lease.
  async reload(): Promise<void> {
    await this.page.reload();
    await expect(this.card('Writer').value).toHaveText('owned', { timeout: uploadTimeoutMs });
  }

  // Reloads without waiting for the lease: the reloaded page conflicts with its own unreleased lease until
  // that lease expires, which the caller then waits out with reclaimOwnership.
  async reloadWithoutOwnership(): Promise<void> {
    await this.page.reload();
    await expect(this.card('Writer').value).toHaveText('conflict', { timeout: uploadTimeoutMs });
  }

  // Clicks "Retry ownership" until the Writer card shows owned. The previous lease lasts up to 15 s after its
  // last renewal and nothing in the app retries on its own, so a click made too early only returns to conflict.
  async reclaimOwnership(): Promise<void> {
    const retry = this.page.getByRole('button', { name: 'Retry ownership' });
    await expect
      .poll(
        async () => {
          const state = await this.card('Writer').value.textContent();
          if (state !== 'owned' && (await retry.isVisible())) {
            // The notice disappears while a claim is in flight, so a click can lose that race; poll again.
            await retry.click({ timeout: 2_000 }).catch(() => undefined);
          }
          return state;
        },
        { intervals: [500, 1_000], timeout: leaseExpiryTimeoutMs },
      )
      .toBe('owned');
  }

  // A tab that opened while another tab owns the writer lease: the lease is in conflict, the alert says so, and
  // none of the lifecycle controls is usable (absent or disabled). Used for a tab that must not record.
  async expectReadOnly(): Promise<void> {
    await expect(this.card('Writer').value).toHaveText('conflict', { timeout: uploadTimeoutMs });
    await expect(this.page.getByRole('alert').filter({ hasText: 'Another tab may own recording' })).toBeVisible();
    for (const name of ['Pause', 'Finish']) {
      const button = this.page.getByRole('button', { exact: true, name });
      await expect
        .poll(async () => (await button.count()) === 0 || (await button.isDisabled()), { timeout: uploadTimeoutMs })
        .toBe(true);
    }
  }

  // The Upload card reads "N pending" while points wait for delivery; waits until N is at least the bound.
  async waitForPendingAtLeast(count: number): Promise<void> {
    const detail = this.card('Upload').detail;
    await expect
      .poll(
        async () => {
          const text = (await detail.textContent()) ?? '';
          const match = /^(\d+) pending$/.exec(text);
          return match?.[1] === undefined ? 0 : Number(match[1]);
        },
        { timeout: captureTimeoutMs },
      )
      .toBeGreaterThanOrEqual(count);
  }
}
