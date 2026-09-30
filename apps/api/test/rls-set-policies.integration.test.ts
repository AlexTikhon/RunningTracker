import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

interface KeyRow {
  org_id: string;
  run_id: string;
}

const tenants = [ids.orgA, ids.orgB] as const;
const users = [
  ids.userDual,
  ids.userInactive,
  ids.userOrgA,
  ids.userOrgB,
  ids.userPausedOwner,
  ids.userStranger,
  ids.userHistoryActiveOwner,
] as const;
const unknownUser = '99999999-9999-4999-8999-999999999999';

describe('P11.5 set-based run visibility functions', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-set-policy-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  // The per-row functions are the specification: the set functions must return exactly the runs
  // for which they are true, for every identity and tenant, including the ones that must see nothing.
  const oracleAndSet = async (
    orgId: string,
    userId: string,
    perRowFunction: 'can_read_run' | 'can_read_run_history',
    setFunction: 'readable_run_keys' | 'history_readable_run_keys',
  ): Promise<{ oracle: KeyRow[]; set: KeyRow[] }> => {
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [orgId, userId],
      );
      const oracle = await client.query<KeyRow>(
        `SELECT org_id, id AS run_id FROM runs
         WHERE app_private.${perRowFunction}(org_id, id)
         ORDER BY org_id, id`,
      );
      const set = await client.query<KeyRow>(
        `SELECT org_id, run_id FROM app_private.${setFunction}() ORDER BY org_id, run_id`,
      );
      await client.query('ROLLBACK');
      return { oracle: oracle.rows, set: set.rows };
    } finally {
      client.release();
    }
  };

  it.each([
    ['can_read_run', 'readable_run_keys'],
    ['can_read_run_history', 'history_readable_run_keys'],
  ] as const)(
    'returns exactly the runs %s allows for every user and tenant',
    async (perRowFunction, setFunction) => {
      let nonEmptySets = 0;
      for (const orgId of tenants) {
        for (const userId of [...users, unknownUser]) {
          const { oracle, set } = await oracleAndSet(orgId, userId, perRowFunction, setFunction);
          expect(set, `${setFunction} for ${userId} in ${orgId}`).toEqual(oracle);
          if (set.length > 0) {
            nonEmptySets += 1;
          }
        }
      }
      // The comparison is only meaningful if it covered granted, owned, and denied identities.
      expect(nonEmptySets).toBeGreaterThanOrEqual(3);
    },
  );

  it('returns nothing without a tenant context, with a malformed one, and across tenants', async () => {
    for (const setting of [
      { orgId: '', userId: '' },
      { orgId: 'not-a-uuid', userId: ids.userDual },
      { orgId: ids.orgA, userId: 'not-a-uuid' },
    ]) {
      const client = await ownerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
          [setting.orgId, setting.userId],
        );
        for (const fn of ['readable_run_keys', 'history_readable_run_keys']) {
          const result = await client.query(`SELECT 1 FROM app_private.${fn}()`);
          expect(result.rowCount, `${fn} with ${JSON.stringify(setting)}`).toBe(0);
        }
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
  });

  it('gives the runtime role the same visible runs, points, and summaries as before the set policies', async () => {
    const visible = (table: 'run_points' | 'run_summaries' | 'runs', orgId: string, userId: string) =>
      withTenantTransaction(runtimePool, { orgId, userId }, async (client) => {
        const column = table === 'runs' ? 'id' : 'run_id';
        const result = await client.query<{ run_id: string }>(
          `SELECT DISTINCT ${column} AS run_id FROM ${table} ORDER BY 1`,
        );
        return result.rows.map((row) => row.run_id);
      });

    const historyGrantee = [ids.runFinishedHistory, ids.runFinishedBoth];
    const dualRuns = [
      ids.runRecording,
      ids.runPaused,
      ids.runFinishedHistory,
      ids.runFinishedBoth,
    ];

    await expect(visible('run_summaries', ids.orgA, ids.userDual)).resolves.toEqual(historyGrantee);
    await expect(visible('run_points', ids.orgA, ids.userDual)).resolves.toEqual(dualRuns);
    await expect(visible('runs', ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(visible('run_points', ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(visible('runs', ids.orgB, ids.userDual)).resolves.toEqual([ids.runOrgBShared]);
  });

  it('keeps both set functions stable, definer-owned, path-pinned, and executable only by the runtime role', async () => {
    const result = await ownerPool.query<{
      maintenance_execute: boolean;
      name: string;
      owner: string;
      proconfig: string[];
      prosecdef: boolean;
      provolatile: string;
      public_execute: boolean;
      runtime_execute: boolean;
    }>(
      `SELECT procedure.proname AS name,
              pg_get_userbyid(procedure.proowner) AS owner,
              procedure.prosecdef,
              procedure.provolatile,
              procedure.proconfig,
              has_function_privilege('running_tracker_runtime', procedure.oid, 'EXECUTE')
                AS runtime_execute,
              has_function_privilege('running_tracker_maintenance', procedure.oid, 'EXECUTE')
                AS maintenance_execute,
              has_function_privilege('public', procedure.oid, 'EXECUTE') AS public_execute
       FROM pg_proc AS procedure
       WHERE procedure.pronamespace = 'app_private'::regnamespace
         AND procedure.proname IN ('readable_run_keys', 'history_readable_run_keys')
       ORDER BY procedure.proname`,
    );
    expect(result.rows).toEqual(
      ['history_readable_run_keys', 'readable_run_keys'].map((name) => ({
        maintenance_execute: false,
        name,
        owner: 'running_tracker_owner',
        proconfig: ['search_path=pg_catalog'],
        prosecdef: true,
        provolatile: 's',
        public_execute: false,
        runtime_execute: true,
      })),
    );
  });
});

describe('P11.5 live visibility scope', () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-live-scope-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  const keys = async (
    orgId: string,
    userId: string,
    scope: string | null,
    fn: 'readable_run_keys' | 'history_readable_run_keys',
  ): Promise<string[]> => {
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [orgId, userId],
      );
      if (scope !== null) {
        await client.query(`SELECT set_config('app.visibility_scope', $1, true)`, [scope]);
      }
      const result = await client.query<{ run_id: string }>(
        `SELECT run_id FROM app_private.${fn}() ORDER BY run_id`,
      );
      await client.query('ROLLBACK');
      return result.rows.map((row) => row.run_id);
    } finally {
      client.release();
    }
  };

  const statusOf = async (runIds: string[]): Promise<Map<string, string>> => {
    const result = await ownerPool.query<{ id: string; status: string }>(
      'SELECT id, status FROM runs WHERE id = ANY($1::uuid[])',
      [runIds],
    );
    return new Map(result.rows.map((row) => [row.id, row.status]));
  };

  it('narrows to recording and paused runs the identity may read, for every user and tenant', async () => {
    let narrowedSomething = false;
    for (const orgId of tenants) {
      for (const userId of [...users, unknownUser]) {
        const full = await keys(orgId, userId, null, 'readable_run_keys');
        const live = await keys(orgId, userId, 'live', 'readable_run_keys');
        const status = await statusOf(full);
        const expected = full.filter((id) => {
          const value = status.get(id);
          return value === 'recording' || value === 'paused';
        });
        expect(live, `live scope for ${userId} in ${orgId}`).toEqual(expected);
        if (live.length < full.length) {
          narrowedSomething = true;
        }
      }
    }
    expect(narrowedSomething).toBe(true);
  });

  it('never widens: any other scope value returns the unscoped set', async () => {
    for (const scope of ['', 'LIVE', 'all', 'history', 'live ', '1', 'live; --']) {
      for (const userId of [ids.userDual, ids.userOrgA, ids.userStranger]) {
        await expect(keys(ids.orgA, userId, scope, 'readable_run_keys')).resolves.toEqual(
          await keys(ids.orgA, userId, null, 'readable_run_keys'),
        );
      }
    }
  });

  it('leaves the archive set untouched by the scope', async () => {
    for (const userId of [ids.userDual, ids.userOrgA]) {
      await expect(keys(ids.orgA, userId, 'live', 'history_readable_run_keys')).resolves.toEqual(
        await keys(ids.orgA, userId, null, 'history_readable_run_keys'),
      );
    }
  });

  it('applies the scope to runs and points through the policies under the runtime role', async () => {
    const visible = (table: 'run_points' | 'runs', scope: string | null) =>
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userDual },
        async (client) => {
          if (scope !== null) {
            await client.query(`SELECT set_config('app.visibility_scope', $1, true)`, [scope]);
          }
          const column = table === 'runs' ? 'id' : 'run_id';
          const result = await client.query<{ run_id: string }>(
            `SELECT DISTINCT ${column} AS run_id FROM ${table} ORDER BY 1`,
          );
          return result.rows.map((row) => row.run_id);
        },
      );

    const liveRuns = [ids.runRecording, ids.runPaused];
    await expect(visible('run_points', 'live')).resolves.toEqual(liveRuns);
    await expect(visible('runs', 'live')).resolves.toEqual(liveRuns);
    // The scope is transaction-local: the next transaction on a pooled connection sees the full set.
    await expect(visible('run_points', null)).resolves.toEqual([
      ids.runRecording,
      ids.runPaused,
      ids.runFinishedHistory,
      ids.runFinishedBoth,
    ]);
  });
});
