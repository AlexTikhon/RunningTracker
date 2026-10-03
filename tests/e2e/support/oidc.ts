import type { BrowserContext, Page } from '@playwright/test';

import { setSuiteUserIdentity } from './database.js';
import { expect, test as base } from './fixtures.js';
import type { E2eEnvironment } from './environment.js';

export const sessionCookieName = 'running_tracker_session';
export const loginCookieName = 'running_tracker_login';

// The provider subject of the provisioned person, and one nobody provisioned.
export const provisionedSubject = 'e2e-runner-subject';
export const unprovisionedSubject = 'e2e-nobody-subject';

interface OidcFixtures {
  // The scenario's runner, provisioned for sign-in the way the runbook describes: the stored identity is
  // `<issuer>|<subject>`. Restored afterwards so the shared user is left as the other specs expect it.
  readonly provisioned: { readonly orgId: string; readonly userId: string };
}

export const test = base.extend<OidcFixtures>({
  provisioned: async ({ environment, scenario }, use) => {
    await setSuiteUserIdentity(
      environment,
      scenario.runnerUserId,
      `${environment.oidc.providerOrigin}|${provisionedSubject}`,
    );
    try {
      await use({ orgId: scenario.orgId, userId: scenario.runnerUserId });
    } finally {
      await setSuiteUserIdentity(environment, scenario.runnerUserId, 'e2e|runner');
    }
  },
});

export { expect };

// The development login page imports a web font from Google. A test must not depend on the internet.
export async function blockExternalFonts(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//u, (route) => route.abort());
}

export interface CallbackRequests {
  /** Every URL the browser requested on the application's callback route, in order. */
  readonly urls: string[];
}

export function recordCallbackRequests(page: Page, environment: E2eEnvironment): CallbackRequests {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(environment.oidc.redirectUri)) {
      urls.push(request.url());
    }
  });
  return { urls };
}

export interface NavigationCookies {
  /** Each top-level navigation to the application, in order, and whether it carried the session cookie. */
  settled(): Promise<ReadonlyArray<{ readonly carriedSession: boolean; readonly url: string }>>;
}

/**
 * Records, for every top-level navigation to the application origin, whether the browser sent the session
 * cookie with it. The cookie is Strict, so this is the observable result of the cross-site hand-over.
 */
export function recordNavigationCookies(page: Page, environment: E2eEnvironment): NavigationCookies {
  const pending: Array<Promise<{ carriedSession: boolean; url: string }>> = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.url().startsWith(environment.oidc.webOrigin)) {
      pending.push(
        request.allHeaders().then((headers) => ({
          carriedSession: (headers['cookie'] ?? '').includes(`${sessionCookieName}=`),
          url: request.url(),
        })),
      );
    }
  });
  return { settled: () => Promise.all(pending) };
}

/**
 * Follows the Sign in link and signs in at the provider's development pages as a person would: a login
 * name (the provider turns it into the subject), then the consent step. Resolves when the browser is back
 * on the application.
 */
export async function signInAt(page: Page, environment: E2eEnvironment, subject: string): Promise<void> {
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.origin === environment.oidc.providerOrigin);
  await page.getByPlaceholder('Enter any login').fill(subject);
  await page.getByPlaceholder('and password').fill('not-checked-by-the-test-provider');
  await page.getByRole('button', { name: 'Sign-in' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // Back on an application page, not the callback itself: that response is only the hand-over page.
  await page.waitForURL(
    (url) => url.origin === environment.oidc.webOrigin && url.pathname !== '/api/auth/callback',
  );
}

/**
 * A request made by the page itself (fetch in the page), so it carries the browser's cookies exactly as the
 * application's own calls do. `context.request` is not used after sign-in: Playwright's request client does
 * not send a Secure cookie to an http origin, which a real Chromium does for a loopback origin.
 */
export async function pageFetch(
  page: Page,
  path: string,
  init?: { readonly headers?: Record<string, string>; readonly method?: string },
): Promise<{ readonly body: unknown; readonly status: number }> {
  return page.evaluate(
    async ({ path: target, init: options }) => {
      const response = await fetch(target, options);
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON (for example a 204): the text is returned as it is.
      }
      return { body, status: response.status };
    },
    { init, path },
  );
}
