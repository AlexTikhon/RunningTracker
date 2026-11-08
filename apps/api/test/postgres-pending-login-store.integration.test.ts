import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  OidcLoginStoreCapacityError,
  OidcLoginStoreUnavailableError,
  pendingLoginDigest,
} from '../src/auth/pending-login-store.js';
import { PostgresPendingLoginStore } from '../src/auth/postgres-pending-login-store.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { runOidcLoginPurgeOnce } from '../src/maintenance/run-oidc-login-purge.js';
import { ContractClock, contractLogin, describePendingLoginStoreContract } from './support/pending-login-store-contract.js';
import { opaqueValue } from './support/session-store-contract.js';

// ADR-0081 against real PostgreSQL: the same contract as the in-memory test store, then what only a shared database
// can show (independent store objects and pools standing in for API instances), concurrency across them, the database
// privileges of migration 0037, bounded cleanup, and outages. The HTTP and process-level scenarios with a real
// identity provider are in oidc-login.integration.test.ts and oidc-login-restart.integration.test.ts.

const ttlMs = 10 * 60 * 1_000;

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

describe('PostgreSQL pending OIDC login store (ADR-0081)', () => {
  let config: Environment;
  let ownerPool: Pool;
  let maintenancePool: Pool;
  const runtimePools: Pool[] = [];

  /** A separate runtime pool: what another API process would have. */
  function runtimePool(max = 4): Pool {
    const pool = createDatabasePool({ ...config, DB_POOL_MAX: max });
    runtimePools.push(pool);
    return pool;
  }

  function storeOn(
    pool: Pool,
    clock: ContractClock,
    options: { capacity?: number; operationTimeoutMs?: number; ttlMs?: number } = {},
  ): PostgresPendingLoginStore {
    return new PostgresPendingLoginStore({
      capacity: options.capacity ?? 100,
      clock,
      operationTimeoutMs: options.operationTimeoutMs ?? 5_000,
      pool,
      ttlMs: options.ttlMs ?? ttlMs,
    });
  }

  async function storedCount(): Promise<number> {
    const result = await ownerPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app_private.oidc_pending_logins',
    );
    return Number(result.rows[0]!.count);
  }

  async function waitingLockHolders(): Promise<number> {
    const result = await ownerPool.query<{ waiting: string }>(
      'SELECT count(DISTINCT pid)::text AS waiting FROM pg_locks WHERE NOT granted',
    );
    return Number(result.rows[0]!.waiting);
  }

  beforeAll(() => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-pending-login-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-pending-login-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await ownerPool.query('DELETE FROM app_private.oidc_pending_logins');
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM app_private.oidc_pending_logins');
    await Promise.allSettled([...runtimePools.splice(0).map((pool) => pool.end()), ownerPool?.end(), maintenancePool?.end()]);
  });

  describePendingLoginStoreContract('PostgresPendingLoginStore', async ({ capacity, clock, ttlMs: lifetime }) => {
    await ownerPool.query('DELETE FROM app_private.oidc_pending_logins');
    return storeOn(runtimePools[0] ?? runtimePool(), clock, { capacity, ttlMs: lifetime });
  });

  describe('what is stored', () => {
    it('keeps the digest of the identifier, never the identifier, and an expiry that completion leaves alone', async () => {
      const clock = new ContractClock();
      const store = storeOn(runtimePool(1), clock);
      const loginId = await store.reserve();
      const read = () =>
        ownerPool.query<Record<string, unknown>>(
          'SELECT login_digest, created_at, expires_at, code_verifier, oidc_state, oidc_nonce FROM app_private.oidc_pending_logins',
        );

      const reserved = await read();
      expect(reserved.rows).toEqual([
        {
          code_verifier: null,
          created_at: new Date(clock.now),
          expires_at: new Date(clock.now + ttlMs),
          login_digest: pendingLoginDigest(loginId),
          oidc_nonce: null,
          oidc_state: null,
        },
      ]);

      clock.advance(ttlMs - 1);
      await store.completeReservation(loginId, contractLogin('stored'));
      const completed = await read();
      expect(completed.rows[0]).toMatchObject({
        created_at: reserved.rows[0]!.created_at,
        expires_at: reserved.rows[0]!.expires_at,
        login_digest: pendingLoginDigest(loginId),
      });
      expect(JSON.stringify(completed.rows)).not.toContain(loginId);
    });

    it('refuses rows the table must never hold, even from its owner', async () => {
      const insert = (values: unknown[]) =>
        ownerPool.query(
          `INSERT INTO app_private.oidc_pending_logins (login_digest, created_at, expires_at, code_verifier, oidc_state, oidc_nonce)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          values,
        );
      const at = new Date('2026-11-08T12:00:00.000Z');
      const later = (ms: number) => new Date(at.getTime() + ms);
      for (const values of [
        ['raw-login-identifier', at, later(1_000), null, null, null],
        [opaqueValue('a'), at, later(60 * 60 * 1_000 + 1), null, null, null],
        [opaqueValue('b'), at, at, null, null, null],
        [opaqueValue('c'), at, later(1_000), 'verifier', null, null],
        [opaqueValue('d'), at, later(1_000), 'verifier', 'has space', 'nonce'],
      ]) {
        await expect(insert(values)).rejects.toSatisfy((error) => sqlState(error) === '23514');
      }
      expect(await storedCount()).toBe(0);
    });
  });

  describe('across independent store instances', () => {
    it('completes on another instance a login reserved by an instance that is gone', async () => {
      const clock = new ContractClock();
      const startedOn = runtimePool(1);
      const loginId = await storeOn(startedOn, clock).reserve();
      await storeOn(startedOn, clock).completeReservation(loginId, contractLogin('restart'));
      await startedOn.end();
      runtimePools.splice(runtimePools.indexOf(startedOn), 1);

      const other = storeOn(runtimePool(1), clock);

      expect(await other.consume(loginId)).toEqual(contractLogin('restart'));
      expect(await storeOn(runtimePool(1), clock).consume(loginId)).toBeUndefined();
    });

    it('applies the expiry instant and the incomplete state the same way on every instance', async () => {
      const clock = new ContractClock();
      const first = storeOn(runtimePool(1), clock);
      const second = storeOn(runtimePool(1), clock);
      const incomplete = await first.reserve();
      const completed = await first.reserve();
      await second.completeReservation(completed, contractLogin('shared'));

      expect(await second.consume(incomplete)).toBeUndefined();
      expect(await first.completeReservation(incomplete, contractLogin('late'))).toBe(false);

      clock.advance(ttlMs);
      expect(await second.consume(completed)).toBeUndefined();
      expect(await storedCount()).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('admits exactly the free slots to reservations racing on three instances, and evicts no live attempt', async () => {
      const clock = new ContractClock();
      const capacity = 10;
      const existing = storeOn(runtimePool(1), clock, { capacity });
      const reservedEarlier = await existing.reserve();
      const completedEarlier = await existing.reserve();
      await existing.completeReservation(completedEarlier, contractLogin('earlier'));
      const instances = [0, 1, 2].map(() => storeOn(runtimePool(4), clock, { capacity }));

      const attempts = await Promise.allSettled(
        Array.from({ length: 24 }, (_, index) => instances[index % instances.length]!.reserve()),
      );

      const admitted = attempts.filter((attempt) => attempt.status === 'fulfilled');
      const refused = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
      expect(admitted).toHaveLength(capacity - 2);
      expect(refused).toHaveLength(24 - (capacity - 2));
      for (const attempt of refused) {
        expect(attempt.reason).toBeInstanceOf(OidcLoginStoreCapacityError);
      }
      expect(await storedCount()).toBe(capacity);
      expect(await existing.completeReservation(reservedEarlier, contractLogin('reserved'))).toBe(true);
      expect(await existing.consume(completedEarlier)).toEqual(contractLogin('earlier'));
    });

    it('hands one attempt to exactly one of several callbacks that reach the database together', async () => {
      const clock = new ContractClock();
      const loginId = await storeOn(runtimePool(1), clock).reserve();
      await storeOn(runtimePool(1), clock).completeReservation(loginId, contractLogin('once'));
      const consumers = [0, 1, 2].flatMap(() => {
        const pool = runtimePool(2);
        return [storeOn(pool, clock), storeOn(pool, clock)];
      });

      // Hold the row so that every consumer's DELETE is queued on it before any of them can run.
      const blocker = await ownerPool.connect();
      let results: unknown[];
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM app_private.oidc_pending_logins WHERE login_digest = $1 FOR UPDATE', [
          pendingLoginDigest(loginId),
        ]);
        const pending = consumers.map((consumer) => consumer.consume(loginId));
        await expect.poll(waitingLockHolders, { interval: 25, timeout: 4_000 }).toBe(consumers.length);
        await blocker.query('ROLLBACK');
        results = await Promise.all(pending);
      } finally {
        blocker.release();
      }

      expect(results.filter((result) => result !== undefined)).toEqual([contractLogin('once')]);
      expect(await storedCount()).toBe(0);
    });

    it('never hands an attempt out twice in repeated unsynchronized races', async () => {
      const clock = new ContractClock();
      const consumers = [runtimePool(3), runtimePool(3)].flatMap((pool) => [0, 1, 2].map(() => storeOn(pool, clock)));
      for (let round = 0; round < 10; round += 1) {
        const loginId = await consumers[0]!.reserve();
        await consumers[1]!.completeReservation(loginId, contractLogin(`round-${round}`));

        const results = await Promise.all(consumers.map((consumer) => consumer.consume(loginId)));

        expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      }
    });
  });

  describe('bounded cleanup', () => {
    async function insertExpired(count: number, expiredAt: number): Promise<void> {
      await ownerPool.query(
        `INSERT INTO app_private.oidc_pending_logins (login_digest, created_at, expires_at)
         SELECT digest, to_timestamp($1::double precision / 1000) - interval '10 minutes', to_timestamp($1::double precision / 1000)
         FROM unnest($2::text[]) AS digest`,
        [expiredAt, Array.from({ length: count }, (_, index) => opaqueValue(`expired-login-${index}`))],
      );
    }

    it('removes at most 100 expired rows per reservation, then the purge removes the rest in bounded batches, never a live row', async () => {
      const clock = new ContractClock();
      await insertExpired(250, clock.now - 1_000);
      const store = storeOn(runtimePool(1), clock, { capacity: 1_000 });

      const live = await store.reserve();
      await store.completeReservation(live, contractLogin('live'));
      expect(await storedCount()).toBe(250 - 100 + 1);

      expect(await runOidcLoginPurgeOnce(maintenancePool, clock)).toEqual({ purgedCount: 150, status: 'purged' });
      expect(await runOidcLoginPurgeOnce(maintenancePool, clock)).toEqual({ status: 'idle' });
      expect(await storedCount()).toBe(1);
      expect(await store.consume(live)).toEqual(contractLogin('live'));
    });

    it('purges no more than its batch limit in one cycle, and nothing that is still live', async () => {
      const clock = new ContractClock();
      // Expired exactly at the reservation instant: the boundary counts as expired.
      await insertExpired(700, clock.now);
      const store = storeOn(runtimePool(1), clock, { capacity: 1_000 });
      const live = await store.reserve();
      expect(await storedCount()).toBe(700 - 100 + 1);

      expect(await runOidcLoginPurgeOnce(maintenancePool, clock)).toEqual({ purgedCount: 500, status: 'purged' });
      expect(await storedCount()).toBe(101);
      expect(await runOidcLoginPurgeOnce(maintenancePool, clock)).toEqual({ purgedCount: 100, status: 'purged' });
      expect(await runOidcLoginPurgeOnce(maintenancePool, clock)).toEqual({ status: 'idle' });
      expect(await store.completeReservation(live, contractLogin('live'))).toBe(true);
    });

    it('keeps both bounds under a plan that rescans the batch, with every expiry tied', async () => {
      // These settings make PostgreSQL choose a nested-loop semi join that re-runs the batch per outer row. A
      // `WHERE digest IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` then deletes all 700 rows (a rescan skips rows the
      // statement already deleted); the materialized batch of migration 0037 deletes exactly n.
      const rescanning = [
        'SET enable_hashjoin = off',
        'SET enable_mergejoin = off',
        'SET enable_hashagg = off',
        'SET enable_material = off',
        'SET enable_sort = off',
      ];
      const integration = loadIntegrationTestConfiguration();
      const clock = new ContractClock();
      await insertExpired(700, clock.now);
      await ownerPool.query('ANALYZE app_private.oidc_pending_logins');

      const runtime = new Pool({ connectionString: integration.runtime.connectionString, max: 1 });
      const maintenance = new Pool({ connectionString: integration.maintenance.connectionString, max: 1 });
      runtimePools.push(runtime, maintenance);
      for (const pool of [runtime, maintenance]) {
        pool.on('connect', (client) => {
          for (const setting of rescanning) void client.query(setting);
        });
      }

      await storeOn(runtime, clock, { capacity: 1_000 }).reserve();
      expect(await storedCount()).toBe(700 - 100 + 1);
      expect(await runOidcLoginPurgeOnce(maintenance, clock)).toEqual({ purgedCount: 500, status: 'purged' });
      expect(await storedCount()).toBe(101);
    });
  });

  describe('database privileges (migration 0037)', () => {
    const tableStatements = [
      'SELECT * FROM app_private.oidc_pending_logins',
      'SELECT count(*) FROM app_private.oidc_pending_logins',
      `INSERT INTO app_private.oidc_pending_logins (login_digest, created_at, expires_at) VALUES ('${opaqueValue('x')}', now(), now() + interval '1 minute')`,
      "UPDATE app_private.oidc_pending_logins SET oidc_state = 'attacker'",
      'DELETE FROM app_private.oidc_pending_logins',
    ];

    it('lets neither application role touch the table directly, so neither can list or count pending logins', async () => {
      const runtime = runtimePool(1);
      for (const pool of [runtime, maintenancePool]) {
        for (const statement of tableStatements) {
          await expect(pool.query(statement), statement).rejects.toSatisfy((error) => sqlState(error) === '42501');
        }
      }
    });

    it('grants the runtime role exactly reserve, complete, consume and cancel by digest, and maintenance only the bounded purge', async () => {
      const result = await ownerPool.query<{
        maintenance: boolean;
        name: string;
        returns: string;
        runtime: boolean;
        world: boolean;
      }>(
        `SELECT proc.proname AS name,
                pg_get_function_result(proc.oid) AS returns,
                has_function_privilege('running_tracker_runtime', proc.oid, 'EXECUTE') AS runtime,
                has_function_privilege('running_tracker_maintenance', proc.oid, 'EXECUTE') AS maintenance,
                EXISTS (SELECT 1 FROM aclexplode(proc.proacl) AS acl WHERE acl.grantee = 0) AS world
         FROM pg_proc AS proc
         JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
         WHERE namespace.nspname = 'app_private' AND proc.proname LIKE '%oidc%'
         ORDER BY proc.proname`,
      );
      // No function returns a digest or more than the one attempt its caller named: there is no way to enumerate.
      expect(result.rows).toEqual([
        { maintenance: false, name: 'cancel_oidc_login', returns: 'boolean', runtime: true, world: false },
        { maintenance: false, name: 'clear_oidc_pending_logins', returns: 'bigint', runtime: false, world: false },
        { maintenance: false, name: 'complete_oidc_login', returns: 'boolean', runtime: true, world: false },
        {
          maintenance: false,
          name: 'consume_oidc_login',
          returns: 'TABLE(code_verifier text, oidc_state text, oidc_nonce text)',
          runtime: true,
          world: false,
        },
        { maintenance: true, name: 'purge_expired_oidc_logins', returns: 'integer', runtime: false, world: false },
        { maintenance: false, name: 'reserve_oidc_login', returns: 'text', runtime: true, world: false },
      ]);
      const table = await ownerPool.query<{ privileged: boolean; rls: boolean }>(
        `SELECT bool_or(has_table_privilege(role, 'app_private.oidc_pending_logins', privilege)) AS privileged,
                (SELECT relrowsecurity FROM pg_class WHERE oid = 'app_private.oidc_pending_logins'::regclass) AS rls
         FROM unnest(ARRAY['running_tracker_runtime', 'running_tracker_maintenance']) AS role,
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege`,
      );
      expect(table.rows[0]).toEqual({ privileged: false, rls: true });

      const runtime = runtimePool(1);
      for (const statement of [
        'SELECT app_private.clear_oidc_pending_logins()',
        'SELECT app_private.purge_expired_oidc_logins(now(), 10)',
      ]) {
        await expect(runtime.query(statement), statement).rejects.toSatisfy((error) => sqlState(error) === '42501');
      }
      const digest = opaqueValue('x');
      for (const statement of [
        `SELECT app_private.reserve_oidc_login('${digest}', now(), now() + interval '1 minute', 10, NULL)`,
        `SELECT app_private.complete_oidc_login('${digest}', 'v', 's', 'n', now())`,
        `SELECT * FROM app_private.consume_oidc_login('${digest}', now())`,
        `SELECT app_private.cancel_oidc_login('${digest}')`,
        'SELECT app_private.clear_oidc_pending_logins()',
      ]) {
        await expect(maintenancePool.query(statement), statement).rejects.toSatisfy((error) => sqlState(error) === '42501');
      }
    });

    it('reaches only the attempt whose identifier the caller knows', async () => {
      const clock = new ContractClock();
      const store = storeOn(runtimePool(1), clock);
      const victim = await store.reserve();
      await store.completeReservation(victim, contractLogin('victim'));
      const runtime = runtimePool(1);

      // Guessing digests, overwriting the victim's material and a duplicate reservation all leave it untouched.
      const guessed = await runtime.query('SELECT * FROM app_private.consume_oidc_login($1, now())', [opaqueValue('guess')]);
      expect(guessed.rows).toEqual([]);
      const overwrite = await runtime.query<{ completed: boolean }>(
        'SELECT app_private.complete_oidc_login($1, $2, $3, $4, $5) AS completed',
        [pendingLoginDigest(victim), 'attacker', 'attacker', 'attacker', new Date(clock.now)],
      );
      expect(overwrite.rows[0]?.completed).toBe(false);
      const duplicate = await runtime.query<{ outcome: string }>(
        'SELECT app_private.reserve_oidc_login($1, $2, $3, 100, NULL) AS outcome',
        [pendingLoginDigest(victim), new Date(clock.now), new Date(clock.now + 1_000)],
      );
      expect(duplicate.rows[0]?.outcome).toBe('duplicate');
      expect(await store.consume(victim)).toEqual(contractLogin('victim'));
    });
  });

  describe('when the store cannot answer', () => {
    it('reports an unreachable database as unavailable, never as a missing attempt, and quickly', async () => {
      const unreachable = new Pool({
        connectionString: `postgresql://running_tracker_runtime:x@127.0.0.1:${await closedPort()}/running_tracker_test`,
        connectionTimeoutMillis: 1_000,
        max: 1,
      });
      unreachable.on('error', () => undefined);
      runtimePools.push(unreachable);
      const store = storeOn(unreachable, new ContractClock());
      const loginId = 'A'.repeat(43);
      const started = Date.now();

      await expect(store.reserve()).rejects.toBeInstanceOf(OidcLoginStoreUnavailableError);
      await expect(store.completeReservation(loginId, contractLogin('x'))).rejects.toBeInstanceOf(OidcLoginStoreUnavailableError);
      await expect(store.consume(loginId)).rejects.toBeInstanceOf(OidcLoginStoreUnavailableError);
      await expect(store.cancel(loginId)).rejects.toBeInstanceOf(OidcLoginStoreUnavailableError);
      expect(Date.now() - started).toBeLessThan(8_000);
    });

    it('gives up at its deadline while the table is locked, then recovers on the same pool without a restart', async () => {
      const clock = new ContractClock();
      const pool = runtimePool(2);
      const store = storeOn(pool, clock, { operationTimeoutMs: 300 });
      const loginId = await store.reserve();
      await store.completeReservation(loginId, contractLogin('locked'));
      const blocker = await ownerPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE app_private.oidc_pending_logins IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        await expect(store.reserve()).rejects.toBeInstanceOf(OidcLoginStoreUnavailableError);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }

      expect(await store.consume(loginId)).toEqual(contractLogin('locked'));
    });

    it('treats a consume that ran out of time as uncertain: the attempt is still handed out at most once', async () => {
      const clock = new ContractClock();
      const loginId = await storeOn(runtimePool(1), clock).reserve();
      await storeOn(runtimePool(1), clock).completeReservation(loginId, contractLogin('uncertain'));
      const impatient = storeOn(runtimePool(1), clock, { operationTimeoutMs: 300 });
      const blocker = await ownerPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE app_private.oidc_pending_logins IN ACCESS EXCLUSIVE MODE');
        await expect(impatient.consume(loginId)).rejects.toBeInstanceOf(OidcLoginStoreUnavailableError);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }

      // The abandoned statement may or may not have run once the lock was gone. Whichever it was, no two callers ever
      // receive the attempt, and the caller that saw the timeout never received it.
      const later = await Promise.all([0, 1, 2].map(() => storeOn(runtimePool(1), clock).consume(loginId)));
      expect(later.filter((result) => result !== undefined).length).toBeLessThanOrEqual(1);
    });
  });
});
