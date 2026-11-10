import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';

import { systemClock } from '../../src/clock.js';
import { loadIntegrationTestConfiguration } from '../../src/config/environment.js';
import { runBoundedStatement } from '../../src/database/bounded-statement.js';
import { createDatabasePool, createMaintenanceDatabasePool } from '../../src/database/database.js';
import { withTenantTransaction } from '../../src/database/tenant-transaction.js';
import { runErasureLedgerExportOnce } from '../../src/maintenance/run-erasure-ledger-export.js';

// Child process of borrowed-client-termination.integration.test.ts. It builds the production runtime and maintenance
// pools, then terminates the PostgreSQL backend of a checked-out client with pg_terminate_backend while the client is
// running a query and while it sits between statements (including the journal export's file-write gap). Each
// operation must fail; the process must not exit; the next checkout must get a working connection. Without a client
// 'error' listener pg emits an unhandled 'error' event at the termination and Node exits with code 1 before the final
// line below is printed. One JSON line per scenario on stdout; the application's own JSON log lines go there too.

const { environment, maintenance, migration, runtime } = loadIntegrationTestConfiguration();
const runtimePool = createDatabasePool(environment);
const maintenancePool = createMaintenanceDatabasePool(environment);
// A role may terminate backends of its own role, so each pool's killer logs in as the same role.
const runtimeKiller = new Pool({ application_name: 'rt-borrowed-client-killer', connectionString: runtime.connectionString, max: 1 });
const maintenanceKiller = new Pool({ application_name: 'rt-borrowed-client-killer', connectionString: maintenance.connectionString, max: 1 });
const owner = new Pool({ application_name: 'rt-borrowed-client-owner', connectionString: migration.connectionString, max: 1 });

const tenant = { orgId: '6a4cc1a4-0d5c-4f0e-9a43-6f1f6b0c2a01', userId: '6a4cc1a4-0d5c-4f0e-9a43-6f1f6b0c2a02' };

function report(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ driver: true, ...line })}\n`);
}

async function terminate(killer: Pool, pid: number): Promise<void> {
  const result = await killer.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [pid]);
  if (result.rows[0]?.terminated !== true) throw new Error(`backend ${pid} was not terminated`);
  // Wait until the server has really ended it, then give the client's socket time to see the close.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await killer.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (alive.rowCount === 0) break;
    await delay(20);
  }
  await delay(200);
}

/** Terminates the one backend running a statement that contains `marker`, once it is active. */
async function terminateWhenActive(killer: Pool, marker: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const active = await killer.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()",
      [`%${marker}%`],
    );
    if (active.rows[0] !== undefined) {
      await terminate(killer, active.rows[0].pid);
      return;
    }
    await delay(20);
  }
  throw new Error(`no active statement with marker ${marker}`);
}

async function outcome(operation: () => Promise<unknown>): Promise<{ errorName: string; failed: boolean }> {
  try {
    await operation();
    return { errorName: '', failed: false };
  } catch (error) {
    return { errorName: error instanceof Error ? error.name : typeof error, failed: true };
  }
}

async function runtimeWorks(): Promise<boolean> {
  const rows = await withTenantTransaction(runtimePool, tenant, async (client) => (await client.query<{ ok: number }>('SELECT 1 AS ok')).rows);
  return rows[0]?.ok === 1;
}

async function maintenanceWorks(): Promise<boolean> {
  const client = await maintenancePool.connect();
  try {
    return (await client.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok === 1;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  // 1. Tenant transaction, terminated while its statement runs.
  {
    const marker = 'rt-borrowed-tenant-during-query';
    const killing = terminateWhenActive(runtimeKiller, marker);
    const result = await outcome(() =>
      withTenantTransaction(runtimePool, tenant, (client) => client.query(`SELECT pg_sleep(4) /* ${marker} */`)),
    );
    await killing;
    report({ scenario: 'tenant-during-query', ...result, recovered: await runtimeWorks() });
  }

  // 2. Tenant transaction, terminated between two statements of the callback.
  {
    const result = await outcome(() =>
      withTenantTransaction(runtimePool, tenant, async (client) => {
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await terminate(runtimeKiller, pid);
        await client.query('SELECT 2');
      }),
    );
    report({ scenario: 'tenant-between-statements', ...result, recovered: await runtimeWorks() });
  }

  // 3. Tenant transaction, terminated after the callback's last statement: COMMIT cannot be sent.
  {
    const result = await outcome(() =>
      withTenantTransaction(runtimePool, tenant, async (client) => {
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await terminate(runtimeKiller, pid);
      }),
    );
    report({ scenario: 'tenant-before-commit', ...result, recovered: await runtimeWorks() });
  }

  // 4. The bounded session statement (ADR-0080/0081), terminated while it runs.
  {
    const marker = 'rt-borrowed-bounded-during-query';
    const killing = terminateWhenActive(runtimeKiller, marker);
    const result = await outcome(() =>
      runBoundedStatement(
        {
          clock: systemClock,
          discardedConnectionMessage: 'discarded by the borrowed-client probe',
          pool: runtimePool,
          timeoutMs: 4_500,
          unavailable: (reason, options) => Object.assign(new Error(reason, options), { name: 'ProbeUnavailableError' }),
        },
        `SELECT pg_sleep(4) /* ${marker} */`,
        [],
      ),
    );
    await killing;
    report({ scenario: 'bounded-during-query', ...result, recovered: await runtimeWorks() });
  }

  // 5. The erasure ledger exporter, terminated while it waits for the durable file write (claim done, no ack yet).
  {
    await owner.query(
      `INSERT INTO erasure_ledger (entity_type, org_id, record_id, owner_user_id, record_created_at, erased_at)
       VALUES ('activity', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now(), now())`,
    );
    const pending = async () => Number((await owner.query<{ count: string }>('SELECT count(*) AS count FROM erasure_ledger')).rows[0]!.count);
    const before = await pending();
    const result = await outcome(() =>
      runErasureLedgerExportOnce(
        maintenancePool,
        {
          write: async () => {
            const exporter = await maintenanceKiller.query<{ pid: number }>(
              "SELECT pid FROM pg_stat_activity WHERE application_name = 'running-tracker-maintenance' AND state = 'idle in transaction'",
            );
            if (exporter.rows.length !== 1) throw new Error(`expected one exporter backend, found ${exporter.rows.length}`);
            await terminate(maintenanceKiller, exporter.rows[0]!.pid);
          },
        },
        systemClock,
      ),
    );
    const keptRows = (await pending()) === before;
    const written: string[] = [];
    const next = await runErasureLedgerExportOnce(maintenancePool, { write: (name) => Promise.resolve(void written.push(name)) }, systemClock);
    report({
      scenario: 'journal-export-io-gap',
      ...result,
      keptRows,
      recovered: (await maintenanceWorks()) && next.status === 'exported' && written.length === 1 && (await pending()) === 0,
    });
  }

  // Late events have had time to arrive; the process is still here.
  await delay(300);
  report({ done: true });
}

try {
  await main();
} finally {
  await Promise.allSettled([runtimePool.end(), maintenancePool.end(), runtimeKiller.end(), maintenanceKiller.end(), owner.end()]);
}
