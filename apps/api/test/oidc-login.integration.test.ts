import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createOidcClient,
  OidcLoginRejectedError,
  OidcProviderUnavailableError,
} from '../src/auth/oidc-client.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { startTestProvider, type TestProvider } from './oidc-test-provider.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const clientId = 'running-tracker-test';
const clientSecret = 'test-client-secret';
const runListPath = `/api/orgs/${ids.orgA}/runs?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`;

interface RunningApp {
  config: Environment;
  origin: string;
}

function setCookies(response: request.Response): string[] {
  return (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
}

function cookiePair(response: request.Response, name: string): string | undefined {
  return setCookies(response)
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0];
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('OIDC sign-in against a real provider and PostgreSQL', () => {
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  let integration: ReturnType<typeof loadIntegrationTestConfiguration>;
  let ownerPool: Pool;
  let provider: TestProvider;
  let runtimePool: Pool;
  const servers: Server[] = [];
  let app: RunningApp;

  /** The redirect URI needs the application's port, so the port is taken before the configuration exists. */
  async function listen(): Promise<{ origin: string; server: Server }> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, server };
  }

  function mount(listening: { origin: string; server: Server }, issuer: string): RunningApp {
    const config = validateEnvironment({
      ALLOWED_ORIGINS: listening.origin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      OIDC_CLIENT_ID: clientId,
      OIDC_CLIENT_SECRET: clientSecret,
      OIDC_ISSUER_URL: issuer,
      OIDC_REDIRECT_URI: `${listening.origin}/api/auth/callback`,
      SESSION_COOKIE_SECURE: 'false',
    });
    listening.server.on('request', createApp({ clock: systemClock, config, pool: runtimePool }));
    return { config, origin: listening.origin };
  }

  /** Starts a login and returns what a browser would hold, plus the URL the provider calls back. */
  async function loginThroughProvider(
    target: RunningApp,
    accountId: string,
  ): Promise<{ callback: string; loginCookie: string }> {
    const started = await request(target.origin).get('/api/auth/login').expect(302);
    const loginCookie = cookiePair(started, 'running_tracker_login');
    if (!loginCookie) {
      throw new Error('Expected the login cookie');
    }
    const returned = await provider.signIn(new URL(started.headers.location as string), accountId);
    return { callback: `${returned.pathname}${returned.search}`, loginCookie };
  }

  beforeAll(() => {
    integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    ownerPool = new Pool({
      application_name: 'running-tracker-p121-login-owner',
      connectionString: integration.migration.connectionString,
      max: 3,
    });
    runtimePool = createDatabasePool(
      validateEnvironment({
        DATABASE_URL: integration.runtime.connectionString,
        DB_POOL_MAX: '6',
        MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      }),
    );
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    const listening = await listen();
    provider = await startTestProvider({
      clientId,
      clientSecret,
      redirectUri: `${listening.origin}/api/auth/callback`,
    });
    app = mount(listening, provider.issuer);
    // Provision exactly one identity, the way an operator would.
    await ownerPool.query('UPDATE users SET external_identity = $1 WHERE id = $2', [
      `${provider.issuer}|alice`,
      ids.userDual,
    ]);
  });

  afterEach(async () => {
    await provider.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  it('signs a provisioned person in, serves their tenant data under RLS, and signs them out', async () => {
    const { callback, loginCookie } = await loginThroughProvider(app, 'alice');

    const completed = await request(app.origin).get(callback).set('Cookie', loginCookie).expect(200);
    const sessionCookie = cookiePair(completed, 'running_tracker_session');
    expect(sessionCookie).toBeDefined();
    expect(completed.text).toContain('http-equiv="refresh"');

    const session = await request(app.origin)
      .get('/api/session')
      .set('Cookie', sessionCookie as string)
      .expect(200);
    expect(session.body).toMatchObject({ identity: { userId: ids.userDual } });

    await request(app.origin)
      .get(runListPath)
      .set('Cookie', sessionCookie as string)
      .expect(200);
    await request(app.origin).get(runListPath).expect(401);

    await request(app.origin)
      .delete('/api/session')
      .set('Cookie', sessionCookie as string)
      .set('Origin', app.origin)
      .set('x-csrf-token', (session.body as { csrf: { token: string } }).csrf.token)
      .expect(204);
    await request(app.origin)
      .get('/api/session')
      .set('Cookie', sessionCookie as string)
      .expect(401);
  });

  it('does not sign in, and does not create a user for, an identity nobody provisioned', async () => {
    const before = await ownerPool.query('SELECT count(*)::int AS count FROM users');
    const { callback, loginCookie } = await loginThroughProvider(app, 'mallory');

    const response = await request(app.origin).get(callback).set('Cookie', loginCookie).expect(302);

    expect(response.headers.location).toBe('/?sign_in_error=not_provisioned');
    expect(cookiePair(response, 'running_tracker_session')).toBeUndefined();
    const after = await ownerPool.query('SELECT count(*)::int AS count FROM users');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('refuses a callback whose state was altered', async () => {
    const { callback, loginCookie } = await loginThroughProvider(app, 'alice');
    const altered = new URL(callback, app.origin);
    altered.searchParams.set('state', 'attacker-chosen-state');

    const response = await request(app.origin)
      .get(`${altered.pathname}${altered.search}`)
      .set('Cookie', loginCookie)
      .expect(302);

    expect(response.headers.location).toBe('/?sign_in_error=denied');
    expect(cookiePair(response, 'running_tracker_session')).toBeUndefined();
  });

  it('refuses a callback for a login that was never started in this browser', async () => {
    const { callback } = await loginThroughProvider(app, 'alice');

    const response = await request(app.origin).get(callback).expect(302);

    expect(response.headers.location).toBe('/?sign_in_error=login_expired');
    expect(cookiePair(response, 'running_tracker_session')).toBeUndefined();
  });

  it('accepts a callback only once', async () => {
    const { callback, loginCookie } = await loginThroughProvider(app, 'alice');
    await request(app.origin).get(callback).set('Cookie', loginCookie).expect(200);

    const replay = await request(app.origin).get(callback).set('Cookie', loginCookie).expect(302);

    expect(replay.headers.location).toBe('/?sign_in_error=login_expired');
    expect(cookiePair(replay, 'running_tracker_session')).toBeUndefined();
  });

  it('rejects an exchange whose nonce, PKCE verifier, or state does not match, using the real client', async () => {
    const oidc = app.config.OIDC;
    if (!oidc) {
      throw new Error('OIDC configuration expected');
    }
    const client = createOidcClient(oidc, systemClock);

    for (const tamper of [
      { nonce: 'a-different-nonce' },
      { codeVerifier: 'a'.repeat(43) },
      { state: 'a-different-state' },
    ]) {
      const { authorizationUrl, pending } = await client.beginLogin();
      const returned = await provider.signIn(authorizationUrl, 'alice');
      await expect(client.completeLogin(returned, { ...pending, ...tamper })).rejects.toBeInstanceOf(
        OidcLoginRejectedError,
      );
    }

    const { authorizationUrl, pending } = await client.beginLogin();
    const returned = await provider.signIn(authorizationUrl, 'alice');
    await expect(client.completeLogin(returned, pending)).resolves.toEqual({
      issuer: provider.issuer,
      subject: 'alice',
    });
  });

  it('sends PKCE S256, state and nonce on the authorization request', async () => {
    const started = await request(app.origin).get('/api/auth/login').expect(302);
    const location = new URL(started.headers.location as string);

    expect(location.origin).toBe(provider.issuer);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe(clientId);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(location.searchParams.get('redirect_uri')).toBe(`${app.origin}/api/auth/callback`);
    expect(location.searchParams.get('scope')).toBe('openid');
  });

  it('treats a wrong client secret as a rejected login, not an outage', async () => {
    const oidc = app.config.OIDC;
    if (!oidc) {
      throw new Error('OIDC configuration expected');
    }
    const client = createOidcClient({ ...oidc, clientSecret: 'not-the-secret' }, systemClock);
    const { authorizationUrl, pending } = await client.beginLogin();
    const returned = await provider.signIn(authorizationUrl, 'alice');

    await expect(client.completeLogin(returned, pending)).rejects.toBeInstanceOf(OidcLoginRejectedError);
  });

  it('refuses to start a login with a provider that does not offer PKCE S256', async () => {
    // Only discovery is reached, so a minimal discovery document is enough: the real provider
    // library always advertises S256, and this one deliberately omits it.
    const discovery = createServer();
    await new Promise<void>((resolve) => discovery.listen(0, '127.0.0.1', resolve));
    servers.push(discovery);
    const issuer = `http://127.0.0.1:${(discovery.address() as AddressInfo).port}`;
    discovery.on('request', (_incoming, outgoing) => {
      outgoing.setHeader('content-type', 'application/json');
      outgoing.end(
        JSON.stringify({
          authorization_endpoint: `${issuer}/auth`,
          issuer,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          token_endpoint: `${issuer}/token`,
        }),
      );
    });
    const client = createOidcClient(
      { ...(app.config.OIDC as NonNullable<Environment['OIDC']>), issuerUrl: issuer },
      systemClock,
    );

    await expect(client.beginLogin()).rejects.toBeInstanceOf(OidcProviderUnavailableError);
  });

  it('answers 503 when the provider cannot be reached, and stays healthy otherwise', async () => {
    const closedPort = await freePort();
    const down = mount(await listen(), `http://127.0.0.1:${closedPort}`);

    const response = await request(down.origin).get('/api/auth/login').expect(503);

    expect(response.body).toMatchObject({ error: { code: 'IDENTITY_PROVIDER_UNAVAILABLE' } });
    await request(down.origin).get('/api/health/live').expect(200);
  });
});
