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

// Page object for the Runner view. Every locator uses roles, labels or visible text only.
export class RunnerPage {
  constructor(private readonly page: Page) {}

  async open(orgId: string): Promise<void> {
    await this.page.goto('/');
    await this.page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Runner' }).click();
    await this.page.getByLabel('Organization ID').fill(orgId);
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
}
