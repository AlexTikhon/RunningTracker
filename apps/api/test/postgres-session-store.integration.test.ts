import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresSessionStore } from '../src/auth/postgres-session-store.js';
import { SessionManager } from '../src/auth/session-manager.js';
import {
  SessionStoreCapacityError,
  SessionStoreUnavailableError,
  SessionUserUnknownError,
} from '../src/auth/session-store.js';
import { systemClock, type Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { runSessionPurgeOnce } from '../src/maintenance/run-session-purge.js';
import { describeSessionStoreContract, opaqueValue } from './support/session-store-contract.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// ADR-0080 against real PostgreSQL: the same contract as the in-memory test store, then what only a shared database
// can show (several independent store objects and pools standing in for several API instances), the database
// privileges of migration 0036, bounded cleanup, and outages. The live-stream and HTTP boundaries are in
// session-runtime.integration.test.ts.

const ttlMs = 60 * 60 * 1_000;

class ControlledClock implements Clock {
  public now = Date.parse('2026-11-08T09:00:00.000Z');
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

async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function sqlState(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

describe('PostgreSQL session store (ADR-0080)', () => {
  let integration: ReturnType<typeof loadIntegrationTestConfiguration>;
  let config: Environment;
  let ownerPool: Pool;
  let maintenancePool: Pool;
  const runtimePools: Pool[] = [];

  /** A separate runtime pool: what a second API process would have. */
  function runtimePool(max = 4): Pool {
    const pool = createDatabasePool({ ...config, DB_POOL_MAX: max });
    runtimePools.push(pool);
    return pool;
  }

  function storeOn(pool: Pool, capacity = 100, operationTimeoutMs = 2_000): PostgresSessionStore {
    return new PostgresSessionStore({ capacity, clock: systemClock, operationTimeoutMs, pool });
  }

  function managerOn(pool: Pool, clock: Clock, capacity = 100): SessionManager {
    return new SessionManager({ clock, store: storeOn(pool, capacity), ttlMs });
  }

  async function storedCount(): Promise<number> {
    const result = await ownerPool.query<{ count: string }>('SELECT count(*)::text AS count FROM app_private.auth_sessions');
    return Number(result.rows[0]!.count);
  }

  beforeAll(async () => {
    integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
    });
    ownerPool = new Pool({ application_name: 'running-tracker-session-store-owner', connectionString: integration.migration.connectionString, max: 2 });
    maintenancePool = new Pool({ application_name: 'running-tracker-session-store-maintenance', connectionString: integration.maintenance.connectionString, max: 1 });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
  });

  beforeEach(async () => {
    await ownerPool.query('DELETE FROM app_private.auth_sessions');
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM app_private.auth_sessions');
    await Promise.allSettled([...runtimePools.splice(0).map((pool) => pool.end()), ownerPool?.end(), maintenancePool?.end()]);
  });

  describeSessionStoreContract('PostgresSessionStore', async (capacity) => {
    await ownerPool.query('DELETE FROM app_private.auth_sessions');
    return { store: storeOn(runtimePools[0] ?? runtimePool(), capacity), userIds: [ids.userDual, ids.userOrgB] };
  });

  describe('across independent store instances', () => {
    it('keeps a session after the instance that created it is gone', async () => {
      const clock = new ControlledClock();
      const creatorPool = runtimePool(1);
      const created = await managerOn(creatorPool, clock).create(ids.userDual);
      await creatorPool.end();
      runtimePools.splice(runtimePools.indexOf(creatorPool), 1);

      const resolved = await managerOn(runtimePool(1), clock).resolve(created.sessionToken);

      expect(resolved).toEqual(created.record);
    });

    it('refuses a session from its expiry instant on, on every instance', async () => {
      const clock = new ControlledClock();
      const first = managerOn(runtimePool(1), clock);
      const second = managerOn(runtimePool(1), clock);
      const created = await first.create(ids.userDual);

      clock.now = created.record.expiresAt.getTime() - 1;
      expect((await second.resolve(created.sessionToken))?.userId).toBe(ids.userDual);
      expect(await second.isActive(created.record)).toBe(true);

      clock.now = created.record.expiresAt.getTime();
      expect(await first.resolve(created.sessionToken)).toBeUndefined();
      expect(await second.isActive(created.record)).toBe(false);
    });

    it('applies a sign-out committed on one instance to the next check on another', async () => {
      const clock = new ControlledClock();
      const first = managerOn(runtimePool(1), clock);
      const second = managerOn(runtimePool(1), clock);
      const created = await first.create(ids.userDual);
      expect(await first.isActive(created.record)).toBe(true);

      expect(await second.revoke(created.sessionToken)).toBe(true);

      expect(await first.resolve(created.sessionToken)).toBeUndefined();
      expect(await first.isActive(created.record)).toBe(false);
      expect(await second.revoke(created.sessionToken)).toBe(false);
    });
  });

  describe('capacity under concurrency', () => {
    it('admits exactly the free slots across instances racing, and evicts no live session', async () => {
      const clock = new ControlledClock();
      const capacity = 10;
      const existing = managerOn(runtimePool(1), clock, capacity);
      const before = [await existing.create(ids.userDual), await existing.create(ids.userOrgB)];
      const instances = [0, 1, 2].map(() => managerOn(runtimePool(4), clock, capacity));

      const attempts = await Promise.allSettled(
        Array.from({ length: 24 }, (_, index) => instances[index % instances.length]!.create(index % 2 ? ids.userDual : ids.userOrgB)),
      );

      const admitted = attempts.filter((attempt) => attempt.status === 'fulfilled');
      const refused = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
      expect(admitted).toHaveLength(capacity - before.length);
      expect(refused).toHaveLength(24 - (capacity - before.length));
      for (const attempt of refused) {
        expect(attempt.reason).toBeInstanceOf(SessionStoreCapacityError);
      }
      expect(await storedCount()).toBe(capacity);
      for (const session of before) {
        expect(await existing.isActive(session.record)).toBe(true);
      }
    });

    it('refuses a session for a user that is not provisioned', async () => {
      const manager = managerOn(runtimePool(1), new ControlledClock());
      await expect(manager.create('99999999-9999-4999-8999-999999999999')).rejects.toBeInstanceOf(SessionUserUnknownError);
      expect(await storedCount()).toBe(0);
    });
  });

  describe('bounded cleanup', () => {
    async function insertExpired(count: number, expiredAt: number): Promise<void> {
      await ownerPool.query(
        `INSERT INTO app_private.auth_sessions (token_digest, user_id, csrf_token, issued_at, expires_at)
         SELECT digest, $1, digest, to_timestamp($2::double precision / 1000) - interval '1 hour', to_timestamp($2::double precision / 1000)
         FROM unnest($3::text[]) AS digest`,
        [ids.userOrgB, expiredAt, Array.from({ length: count }, (_, index) => opaqueValue(`expired-${index}`))],
      );
    }

    it('removes at most 100 expired rows per sign-in, then the purge removes the rest in bounded batches, never a live row', async () => {
      const clock = new ControlledClock();
      await insertExpired(250, clock.now - 1_000);
      const manager = managerOn(runtimePool(1), clock, 1_000);

      const live = await manager.create(ids.userDual);
      expect(await storedCount()).toBe(250 - 100 + 1);

      const first = await runSessionPurgeOnce(maintenancePool, clock);
      expect(first).toEqual({ purgedCount: 150, status: 'purged' });
      expect(await runSessionPurgeOnce(maintenancePool, clock)).toEqual({ status: 'idle' });
      expect(await storedCount()).toBe(1);
      expect(await manager.isActive(live.record)).toBe(true);
    });

    it('purges no more than its batch limit in one cycle', async () => {
      const clock = new ControlledClock();
      await insertExpired(600, clock.now - 1);

      expect(await runSessionPurgeOnce(maintenancePool, clock)).toEqual({ purgedCount: 500, status: 'purged' });
      expect(await storedCount()).toBe(100);
    });
  });

  describe('database privileges (migration 0036)', () => {
    const tableStatements = [
      'SELECT * FROM app_private.auth_sessions',
      'SELECT count(*) FROM app_private.auth_sessions',
      `INSERT INTO app_private.auth_sessions VALUES ('${opaqueValue('x')}', '${ids.userDual}', '${opaqueValue('y')}', now(), now() + interval '1 hour')`,
      `UPDATE app_private.auth_sessions SET user_id = '${ids.userOrgB}'`,
      'DELETE FROM app_private.auth_sessions',
    ];

    it('lets neither application role touch the table directly, so neither can list or count sessions', async () => {
      const runtime = runtimePool(1);
      for (const pool of [runtime, maintenancePool]) {
        for (const statement of tableStatements) {
          await expect(pool.query(statement), statement).rejects.toSatisfy((error) => sqlState(error) === '42501');
        }
      }
    });

    it('grants the runtime role exactly create, read and revoke by digest, and maintenance only the bounded purge', async () => {
      const result = await ownerPool.query<{ maintenance: boolean; name: string; runtime: boolean; world: boolean }>(
        `SELECT proc.proname AS name,
                has_function_privilege('running_tracker_runtime', proc.oid, 'EXECUTE') AS runtime,
                has_function_privilege('running_tracker_maintenance', proc.oid, 'EXECUTE') AS maintenance,
                EXISTS (SELECT 1 FROM aclexplode(proc.proacl) AS acl WHERE acl.grantee = 0) AS world
         FROM pg_proc AS proc
         JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
         WHERE namespace.nspname = 'app_private' AND proc.proname LIKE '%auth_session%'
         ORDER BY proc.proname`,
      );
      expect(result.rows).toEqual([
        { maintenance: false, name: 'clear_auth_sessions', runtime: false, world: false },
        { maintenance: false, name: 'create_auth_session', runtime: true, world: false },
        { maintenance: true, name: 'purge_expired_auth_sessions', runtime: false, world: false },
        { maintenance: false, name: 'read_auth_session', runtime: true, world: false },
        { maintenance: false, name: 'revoke_auth_session', runtime: true, world: false },
      ]);
      const table = await ownerPool.query<{ privileged: boolean; rls: boolean }>(
        `SELECT bool_or(has_table_privilege(role, 'app_private.auth_sessions', privilege)) AS privileged,
                (SELECT relrowsecurity FROM pg_class WHERE oid = 'app_private.auth_sessions'::regclass) AS rls
         FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role,
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege`,
      );
      expect(table.rows[0]).toEqual({ privileged: false, rls: true });

      const runtime = runtimePool(1);
      await expect(runtime.query('SELECT app_private.clear_auth_sessions()')).rejects.toSatisfy((error) => sqlState(error) === '42501');
      await expect(runtime.query('SELECT app_private.purge_expired_auth_sessions(now(), 10)')).rejects.toSatisfy(
        (error) => sqlState(error) === '42501',
      );
      await expect(maintenancePool.query(`SELECT * FROM app_private.read_auth_session('${opaqueValue('x')}', now())`)).rejects.toSatisfy(
        (error) => sqlState(error) === '42501',
      );
    });

    it('cannot move an existing session to another identity through the runtime functions', async () => {
      const runtime = runtimePool(1);
      const manager = managerOn(runtime, new ControlledClock());
      const victim = await manager.create(ids.userDual);

      const outcome = await runtime.query<{ outcome: string }>(
        'SELECT app_private.create_auth_session($1, $2, $3, $4, $5, $6) AS outcome',
        [victim.record.tokenDigest, ids.userOrgB, opaqueValue('attacker-csrf'), victim.record.issuedAt, victim.record.expiresAt, 100],
      );

      expect(outcome.rows[0]?.outcome).toBe('duplicate');
      expect(await manager.resolve(victim.sessionToken)).toEqual(victim.record);
    });
  });

  describe('when the store cannot answer', () => {
    it('reports an unreachable database as unavailable, never as a missing session, and quickly', async () => {
      const unreachable = new Pool({
        connectionString: `postgresql://running_tracker_runtime:x@127.0.0.1:${await closedPort()}/running_tracker_test`,
        connectionTimeoutMillis: 1_000,
        max: 1,
      });
      unreachable.on('error', () => undefined);
      runtimePools.push(unreachable);
      const manager = managerOn(unreachable, new ControlledClock());
      const token = 'A'.repeat(43);
      const started = Date.now();

      await expect(manager.resolve(token)).rejects.toBeInstanceOf(SessionStoreUnavailableError);
      await expect(manager.isActive({ tokenDigest: opaqueValue('d'), userId: ids.userDual })).rejects.toBeInstanceOf(SessionStoreUnavailableError);
      await expect(manager.revoke(token)).rejects.toBeInstanceOf(SessionStoreUnavailableError);
      await expect(manager.create(ids.userDual)).rejects.toBeInstanceOf(SessionStoreUnavailableError);
      expect(Date.now() - started).toBeLessThan(8_000);
    });

    it('gives up at its deadline while the table is locked, then recovers on the same pool without a restart', async () => {
      const clock = new ControlledClock();
      const pool = runtimePool(2);
      const manager = new SessionManager({ clock, store: storeOn(pool, 100, 300), ttlMs });
      const created = await manager.create(ids.userDual);
      const blocker = await ownerPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE app_private.auth_sessions IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        await expect(manager.resolve(created.sessionToken)).rejects.toBeInstanceOf(SessionStoreUnavailableError);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }

      expect(await manager.resolve(created.sessionToken)).toEqual(created.record);
    });
  });
});
