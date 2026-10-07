import { authedApi, signIn } from './support/api.js';
import { CoachPage } from './support/coach-page.js';
import { setMembershipActive } from './support/database.js';
import { expect, test } from './support/fixtures.js';
import { RunnerPage } from './support/runner-page.js';
import {
  expectOrganizationChosen,
  expectOrganizationSelected,
  expectSignedIn,
  organizationRegion,
} from './support/session.js';

interface OrganizationList {
  readonly items: ReadonlyArray<{ readonly organizationId: string }>;
}

const rememberedKey = (userId: string): string => `running-tracker.organization.${userId}`;

test.describe('organization discovery in the browser', () => {
  test('the only organization is selected on its own, nothing asks for an identifier, and every view uses it', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');

    await expectSignedIn(page, scenario.runnerUserId);
    await expectOrganizationSelected(page, scenario.orgId);
    // No field asks for an identifier, and with one organization there is nothing to choose from either.
    await expect(page.getByLabel('Organization ID')).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(organizationRegion(page).getByRole('combobox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();

    const listed = await context.request.get(`${environment.webOrigin}/api/organizations`);
    expect(listed.status()).toBe(200);
    expect(((await listed.json()) as OrganizationList).items).toEqual([{ organizationId: scenario.orgId }]);

    const views = page.getByRole('navigation', { name: 'Application view' });
    await views.getByRole('button', { name: 'Coach' }).click();
    await expect(new CoachPage(page).streamStatus()).toContainText('live');
    await expectOrganizationSelected(page, scenario.orgId);

    await views.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByRole('heading', { name: /Finished runs/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'ready' })).toBeVisible();

    await views.getByRole('button', { name: 'Runner' }).click();
    await expectOrganizationSelected(page, scenario.orgId);
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
  });

  test('several organizations are offered, an unauthorized or inactive one is not, and the choice is the one used', async ({
    context,
    environment,
    organizations,
    page,
    scenario,
  }) => {
    const second = await organizations.memberOf(scenario.runnerUserId);
    const foreign = await organizations.foreign();
    const inactive = await organizations.inactiveFor(scenario.runnerUserId);
    await signIn(context, environment, scenario.runnerUserId);
    const api = await authedApi(context, environment);

    await page.goto('/');
    await expectSignedIn(page, scenario.runnerUserId);

    // Two memberships and no way to know which is meant: nothing is chosen, and nothing can be started.
    const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });
    await expect(picker).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
    await expect(page.getByText('Choose an organization to continue.')).toBeVisible();

    // Exactly the active memberships, in the server's order; the organization the person is not in is absent,
    // and so is the one whose membership was deactivated.
    const offered = await picker.locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== ''),
    );
    expect(offered).toEqual([scenario.orgId, second].sort());
    expect(offered).not.toContain(foreign);
    expect(offered).not.toContain(inactive);
    const listed = (await (await context.request.get(`${environment.webOrigin}/api/organizations`)).json()) as OrganizationList;
    expect(listed.items.map((item) => item.organizationId)).toEqual(offered);
    // The server refuses the foreign organization itself, so the page being tidy is not what protects it.
    const refused = await context.request.get(
      `${environment.webOrigin}/api/orgs/${foreign}/runs?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`,
    );
    expect(refused.status()).toBe(403);

    // The choice follows the person through the views and through a reload.
    await picker.selectOption(second);
    await expectOrganizationChosen(page, second);
    await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Coach' }).click();
    await expect(new CoachPage(page).streamStatus()).toContainText('live');
    await expectOrganizationChosen(page, second);
    await page.reload();
    await expectOrganizationChosen(page, second);

    // A run is recorded and uploaded in the organization that was chosen when it started.
    await picker.selectOption(scenario.orgId);
    const runner = new RunnerPage(page);
    await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Runner' }).click();
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    // While a run exists it belongs to its organization: switching is off, and says why.
    await expect(picker).toBeDisabled();
    await expect(page.getByText('Finish and clear the current run to switch organization.')).toBeVisible();
    await runner.waitForCaptureComplete();
    await runner.waitForEmptyBuffer();
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    expect(await api.listRunIds(scenario.orgId)).toHaveLength(1);
    expect(await api.listRunIds(second)).toEqual([]);
  });

  test('a remembered organization is used only while it is still one of the memberships', async ({
    context,
    environment,
    organizations,
    page,
    scenario,
  }) => {
    const second = await organizations.memberOf(scenario.runnerUserId);
    const foreign = await organizations.foreign();
    await signIn(context, environment, scenario.runnerUserId);
    await page.goto('/');
    await expectSignedIn(page, scenario.runnerUserId);
    const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });

    // Remembered and still a membership: restored.
    await page.evaluate(([key, value]) => localStorage.setItem(key as string, value as string), [
      rememberedKey(scenario.runnerUserId),
      second,
    ]);
    await page.reload();
    await expectOrganizationChosen(page, second);

    // Remembered but no longer (or never) a membership: ignored, and the person is asked again.
    await page.evaluate(([key, value]) => localStorage.setItem(key as string, value as string), [
      rememberedKey(scenario.runnerUserId),
      foreign,
    ]);
    await page.reload();
    await expect(picker).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  });

  test('a person with no active membership gets a plain explanation, not an error', async ({
    context,
    environment,
    page,
    scenario,
  }) => {
    await setMembershipActive(environment, scenario.orgId, scenario.coachUserId, false);
    await signIn(context, environment, scenario.coachUserId);

    const listed = await context.request.get(`${environment.webOrigin}/api/organizations`);
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toEqual({ items: [] });

    await page.goto('/');
    await expectSignedIn(page, scenario.coachUserId);
    // An empty list is a status, not a region to choose from, and not an alert.
    const empty = page.getByRole('status', { name: 'Organization' });
    await expect(empty.getByText('No organization yet')).toBeVisible();
    await expect(empty.getByText(/Ask the organizer/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Coach' }).click();
    // The hidden Runner view says the same next to its Start button; the role query skips it.
    await expect(page.getByRole('status').filter({ hasText: 'You are not a member of any organization yet.' })).toBeVisible();
  });
});
