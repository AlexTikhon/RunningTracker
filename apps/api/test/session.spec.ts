import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import {
  createAuthenticatedMutationProtection,
  csrfHeaderName,
  sessionCookieName,
} from '../src/auth/session-http.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { validateEnvironment, type Environment } from '../src/config/environment.js';
import type { DatabasePool } from '../src/database/database.js';

const allowedUser = '11111111-1111-4111-8111-111111111111';
const otherUser = '22222222-2222-4222-8222-222222222222';
const allowedOrigin = 'http://127.0.0.1:5173';

class ControlledClock implements Clock {
  public now = new Date('2026-09-21T10:00:00.000Z');

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return this.now.getTime();
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.now);
  }
}

const pool: DatabasePool = {
  connect: vi.fn(() => Promise.reject(new Error('Database must not be used by session tests'))),
};

function localAuthConfig(overrides: Record<string, unknown> = {}): Environment {
  return validateEnvironment({
    ALLOWED_ORIGINS: allowedOrigin,
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: `${allowedUser},${otherUser}`,
    SESSION_COOKIE_SECURE: 'false',
    SESSION_TTL_MS: '1000',
    ...overrides,
  });
}

function deterministicManager(clock: Clock, config: Environment): SessionManager {
  let tokenIndex = 0;
  const tokenCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return new SessionManager({
    clock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    tokenGenerator: () => tokenCharacters[tokenIndex++]!.repeat(43),
    ttlMs: config.SESSION_TTL_MS,
  });
}

function responseBody(response: request.Response): unknown {
  return response.body as unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object response body');
  }
  return value as Record<string, unknown>;
}

function stringProperty(value: unknown, property: string): string {
  const candidate = objectValue(value)[property];
  if (typeof candidate !== 'string') {
    throw new Error(`Expected string property ${property}`);
  }
  return candidate;
}

function errorCode(response: request.Response): string {
  return stringProperty(objectValue(responseBody(response)).error, 'code');
}

function errorObject(response: request.Response): Record<string, unknown> {
  return objectValue(objectValue(responseBody(response)).error);
}

function csrfToken(response: request.Response): string {
  return stringProperty(objectValue(responseBody(response)).csrf, 'token');
}

function headerValues(response: request.Response, name: string): string[] {
  const header = response.headers[name] as unknown;
  if (typeof header === 'string') {
    return [header];
  }
  if (Array.isArray(header) && header.every((value) => typeof value === 'string')) {
    return header;
  }
  throw new Error(`Expected ${name} response header`);
}

function cookiePair(response: request.Response): string {
  const cookie = headerValues(response, 'set-cookie')[0];
  if (!cookie) {
    throw new Error('Expected Set-Cookie header');
  }
  return cookie.split(';', 1)[0]!;
}

async function createLocalSession(
  app: ReturnType<typeof createApp>,
  userId = allowedUser,
): Promise<{ cookie: string; csrfToken: string; response: request.Response }> {
  const response = await request(app)
    .post('/api/session')
    .set('Origin', allowedOrigin)
    .type('application/json')
    .send({ userId })
    .expect(201);
  return { cookie: cookiePair(response), csrfToken: csrfToken(response), response };
}

