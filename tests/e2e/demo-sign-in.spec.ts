import type { Page, Route } from '@playwright/test';

import { signIn } from './support/api.js';
import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// The local demo's sign-in buttons (apps/web/src/demo-sign-in.ts) on a dev server started with
// VITE_LOCAL_DEMO_ENABLED=true, as `npm run demo:up` starts it. The people are the fixed demo identities, created in the
// _test database by the demoScenario fixture; the development database and its seed are never touched.

const sessionPath = '/api/session';

function demoPanel(page: Page) {
  return page.getByRole('region', { name: 'Local demo sign-in' });
}

function demoButton(page: Page, name: 'Demo coach' | 'Demo runner') {
  return demoPanel(page).getByRole('button', { name });
}

// Signed in, and as exactly this person. The page shows only the first eight characters of the identity, which the
// two demo people share, so the exact ID is read from the session this browser context holds.
async function expectSignedInAs(page: Page, origin: string, userId: string): Promise<void> {
  await expectSignedIn(page, userId);
  const session = await page.request.get(`${origin}${sessionPath}`);
  expect(session.status()).toBe(200);
  expect(((await session.json()) as { identity: { userId: string } }).identity.userId).toBe(userId);
}

// Every request the page makes for its session, in order, as "METHOD body".
function recordSessionRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === sessionPath) {
      requests.push(`${request.method()} ${request.postData() ?? ''}`.trim());
    }
  });
  return requests;
}

