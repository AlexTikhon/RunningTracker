import type { Cookie } from '@playwright/test';

import {
  blockExternalFonts,
  expect,
  loginCookieName,
  pageFetch,
  provisionedSubject,
  recordCallbackRequests,
  recordNavigationCookies,
  sessionCookieName,
  signInAt,
  test,
  unprovisionedSubject,
} from '../support/oidc.js';

function findCookie(cookies: readonly Cookie[], name: string): Cookie | undefined {
  return cookies.find((cookie) => cookie.name === name);
}

test.beforeEach(async ({ context }) => {
  await blockExternalFonts(context);
});

test.describe('OpenID Connect sign-in in a real browser', () => {
  test('an anonymous visitor is asked to sign in and no local session can be created', async ({
    environment,
    page,
    provisioned,
  }) => {
    await page.goto('/');

    await expect(page.getByText('Sign in required')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/api/auth/login');

    const origin = environment.oidc.webOrigin;
    const session = await page.request.get(`${origin}/api/session`);
    expect(session.status()).toBe(401);
    // Production has no local session endpoint, and neither has this stack.
    const local = await page.request.post(`${origin}/api/session`, {
      data: { userId: provisioned.userId },
      headers: { origin },
    });
    expect(local.status()).toBe(404);
  });

  test('signing in at a provider on another site returns to a ready session', async ({
    context,
    environment,
    page,
    provisioned,
  }) => {
    const callbacks = recordCallbackRequests(page, environment);
    const navigations = recordNavigationCookies(page, environment);
    await page.goto('/');

    await signInAt(page, environment, provisionedSubject);

    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
    // Back on the plain application path: nothing from the callback remains in the address bar.
    expect(page.url()).toBe(`${environment.oidc.webOrigin}/`);
    expect(callbacks.urls).toHaveLength(1);

    // The session cookie is Strict and the callback was reached from another site, so the callback response is a
    // page that navigates onward itself. The navigation it starts is a same-site one and carries the cookie. (A
    // plain 302 from the callback would not: Chromium withholds a Strict cookie along a cross-site redirect
    // chain, so the document request would go out without it.)
    const sequence = await navigations.settled();
    expect(sequence.map((entry) => `${new URL(entry.url).pathname} ${String(entry.carriedSession)}`)).toEqual([
      '/ false',
      '/api/auth/login false',
      '/api/auth/callback false',
      '/ true',
    ]);

    // Not filtered by URL: Playwright leaves a Secure cookie out of a lookup for an http URL.
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === sessionCookieName);
    expect(session).toMatchObject({ httpOnly: true, path: '/', sameSite: 'Strict', secure: true });
    // The single-use login cookie was cleared by the callback.
    expect(cookies.find((cookie) => cookie.name === loginCookieName)).toBeUndefined();
    // Script cannot read the session.
    expect(await page.evaluate(() => document.cookie)).not.toContain(sessionCookieName);

    // The cookie travels with the page's own requests: a tenant read under row-level security succeeds for the
    // provisioned member and not for an organization the person does not belong to.
    const range = 'from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z';
    const own = await pageFetch(page, `/api/orgs/${provisioned.orgId}/runs?${range}`);
    expect(own.status).toBe(200);
    const foreign = await pageFetch(page, `/api/orgs/00000000-0000-4000-8000-000000000000/runs?${range}`);
    expect(foreign.status).toBe(403);
  });

  test('an identity nobody provisioned gets a fixed message and no session', async ({
    context,
    environment,
    page,
  }) => {
    await page.goto('/');

    await signInAt(page, environment, unprovisionedSubject);

    await expect(page.getByRole('alert')).toContainText('Your account is not set up for this service yet');
    // The failure code was removed from the address bar, so a reload does not repeat the message.
    expect(page.url()).toBe(`${environment.oidc.webOrigin}/`);
    expect(findCookie(await context.cookies(), sessionCookieName)).toBeUndefined();
    await page.reload();
    await expect(page.getByText('Sign in required')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a replayed callback is refused and leaves the existing session as it was', async ({
    context,
    environment,
    page,
    provisioned,
  }) => {
    const callbacks = recordCallbackRequests(page, environment);
    await page.goto('/');
    await signInAt(page, environment, provisionedSubject);
    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
    const before = findCookie(await context.cookies(), sessionCookieName);
    const replayUrl = callbacks.urls[0];
    expect(replayUrl).toBeDefined();

    const answered = page.waitForResponse((response) => response.url() === replayUrl);
    await page.goto(replayUrl as string);
    const response = await answered;

    // The login attempt was single use: the second presentation has nothing to complete.
    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe('/?sign_in_error=login_expired');
    expect(findCookie(await context.cookies(), sessionCookieName)?.value).toBe(before?.value);
  });

  test('a callback opened in a browser that did not start the sign-in is refused', async ({
    browser,
    environment,
    page,
    provisioned,
  }) => {
    const callbacks = recordCallbackRequests(page, environment);
    await page.goto('/');
    await signInAt(page, environment, provisionedSubject);
    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
    const callbackUrl = callbacks.urls[0] as string;

    // Someone else's browser: no login cookie, no session.
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage();
      await otherPage.goto(callbackUrl);

      await expect(otherPage.getByRole('alert')).toContainText('took too long or was started in another browser');
      expect(findCookie(await other.cookies(), sessionCookieName)).toBeUndefined();
    } finally {
      await other.close();
    }
  });

  test('a callback whose state was altered is refused, and signing in again works', async ({
    context,
    environment,
    page,
    provisioned,
  }) => {
    // The authorization request leaves the application with a different `state`, so the provider returns that
    // value and the callback carries a state this login never issued (what a login-CSRF attempt looks like).
    // Playwright cannot rewrite a request that is itself a redirect target, so the application's own redirect
    // response is the place to alter it.
    const loginRoute = '**/api/auth/login';
    await page.route(loginRoute, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const authorization = new URL(response.headers()['location'] as string);
      authorization.searchParams.set('state', 'altered-by-the-test');
      await route.fulfill({
        headers: { ...response.headers(), location: authorization.toString() },
        response,
      });
    });
    await page.goto('/');

    await signInAt(page, environment, provisionedSubject);

    await expect(page.getByRole('alert')).toContainText('did not confirm your sign-in');
    expect(findCookie(await context.cookies(), sessionCookieName)).toBeUndefined();

    // The failed attempt used up its login record; a fresh attempt is independent of it. The provider still
    // knows this browser, so it answers without asking for a login again.
    await page.unroute(loginRoute);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
  });

  test('cancelling at the provider returns to the application with a fixed message and no session', async ({
    context,
    environment,
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.origin === environment.oidc.providerOrigin);

    await page.getByRole('link', { name: '[ Cancel ]' }).click();

    await expect(page.getByRole('alert')).toContainText('did not confirm your sign-in');
    expect(findCookie(await context.cookies(), sessionCookieName)).toBeUndefined();
  });

  test('signing out clears the cookie in the browser; the provider session is not ended', async ({
    context,
    environment,
    page,
    provisioned,
  }) => {
    await page.goto('/');
    await signInAt(page, environment, provisionedSubject);
    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
    const session = await pageFetch(page, '/api/session');
    const { csrf } = session.body as { csrf: { headerName: string; token: string } };

    const signedOut = await pageFetch(page, '/api/session', {
      headers: { [csrf.headerName]: csrf.token },
      method: 'DELETE',
    });

    expect(signedOut.status).toBe(204);
    // Removed from the real cookie jar: the clearing Set-Cookie matches the attributes it was set with.
    expect(findCookie(await context.cookies(), sessionCookieName)).toBeUndefined();
    expect((await pageFetch(page, '/api/session')).status).toBe(401);
    await page.reload();
    await expect(page.getByText('Sign in required')).toBeVisible();

    // The sign-out is the application's only: the provider still has this browser's session and consent, so the
    // next sign-in completes without asking for a login (no RP-initiated logout, documented in ADR-0046).
    const interactions: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(`${environment.oidc.providerOrigin}/interaction/`)) {
        interactions.push(request.url());
      }
    });
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
    expect(interactions).toHaveLength(0);
  });

  test('an expired session is refused by the server and the person can sign in again', async ({
    context,
    environment,
    page,
    provisioned,
  }) => {
    await page.goto('/');
    await signInAt(page, environment, provisionedSubject);
    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
    const token = findCookie(await context.cookies(), sessionCookieName)?.value;
    expect(token).toBeDefined();
    const first = (await pageFetch(page, '/api/session')).body as { expiresAt: string };

    // The lifetime is the stack's SESSION_TTL_MS (20 s): poll the real behaviour instead of sleeping.
    await expect
      .poll(async () => (await pageFetch(page, '/api/session')).status, { intervals: [500], timeout: 40_000 })
      .toBe(401);
    // Not only the browser dropping its cookie at Max-Age: the server refuses the old token itself.
    const replayed = await page.request.get(`${environment.oidc.webOrigin}/api/session`, {
      headers: { cookie: `${sessionCookieName}=${token as string}` },
    });
    expect(replayed.status()).toBe(401);

    await page.reload();
    await expect(page.getByText('Sign in required')).toBeVisible();
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByText(`Session ready · user ${provisioned.userId.slice(0, 8)}`)).toBeVisible();
    const second = (await pageFetch(page, '/api/session')).body as { expiresAt: string };
    expect(Date.parse(second.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
  });
});
