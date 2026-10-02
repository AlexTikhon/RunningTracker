import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { validateEnvironment } from '../config/environment.js';
import { apiErrorHandler } from '../http/errors.js';
import { requestIdMiddleware } from '../http/request-id.js';
import { createLogger, type LogLevel } from '../observability/logger.js';
import { oidcExternalIdentity } from './identity-resolver.js';
import { OidcLoginRejectedError, OidcProviderUnavailableError, type OidcClient } from './oidc-client.js';
import { createOidcRouter } from './oidc-http.js';
import { OidcLoginStore } from './oidc-login-store.js';
import { SessionManager } from './session-manager.js';
import { InMemorySessionStore } from './session-store.js';

const issuer = 'https://idp.example/realm';
const userId = '11111111-1111-4111-8111-111111111111';
const authorizationUrl = new URL('https://idp.example/realm/auth?client_id=running-tracker&state=s1');

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse('2026-10-02T10:00:00.000Z');
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date('2026-10-02T10:00:00.000Z');
  }
}

interface Harness {
  app: express.Express;
  client: { completions: Array<{ callbackUrl: string; pendingState: string }> };
  logs: string[];
  sessions: SessionManager;
}

function createHarness(
  options: {
    complete?: OidcClient['completeLogin'];
    begin?: OidcClient['beginLogin'];
    maxEntries?: number;
    resolve?: (identity: string) => Promise<string | undefined>;
    secureCookies?: boolean;
  } = {},
): Harness {
  const config = validateEnvironment({
    ALLOWED_ORIGINS: 'https://tracker.example',
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
    MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/test',
    OIDC_CLIENT_ID: 'running-tracker',
    OIDC_CLIENT_SECRET: 'client-secret-value',
    OIDC_ISSUER_URL: issuer,
    OIDC_POST_LOGIN_PATH: '/runner',
    OIDC_REDIRECT_URI: 'https://tracker.example/api/auth/callback',
    SESSION_COOKIE_SECURE: String(options.secureCookies ?? true),
    ...(options.maxEntries === undefined ? {} : { OIDC_STORE_MAX_ENTRIES: String(options.maxEntries) }),
  });
  const clock = new FixedClock();
  const sessions = new SessionManager({
    clock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    ttlMs: config.SESSION_TTL_MS,
  });
  const logs: string[] = [];
  const completions: Harness['client']['completions'] = [];
  let attempt = 0;
  const client: OidcClient = {
    beginLogin:
      options.begin ??
      (() => {
        attempt += 1;
        return Promise.resolve({
          authorizationUrl,
          pending: { codeVerifier: `verifier-${attempt}`, nonce: `nonce-${attempt}`, state: `state-${attempt}` },
        });
      }),
    completeLogin:
      options.complete ??
      ((callbackUrl, pending) => {
        completions.push({ callbackUrl: callbackUrl.toString(), pendingState: pending.state });
        return Promise.resolve({ issuer, subject: 'subject-1' });
      }),
  };
  const oidc = config.OIDC;
  if (!oidc) {
    throw new Error('OIDC configuration expected');
  }
  const app = express();
  app.use(requestIdMiddleware);
  app.use(
    '/api/auth',
    createOidcRouter({
      client,
      config,
      logger: createLogger({
        clock,
        write: (_level: LogLevel, line: string) => {
          logs.push(line);
        },
      }),
      loginStore: new OidcLoginStore({ clock, maxEntries: oidc.storeMaxEntries, ttlMs: oidc.loginTtlMs }),
      resolveIdentity:
        options.resolve ??
        ((identity) =>
          Promise.resolve(identity === oidcExternalIdentity(issuer, 'subject-1') ? userId : undefined)),
      sessionManager: sessions,
    }),
  );
  app.use(apiErrorHandler());
  return { app, client: { completions }, logs, sessions };
}

function cookieValue(response: request.Response, name: string): string | undefined {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  const match = header?.find((entry) => entry.startsWith(`${name}=`));
  return match?.split(';')[0]?.slice(name.length + 1);
}

