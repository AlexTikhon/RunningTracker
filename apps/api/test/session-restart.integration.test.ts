import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// ADR-0080, end to end with real processes: the API entrypoint (src/entrypoint.ts, the same composition as development
// and production) is started, a person signs in, the process is stopped, and a NEW process on the same database
// accepts the cookie the browser kept. Then a sign-out in that process is refused by the next process too.

const apiDirectory = resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:5173';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

describe('API process restart keeps signed-in sessions (ADR-0080)', () => {
  let integration: ReturnType<typeof loadIntegrationTestConfiguration>;
  let ownerPool: Pool;
  const processes: ChildProcess[] = [];

  async function startApi(port: number): Promise<{ child: ChildProcess; output: () => string }> {
    let output = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/entrypoint.ts'], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        ALLOWED_ORIGINS: origin,
        APP_ENV: 'test',
        DATABASE_URL: integration.runtime.connectionString,
        LOCAL_AUTH_ENABLED: 'true',
        LOCAL_AUTH_USER_IDS: ids.userDual,
        MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
        PORT: String(port),
        RUN_SEARCH_AI_ENABLED: 'false',
        SESSION_COOKIE_SECURE: 'false',
        WEEKLY_INSIGHTS_PROVIDER: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.push(child);
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`The API exited early:\n${output}`);
      const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) return { child, output: () => output };
      if (Date.now() > deadline) throw new Error(`The API did not become ready:\n${output}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }

  async function stopApi(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }

  beforeAll(async () => {
    integration = loadIntegrationTestConfiguration();
    ownerPool = new Pool({ connectionString: integration.migration.connectionString, max: 1 });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await ownerPool.query('DELETE FROM app_private.auth_sessions');
  });

  afterEach(async () => {
    for (const child of processes.splice(0)) await stopApi(child);
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM app_private.auth_sessions');
    await ownerPool?.end();
  });

  it(
    'accepts the kept cookie in a new process on the same database, and a sign-out there holds in the next one',
    async () => {
      const port = await freePort();
      const first = await startApi(port);
      const signIn = await fetch(`http://127.0.0.1:${port}/api/session`, {
        body: JSON.stringify({ userId: ids.userDual }),
        headers: { 'content-type': 'application/json', origin },
        method: 'POST',
      });
      expect(signIn.status).toBe(201);
      const cookie = signIn.headers.getSetCookie()[0]!.split(';', 1)[0]!;
      const issued = (await signIn.json()) as { csrf: { token: string }; expiresAt: string };
      await stopApi(first.child);
      await expect(fetch(`http://127.0.0.1:${port}/api/session`)).rejects.toThrow();

      // A different process, the same port and database: the browser's cookie still works, unchanged.
      const second = await startApi(port);
      const afterRestart = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { cookie } });
      expect(afterRestart.status).toBe(200);
      expect(await afterRestart.json()).toMatchObject({
        csrf: { token: issued.csrf.token },
        expiresAt: issued.expiresAt,
        identity: { userId: ids.userDual },
      });
      const organizations = await fetch(`http://127.0.0.1:${port}/api/organizations`, { headers: { cookie } });
      expect(organizations.status).toBe(200);

      const signOut = await fetch(`http://127.0.0.1:${port}/api/session`, {
        headers: { cookie, origin, 'x-csrf-token': issued.csrf.token },
        method: 'DELETE',
      });
      expect(signOut.status).toBe(204);
      await stopApi(second.child);

      const third = await startApi(port);
      const afterSignOut = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { cookie } });
      expect(afterSignOut.status).toBe(401);
      // Nothing secret reached the logs of any process.
      for (const output of [first.output(), second.output(), third.output()]) {
        expect(output).not.toContain(cookie.split('=')[1]!);
        expect(output).not.toContain(issued.csrf.token);
        expect(output).not.toMatch(/postgres(ql)?:\/\/[^\s]*:[^\s@]+@/u);
      }
    },
    120_000,
  );
});
