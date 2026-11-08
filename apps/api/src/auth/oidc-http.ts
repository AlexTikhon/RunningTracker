import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';

import type { Environment } from '../config/environment.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../observability/logger.js';
import { describeError } from '../observability/logger.js';
import { oidcExternalIdentity, type IdentityResolver } from './identity-resolver.js';
import { OidcLoginRejectedError, OidcProviderUnavailableError, type OidcClient } from './oidc-client.js';
import {
  OidcLoginStoreCapacityError,
  OidcLoginStoreUnavailableError,
  type PendingLogin,
  type PendingLoginStore,
} from './pending-login-store.js';
import { parseCookie, sessionCookie } from './session-http.js';
import type { SessionManager } from './session-manager.js';

export const loginCookieName = 'running_tracker_login';

/** What the browser is told when a login does not complete; deliberately a closed set. */
export type SignInFailure = 'denied' | 'login_expired' | 'not_provisioned' | 'unavailable';

const maximumCallbackQueryLength = 4_096;

export interface OidcRouterDependencies {
  client: OidcClient;
  config: Environment;
  logger: Logger;
  /** PostgreSQL in the API process (ADR-0081); an explicit in-memory store in unit tests. Never a fallback. */
  loginStore: PendingLoginStore;
  resolveIdentity: IdentityResolver;
  sessionManager: SessionManager;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function loginCookie(loginId: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${loginCookieName}=${loginId}`,
    'HttpOnly',
    // Lax, not Strict: the provider sends the browser back with a cross-site top-level GET.
    'SameSite=Lax',
    'Path=/api/auth',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function clearedLoginCookie(secure: boolean): string {
  return [
    `${loginCookieName}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/api/auth',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function createOidcRouter({
  client,
  config,
  logger,
  loginStore,
  resolveIdentity,
  sessionManager,
}: OidcRouterDependencies): Router {
  const oidc = config.OIDC;
  if (!oidc) {
    throw new Error('OIDC routes require OIDC configuration');
  }
  const secure = config.SESSION_COOKIE_SECURE;
  const router = createRouter();
  // Process-wide admission, including provider work still in flight. Client IP
  // limiting belongs to nginx's direct socket boundary, never forwarded headers.
  const initiations: number[] = [];
  let inFlight = 0;

  const failureLocation = (failure: SignInFailure): string => {
    const target = new URL(oidc.postLoginPath, 'http://localhost');
    target.searchParams.set('sign_in_error', failure);
    return `${target.pathname}${target.search}`;
  };

  const fail = (response: Response, failure: SignInFailure, error?: unknown): void => {
    logger.warn('auth.login.failed', {
      reason: failure,
      ...(error === undefined ? {} : describeError(error)),
    });
    response.redirect(302, failureLocation(failure));
  };

  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/login', async (request, response) => {
    const now = Date.now();
    while (initiations[0] !== undefined && initiations[0] <= now - 60_000) initiations.shift();
    if (inFlight >= 5 || initiations.length >= 30) {
      response.setHeader('Retry-After', '60');
      throw new ApiError(429, 'LOGIN_RATE_LIMITED', 'Too many sign-in attempts; retry shortly');
    }
    initiations.push(now);
    inFlight += 1;
    let loginId: string | undefined;
    try {
      // Capacity is taken before the provider is contacted, so a full store never starts provider work. No database
      // connection or transaction is held while discovery runs: each store call is one short statement.
      loginId = await loginStore.reserve(parseCookie(request.header('cookie'), loginCookieName));
      const { authorizationUrl, pending } = await client.beginLogin();
      // False when the reservation expired during discovery, or this browser replaced or used it meanwhile.
      if (!(await loginStore.completeReservation(loginId, pending))) {
        throw new OidcLoginStoreCapacityError();
      }
      response.setHeader(
        'Set-Cookie',
        loginCookie(loginId, Math.max(1, Math.floor(oidc.loginTtlMs / 1_000)), secure),
      );
      response.redirect(302, authorizationUrl.toString());
    } catch (error) {
      if (loginId !== undefined) {
        // Frees the slot now; if the store cannot answer, the reservation still expires on its own.
        await loginStore.cancel(loginId).catch((cancelError: unknown) => {
          logger.warn('auth.login.cancel_failed', describeError(cancelError));
        });
      }
      if (error instanceof OidcProviderUnavailableError) {
        logger.warn('auth.login.failed', { reason: 'provider_unavailable', ...describeError(error) });
        throw new ApiError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'The identity provider is unavailable');
      }
      if (error instanceof OidcLoginStoreCapacityError) {
        logger.warn('auth.login.failed', { reason: 'store_full' });
        throw new ApiError(503, 'LOGIN_TEMPORARILY_UNAVAILABLE', 'Sign-in is temporarily unavailable');
      }
      if (error instanceof OidcLoginStoreUnavailableError) {
        // The same answer as a full store for the browser; the log tells an outage from a full store.
        logger.warn('auth.login.failed', { reason: 'store_unavailable', ...describeError(error) });
        response.setHeader('Retry-After', '5');
        throw new ApiError(503, 'LOGIN_TEMPORARILY_UNAVAILABLE', 'Sign-in is temporarily unavailable');
      }
      throw error;
    } finally {
      inFlight -= 1;
    }
  });

  router.get('/callback', async (request: Request, response: Response) => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    // The attempt is single use whatever happens next, and its cookie is always cleared.
    const loginId = parseCookie(request.header('cookie'), loginCookieName);
    response.setHeader('Set-Cookie', clearedLoginCookie(secure));
    if (loginId === undefined) {
      fail(response, 'login_expired');
      return;
    }
    // Consumed BEFORE any provider work, atomically across instances: of two callbacks for one login, at most one
    // receives it and reaches the token exchange. A store that cannot answer is not an expired login: the sign-in
    // fails as unavailable. Its outcome may be uncertain (the removal may have committed), so the exchange is never
    // attempted and never retried; the person starts a new sign-in (at most once, ADR-0081).
    let pending: PendingLogin | undefined;
    try {
      pending = await loginStore.consume(loginId);
    } catch (error) {
      fail(response, 'unavailable', error);
      return;
    }
    if (pending === undefined) {
      fail(response, 'login_expired');
      return;
    }

    // The URL the provider was told about, plus only the query it sent back: never the Host header.
    const callbackUrl = new URL(oidc.redirectUri);
    callbackUrl.search = new URL(request.originalUrl, 'http://localhost').search;
    if (callbackUrl.search.length > maximumCallbackQueryLength) {
      fail(response, 'denied');
      return;
    }

    let userId: string | undefined;
    try {
      const identity = await client.completeLogin(callbackUrl, pending);
      userId = await resolveIdentity(oidcExternalIdentity(identity.issuer, identity.subject));
    } catch (error) {
      fail(response, error instanceof OidcLoginRejectedError ? 'denied' : 'unavailable', error);
      return;
    }
    if (userId === undefined) {
      fail(response, 'not_provisioned');
      return;
    }

    // A full or unreachable session store ends the attempt as `unavailable`; nothing is stored, no cookie is set.
    let created;
    try {
      created = await sessionManager.create(userId);
    } catch (error) {
      fail(response, 'unavailable', error);
      return;
    }
    logger.info('auth.login.succeeded', { outcome: 'session_created' });
    response.setHeader('Set-Cookie', [clearedLoginCookie(secure), sessionCookie(created.sessionToken, config)]);
    // Not a 302: the browser reached this response from another site, and a redirect chain started
    // there would still count as cross-site, so the Strict session cookie would not be sent to the
    // app. A same-origin navigation from this page does send it.
    const target = escapeHtml(oidc.postLoginPath);
    response.status(200).type('html').setHeader('Content-Security-Policy', "default-src 'none'");
    response.send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        `<meta http-equiv="refresh" content="0;url=${target}"><title>Signing in</title></head>` +
        `<body><a href="${target}">Continue</a></body></html>`,
    );
  });

  return router;
}
