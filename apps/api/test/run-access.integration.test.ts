import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const extraRunIds = {
  constraint: 'c0000000-0000-4000-8000-000000000001',
  insert: 'c0000000-0000-4000-8000-000000000002',
  orgAActive: 'c0000000-0000-4000-8000-000000000003',
  orgBActive: 'c0000000-0000-4000-8000-000000000004',
} as const;

describe('P02B runs and run_shares ACL', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-run-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-run-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  const readRuns = (orgId: string, userId: string) =>
    withTenantTransaction(runtimePool, { orgId, userId }, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM runs ORDER BY id');
      return result.rows.map(({ id }) => id);
    });

  it('applies owner, live, history, role, and tenant read rules', async () => {
    await expect(readRuns(ids.orgA, ids.userOrgA)).resolves.toEqual([
      ids.runRecording,
      ids.runFinishedHistory,
      ids.runFinishedLiveOnly,
      ids.runFinishedBoth,
    ]);
    await expect(readRuns(ids.orgA, ids.userDual)).resolves.toEqual([
      ids.runRecording,
      ids.runPaused,
      ids.runFinishedHistory,
      ids.runFinishedBoth,
    ]);
    await expect(readRuns(ids.orgA, ids.userStranger)).resolves.toEqual([]);
    await expect(readRuns(ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(readRuns(ids.orgA, ids.userInactive)).resolves.toEqual([]);

    await expect(readRuns(ids.orgB, ids.userDual)).resolves.toEqual([ids.runOrgBShared]);
  });

  it('fails closed for missing and malformed run contexts', async () => {
    const missing = await runtimePool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM runs',
    );
    expect(missing.rows[0]?.count).toBe('0');

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', 'invalid', true)");
      await client.query("SELECT set_config('app.org_id', 'invalid', true)");
      const malformed = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM runs',
      );
      expect(malformed.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('does not expose another user shares through direct run_shares reads', async () => {
    const readShares = (userId: string) =>
      withTenantTransaction(runtimePool, { orgId: ids.orgA, userId }, async (client) => {
        const result = await client.query<{ grantee_user_id: string; run_id: string }>(
          `SELECT run_id, grantee_user_id
           FROM run_shares
           ORDER BY run_id, grantee_user_id`,
        );
        return result.rows;
      });

    const granteeShares = await readShares(ids.userDual);
    expect(granteeShares).toHaveLength(6);
    expect(granteeShares.every(({ grantee_user_id }) => grantee_user_id === ids.userDual)).toBe(true);

    const ownerShares = await readShares(ids.userOrgA);
    expect(ownerShares).toHaveLength(5);
    expect(ownerShares.map(({ run_id }) => run_id)).not.toContain(ids.runPaused);

    await expect(readShares(ids.userStranger)).resolves.toEqual([]);
  });

  it('lets an active owner insert and update runs but never delete them', async () => {
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        async (client) => {
          const updated = await client.query(
            'UPDATE runs SET data_revision = data_revision + 1 WHERE org_id = $1 AND id = $2',
            [ids.orgA, ids.runRecording],
          );
          const inserted = await client.query(
            `INSERT INTO runs (
               org_id, id, user_id, status, created_at, started_at, finished_at
             )
             VALUES ($1, $2, $3, 'finished', $4, $4, $5)`,
            [
              ids.orgA,
              extraRunIds.insert,
              ids.userOrgA,
              '2026-09-20T10:00:00.000Z',
              '2026-09-20T11:00:00.000Z',
            ],
          );
          return { inserted: inserted.rowCount, updated: updated.rowCount };
        },
      ),
    ).resolves.toEqual({ inserted: 1, updated: 1 });

    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        (client) => client.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [
          ids.orgA,
          ids.runRecording,
        ]),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('prevents a grantee from changing a run or its shares', async () => {
    const result = await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userDual },
      async (client) => {
        const runUpdate = await client.query(
          'UPDATE runs SET data_revision = data_revision + 1 WHERE org_id = $1 AND id = $2',
          [ids.orgA, ids.runRecording],
        );
        const shareUpdate = await client.query(
          `UPDATE run_shares
           SET can_read_history = true
           WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
          [ids.orgA, ids.runRecording, ids.userDual],
        );
        const shareDelete = await client.query(
          `DELETE FROM run_shares
           WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
          [ids.orgA, ids.runRecording, ids.userDual],
        );
        return {
          runUpdate: runUpdate.rowCount,
          shareDelete: shareDelete.rowCount,
          shareUpdate: shareUpdate.rowCount,
        };
      },
    );
    expect(result).toEqual({ runUpdate: 0, shareDelete: 0, shareUpdate: 0 });

    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userDual },
        (client) =>
          client.query(
            `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_history)
             VALUES ($1, $2, $3, true)`,
            [ids.orgA, ids.runRecording, ids.userStranger],
          ),
      ),
    ).rejects.toThrow(/row-level security/u);
  });

  it('lets only the run owner create, change, and revoke shares', async () => {
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        async (client) => {
          const inserted = await client.query<{
            can_read_history: boolean;
            can_read_live: boolean;
          }>(
            `INSERT INTO run_shares (org_id, run_id, grantee_user_id)
             VALUES ($1, $2, $3)
             RETURNING can_read_history, can_read_live`,
            [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
          );
          const updated = await client.query(
            `UPDATE run_shares
             SET can_read_history = true, can_read_live = true
             WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
            [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
          );
          const deleted = await client.query(
            `DELETE FROM run_shares
             WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
            [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
          );
          return {
            deleted: deleted.rowCount,
            inserted: inserted.rows[0],
            updated: updated.rowCount,
          };
        },
      ),
    ).resolves.toEqual({
      deleted: 1,
      inserted: { can_read_history: false, can_read_live: false },
      updated: 1,
    });
  });

  it('rejects owner and organization changes through UPDATE', async () => {
    for (const [column, value] of [
      ['user_id', ids.userPausedOwner],
      ['org_id', ids.orgB],
    ] as const) {
      await expect(
        withTenantTransaction(
          runtimePool,
          { orgId: ids.orgA, userId: ids.userOrgA },
          (client) =>
            client.query(
              `UPDATE runs SET ${column} = $1 WHERE org_id = $2 AND id = $3`,
              [value, ids.orgA, ids.runFinishedHistory],
            ),
        ),
      ).rejects.toThrow(/foreign key|permission denied|row-level security/u);
    }
  });

  it('removes access immediately after grant revocation or membership deactivation', async () => {
    await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userOrgA },
      (client) =>
        client.query(
          `DELETE FROM run_shares
           WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
          [ids.orgA, ids.runFinishedHistory, ids.userDual],
        ),
    );
    await expect(readRuns(ids.orgA, ids.userDual)).resolves.not.toContain(ids.runFinishedHistory);

    await ownerPool.query(
      'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
      [ids.orgA, ids.userDual],
    );
    await expect(readRuns(ids.orgA, ids.userDual)).resolves.toEqual([]);
  });

  it('enforces run state, revision, and timestamp constraints', async () => {
    const invalidStatements = [
      {
        constraint: 'runs_status_known',
        values: [ids.orgA, extraRunIds.constraint, ids.userStranger, 'unknown'],
        sql: `INSERT INTO runs (org_id, id, user_id, status)
              VALUES ($1, $2, $3, $4)`,
      },
      {
        constraint: 'runs_raw_state_known',
        values: [ids.orgA, extraRunIds.constraint, ids.userStranger, 'missing'],
        sql: `INSERT INTO runs (
                org_id, id, user_id, status, raw_state, created_at, started_at, finished_at
              )
              VALUES (
                $1, $2, $3, 'finished', $4,
                '2026-09-20T08:00:00Z', '2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z'
              )`,
      },
      {
        constraint: 'runs_data_revision_nonnegative',
        values: [ids.orgA, extraRunIds.constraint, ids.userStranger],
        sql: `INSERT INTO runs (org_id, id, user_id, data_revision)
              VALUES ($1, $2, $3, -1)`,
      },
      {
        constraint: 'runs_control_revision_nonnegative',
        values: [ids.orgA, extraRunIds.constraint, ids.userStranger],
        sql: `INSERT INTO runs (org_id, id, user_id, control_revision)
              VALUES ($1, $2, $3, -1)`,
      },
      {
        constraint: 'runs_finished_state_consistent',
        values: [ids.orgA, extraRunIds.constraint, ids.userStranger],
        sql: `INSERT INTO runs (org_id, id, user_id, status)
              VALUES ($1, $2, $3, 'finished')`,
      },
      {
        constraint: 'runs_finished_state_consistent',
        values: [ids.orgA, extraRunIds.constraint, ids.userStranger],
        sql: `INSERT INTO runs (
                org_id, id, user_id, status, created_at, started_at, finished_at
              )
              VALUES (
                $1, $2, $3, 'finished',
                '2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', '2026-09-20T08:30:00Z'
              )`,
      },
      {
        constraint: 'runs_raw_state_requires_finished',
        values: [ids.orgA, extraRunIds.constraint, ids.userStranger],
        sql: `INSERT INTO runs (org_id, id, user_id, status, raw_state)
              VALUES ($1, $2, $3, 'recording', 'purging')`,
      },
    ];

    for (const { constraint, sql, values } of invalidStatements) {
      await expect(ownerPool.query(sql, values)).rejects.toThrow(new RegExp(constraint, 'u'));
    }
  });

  it('enforces tenant-bound owner, run, and grantee foreign keys', async () => {
    await expect(
      ownerPool.query(
        `INSERT INTO runs (org_id, id, user_id)
         VALUES ($1, $2, $3)`,
        [ids.orgA, extraRunIds.constraint, ids.userOrgB],
      ),
    ).rejects.toThrow(/runs_owner_membership_fk/u);

    await expect(
      ownerPool.query(
        `INSERT INTO run_shares (org_id, run_id, grantee_user_id)
         VALUES ($1, $2, $3)`,
        [ids.orgB, ids.runRecording, ids.userOrgB],
      ),
    ).rejects.toThrow(/run_shares_run_fk/u);

    await expect(
      ownerPool.query(
        `INSERT INTO run_shares (org_id, run_id, grantee_user_id)
         VALUES ($1, $2, $3)`,
        [ids.orgA, ids.runRecording, ids.userOrgB],
      ),
    ).rejects.toThrow(/run_shares_grantee_membership_fk/u);
  });

  it('allows only one active run per user across organizations', async () => {
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status)
       VALUES ($1, $2, $3, 'recording')`,
      [ids.orgA, extraRunIds.orgAActive, ids.userDual],
    );
    await expect(
      ownerPool.query(
        `INSERT INTO runs (org_id, id, user_id, status)
         VALUES ($1, $2, $3, 'paused')`,
        [ids.orgB, extraRunIds.orgBActive, ids.userDual],
      ),
    ).rejects.toThrow(/runs_one_active_per_user_idx/u);
  });

  it('keeps maintenance without run or share table access', async () => {
    await expect(maintenancePool.query('SELECT * FROM runs')).rejects.toThrow(/permission denied/u);
    await expect(maintenancePool.query('SELECT * FROM run_shares')).rejects.toThrow(
      /permission denied/u,
    );
  });
});
