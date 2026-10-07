import { performance } from 'node:perf_hooks';

import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { lockArchiveRevisionForAclChange } from '../src/archive/archive-service.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { classifyDatabaseTimeout } from '../src/database/database-errors.js';
import { createDatabasePool, createMaintenanceDatabasePool } from '../src/database/database.js';
import { withAuthenticatedTenantTransaction } from '../src/database/authenticated-tenant-transaction.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const STATEMENT_BUDGET_MS = 800;
const LOCK_BUDGET_MS = 300;
// Generous upper bound: a budget that fires must end the work well before an unbounded wait would be noticed.
const SETTLE_LIMIT_MS = 3_000;
const tenant = { orgId: ids.orgA, userId: ids.userDual };

async function timed<Result>(
  operation: () => Promise<Result>,
): Promise<{ elapsedMs: number; error: unknown; result?: Result }> {
  const startedAt = performance.now();
  try {
    const result = await operation();
    return { elapsedMs: performance.now() - startedAt, error: undefined, result };
  } catch (error) {
    return { elapsedMs: performance.now() - startedAt, error };
  }
}

async function waitUntil(predicate: () => boolean, limitMs = 5_000): Promise<void> {
  const deadline = performance.now() + limitMs;
  while (performance.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Deterministic integration condition was not reached');
}

function checkedOut(pool: Pool): number {
  return pool.totalCount - pool.idleCount;
}

describe('runtime SQL execution and lock-wait budgets', () => {
  let config: Environment;
  let integrationMaintenanceUrl: string;
  let ownerPool: Pool;
  const openedPools: Pool[] = [];
  const heldByOwner: PoolClient[] = [];

  function runtimePool(max: number): Pool {
    const pool = createDatabasePool({ ...config, DB_POOL_MAX: max });
    openedPools.push(pool);
    return pool;
  }

  /** Connection A: a separate owner-role session that holds a lock inside an open transaction. */
  async function holdWithOwner(statement: string, values: unknown[] = []): Promise<PoolClient> {
    const holder = await ownerPool.connect();
    heldByOwner.push(holder);
    await holder.query('BEGIN');
    await holder.query(statement, values);
    return holder;
  }

  async function releaseHeld(): Promise<void> {
    for (const holder of heldByOwner.splice(0)) {
      try {
        await holder.query('ROLLBACK');
      } finally {
        holder.release();
      }
    }
  }

  async function probeRows(): Promise<Array<{ id: number; note: string }>> {
    const result = await ownerPool.query<{ id: number; note: string }>(
      'SELECT id, note FROM public.db_budget_probe ORDER BY id',
    );
    return result.rows;
  }

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    integrationMaintenanceUrl = integration.maintenance.connectionString;
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      DB_LOCK_TIMEOUT_MS: String(LOCK_BUDGET_MS),
      DB_STATEMENT_TIMEOUT_MS: String(STATEMENT_BUDGET_MS),
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: ids.userDual,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-database-budget-fixtures',
      connectionString: integration.migration.connectionString,
      max: 4,
    });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await ownerPool.query('DROP TABLE IF EXISTS public.db_budget_probe');
    await ownerPool.query('CREATE TABLE public.db_budget_probe (id integer PRIMARY KEY, note text NOT NULL)');
    await ownerPool.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.db_budget_probe TO running_tracker_runtime',
    );
  });

  beforeEach(async () => {
    await ownerPool.query('DELETE FROM public.db_budget_probe');
    await ownerPool.query("INSERT INTO public.db_budget_probe (id, note) VALUES (1, 'seed')");
  });

  afterEach(async () => {
    await releaseHeld();
  });

  afterAll(async () => {
    await releaseHeld();
    await Promise.all(openedPools.map((pool) => pool.end()));
    await ownerPool?.query('DROP TABLE IF EXISTS public.db_budget_probe');
    await ownerPool?.end();
  });

  describe('the configured budgets', () => {
    it('are in force on every fresh runtime connection and absent from the maintenance pool', async () => {
      const pool = runtimePool(1);
      const maintenance = createMaintenanceDatabasePool(
        validateEnvironment({
          APP_ENV: 'test',
          DATABASE_URL: config.DATABASE_URL,
          MAINTENANCE_DATABASE_URL: integrationMaintenanceUrl,
        }),
      );
      openedPools.push(maintenance);
      const settings =
        "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock";

      await expect(pool.query(settings)).resolves.toMatchObject({
        rows: [{ lock: `${LOCK_BUDGET_MS}ms`, statement: `${STATEMENT_BUDGET_MS}ms` }],
      });
      await expect(maintenance.query(settings)).resolves.toMatchObject({
        rows: [{ lock: '0', statement: '0' }],
      });
    });

    it('leave a normal transaction unaffected', async () => {
      const pool = runtimePool(2);

      const written = await withTenantTransaction(pool, tenant, async (client) => {
        await client.query("INSERT INTO public.db_budget_probe (id, note) VALUES (2, 'committed')");
        await client.query('SELECT pg_sleep(0.05)');
        return client.query<{ note: string }>('SELECT note FROM public.db_budget_probe WHERE id = 2');
      });

      expect(written.rows).toEqual([{ note: 'committed' }]);
      expect(await probeRows()).toEqual([
        { id: 1, note: 'seed' },
        { id: 2, note: 'committed' },
      ]);
    });
  });

  describe('statement timeout', () => {
    it('cancels an ordinary pooled query and keeps the pool usable', async () => {
      const pool = runtimePool(1);

      const slow = await timed(() => pool.query('SELECT pg_sleep(5)'));

      expect(classifyDatabaseTimeout(slow.error)).toBe('statement');
      expect(slow.elapsedMs).toBeGreaterThanOrEqual(STATEMENT_BUDGET_MS - 100);
      expect(slow.elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
      expect(checkedOut(pool)).toBe(0);
      await expect(pool.query('SELECT 1 AS reusable')).resolves.toMatchObject({ rows: [{ reusable: 1 }] });
    });

    it('cancels a transaction statement, rolls the transaction back and reuses the same connection', async () => {
      const pool = runtimePool(1);
      const { rows: before } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

      const slow = await timed(() =>
        withTenantTransaction(pool, tenant, async (client) => {
          await client.query("INSERT INTO public.db_budget_probe (id, note) VALUES (50, 'must roll back')");
          await client.query('SELECT pg_sleep(5)');
        }),
      );

      expect(classifyDatabaseTimeout(slow.error)).toBe('statement');
      expect(slow.elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
      expect(await probeRows()).toEqual([{ id: 1, note: 'seed' }]);
      expect(checkedOut(pool)).toBe(0);

      const after = await withTenantTransaction(pool, tenant, (client) =>
        client.query<{ in_transaction: boolean; pid: number }>(
          'SELECT pg_backend_pid() AS pid, (pg_current_xact_id_if_assigned() IS NOT NULL) AS in_transaction',
        ),
      );
      expect(after.rows[0]?.pid).toBe(before[0]?.pid);
    });
  });

  describe('lock timeout', () => {
    it('fails a conflicting transaction within the lock budget as a lock timeout, not a statement timeout', async () => {
      const pool = runtimePool(2);
      await holdWithOwner("UPDATE public.db_budget_probe SET note = 'held by A' WHERE id = 1");

      const blocked = await timed(() =>
        withTenantTransaction(pool, tenant, async (client) => {
          await client.query("INSERT INTO public.db_budget_probe (id, note) VALUES (60, 'must roll back')");
          await client.query("UPDATE public.db_budget_probe SET note = 'by B' WHERE id = 1");
        }),
      );

      expect(classifyDatabaseTimeout(blocked.error)).toBe('lock');
      expect(blocked.elapsedMs).toBeGreaterThanOrEqual(LOCK_BUDGET_MS - 100);
      expect(blocked.elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
      expect(checkedOut(pool)).toBe(0);
      expect(pool.waitingCount).toBe(0);

      await releaseHeld();
      expect(await probeRows()).toEqual([{ id: 1, note: 'seed' }]);
    });

    it('serves the conflicting work normally once the holder lets go', async () => {
      const pool = runtimePool(2);
      await holdWithOwner("UPDATE public.db_budget_probe SET note = 'held by A' WHERE id = 1");
      const blocked = await timed(() =>
        withTenantTransaction(pool, tenant, (client) =>
          client.query("UPDATE public.db_budget_probe SET note = 'by B' WHERE id = 1"),
        ),
      );
      expect(classifyDatabaseTimeout(blocked.error)).toBe('lock');

      await releaseHeld();
      await withTenantTransaction(pool, tenant, (client) =>
        client.query("UPDATE public.db_budget_probe SET note = 'by B' WHERE id = 1"),
      );

      expect(await probeRows()).toEqual([{ id: 1, note: 'by B' }]);
    });

    it('does not let a lock waiter outlive its budget on the archive revision row', async () => {
      const pool = runtimePool(2);
      // A tile reader holds FOR SHARE on the organization; an ACL change needs FOR UPDATE.
      await holdWithOwner('SELECT id FROM public.organizations WHERE id = $1 FOR SHARE', [ids.orgA]);

      const blocked = await timed(() =>
        withAuthenticatedTenantTransaction(pool, { userId: ids.userDual }, ids.orgA, (client) =>
          lockArchiveRevisionForAclChange(client, ids.orgA),
        ),
      );

      expect(classifyDatabaseTimeout(blocked.error)).toBe('lock');
      expect(blocked.elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
      expect(checkedOut(pool)).toBe(0);
    });
  });

  describe('pool recovery', () => {
    it('does not leak a transaction-local override to the next borrower of the same connection', async () => {
      const pool = runtimePool(1);
      const settings = (client: PoolClient) =>
        client.query<{ lock: string; statement: string }>(
          "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock",
        );

      await withTenantTransaction(pool, tenant, async (client) => {
        await client.query("SET LOCAL statement_timeout = '50ms'");
        await client.query("SET LOCAL lock_timeout = '20ms'");
        expect((await settings(client)).rows[0]).toEqual({ lock: '20ms', statement: '50ms' });
      });
      const afterCommit = await withTenantTransaction(pool, tenant, settings);
      expect(afterCommit.rows[0]).toEqual({
        lock: `${LOCK_BUDGET_MS}ms`,
        statement: `${STATEMENT_BUDGET_MS}ms`,
      });

      const failed = await timed(() =>
        withTenantTransaction(pool, tenant, async (client) => {
          await client.query("SET LOCAL statement_timeout = '50ms'");
          await client.query('SELECT pg_sleep(5)');
        }),
      );
      expect(classifyDatabaseTimeout(failed.error)).toBe('statement');
      const afterRollback = await withTenantTransaction(pool, tenant, settings);
      expect(afterRollback.rows[0]).toEqual({
        lock: `${LOCK_BUDGET_MS}ms`,
        statement: `${STATEMENT_BUDGET_MS}ms`,
      });
    });

    it('survives repeated lock and statement timeouts without leaking or stranding connections', async () => {
      const pool = runtimePool(2);
      await holdWithOwner("UPDATE public.db_budget_probe SET note = 'held by A' WHERE id = 1");

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const lock = await timed(() =>
          withTenantTransaction(pool, tenant, (client) =>
            client.query("UPDATE public.db_budget_probe SET note = 'by B' WHERE id = 1"),
          ),
        );
        expect(classifyDatabaseTimeout(lock.error)).toBe('lock');
        const statement = await timed(() =>
          withTenantTransaction(pool, tenant, (client) => client.query('SELECT pg_sleep(5)')),
        );
        expect(classifyDatabaseTimeout(statement.error)).toBe('statement');
      }

      expect(pool.waitingCount).toBe(0);
      expect(checkedOut(pool)).toBe(0);
      expect(pool.totalCount).toBeLessThanOrEqual(2);
      await releaseHeld();
      await expect(pool.query('SELECT 1 AS reusable')).resolves.toMatchObject({ rows: [{ reusable: 1 }] });
    });

    it('frees a saturated small pool: contenders time out in turn, then new work proceeds', async () => {
      const pool = runtimePool(2);
      // Connection A is itself a runtime connection, so only one slot remains for two contenders.
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query("UPDATE public.db_budget_probe SET note = 'held by A' WHERE id = 1");

        const contenders = await Promise.all(
          [1, 2].map(() =>
            timed(() =>
              withTenantTransaction(pool, tenant, (client) =>
                client.query("UPDATE public.db_budget_probe SET note = 'by B' WHERE id = 1"),
              ),
            ),
          ),
        );

        // Both fail on the database lock budget; neither starves on pool acquisition.
        expect(contenders.map(({ error }) => classifyDatabaseTimeout(error))).toEqual(['lock', 'lock']);
        expect(Math.max(...contenders.map(({ elapsedMs }) => elapsedMs))).toBeLessThan(SETTLE_LIMIT_MS);
        expect(pool.waitingCount).toBe(0);
        expect(checkedOut(pool)).toBe(1);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }

      expect(checkedOut(pool)).toBe(0);
      const results = await Promise.all(
        [10, 11, 12].map((id) =>
          withTenantTransaction(pool, tenant, (client) =>
            client.query('INSERT INTO public.db_budget_probe (id, note) VALUES ($1, $2)', [id, 'after']),
          ),
        ),
      );
      expect(results).toHaveLength(3);
      expect((await probeRows()).map(({ id }) => id)).toEqual([1, 10, 11, 12]);
    });
  });

  describe('archive flow over HTTP', () => {
    async function archiveApp(pool: Pool): Promise<ReturnType<typeof request.agent>> {
      const sessionManager = new SessionManager({
        clock: systemClock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      });
      const agent = request.agent(
        createApp({ clock: systemClock, config, pool, sessionManager }),
      );
      await agent
        .post('/api/session')
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ userId: ids.userDual })
        .expect(201);
      return agent;
    }

    const tileUrl = `/api/orgs/${ids.orgA}/tiles/runs/8/130/84.mvt?revision=0&from=2026-09-01T00%3A00%3A00Z&to=2026-10-01T00%3A00%3A00Z`;

    it('answers a blocked archive authorization lock with a sanitized retryable 503, then recovers', async () => {
      const pool = runtimePool(2);
      const agent = await archiveApp(pool);
      // An in-flight ACL change or archive revision bump owns the organization row.
      await holdWithOwner('SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE', [ids.orgA]);

      const blocked = await timed(() => agent.get(tileUrl).buffer(true));

      const response = blocked.result;
      expect(response?.status).toBe(503);
      expect(response?.body).toMatchObject({ error: { code: 'DB_LOCK_TIMEOUT' } });
      expect(JSON.stringify(response?.body)).not.toMatch(/55P03|lock timeout|organizations|SELECT/u);
      expect(blocked.elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
      expect(checkedOut(pool)).toBe(0);
      expect(pool.waitingCount).toBe(0);

      await releaseHeld();
      await agent.get(tileUrl).buffer(true).expect(200);
    });

    it('releases the database connection on its own when the browser gives up while the lock is held', async () => {
      const pool = runtimePool(2);
      const agent = await archiveApp(pool);
      await holdWithOwner('SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE', [ids.orgA]);

      // The caller abandons the request after 100 ms, far sooner than the database budget.
      const abandoned = timed(() => agent.get(tileUrl).buffer(true).timeout({ response: 100 }));
      await waitUntil(() => checkedOut(pool) === 1);
      expect((await abandoned).error).toBeDefined();

      // Nothing cancels the statement from the client side; only the server-side budget can free the connection.
      await waitUntil(() => checkedOut(pool) === 0, SETTLE_LIMIT_MS);
      expect(pool.waitingCount).toBe(0);
      await expect(pool.query('SELECT 1 AS reusable')).resolves.toMatchObject({ rows: [{ reusable: 1 }] });
    });
  });
});
