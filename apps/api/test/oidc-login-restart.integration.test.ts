import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pendingLoginDigest } from '../src/auth/pending-login-store.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { startTestProvider, type TestProvider } from './oidc-test-provider.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// ADR-0081, end to end with real processes and a real identity provider (oidc-provider on loopback): the API entrypoint
// (src/entrypoint.ts, the composition development and production use) is started behind a small reverse proxy that is
// the one stable external origin, the way a load balancer would be. OIDC_REDIRECT_URI names that origin, so the
// provider sends the browser back there whichever API process answers. Every process uses the same database, issuer,
// client and redirect URI. A fake provider would not show that the PKCE verifier, state and nonce survive the trip
// through PostgreSQL: here the real token exchange validates them.

const apiDirectory = resolve(import.meta.dirname, '..');
const clientId = 'running-tracker-restart-test';
const clientSecret = 'restart-test-client-secret';
const accountId = 'alice';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** The stable external origin: forwards every request, unchanged, to whichever API port it currently routes to. */
async function startProxy(): Promise<{ close(): Promise<void>; origin: string; routeTo(port: number): void }> {
  let target = 0;
  const server: Server = createServer((incoming, outgoing) => {
    const upstream = httpRequest(
      { headers: incoming.headers, host: '127.0.0.1', method: incoming.method, path: incoming.url, port: target },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
    origin: `http://127.0.0.1:${port}`,
    routeTo: (port) => {
      target = port;
    },
  };
}

function cookieValue(response: Response, name: string): string | undefined {
  const line = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
  return line?.split(';', 1)[0]?.slice(name.length + 1);
}

describe('pending OIDC logins across API restarts and instances (ADR-0081)', () => {
  let integration: ReturnType<typeof loadIntegrationTestConfiguration>;
  let ownerPool: Pool;
  let provider: TestProvider;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  const processes: { child: ChildProcess; output: () => string }[] = [];

  async function startApi(port: number): Promise<{ child: ChildProcess; output: () => string; port: number }> {
    let output = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/entrypoint.ts'], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        ALLOWED_ORIGINS: proxy.origin,
        APP_ENV: 'test',
        DATABASE_URL: integration.runtime.connectionString,
        LOCAL_AUTH_ENABLED: 'false',
        MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
        OIDC_CLIENT_ID: clientId,
        OIDC_CLIENT_SECRET: clientSecret,
        OIDC_ISSUER_URL: provider.issuer,
        OIDC_REDIRECT_URI: `${proxy.origin}/api/auth/callback`,
        PORT: String(port),
        RUN_SEARCH_AI_ENABLED: 'false',
        SESSION_COOKIE_SECURE: 'false',
        // Short, so that the database-outage scenario fails fast; the healthy scenarios answer far sooner.
        SESSION_STORE_TIMEOUT_MS: '750',
        WEEKLY_INSIGHTS_PROVIDER: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = { child, output: () => output };
    processes.push(entry);
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`The API exited early:\n${output}`);
      const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) return { ...entry, port };
      if (Date.now() > deadline) throw new Error(`The API did not become ready:\n${output}`);
      await new Promise((done) => setTimeout(done, 250));
    }
  }

  async function stopApi(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }

  /** What a browser does up to the provider's redirect back: returns its login cookie and the callback path. */
  async function startLoginThroughProvider(origin: string): Promise<{ callbackPath: string; loginId: string }> {
    const started = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    expect(started.status).toBe(302);
    const loginId = cookieValue(started, 'running_tracker_login');
    if (!loginId) throw new Error('Expected the login cookie');
    const returned = await provider.signIn(new URL(started.headers.get('location')!), accountId);
    expect(returned.origin).toBe(proxy.origin);
    return { callbackPath: `${returned.pathname}${returned.search}`, loginId };
  }

  function callback(origin: string, callbackPath: string, loginId: string): Promise<Response> {
    return fetch(`${origin}${callbackPath}`, {
      headers: { cookie: `running_tracker_login=${loginId}` },
      redirect: 'manual',
    });
  }

  async function storedSessions(): Promise<number> {
    const result = await ownerPool.query<{ count: string }>('SELECT count(*)::text AS count FROM app_private.auth_sessions');
    return Number(result.rows[0]!.count);
  }

  async function storedLogins(): Promise<number> {
    const result = await ownerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app_private.oidc_pending_logins',
    );
    return Number(result.rows[0]!.count);
  }

  function expectNoSecrets(outputs: string[], secrets: string[]): void {
    for (const output of outputs) {
      for (const secret of secrets) expect(output).not.toContain(secret);
      expect(output).not.toMatch(/postgres(ql)?:\/\/[^\s]*:[^\s@]+@/u);
    }
  }

  beforeAll(async () => {
    integration = loadIntegrationTestConfiguration();
    ownerPool = new Pool({ connectionString: integration.migration.connectionString, max: 2 });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    proxy = await startProxy();
    provider = await startTestProvider({ clientId, clientSecret, redirectUri: `${proxy.origin}/api/auth/callback` });
    // Provision exactly one identity, the way an operator would.
    await ownerPool.query('UPDATE users SET external_identity = $1 WHERE id = $2', [
      `${provider.issuer}|${accountId}`,
      ids.userDual,
    ]);
  });

  beforeEach(async () => {
    provider.setFailing(false);
    await ownerPool.query('DELETE FROM app_private.auth_sessions');
    await ownerPool.query('DELETE FROM app_private.oidc_pending_logins');
  });

  afterEach(async () => {
    for (const { child } of processes.splice(0)) await stopApi(child);
  });

  afterAll(async () => {
    await provider?.close();
    await proxy?.close();
    await ownerPool?.query('DELETE FROM app_private.auth_sessions');
    await ownerPool?.query('DELETE FROM app_private.oidc_pending_logins');
    await ownerPool?.end();
  });

  it(
    'completes, after the API process restarted, a login that was started before the restart',
    async () => {
      const port = await freePort();
      const first = await startApi(port);
      proxy.routeTo(port);
      const { callbackPath, loginId } = await startLoginThroughProvider(proxy.origin);
      expect(await storedLogins()).toBe(1);
      await stopApi(first.child);

      const second = await startApi(port);
      const completed = await callback(proxy.origin, callbackPath, loginId);

      expect(completed.status).toBe(200);
      const sessionToken = cookieValue(completed, 'running_tracker_session');
      expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(cookieValue(completed, 'running_tracker_login')).toBe('');
      const session = await fetch(`${proxy.origin}/api/session`, {
        headers: { cookie: `running_tracker_session=${sessionToken}` },
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ identity: { userId: ids.userDual } });
      // The attempt was single use: it is gone, and presenting it again creates nothing.
      expect(await storedLogins()).toBe(0);
      const replay = await callback(proxy.origin, callbackPath, loginId);
      expect(replay.status).toBe(302);
      expect(replay.headers.get('location')).toBe('/?sign_in_error=login_expired');
      expect(await storedSessions()).toBe(1);
      const query = new URL(callbackPath, proxy.origin).searchParams;
      expectNoSecrets([first.output(), second.output()], [loginId, sessionToken!, query.get('code')!, query.get('state')!]);
    },
    120_000,
  );

  it(
    'completes on instance B, through the stable external origin, a login started on instance A',
    async () => {
      const [a, b] = await Promise.all([freePort().then(startApi), freePort().then(startApi)]);
      proxy.routeTo(a.port);
      const { callbackPath, loginId } = await startLoginThroughProvider(proxy.origin);
      const digest = pendingLoginDigest(loginId);
      const stored = await ownerPool.query<{ login_digest: string }>('SELECT login_digest FROM app_private.oidc_pending_logins');
      expect(stored.rows).toEqual([{ login_digest: digest }]);

      proxy.routeTo(b.port);
      const completed = await callback(proxy.origin, callbackPath, loginId);

      expect(completed.status).toBe(200);
      expect(b.output()).toContain('auth.login.succeeded');
      expect(a.output()).not.toContain('auth.login.succeeded');
      // The session is shared too (ADR-0080): instance A accepts it directly.
      const sessionToken = cookieValue(completed, 'running_tracker_session')!;
      const onA = await fetch(`http://127.0.0.1:${a.port}/api/session`, {
        headers: { cookie: `running_tracker_session=${sessionToken}` },
      });
      expect(onA.status).toBe(200);
      expectNoSecrets([a.output(), b.output()], [loginId, digest, sessionToken]);
    },
    120_000,
  );

  it(
    'lets only one of two simultaneous callbacks on two instances exchange the code and create a session',
    async () => {
      const [a, b] = await Promise.all([freePort().then(startApi), freePort().then(startApi)]);
      proxy.routeTo(a.port);
      const { callbackPath, loginId } = await startLoginThroughProvider(proxy.origin);
      const exchangesBefore = provider.tokenRequestCount();

      // The same browser state presented to both instances at once (a double submit, or a replay racing the original).
      const responses = await Promise.all([
        callback(`http://127.0.0.1:${a.port}`, callbackPath, loginId),
        callback(`http://127.0.0.1:${b.port}`, callbackPath, loginId),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 302]);
      expect(responses.find((response) => response.status === 302)?.headers.get('location')).toBe(
        '/?sign_in_error=login_expired',
      );
      expect(responses.filter((response) => cookieValue(response, 'running_tracker_session'))).toHaveLength(1);
      expect(provider.tokenRequestCount() - exchangesBefore).toBe(1);
      expect(await storedSessions()).toBe(1);

      // A later replay on either instance creates nothing and reaches no provider.
      for (const port of [a.port, b.port]) {
        const replay = await callback(`http://127.0.0.1:${port}`, callbackPath, loginId);
        expect(replay.headers.get('location')).toBe('/?sign_in_error=login_expired');
      }
      expect(provider.tokenRequestCount() - exchangesBefore).toBe(1);
      expect(await storedSessions()).toBe(1);
    },
    120_000,
  );

  it(
    'creates no session when the state was altered or the stored nonce does not match the ID token',
    async () => {
      const [a, b] = await Promise.all([freePort().then(startApi), freePort().then(startApi)]);
      proxy.routeTo(a.port);

      // 1. The state in the returned URL is not the state stored for this login.
      const altered = await startLoginThroughProvider(proxy.origin);
      const alteredPath = new URL(altered.callbackPath, proxy.origin);
      alteredPath.searchParams.set('state', 'attacker-chosen-state');
      proxy.routeTo(b.port);
      const refused = await callback(proxy.origin, `${alteredPath.pathname}${alteredPath.search}`, altered.loginId);
      expect(refused.headers.get('location')).toBe('/?sign_in_error=denied');
      expect(cookieValue(refused, 'running_tracker_session')).toBeUndefined();

      // 2. The nonce stored with the login differs from the one in the ID token the provider issues.
      proxy.routeTo(a.port);
      const tampered = await startLoginThroughProvider(proxy.origin);
      await ownerPool.query('UPDATE app_private.oidc_pending_logins SET oidc_nonce = $1 WHERE login_digest = $2', [
        'a-different-nonce',
        pendingLoginDigest(tampered.loginId),
      ]);
      proxy.routeTo(b.port);
      const rejected = await callback(proxy.origin, tampered.callbackPath, tampered.loginId);
      expect(rejected.headers.get('location')).toBe('/?sign_in_error=denied');
      expect(cookieValue(rejected, 'running_tracker_session')).toBeUndefined();

      expect(await storedSessions()).toBe(0);
      expect(await storedLogins()).toBe(0);
    },
    120_000,
  );

  it(
    'creates no session when the provider or the database fails, never retries the exchange, and recovers',
    async () => {
      const [a, b] = await Promise.all([freePort().then(startApi), freePort().then(startApi)]);
      proxy.routeTo(a.port);

      // 1. The provider fails at the token exchange (on an instance that has not discovered it yet, too).
      const providerDown = await startLoginThroughProvider(proxy.origin);
      provider.setFailing(true);
      proxy.routeTo(b.port);
      const unavailable = await callback(proxy.origin, providerDown.callbackPath, providerDown.loginId);
      expect(unavailable.headers.get('location')).toBe('/?sign_in_error=unavailable');
      expect(cookieValue(unavailable, 'running_tracker_session')).toBeUndefined();
      provider.setFailing(false);
      // The attempt was consumed before the provider was asked: it is not retried with the same code.
      const retried = await callback(proxy.origin, providerDown.callbackPath, providerDown.loginId);
      expect(retried.headers.get('location')).toBe('/?sign_in_error=login_expired');

      // 2. The database cannot answer while the callback consumes the attempt (the table is locked past the deadline).
      proxy.routeTo(a.port);
      const databaseDown = await startLoginThroughProvider(proxy.origin);
      const exchangesBefore = provider.tokenRequestCount();
      const blocker = await ownerPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE app_private.oidc_pending_logins IN ACCESS EXCLUSIVE MODE');
        proxy.routeTo(b.port);
        const outage = await callback(proxy.origin, databaseDown.callbackPath, databaseDown.loginId);
        expect(outage.headers.get('location')).toBe('/?sign_in_error=unavailable');
        expect(cookieValue(outage, 'running_tracker_session')).toBeUndefined();
        expect(cookieValue(outage, 'running_tracker_login')).toBe('');
        // A new sign-in cannot even reserve while the store cannot answer.
        const login = await fetch(`${proxy.origin}/api/auth/login`, { redirect: 'manual' });
        expect(login.status).toBe(503);
        expect(login.headers.get('retry-after')).toBe('5');
        expect(cookieValue(login, 'running_tracker_login')).toBeUndefined();
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      // The uncertain consume was never followed by a token exchange.
      expect(provider.tokenRequestCount()).toBe(exchangesBefore);
      expect(await storedSessions()).toBe(0);
      expect(b.output()).toContain('OidcLoginStoreUnavailableError');

      // 3. Once the database answers again, a new sign-in works without a restart.
      const fresh = await startLoginThroughProvider(proxy.origin);
      const completed = await callback(proxy.origin, fresh.callbackPath, fresh.loginId);
      expect(completed.status).toBe(200);
      expect(await storedSessions()).toBe(1);
      expectNoSecrets([a.output(), b.output()], [providerDown.loginId, databaseDown.loginId, fresh.loginId]);
    },
    120_000,
  );
});