describe('HTTP session boundary', () => {
  it('creates, reads, and revokes an opaque local session with aligned cookie attributes', async () => {
    const clock = new ControlledClock();
    const config = localAuthConfig();
    const app = createApp({
      clock,
      config,
      pool,
      sessionManager: deterministicManager(clock, config),
    });
    const created = await createLocalSession(app);
    const setCookie = headerValues(created.response, 'set-cookie');

    expect(setCookie[0]).toContain(`${sessionCookieName}=`);
    expect(setCookie[0]).toContain('HttpOnly');
    expect(setCookie[0]).toContain('Path=/');
    expect(setCookie[0]).toContain('SameSite=Strict');
    expect(setCookie[0]).toContain('Max-Age=1');
    expect(setCookie[0]).not.toContain('Domain=');
    expect(setCookie[0]).not.toContain('Secure');
    expect(created.response.headers['cache-control']).toBe('no-store');

    const read = await request(app)
      .get('/api/session')
      .set('Cookie', created.cookie)
      .set('x-user-id', otherUser)
      .query({ userId: otherUser })
      .expect(200);
    expect(responseBody(read)).toEqual({
      csrf: { headerName: csrfHeaderName, token: created.csrfToken },
      expiresAt: '2026-09-21T10:00:01.000Z',
      identity: { userId: allowedUser },
    });
    expect(read.headers['cache-control']).toBe('no-store');

    const logout = await request(app)
      .delete('/api/session')
      .set('Cookie', created.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, created.csrfToken)
      .expect(204);
    const cleared = headerValues(logout, 'set-cookie')[0]!;
    expect(cleared).toContain(`${sessionCookieName}=`);
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('SameSite=Strict');
    expect(cleared).toContain('Max-Age=0');

    await request(app)
      .get('/api/session')
      .set('Cookie', created.cookie)
      .expect(401)
      .expect((response) => expect(errorCode(response)).toBe('AUTH_REQUIRED'));
  });

  it('rejects missing, malformed, unknown, expired, and revoked session tokens', async () => {
    const clock = new ControlledClock();
    const config = localAuthConfig();
    const manager = deterministicManager(clock, config);
    const app = createApp({ clock, config, pool, sessionManager: manager });

    for (const cookie of [
      undefined,
      `${sessionCookieName}=not-an-opaque-token`,
      `${sessionCookieName}=${'Z'.repeat(43)}`,
    ]) {
      const pending = request(app).get('/api/session');
      if (cookie) {
        pending.set('Cookie', cookie);
      }
      await pending.expect(401).expect((response) => expect(errorCode(response)).toBe('AUTH_REQUIRED'));
    }

    const expired = await createLocalSession(app);
    clock.now = new Date('2026-09-21T10:00:01.000Z');
    await request(app)
      .get('/api/session')
      .set('Cookie', expired.cookie)
      .expect(401)
      .expect((response) => expect(errorCode(response)).toBe('AUTH_REQUIRED'));

    clock.now = new Date('2026-09-21T10:00:02.000Z');
    const revoked = await createLocalSession(app);
    manager.revoke(revoked.cookie.slice(sessionCookieName.length + 1));
    await request(app)
      .get('/api/session')
      .set('Cookie', revoked.cookie)
      .expect(401)
      .expect((response) => expect(errorCode(response)).toBe('AUTH_REQUIRED'));
  });

  it('requires exact Origin and JSON for login, and an allowed Origin plus session-bound CSRF for mutations', async () => {
    const clock = new ControlledClock();
    const config = localAuthConfig();
    const manager = deterministicManager(clock, config);
    let mutationCount = 0;
    const testRouter = Router();
    testRouter.post(
      '/protected-mutation',
      ...createAuthenticatedMutationProtection(config, manager),
      (_request, response) => {
        mutationCount += 1;
        response.status(204).end();
      },
    );
    const app = createApp({ clock, config, pool, sessionManager: manager, testOnlyRouter: testRouter });

    for (const origin of [undefined, 'null', 'http://evil.example', `${allowedOrigin}/`]) {
      const pending = request(app).post('/api/session').type('application/json').send({ userId: allowedUser });
      if (origin) {
        pending.set('Origin', origin);
      }
      await pending.expect(403).expect((response) => expect(errorCode(response)).toBe('ORIGIN_DENIED'));
    }
    await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('form')
      .send({ userId: allowedUser })
      .expect(415)
      .expect((response) => expect(errorCode(response)).toBe('UNSUPPORTED_MEDIA_TYPE'));
    await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({})
      .expect(400)
      .expect((response) => expect(errorCode(response)).toBe('INVALID_REQUEST'));

    const first = await createLocalSession(app);
    const second = await createLocalSession(app, otherUser);

    await request(app)
      .post('/api/protected-mutation')
      .set('Cookie', first.cookie)
      .set(csrfHeaderName, first.csrfToken)
      .expect(403)
      .expect((response) => expect(errorCode(response)).toBe('ORIGIN_DENIED'));
    await request(app)
      .post('/api/protected-mutation')
      .set('Cookie', first.cookie)
      .set('Origin', allowedOrigin)
      .expect(403)
      .expect((response) => expect(errorCode(response)).toBe('CSRF_DENIED'));
    await request(app)
      .post('/api/protected-mutation')
      .set('Cookie', first.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, second.csrfToken)
      .expect(403)
      .expect((response) => expect(errorCode(response)).toBe('CSRF_DENIED'));
    expect(mutationCount).toBe(0);

    await request(app)
      .post('/api/protected-mutation')
      .set('Cookie', first.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, first.csrfToken)
      .expect(204);
    expect(mutationCount).toBe(1);
  });

  it('returns one sanitized ApiError envelope and a server-generated requestId', async () => {
    const clock = new ControlledClock();
    const config = localAuthConfig();
    const manager = deterministicManager(clock, config);
    const testRouter = Router();
    testRouter.get('/boom', () => {
      throw new Error('SELECT secret FROM users; postgresql://role:password@database/internal');
    });
    const app = createApp({ clock, config, pool, sessionManager: manager, testOnlyRouter: testRouter });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const unknown = await request(app)
      .get('/api/does-not-exist')
      .set('X-Request-Id', 'attacker-controlled')
      .expect(404);
    expect(errorCode(unknown)).toBe('ROUTE_NOT_FOUND');
    const unknownRequestId = stringProperty(errorObject(unknown), 'requestId');
    expect(unknownRequestId).toBe(unknown.headers['x-request-id']);
    expect(unknownRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(unknownRequestId).not.toBe('attacker-controlled');

    const malformedJson = await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .set('Content-Type', 'application/json')
      .send('{"userId":')
      .expect(400);
    expect(errorCode(malformedJson)).toBe('INVALID_REQUEST');
    expect(malformedJson.headers['cache-control']).toBe('no-store');
    expect(stringProperty(errorObject(malformedJson), 'requestId')).toBe(
      malformedJson.headers['x-request-id'],
    );

    const unexpected = await request(app).get('/api/boom').expect(500);
    expect(errorObject(unexpected)).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected server error occurred',
      requestId: unexpected.headers['x-request-id'],
    });
    expect(JSON.stringify(responseBody(unexpected))).not.toMatch(/SELECT|password|postgresql/u);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toMatch(/SELECT|password|postgresql/u);
    log.mockRestore();
  });

  it('keeps local auth disabled by default and requires Secure cookies when configured', async () => {
    const clock = new ControlledClock();
    const disabled = validateEnvironment({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
    });
    const disabledApp = createApp({ clock, config: disabled, pool });
    await request(disabledApp)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: allowedUser })
      .expect(404);

    const secure = localAuthConfig({ SESSION_COOKIE_SECURE: 'true' });
    const secureApp = createApp({
      clock,
      config: secure,
      pool,
      sessionManager: deterministicManager(clock, secure),
    });
    const response = await request(secureApp)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: allowedUser })
      .expect(201);
    expect(headerValues(response, 'set-cookie')[0]).toContain('Secure');
  });

  it('bounds the local store, fails closed at capacity, and reclaims expired records', async () => {
    const clock = new ControlledClock();
    const config = localAuthConfig({ SESSION_STORE_MAX_ENTRIES: '1' });
    const app = createApp({
      clock,
      config,
      pool,
      sessionManager: deterministicManager(clock, config),
    });

    await createLocalSession(app);
    await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: otherUser })
      .expect(503)
      .expect((response) => expect(errorCode(response)).toBe('SESSION_STORE_UNAVAILABLE'));

    clock.now = new Date('2026-09-21T10:00:01.000Z');
    await createLocalSession(app, otherUser);
  });
});
