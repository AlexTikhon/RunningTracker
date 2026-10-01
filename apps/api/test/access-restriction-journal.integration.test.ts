import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const runId = 'a7600000-0000-4000-8000-000000000001';
const otherRunId = 'a7600000-0000-4000-8000-000000000002';
const unknownOrgId = 'a7600000-0000-4000-8000-0000000000ff';

interface JournalRow {
  can_read_history: boolean | null;
  can_read_live: boolean | null;
  changed_at: Date;
  kind: string;
  org_id: string;
  run_id: string | null;
  user_id: string;
}

describe('P12.4 access-restriction journal and restore reapplication', () => {
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(() => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    ownerPool = new Pool({
      application_name: 'running-tracker-p124-owner',
      connectionString: integration.migration.connectionString,
      max: 3,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p124-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 3,
    });
    runtimePool = new Pool({
      application_name: 'running-tracker-p124-runtime',
      connectionString: integration.runtime.connectionString,
      max: 3,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM runs');
    for (const id of [runId, otherRunId]) {
      await ownerPool.query(
        `INSERT INTO runs (
           org_id, id, user_id, status, started_at, created_at, finished_at,
           data_revision, control_revision, raw_state
         ) VALUES ($1, $2, $3, 'finished', $4, $4, $5, 1, 0, 'available')`,
        [ids.orgA, id, ids.userDual, '2031-01-01T00:00:00.000Z', '2031-01-01T01:00:00.000Z'],
      );
    }
    await ownerPool.query(
      `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_history, can_read_live)
       VALUES ($1, $2, $3, true, true), ($1, $4, $3, true, false)`,
      [ids.orgA, runId, ids.userOrgA, otherRunId],
    );
    await ownerPool.query('DELETE FROM access_restriction_journal');
    await ownerPool.query('UPDATE organizations SET archive_revision = 0 WHERE id = $1', [ids.orgA]);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  async function journal(): Promise<JournalRow[]> {
    const result = await ownerPool.query<JournalRow>(
      `SELECT kind, org_id, user_id, run_id, can_read_history, can_read_live, changed_at
       FROM access_restriction_journal ORDER BY journal_seq`,
    );
    return result.rows;
  }

  async function reapply(
    kind: string,
    options: { history?: boolean | null; live?: boolean | null; org?: string; run?: string | null; user?: string } = {},
  ): Promise<unknown> {
    const result = await ownerPool.query<{ outcome: unknown }>(
      'SELECT app_private.reapply_access_restriction($1, $2, $3, $4, $5, $6) AS outcome',
      [
        kind,
        options.org ?? ids.orgA,
        options.user ?? ids.userOrgA,
        options.run === undefined ? runId : options.run,
        options.history === undefined ? null : options.history,
        options.live === undefined ? null : options.live,
      ],
    );
    return result.rows[0]?.outcome;
  }

  async function share(forRun: string): Promise<{ h: boolean; l: boolean } | undefined> {
    const result = await ownerPool.query<{ h: boolean; l: boolean }>(
      `SELECT can_read_history AS h, can_read_live AS l FROM run_shares
       WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
      [ids.orgA, forRun, ids.userOrgA],
    );
    return result.rows[0];
  }

  describe('journaling by database triggers', () => {
    it('journals a membership deactivation once, with identifiers and an instant only', async () => {
      await ownerPool.query(
        'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userOrgA],
      );
      const rows = await journal();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        can_read_history: null,
        can_read_live: null,
        kind: 'membership_deactivated',
        org_id: ids.orgA,
        run_id: null,
        user_id: ids.userOrgA,
      });
      expect(Number.isFinite(rows[0]!.changed_at.getTime())).toBe(true);
    });

    it('does not journal a re-activation, a role change, or deactivating an inactive member', async () => {
      await ownerPool.query(
        "UPDATE memberships SET role = 'coach' WHERE org_id = $1 AND user_id = $2",
        [ids.orgA, ids.userOrgA],
      );
      await ownerPool.query(
        'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userInactive],
      );
      await ownerPool.query(
        'UPDATE memberships SET active = true WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userInactive],
      );
      expect(await journal()).toEqual([]);
    });

    it('journals a revoked share with its key and a narrowed share with the new booleans', async () => {
      await ownerPool.query(
        `UPDATE run_shares SET can_read_live = false
         WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
        [ids.orgA, runId, ids.userOrgA],
      );
      await ownerPool.query(
        'DELETE FROM run_shares WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3',
        [ids.orgA, otherRunId, ids.userOrgA],
      );
      const rows = await journal();
      expect(rows.map((row) => row.kind)).toEqual(['share_narrowed', 'share_revoked']);
      expect(rows[0]).toMatchObject({
        can_read_history: true,
        can_read_live: false,
        run_id: runId,
        user_id: ids.userOrgA,
      });
      expect(rows[1]).toMatchObject({
        can_read_history: null,
        can_read_live: null,
        run_id: otherRunId,
        user_id: ids.userOrgA,
      });
    });

    it('does not journal a new share, a widened share, or an unchanged upsert', async () => {
      await ownerPool.query(
        `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_history, can_read_live)
         VALUES ($1, $2, $3, false, true)`,
        [ids.orgA, runId, ids.userPausedOwner],
      );
      await ownerPool.query(
        `UPDATE run_shares SET can_read_live = true
         WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
        [ids.orgA, otherRunId, ids.userOrgA],
      );
      await ownerPool.query(
        `UPDATE run_shares SET can_read_history = true
         WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
        [ids.orgA, runId, ids.userOrgA],
      );
      expect(await journal()).toEqual([]);
    });

    it('journals a share revoked through the runtime role and the deletion path', async () => {
      const client = await runtimePool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)",
          [ids.userDual, ids.orgA],
        );
        await client.query(
          'DELETE FROM run_shares WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3',
          [ids.orgA, runId, ids.userOrgA],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect((await journal()).map((row) => row.kind)).toEqual(['share_revoked']);
    });

    it('writes nothing when the change rolls back', async () => {
      const client = await ownerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
          [ids.orgA, ids.userOrgA],
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await journal()).toEqual([]);
    });

    it('lets neither application role read, write or delete the journal directly', async () => {
      for (const pool of [runtimePool, maintenancePool]) {
        await expect(pool.query('SELECT 1 FROM access_restriction_journal')).rejects.toThrow(
          /permission denied/u,
        );
        await expect(
          pool.query(
            `INSERT INTO access_restriction_journal (org_id, kind, user_id, changed_at)
             VALUES ($1, 'membership_deactivated', $2, now())`,
            [ids.orgA, ids.userOrgA],
          ),
        ).rejects.toThrow(/permission denied/u);
        await expect(pool.query('DELETE FROM access_restriction_journal')).rejects.toThrow(
          /permission denied/u,
        );
      }
    });
  });

  describe('export capability', () => {
    it('lets only the maintenance role claim and acknowledge, oldest first', async () => {
      await ownerPool.query(
        'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userOrgA],
      );
      await ownerPool.query(
        'DELETE FROM run_shares WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3',
        [ids.orgA, runId, ids.userOrgA],
      );
      await expect(
        runtimePool.query('SELECT * FROM app_private.claim_access_journal_batch(10)'),
      ).rejects.toThrow(/permission denied/u);

      const client = await maintenancePool.connect();
      try {
        await client.query('BEGIN');
        const claimed = await client.query<{ journal_seq: string; kind: string }>(
          'SELECT journal_seq::text AS journal_seq, kind FROM app_private.claim_access_journal_batch(10)',
        );
        expect(claimed.rows.map((row) => row.kind)).toEqual([
          'membership_deactivated',
          'share_revoked',
        ]);
        await expect(
          client.query('SELECT * FROM app_private.claim_access_journal_batch(0)'),
        ).rejects.toThrow(/between 1 and 1000/u);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        const second = await client.query<{ journal_seq: string }>(
          'SELECT journal_seq::text AS journal_seq FROM app_private.claim_access_journal_batch(10)',
        );
        const acknowledged = await client.query<{ acknowledged: number }>(
          'SELECT app_private.ack_access_journal_batch($1::bigint[]) AS acknowledged',
          [second.rows.map((row) => row.journal_seq)],
        );
        expect(acknowledged.rows[0]?.acknowledged).toBe(2);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await journal()).toEqual([]);
    });
  });

  describe('restore-time reapplication', () => {
    it('is granted to nobody but the owner', async () => {
      for (const pool of [runtimePool, maintenancePool]) {
        await expect(
          pool.query(
            'SELECT app_private.reapply_access_restriction($1, $2, $3, $4, NULL, NULL)',
            ['membership_deactivated', ids.orgA, ids.userOrgA, null],
          ),
        ).rejects.toThrow(/permission denied/u);
      }
    });

    it('deactivates a membership, then reports it already applied', async () => {
      expect(await reapply('membership_deactivated', { run: null })).toBe('applied');
      expect(await reapply('membership_deactivated', { run: null })).toBe('already_applied');
      const active = await ownerPool.query<{ active: boolean }>(
        'SELECT active FROM memberships WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userOrgA],
      );
      expect(active.rows[0]?.active).toBe(false);
    });

    it('removes a share that the old backup still holds, then reports it already applied', async () => {
      expect(await reapply('share_revoked')).toBe('applied');
      expect(await share(runId)).toBeUndefined();
      expect(await reapply('share_revoked')).toBe('already_applied');
      expect(await share(otherRunId)).toEqual({ h: true, l: false });
    });

    it('narrows a share to the intersection and never widens it', async () => {
      expect(await reapply('share_narrowed', { history: true, live: false })).toBe('applied');
      expect(await share(runId)).toEqual({ h: true, l: false });
      expect(await reapply('share_narrowed', { history: true, live: false })).toBe('already_applied');
      // The journaled state allows live, the restored share does not: stay narrow.
      expect(await reapply('share_narrowed', { history: true, live: true, run: otherRunId })).toBe(
        'already_applied',
      );
      expect(await share(otherRunId)).toEqual({ h: true, l: false });
      expect(await reapply('share_narrowed', { history: false, live: false, run: otherRunId })).toBe(
        'applied',
      );
      expect(await share(otherRunId)).toEqual({ h: false, l: false });
    });

    it('treats an absent share or membership as already restricted, and an unknown organization as skipped', async () => {
      expect(await reapply('share_revoked', { run: 'a7600000-0000-4000-8000-0000000000aa' })).toBe(
        'already_applied',
      );
      expect(await reapply('membership_deactivated', { run: null, user: ids.userStranger })).toBe(
        'applied',
      );
      expect(
        await reapply('membership_deactivated', {
          run: null,
          user: 'a7600000-0000-4000-8000-0000000000bb',
        }),
      ).toBe('already_applied');
      expect(await reapply('share_revoked', { org: unknownOrgId })).toBe('skipped_unknown_organization');
    });

    it('rejects an unknown kind and an entry whose shape does not match its kind', async () => {
      await expect(reapply('membership_activated', { run: null })).rejects.toThrow(/access restriction/u);
      await expect(reapply('membership_deactivated')).rejects.toThrow(/access restriction/u);
      await expect(reapply('share_revoked', { run: null })).rejects.toThrow(/access restriction/u);
      await expect(reapply('share_narrowed', { history: null, live: true })).rejects.toThrow(
        /access restriction/u,
      );
    });

    it('advances the archive revision when it changes access, and journals the change again', async () => {
      expect(await reapply('share_revoked')).toBe('applied');
      const revision = await ownerPool.query<{ archive_revision: string }>(
        'SELECT archive_revision::text AS archive_revision FROM organizations WHERE id = $1',
        [ids.orgA],
      );
      // No run summary exists, so a share change alone does not advance it; the membership change does.
      expect(await reapply('membership_deactivated', { run: null })).toBe('applied');
      const after = await ownerPool.query<{ archive_revision: string }>(
        'SELECT archive_revision::text AS archive_revision FROM organizations WHERE id = $1',
        [ids.orgA],
      );
      expect(BigInt(after.rows[0]!.archive_revision)).toBeGreaterThan(BigInt(revision.rows[0]!.archive_revision));
      expect((await journal()).map((row) => row.kind)).toEqual(['share_revoked', 'membership_deactivated']);
    });
  });
});
