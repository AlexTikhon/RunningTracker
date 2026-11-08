import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from '../clock.js';
import { validateEnvironment } from '../config/environment.js';
import { apiErrorHandler } from '../http/errors.js';
import { requestIdMiddleware } from '../http/request-id.js';
import { createLogger, type LogLevel } from '../observability/logger.js';
import { oidcExternalIdentity } from './identity-resolver.js';
import { OidcLoginRejectedError, OidcProviderUnavailableError, type OidcClient } from './oidc-client.js';
import { createOidcRouter } from './oidc-http.js';
import { InMemoryPendingLoginStore } from '../testing/in-memory-pending-logins.js';
import { OidcLoginStoreUnavailableError, type PendingLoginStore } from './pending-login-store.js';
import { SessionManager } from './session-manager.js';
import { InMemorySessionStore } from './session-store.js';

const issuer = 'https://idp.example/realm';
const userId = '11111111-1111-4111-8111-111111111111';
const authorizationUrl = new URL('https://idp.example/realm/auth?client_id=running-tracker&state=s1');

class FixedClock implements Clock {
  public now = Date.parse('2026-10-02T10:00:00.000Z');
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return this.now;
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.now);
  }
}

interface Harness {
  clock: FixedClock;
  app: express.Express;
  client: { completions: Array<{ callbackUrl: string; pendingState: string }> };
  loginStore: PendingLoginStore;
  logs: string[];
  sessions: SessionManager;
}

function createHarness(
  options: {
    complete?: OidcClient['completeLogin'];
    begin?: OidcClient['beginLogin'];
    /** Wraps the in-memory store, e.g. to make one of its operations fail like an unreachable database. */
    wrapStore?: (store: PendingLoginStore) => PendingLoginStore;
    maxEntries?: number;
    resolve?: (identity: string) => Promise<string | undefined>;
    secureCookies?: boolean;
    sessionMaxEntries?: number;
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
    ...(options.sessionMaxEntries === undefined ? {} : { SESSION_STORE_MAX_ENTRIES: String(options.sessionMaxEntries) }),
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
  const memory = new InMemoryPendingLoginStore({ capacity: oidc.storeMaxEntries, clock, ttlMs: oidc.loginTtlMs });
  const loginStore = options.wrapStore ? options.wrapStore(memory) : memory;
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
      loginStore,
      resolveIdentity:
        options.resolve ??
        ((identity) =>
          Promise.resolve(identity === oidcExternalIdentity(issuer, 'subject-1') ? userId : undefined)),
      sessionManager: sessions,
    }),
  );
  app.use(apiErrorHandler());
  return { app, clock, client: { completions }, loginStore, logs, sessions };
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