function setCookieLines(response: request.Response): string[] {
  return (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
}

async function startLogin(harness: Harness): Promise<string> {
  const response = await request(harness.app).get('/api/auth/login').expect(302);
  const loginCookie = cookieValue(response, 'running_tracker_login');
  if (!loginCookie) {
    throw new Error('Expected a login cookie');
  }
  return loginCookie;
}

describe('OIDC login routes', () => {
  it('redirects to the provider and holds the attempt in a short-lived Lax cookie', async () => {
    const harness = createHarness();

    const response = await request(harness.app).get('/api/auth/login').expect(302);

    expect(response.headers.location).toBe(authorizationUrl.toString());
    expect(response.headers['cache-control']).toBe('no-store');
    const [cookie] = setCookieLines(response);
    expect(cookie).toMatch(/^running_tracker_login=[A-Za-z0-9_-]{43}; /u);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/auth');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Secure');
    expect(response.text).not.toContain('verifier');
  });

  it('completes a login: session cookie, no CSRF token in the URL, same-origin refresh to the app', async () => {
    const harness = createHarness();
    const loginCookie = await startLogin(harness);

    const response = await request(harness.app)
      .get('/api/auth/callback?code=abc&state=state-1&iss=x')
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(200);

    const session = setCookieLines(response).find((line) => line.startsWith('running_tracker_session='));
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Strict');
    expect(session).toContain('Secure');
    const sessionToken = session?.split(';')[0]?.slice('running_tracker_session='.length) ?? '';
    expect(harness.sessions.resolve(sessionToken)?.userId).toBe(userId);
    expect(setCookieLines(response).find((line) => line.startsWith('running_tracker_login='))).toContain(
      'Max-Age=0',
    );
    expect(response.headers['content-type']).toMatch(/^text\/html/u);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.text).toContain('<meta http-equiv="refresh" content="0;url=/runner">');
    expect(response.text).not.toContain(sessionToken);
    expect(harness.client.completions).toEqual([
      {
        callbackUrl: 'https://tracker.example/api/auth/callback?code=abc&state=state-1&iss=x',
        pendingState: 'state-1',
      },
    ]);
  });

  it('completes a callback only once', async () => {
    const harness = createHarness();
    const loginCookie = await startLogin(harness);
    const callback = () =>
      request(harness.app)
        .get('/api/auth/callback?code=abc&state=state-1')
        .set('Cookie', `running_tracker_login=${loginCookie}`);

    await callback().expect(200);
    const replay = await callback().expect(302);

    expect(replay.headers.location).toBe('/runner?sign_in_error=login_expired');
    expect(setCookieLines(replay).some((line) => line.startsWith('running_tracker_session='))).toBe(false);
  });

  it('fails closed without a login cookie, with a forged cookie, or with an oversized query', async () => {
    const harness = createHarness();
    const loginCookie = await startLogin(harness);

    for (const cookie of [undefined, 'running_tracker_login=forged', `running_tracker_login=${'a'.repeat(43)}`]) {
      const call = request(harness.app).get('/api/auth/callback?code=abc&state=state-1');
      const response = await (cookie ? call.set('Cookie', cookie) : call).expect(302);
      expect(response.headers.location).toBe('/runner?sign_in_error=login_expired');
    }
    const oversized = await request(harness.app)
      .get(`/api/auth/callback?code=${'x'.repeat(5_000)}`)
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(302);
    expect(oversized.headers.location).toBe('/runner?sign_in_error=denied');
    expect(harness.client.completions).toEqual([]);
  });

  it('reports a rejected provider response as denied and never creates a session', async () => {
    const harness = createHarness({
      complete: () => Promise.reject(new OidcLoginRejectedError('state mismatch')),
    });
    const loginCookie = await startLogin(harness);

    const response = await request(harness.app)
      .get('/api/auth/callback?error=access_denied&state=state-1')
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(302);

    expect(response.headers.location).toBe('/runner?sign_in_error=denied');
    expect(setCookieLines(response).some((line) => line.startsWith('running_tracker_session='))).toBe(false);
  });

  it('refuses an identity nobody provisioned, without creating a session or a user', async () => {
    const harness = createHarness({
      complete: () => Promise.resolve({ issuer, subject: 'stranger' }),
    });
    const loginCookie = await startLogin(harness);

    const response = await request(harness.app)
      .get('/api/auth/callback?code=abc&state=state-1')
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(302);

    expect(response.headers.location).toBe('/runner?sign_in_error=not_provisioned');
    expect(setCookieLines(response).some((line) => line.startsWith('running_tracker_session='))).toBe(false);
  });

  it('keys the identity by issuer and subject, so another issuer cannot reuse a subject', async () => {
    const seen: string[] = [];
    const harness = createHarness({
      complete: () => Promise.resolve({ issuer: 'https://evil.example', subject: 'subject-1' }),
      resolve: (identity) => {
        seen.push(identity);
        return Promise.resolve(undefined);
      },
    });
    const loginCookie = await startLogin(harness);

    await request(harness.app)
      .get('/api/auth/callback?code=abc&state=state-1')
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(302);

    expect(seen).toEqual(['https://evil.example|subject-1']);
  });

  it('reports an unreachable provider as 503 at login and as unavailable at the callback', async () => {
    const down = createHarness({
      begin: () => Promise.reject(new OidcProviderUnavailableError('discovery failed')),
    });
    const login = await request(down.app).get('/api/auth/login').expect(503);
    expect(login.body).toMatchObject({ error: { code: 'IDENTITY_PROVIDER_UNAVAILABLE' } });

    const harness = createHarness({
      complete: () => Promise.reject(new OidcProviderUnavailableError('token endpoint down')),
    });
    const loginCookie = await startLogin(harness);
    const callback = await request(harness.app)
      .get('/api/auth/callback?code=abc&state=state-1')
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(302);
    expect(callback.headers.location).toBe('/runner?sign_in_error=unavailable');
  });

  it('is bounded: a full pending-login store answers 503 instead of growing', async () => {
    const harness = createHarness({ maxEntries: 1 });
    await startLogin(harness);

    const response = await request(harness.app).get('/api/auth/login').expect(503);

    expect(response.body).toMatchObject({ error: { code: 'LOGIN_TEMPORARILY_UNAVAILABLE' } });
  });

  it('logs only an outcome code, never a code, token, subject, or provider message', async () => {
    const harness = createHarness({
      complete: () => Promise.reject(new OidcLoginRejectedError('secret-provider-detail')),
    });
    const loginCookie = await startLogin(harness);

    await request(harness.app)
      .get('/api/auth/callback?code=very-secret-code&state=state-1')
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(302);

    const output = harness.logs.join('\n');
    expect(output).toContain('auth.login.failed');
    expect(output).toContain('denied');
    for (const secret of ['very-secret-code', 'secret-provider-detail', 'subject-1', loginCookie, 'verifier']) {
      expect(output).not.toContain(secret);
    }
  });

  it('omits the Secure attribute only when the deployment explicitly allows plain HTTP', async () => {
    const harness = createHarness({ secureCookies: false });

    const response = await request(harness.app).get('/api/auth/login').expect(302);

    expect(setCookieLines(response)[0]).not.toContain('Secure');
  });
});
