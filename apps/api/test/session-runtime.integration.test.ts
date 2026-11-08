import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { PostgresSessionStore } from '../src/auth/postgres-session-store.js';
import { sessionCookieName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { systemClock, type Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment, type Environment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { LiveSseHub, type LiveStreamResponse } from '../src/live/live-sse.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// ADR-0080 at the runtime boundaries, against real PostgreSQL: a live stream on one instance stops after a sign-out
// committed on another, and an unreachable store is a 503 that leaves the cookie alone. Separate store objects and
// pools stand in for separate API instances.

const ttlMs = 60 * 60 * 1_000;

/** Sessions are judged at a fixed instant; the hub's poll timers run only when the test advances them. */
function manualTimers(): Clock & { advanceBy(ms: number): void } {
  let now = Date.parse('2026-11-08T09:00:00.000Z');
  let next = 1;
  const timers = new Map<number, { callback: () => void; dueAt: number }>();
  return {
    advanceBy(ms) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.dueAt <= now) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    clearTimeout: (handle) => void timers.delete(handle as unknown as number),
    monotonicNow: () => now,
    setTimeout(callback, delayMs) {
      const handle = next++;
      timers.set(handle, { callback, dueAt: now + delayMs });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    utcNow: () => new Date(now),
  };
}

class StreamResponse extends EventEmitter implements LiveStreamResponse {
  public ended = false;
  public readonly chunks: string[] = [];
  public end(): void {
    this.ended = true;
  }
  public setHeader(): void {}
  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('Durable sessions at the runtime boundaries (ADR-0080)', () => {
  let integration: ReturnType<typeof loadIntegrationTestConfiguration>;
  let config: Environment;
  let ownerPool: Pool;
  const pools: Pool[] = [];

  function runtimePool(max = 2): Pool {
    const pool = createDatabasePool({ ...config, DB_POOL_MAX: max });
    pools.push(pool);
    return pool;
  }

  function managerOn(pool: Pool): SessionManager {
    return new SessionManager({
      clock: systemClock,
      store: new PostgresSessionStore({ capacity: 100, clock: systemClock, operationTimeoutMs: 2_000, pool }),
      ttlMs,
    });
  }

  beforeAll(async () => {
    integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: ids.userDual,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({ connectionString: integration.migration.connectionString, max: 1 });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
  });

  beforeEach(async () => {
    await ownerPool.query('DELETE FROM app_private.auth_sessions');
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM app_private.auth_sessions');
    await Promise.allSettled([...pools.splice(0).map((pool) => pool.end()), ownerPool?.end()]);
  });

  it('stops live delivery on one instance after a sign-out on another, within one poll cycle', async () => {
    const instanceA = managerOn(runtimePool(1));
    const instanceB = managerOn(runtimePool(1));
    const revoked = await instanceA.create(ids.userDual);
    const kept = await instanceA.create(ids.userDual);
    const timers = manualTimers();
    const readState = vi.fn(() =>
      Promise.resolve({ algorithmVersion: 'v1', runs: [], serverTime: new Date().toISOString() }),
    );
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock: timers,
      heartbeatIntervalMs: 15_000,
      maxConnections: 4,
      pollConcurrency: 2,
      pollIntervalMs: 2_000,
      readState,
      validateSession: (session) => instanceA.isActive(session),
    });
    const revokedStream = new StreamResponse();
    const keptStream = new StreamResponse();
    await hub.connect({ orgId: ids.orgA, session: revoked.record }, new EventEmitter(), revokedStream);
    await hub.connect({ orgId: ids.orgA, session: kept.record }, new EventEmitter(), keptStream);

    // The sign-out commits on instance B; instance A's next poll cycle asks the shared store.
    await instanceB.revoke(revoked.sessionToken);
    timers.advanceBy(2_000);

    await vi.waitFor(() => expect(revokedStream.ended).toBe(true));
    await vi.waitFor(() => expect(keptStream.chunks.length).toBe(2));
    expect(revokedStream.chunks).toHaveLength(1);
    expect(keptStream.ended).toBe(false);
    hub.stop();
  });

  it('closes open streams when the store cannot be asked, instead of delivering unverified state', async () => {
    const pool = runtimePool(2);
    const instance = managerOn(pool);
    const session = await instance.create(ids.userDual);
    const timers = manualTimers();
    let storeDown = false;
    const hub = new LiveSseHub({
      backpressureTimeoutMs: 10_000,
      clock: timers,
      heartbeatIntervalMs: 15_000,
      maxConnections: 4,
      pollConcurrency: 1,
      pollIntervalMs: 2_000,
      readState: () => Promise.resolve({ algorithmVersion: 'v1', runs: [], serverTime: new Date().toISOString() }),
      // The real store until storeDown is set, then a store whose database cannot be reached.
      validateSession: (candidate) => (storeDown ? unreachableManager.isActive(candidate) : instance.isActive(candidate)),
    });
    const unreachable = new Pool({
      connectionString: `postgresql://running_tracker_runtime:x@127.0.0.1:${await closedPort()}/running_tracker_test`,
      connectionTimeoutMillis: 1_000,
      max: 1,
    });
    unreachable.on('error', () => undefined);
    pools.push(unreachable);
    const unreachableManager = managerOn(unreachable);
    const stream = new StreamResponse();
    await hub.connect({ orgId: ids.orgA, session: session.record }, new EventEmitter(), stream);

    storeDown = true;
    timers.advanceBy(2_000);

    await vi.waitFor(() => expect(stream.ended).toBe(true));
    expect(stream.chunks).toHaveLength(1);
    // The session itself is untouched: once the store answers, it is still valid.
    expect(await instance.isActive(session.record)).toBe(true);
    hub.stop();
  });

  it('answers 503 without touching the cookie while the database is unreachable, and the cookie works again after', async () => {
    const healthy = runtimePool(2);
    const signedIn = await managerOn(healthy).create(ids.userDual);
    const cookie = `${sessionCookieName}=${signedIn.sessionToken}`;

    const unreachable = new Pool({
      connectionString: `postgresql://running_tracker_runtime:x@127.0.0.1:${await closedPort()}/running_tracker_test`,
      connectionTimeoutMillis: 1_000,
      max: 1,
    });
    unreachable.on('error', () => undefined);
    pools.push(unreachable);
    const down = createApp({ clock: systemClock, config, pool: unreachable, sessionManager: managerOn(unreachable) });
    for (const path of ['/api/session', '/api/organizations']) {
      const response = await request(down).get(path).set('Cookie', cookie).expect(503);
      expect(response.body).toMatchObject({ error: { code: 'SESSION_STORE_UNAVAILABLE' } });
      expect(response.headers['retry-after']).toBe('5');
      expect(response.headers['set-cookie']).toBeUndefined();
    }

    const up = createApp({ clock: systemClock, config, pool: healthy, sessionManager: managerOn(healthy) });
    await request(up).get('/api/session').set('Cookie', cookie).expect(200);
  });
});
