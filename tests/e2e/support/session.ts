import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// What a person sees once signed in: "Signed in" and a Sign out button. The identity is a developer diagnostic
// behind a "Session details" disclosure, which is opened here only when a test needs to tell who is signed in.
export async function expectSignedIn(page: Page, userId?: string): Promise<void> {
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  if (userId !== undefined) {
    const identity = page.getByText(`user ${userId.slice(0, 8)}`);
    if (!(await identity.isVisible())) {
      await page.getByText('Session details', { exact: true }).click();
    }
    await expect(identity).toBeVisible();
  }
}

// The signed-out screen: the notice with its Sign in link, no Sign out, and no identity left on the page.
export async function expectSignedOut(page: Page): Promise<void> {
  await expect(page.getByText('Sign in required', { exact: true })).toBeVisible();
  await expect(page.getByText('Not signed in', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
}

// The organization picker's region. The server reports identifiers only, so a person sees the start of one.
export function organizationRegion(page: Page) {
  return page.getByRole('region', { name: 'Organization' });
}

// The one organization the person belongs to is selected without any click or typing.
export async function expectOrganizationSelected(page: Page, orgId: string): Promise<void> {
  await expect(organizationRegion(page).getByText(orgId.slice(0, 8))).toBeVisible();
}

// With several organizations the picker is a select, and the chosen one is its value.
export async function expectOrganizationChosen(page: Page, orgId: string): Promise<void> {
  await expect(organizationRegion(page).getByRole('combobox', { name: 'Organization' })).toHaveValue(orgId);
}