const refusal = (code: string, message: string) => ({
  body: JSON.stringify({ error: { code, message, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }),
  contentType: 'application/json',
  status: 403,
});

test.describe('demo sign-in buttons', () => {
  test('are absent from a dev server without the flag, which still offers the normal sign-in', async ({ page }) => {
    const requests = recordSessionRequests(page);
    await page.goto('/');

    await expectSignedOut(page);
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/api/auth/login');
    await expect(demoPanel(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Demo / })).toHaveCount(0);
    expect(requests.every((request) => request.startsWith('GET'))).toBe(true);
  });

  test('sign in as the demo runner and then, after Sign out, as the demo coach, each with its organization', async ({
    demoScenario,
    environment,
    page,
  }) => {
    const requests = recordSessionRequests(page);
    await page.goto(environment.demoWebOrigin);
    await expectSignedOut(page);
    // The normal sign-in stays available next to the demo buttons.
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/api/auth/login');
    const checksBefore = requests.length;

    await demoButton(page, 'Demo runner').click();

    await expectSignedInAs(page, environment.demoWebOrigin, demoScenario.runnerUserId);
    await expectOrganizationSelected(page, demoScenario.orgId);
    // The button asked for the session; the page's own GET then established it.
    expect(requests.slice(checksBefore)).toEqual([`POST {"userId":"${demoScenario.runnerUserId}"}`, 'GET']);
    // Nobody can switch to the other demo person while signed in.
    await expect(demoPanel(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expectSignedOut(page);
    await expect(page.getByText(/You are signed out\./)).toBeVisible();

    await demoButton(page, 'Demo coach').click();

    await expectSignedInAs(page, environment.demoWebOrigin, demoScenario.coachUserId);
    await expectOrganizationSelected(page, demoScenario.orgId);
    expect(requests.filter((request) => request.startsWith('POST'))).toEqual([
      `POST {"userId":"${demoScenario.runnerUserId}"}`,
      `POST {"userId":"${demoScenario.coachUserId}"}`,
    ]);
    // The coach's own view opens for the discovered organization.
    await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Coach' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'An active session is required' })).toHaveCount(0);
  });

  test('disable both buttons while the request is pending, and send it once', async ({ demoScenario, environment, page }) => {
    const held: Route[] = [];
    await page.route(`**${sessionPath}`, async (route) => {
      if (route.request().method() === 'POST') {
        held.push(route);
        return;
      }
      await route.continue();
    });
    await page.goto(environment.demoWebOrigin);
    await expectSignedOut(page);

    await demoButton(page, 'Demo runner').click();

    await expect(demoButton(page, 'Demo runner')).toBeDisabled();
    await expect(demoButton(page, 'Demo coach')).toBeDisabled();
    await expect(demoPanel(page).getByRole('status')).toHaveText('Signing in as the demo runner…');
    await expect.poll(() => held.length).toBe(1);

    await held[0]?.continue();

    await expectSignedInAs(page, environment.demoWebOrigin, demoScenario.runnerUserId);
    expect(held).toHaveLength(1);
  });

  test('say why a sign-in failed, keep the person signed out, and let them try again', async ({
    context,
    demoScenario,
    environment,
    page,
  }) => {
    const answers: Array<'abort' | 'refuse'> = ['abort', 'refuse'];
    await page.route(`**${sessionPath}`, async (route) => {
      const answer = route.request().method() === 'POST' ? answers.shift() : undefined;
      if (answer === 'abort') await route.abort('failed');
      else if (answer === 'refuse') await route.fulfill(refusal('LOCAL_IDENTITY_DENIED', 'The local identity is not allowed'));
      else await route.continue();
    });
    await page.goto(environment.demoWebOrigin);
    await expectSignedOut(page);

    await demoButton(page, 'Demo coach').click();
    await expect(demoPanel(page).getByRole('alert')).toContainText('Could not sign in as the demo coach. The server could not be reached.');
    await expect(demoButton(page, 'Demo coach')).toBeEnabled();
    await expect(demoButton(page, 'Demo runner')).toBeEnabled();

    await demoButton(page, 'Demo coach').click();
    await expect(demoPanel(page).getByRole('alert')).toContainText('LOCAL_AUTH_USER_IDS');
    await expectSignedOut(page);
    expect((await context.cookies()).some((cookie) => cookie.name === 'running_tracker_session')).toBe(false);

    await demoButton(page, 'Demo coach').click();
    await expectSignedInAs(page, environment.demoWebOrigin, demoScenario.coachUserId);
    await expectOrganizationSelected(page, demoScenario.orgId);
  });

  test('a late answer for a sign-in the page has moved on from changes nothing', async ({
    context,
    demoScenario,
    environment,
    page,
  }) => {
    const held: Route[] = [];
    await page.route(`**${sessionPath}`, async (route) => {
      if (route.request().method() === 'POST') {
        held.push(route);
        return;
      }
      await route.continue();
    });
    const requests = recordSessionRequests(page);
    await page.goto(environment.demoWebOrigin);
    await expectSignedOut(page);
    await demoButton(page, 'Demo runner').click();
    await expect.poll(() => held.length).toBe(1);

    // Meanwhile the coach signs in by another route (here the API itself), and the page's session check finds them.
    const abandoned = page.waitForEvent(
      'requestfailed',
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === sessionPath,
    );
    await signIn(context, environment, demoScenario.coachUserId);
    await page.getByRole('button', { name: 'Retry session' }).click();
    await expectSignedInAs(page, environment.demoWebOrigin, demoScenario.coachUserId);
    await expect(demoPanel(page)).toHaveCount(0);
    // The superseded request was cancelled by the page, so its answer can no longer reach it.
    await abandoned;
    const checks = requests.filter((request) => request === 'GET').length;

    await held[0]?.fulfill({ body: '{}', contentType: 'application/json', status: 201 }).catch(() => undefined);
    await page.waitForTimeout(500);

    await expectSignedInAs(page, environment.demoWebOrigin, demoScenario.coachUserId);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // No session check was started on its behalf.
    expect(requests.filter((request) => request === 'GET').length).toBe(checks);
  });

  test('wait for a session check that answers before offering an identity', async ({ demoScenario, environment, page }) => {
    let unreachable = true;
    await page.route(`**${sessionPath}`, async (route) => {
      if (unreachable && route.request().method() === 'GET') await route.abort('failed');
      else await route.continue();
    });
    await page.goto(environment.demoWebOrigin);

    await expect(page.getByText(/could not be reached to check your session/)).toBeVisible();
    await expect(demoButton(page, 'Demo runner')).toBeDisabled();
    await expect(demoButton(page, 'Demo coach')).toBeDisabled();
    await expect(demoPanel(page)).toContainText('Press Retry session first.');

    unreachable = false;
    await page.getByRole('button', { name: 'Retry session' }).click();
    await expect(demoButton(page, 'Demo runner')).toBeEnabled();
    await demoButton(page, 'Demo runner').click();
    await expectSignedInAs(page, environment.demoWebOrigin, demoScenario.runnerUserId);
  });
});
