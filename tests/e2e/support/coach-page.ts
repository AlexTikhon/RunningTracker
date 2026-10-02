import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export type CoachMarkerQuality = 'confirmed' | 'stale' | 'unavailable' | 'unconfirmed';

const qualities: readonly string[] = ['confirmed', 'stale', 'unavailable', 'unconfirmed'];

// The stream pushes a snapshot on every poll (2 s by default), and each one shows its server time to the second.
const snapshotTimeoutMs = 30_000;

// Page object for the Coach view. Every locator uses roles, labels or visible text only.
export class CoachPage {
  constructor(private readonly page: Page) {}

  async open(orgId: string): Promise<void> {
    await this.page.goto('/');
    await this.page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Coach' }).click();
    // The hidden Runner view has an input with the same label; a role query skips hidden elements.
    await this.page.getByRole('textbox', { name: 'Organization ID' }).fill(orgId);
  }

  // The connection indicator ("live", "connecting", ...). The hidden Runner view and the "enter an organization"
  // prerequisite also have role=status, but only this one has a span with the state in it.
  streamStatus(): Locator {
    return this.page.getByRole('status').filter({ has: this.page.locator('span') });
  }

  // The board's text for a live connection with no authorized active run.
  emptyBoard(): Locator {
    return this.page
      .getByLabel('Live run markers')
      .getByText('No active runs are currently shared with this identity.');
  }

  markers(): Locator {
    return this.page.getByLabel('Live run markers').getByRole('article');
  }

  async markerQuality(marker: Locator): Promise<CoachMarkerQuality> {
    const text = (await marker.locator('strong').textContent()) ?? '';
    if (!qualities.includes(text)) {
      throw new Error(`The marker shows an unknown quality: "${text}"`);
    }
    return text as CoachMarkerQuality;
  }

  trackOptions(): Locator {
    return this.page.getByLabel('Selected live tracks').getByRole('checkbox');
  }

  // The "N points · rev R" (or "rev R" / "syncing ...") text next to a track checkbox.
  trackLabel(option: Locator): Locator {
    return option.locator('xpath=ancestor::label').locator('small');
  }

  // The "N selected" counter at the top of the track picker.
  trackSelectionCount(): Locator {
    return this.page.getByLabel('Selected live tracks').getByText(/^\d+ selected$/);
  }

  // Waits until the stream has delivered `count` further snapshots, seen as the server time changing. Snapshot n+1
  // is read from the database after snapshot n was sent, so after two changes the page shows server state read
  // after the moment this method was called.
  async waitForSnapshots(count: number): Promise<void> {
    const serverTime = this.streamStatus().locator('small');
    let previous = await serverTime.textContent();
    let changes = 0;
    await expect
      .poll(
        async () => {
          const current = await serverTime.textContent();
          if (current !== null && current !== previous) {
            previous = current;
            changes += 1;
          }
          return changes;
        },
        { intervals: [250, 500], timeout: snapshotTimeoutMs },
      )
      .toBeGreaterThanOrEqual(count);
  }
}