afterEach(() => vi.useRealTimers());

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
    expect((await harness.sessions.resolve(sessionToken))?.userId).toBe(userId);
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

  it('fails a callback as unavailable when the session store is full of live sessions, and signs nobody out (ADR-0075)', async () => {
    const harness = createHarness({ sessionMaxEntries: 1 });
    const signedIn = await harness.sessions.create(userId);
    const loginCookie = await startLogin(harness);

    const callback = await request(harness.app)
      .get('/api/auth/callback?code=abc&state=state-1')
      .set('Cookie', `running_tracker_login=${loginCookie}`)
      .expect(302);

    expect(callback.headers.location).toBe('/runner?sign_in_error=unavailable');
    expect(setCookieLines(callback).some((line) => line.startsWith('running_tracker_session='))).toBe(false);
    expect((await harness.sessions.resolve(signedIn.sessionToken))?.userId).toBe(userId);

    // Once the existing session has expired, the next sign-in takes its slot.
    harness.clock.now = signedIn.record.expiresAt.getTime();
    const retryCookie = await startLogin(harness);
    const retry = await request(harness.app)
      .get('/api/auth/callback?code=abc&state=state-2')
      .set('Cookie', `running_tracker_login=${retryCookie}`)
      .expect(200);
    expect(setCookieLines(retry).some((line) => line.startsWith('running_tracker_session='))).toBe(true);
    expect(await harness.sessions.resolve(signedIn.sessionToken)).toBeUndefined();
  });

  it('is bounded: a full pending-login store answers 503 instead of growing', async () => {
    const harness = createHarness({ maxEntries: 1 });
    await startLogin(harness);

    const response = await request(harness.app).get('/api/auth/login').expect(503);

    expect(response.body).toMatchObject({ error: { code: 'LOGIN_TEMPORARILY_UNAVAILABLE' } });
  });

  it('replaces this browser attempt even at capacity, and consumes only the replacement callback', async () => {
    const harness = createHarness({ maxEntries: 1 });
    const first = await startLogin(harness);
    const replacement = await request(harness.app).get('/api/auth/login').set('Cookie', `running_tracker_login=${first}`).expect(302);
    const second = cookieValue(replacement, 'running_tracker_login');
    expect(second).not.toBe(first);
    const stale = await request(harness.app).get('/api/auth/callback?code=old').set('Cookie', `running_tracker_login=${first}`).expect(302);
    expect(stale.headers.location).toContain('login_expired');
    await request(harness.app).get('/api/auth/callback?code=new').set('Cookie', `running_tracker_login=${second}`).expect(200);
    expect(harness.client.completions).toMatchObject([{ pendingState: 'state-2' }]);
  });

  it('rejects admission before provider work and frees expired reservations for legitimate login', async () => {
    const begin = vi.fn<OidcClient['beginLogin']>().mockResolvedValue({ authorizationUrl, pending: { codeVerifier: 'v', nonce: 'n', state: 's' } });
    const harness = createHarness({ begin, maxEntries: 1 });
    await startLogin(harness);
    await request(harness.app).get('/api/auth/login').expect(503);
    expect(begin).toHaveBeenCalledOnce();
    harness.clock.now += 600_000;
    await request(harness.app).get('/api/auth/login').expect(302);
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('bounds login initiation rate regardless of forged forwarded addresses and recovers after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const harness = createHarness();
    for (let index = 0; index < 30; index += 1) await request(harness.app).get('/api/auth/login').expect(302);
    const rejected = await request(harness.app).get('/api/auth/login').set('X-Forwarded-For', '203.0.113.2').expect(429);
    expect(rejected.headers['retry-after']).toBe('60');
    vi.setSystemTime(Date.now() + 60_000);
    await request(harness.app).get('/api/auth/login').expect(302);
  });

  it('reserves capacity before concurrent provider work and releases failed reservations', async () => {
    let rejectPending: (error: Error) => void = () => {};
    const pending = new Promise<Awaited<ReturnType<OidcClient['beginLogin']>>>((_resolve, reject) => { rejectPending = reject; });
    const begin = vi.fn<OidcClient['beginLogin']>().mockReturnValue(pending);
    const harness = createHarness({ begin, maxEntries: 1 });
    const first = request(harness.app).get('/api/auth/login').then((response) => response.status);
    await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
    await request(harness.app).get('/api/auth/login').expect(503);
    expect(begin).toHaveBeenCalledOnce();
    rejectPending(new OidcProviderUnavailableError('offline'));
    expect(await first).toBe(503);
    begin.mockResolvedValue({ authorizationUrl, pending: { codeVerifier: 'v', nonce: 'n', state: 's' } });
    await request(harness.app).get('/api/auth/login').expect(302);
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

  describe('pending-login store outages and lifecycle (ADR-0081)', () => {
    const outage = () => new OidcLoginStoreUnavailableError('no connection', { cause: { code: 'ECONNREFUSED' } });

    /** The in-memory store with one operation failing like an unreachable database; the others still work. */
    function failing(operation: keyof PendingLoginStore, calls: string[] = []) {
      return (store: PendingLoginStore): PendingLoginStore => ({
        cancel: (loginId) => {
          calls.push('cancel');
          return operation === 'cancel' ? Promise.reject(outage()) : store.cancel(loginId);
        },
        completeReservation: (loginId, login) => {
          calls.push('completeReservation');
          return operation === 'completeReservation' ? Promise.reject(outage()) : store.completeReservation(loginId, login);
        },
        consume: (loginId) => {
          calls.push('consume');
          return operation === 'consume' ? Promise.reject(outage()) : store.consume(loginId);
        },
        reserve: (previous) => {
          calls.push('reserve');
          return operation === 'reserve' ? Promise.reject(outage()) : store.reserve(previous);
        },
      });
    }

    it('answers 503 with Retry-After and never contacts the provider when no reservation can be made', async () => {
      const begin = vi.fn<OidcClient['beginLogin']>();
      const harness = createHarness({ begin, wrapStore: failing('reserve') });

      const response = await request(harness.app).get('/api/auth/login').expect(503);

      expect(response.body).toMatchObject({ error: { code: 'LOGIN_TEMPORARILY_UNAVAILABLE' } });
      expect(response.headers['retry-after']).toBe('5');
      expect(setCookieLines(response)).toEqual([]);
      expect(begin).not.toHaveBeenCalled();
      expect(harness.logs.join('\n')).toContain('store_unavailable');
      expect(harness.logs.join('\n')).toContain('ECONNREFUSED');
    });

    it('answers 503 without a login cookie and frees the reservation when completion cannot be stored', async () => {
      const calls: string[] = [];
      const harness = createHarness({ maxEntries: 1, wrapStore: failing('completeReservation', calls) });

      const response = await request(harness.app).get('/api/auth/login').expect(503);

      expect(response.body).toMatchObject({ error: { code: 'LOGIN_TEMPORARILY_UNAVAILABLE' } });
      expect(setCookieLines(response)).toEqual([]);
      expect(calls).toEqual(['reserve', 'completeReservation', 'cancel']);
      // The only slot was released: the next reservation is admitted (and fails at completion again).
      await request(harness.app).get('/api/auth/login').expect(503);
      expect(calls.filter((call) => call === 'reserve')).toHaveLength(2);
    });

    it('still answers for the provider when the cancellation after a provider outage cannot be stored', async () => {
      const calls: string[] = [];
      const harness = createHarness({
        begin: () => Promise.reject(new OidcProviderUnavailableError('discovery failed')),
        wrapStore: failing('cancel', calls),
      });

      const response = await request(harness.app).get('/api/auth/login').expect(503);

      expect(response.body).toMatchObject({ error: { code: 'IDENTITY_PROVIDER_UNAVAILABLE' } });
      expect(calls).toEqual(['reserve', 'cancel']);
      expect(harness.logs.join('\n')).toContain('auth.login.cancel_failed');
    });

    it('fails a callback as unavailable, not expired, when the attempt cannot be consumed, and never exchanges the code', async () => {
      const harness = createHarness({ wrapStore: failing('consume') });
      const loginCookie = await startLogin(harness);

      const response = await request(harness.app)
        .get('/api/auth/callback?code=secret-code&state=state-1')
        .set('Cookie', `running_tracker_login=${loginCookie}`)
        .expect(302);

      expect(response.headers.location).toBe('/runner?sign_in_error=unavailable');
      expect(setCookieLines(response)).toEqual([expect.stringContaining('running_tracker_login=; ')]);
      expect(harness.client.completions).toEqual([]);
      const output = harness.logs.join('\n');
      expect(output).toContain('OidcLoginStoreUnavailableError');
      for (const secret of [loginCookie, 'secret-code', 'state-1', 'verifier-1', 'nonce-1']) {
        expect(output).not.toContain(secret);
      }
    });

    it('does not repeat the exchange after an uncertain consume: the attempt is gone, and a retry is expired', async () => {
      // The consume committed, but its answer was lost (as on a deadline): the first callback fails as unavailable.
      let lose = true;
      const harness = createHarness({
        wrapStore: (store) => ({
          cancel: (loginId) => store.cancel(loginId),
          completeReservation: (loginId, login) => store.completeReservation(loginId, login),
          consume: async (loginId) => {
            const consumed = await store.consume(loginId);
            if (lose) throw new OidcLoginStoreUnavailableError('no answer within 2000 ms');
            return consumed;
          },
          reserve: (previous) => store.reserve(previous),
        }),
      });
      const loginCookie = await startLogin(harness);
      const callback = () =>
        request(harness.app)
          .get('/api/auth/callback?code=abc&state=state-1')
          .set('Cookie', `running_tracker_login=${loginCookie}`);

      expect((await callback().expect(302)).headers.location).toBe('/runner?sign_in_error=unavailable');
      lose = false;
      expect((await callback().expect(302)).headers.location).toBe('/runner?sign_in_error=login_expired');
      expect(harness.client.completions).toEqual([]);
    });

    it('lets only one of two concurrent callbacks for one login reach the token exchange and create a session', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const completions: string[] = [];
      const harness = createHarness({
        complete: async (_callbackUrl, pending) => {
          completions.push(pending.state);
          await gate;
          return { issuer, subject: 'subject-1' };
        },
      });
      const loginCookie = await startLogin(harness);
      const callback = () =>
        request(harness.app)
          .get('/api/auth/callback?code=abc&state=state-1')
          .set('Cookie', `running_tracker_login=${loginCookie}`)
          .then((response) => response);

      const first = callback();
      const second = callback();
      await vi.waitFor(() => expect(completions).toHaveLength(1));
      release();
      const responses = await Promise.all([first, second]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 302]);
      expect(responses.find((response) => response.status === 302)?.headers.location).toBe(
        '/runner?sign_in_error=login_expired',
      );
      expect(completions).toEqual(['state-1']);
    });

    it('never hands an incomplete reservation to the token exchange', async () => {
      // The provider is slow, so the browser's cookie from an earlier response is presented while the new reservation
      // has not been completed yet: the callback consumes nothing usable and the exchange is never attempted.
      let reserved: string | undefined;
      let finishDiscovery: () => void = () => {};
      const discovery = new Promise<void>((resolve) => {
        finishDiscovery = resolve;
      });
      const harness = createHarness({
        begin: async () => {
          await discovery;
          return { authorizationUrl, pending: { codeVerifier: 'v', nonce: 'n', state: 's' } };
        },
        wrapStore: (store) => {
          const wrapped: PendingLoginStore = {
            cancel: (loginId) => store.cancel(loginId),
            completeReservation: (loginId, login) => store.completeReservation(loginId, login),
            consume: (loginId) => store.consume(loginId),
            reserve: async (previous) => {
              reserved = await store.reserve(previous);
              return reserved;
            },
          };
          return wrapped;
        },
      });
      const login = request(harness.app).get('/api/auth/login').then((response) => response);
      await vi.waitFor(() => expect(reserved).toBeDefined());

      const early = await request(harness.app)
        .get('/api/auth/callback?code=abc&state=s')
        .set('Cookie', `running_tracker_login=${reserved}`)
        .expect(302);
      finishDiscovery();

      expect(early.headers.location).toBe('/runner?sign_in_error=login_expired');
      expect(harness.client.completions).toEqual([]);
      // The reservation was consumed, so completing it fails and the login answers 503 without a cookie.
      const answered = await login;
      expect(answered.status).toBe(503);
      expect(setCookieLines(answered)).toEqual([]);
    });
  });

  it('omits the Secure attribute only when the deployment explicitly allows plain HTTP', async () => {
    const harness = createHarness({ secureCookies: false });

    const response = await request(harness.app).get('/api/auth/login').expect(302);

    expect(setCookieLines(response)[0]).not.toContain('Secure');
  });
});
