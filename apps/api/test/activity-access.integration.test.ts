import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0072: activities are owner-only health data. These checks run as the real runtime role (and the maintenance
// role) against migration 0025. The people come from the shared tenant fixture:
//   userOrgA        runner in org A, owns two activities and the runs shared with userDual
//   userDual        runner in org A holding history/live grants on userOrgA's runs; coach in org B holding a grant
//                   on userOrgB's run
//   userStranger    coach in org A without any grant, owns one activity
//   userInactive    inactive member of org A
//   userOrgB        runner in org B only, owns one activity there
const activityIds = {
  orgAOwnerRun: 'ac000000-0000-4000-8000-000000000001',
  orgAOwnerRide: 'ac000000-0000-4000-8000-000000000002',
  orgACoach: 'ac000000-0000-4000-8000-000000000003',
  orgBOwner: 'ac000000-0000-4000-8000-000000000004',
  inserted: 'ac000000-0000-4000-8000-000000000010',
  forged: 'ac000000-0000-4000-8000-000000000011',
} as const;

const startedAt = '2026-10-05T06:00:00.000Z';
const createdAt = '2026-10-05T08:00:00.000Z';

describe('ADR-0072 activities ACL (migration 0025)', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-activity-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-activity-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, created_at)
       VALUES
         ($1, $3, $5, 'run',  $9, 1800, 5000, 6, 'tempo', $10),
         ($1, $4, $5, 'ride', $9, 3600, NULL, NULL, NULL, $10),
         ($1, $6, $7, 'walk', $9, 900,  1200, NULL, NULL, $10),
         ($2, $11, $8, 'swim', $9, 1200, 1500, 3, NULL, $10)`,
      [
        ids.orgA,
        ids.orgB,
        activityIds.orgAOwnerRun,
        activityIds.orgAOwnerRide,
        ids.userOrgA,
        activityIds.orgACoach,
        ids.userStranger,
        ids.userOrgB,
        startedAt,
        createdAt,
        activityIds.orgBOwner,
      ],
    );
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  const asRuntime = <Result>(
    orgId: string,
    userId: string,
    work: (client: PoolClient) => Promise<Result>,
  ) => withTenantTransaction(runtimePool, { orgId, userId }, work);

  const readActivities = (orgId: string, userId: string) =>
    asRuntime(orgId, userId, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM activities ORDER BY id');
      return result.rows.map(({ id }) => id);
    });

  const storedIds = async () =>
    (await ownerPool.query<{ id: string }>('SELECT id FROM activities ORDER BY id')).rows.map(({ id }) => id);

  const insertAs = (orgId: string, userId: string, row: { id: string; orgId: string; userId: string }) =>
    asRuntime(orgId, userId, (client) =>
      client.query(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, created_at)
         VALUES ($1, $2, $3, 'run', $4, 600, $5)`,
        [row.orgId, row.id, row.userId, startedAt, createdAt],
      ),
    );

  it('shows each person only their own activities in the current organization', async () => {
    await expect(readActivities(ids.orgA, ids.userOrgA)).resolves.toEqual([
      activityIds.orgAOwnerRun,
      activityIds.orgAOwnerRide,
    ]);
    await expect(readActivities(ids.orgA, ids.userStranger)).resolves.toEqual([activityIds.orgACoach]);
    await expect(readActivities(ids.orgB, ids.userOrgB)).resolves.toEqual([activityIds.orgBOwner]);
  });

  it('shows nothing to a coach, a grantee, another organization, an inactive member or a foreign context', async () => {
    // userDual reads userOrgA's runs through grants in org A and userOrgB's run as a coach in org B.
    await expect(readActivities(ids.orgA, ids.userDual)).resolves.toEqual([]);
    await expect(readActivities(ids.orgB, ids.userDual)).resolves.toEqual([]);
    await expect(readActivities(ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readActivities(ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(readActivities(ids.orgB, ids.userOrgA)).resolves.toEqual([]);
    await expect(readActivities(ids.orgA, ids.userPausedOwner)).resolves.toEqual([]);
    // The coach of org A owns an activity, yet sees nothing of the runner's.
    const coachView = await readActivities(ids.orgA, ids.userStranger);
    expect(coachView).not.toContain(activityIds.orgAOwnerRun);
  });

  it('answers a filter by someone else\'s id or owner with no row, not an error', async () => {
    const probe = (userId: string) =>
      asRuntime(ids.orgA, userId, async (client) => {
        const byId = await client.query('SELECT * FROM activities WHERE id = $1', [activityIds.orgAOwnerRun]);
        const byOwner = await client.query('SELECT * FROM activities WHERE user_id = $1', [ids.userOrgA]);
        const counted = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM activities WHERE org_id = $1', [ids.orgA]);
        return [byId.rowCount, byOwner.rowCount, counted.rows[0]?.count];
      });
    await expect(probe(ids.userDual)).resolves.toEqual([0, 0, '0']);
    await expect(probe(ids.userStranger)).resolves.toEqual([0, 0, '1']);
  });

  it('fails closed for missing and malformed contexts', async () => {
    const missing = await runtimePool.query<{ count: string }>('SELECT count(*)::text AS count FROM activities');
    expect(missing.rows[0]?.count).toBe('0');

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', 'invalid', true)");
      await client.query("SELECT set_config('app.org_id', 'invalid', true)");
      const malformed = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM activities');
      expect(malformed.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      // An identity without an organization, or the reverse, is not a context either.
      await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userOrgA]);
      const userOnly = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM activities');
      expect(userOnly.rows[0]?.count).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('lets the owner insert with RETURNING, read back and delete their own activity', async () => {
    await asRuntime(ids.orgA, ids.userOrgA, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, created_at)
         VALUES ($1, $2, $3, 'hike', $4, 7200, 12000.5, 7, 'ridge', $5)
         RETURNING id`,
        [ids.orgA, activityIds.inserted, ids.userOrgA, startedAt, createdAt],
      );
      expect(inserted.rows).toEqual([{ id: activityIds.inserted }]);
      const read = await client.query<{ source: string }>('SELECT source FROM activities WHERE id = $1', [activityIds.inserted]);
      expect(read.rows).toEqual([{ source: 'manual' }]);
      const deleted = await client.query('DELETE FROM activities WHERE id = $1', [activityIds.orgAOwnerRide]);
      expect(deleted.rowCount).toBe(1);
    });
    expect(await storedIds()).toEqual([
      activityIds.orgAOwnerRun,
      activityIds.orgACoach,
      activityIds.orgBOwner,
      activityIds.inserted,
    ]);
  });

  it('refuses inserting an activity for someone else, into another organization, or without an active membership', async () => {
    const rls = /row-level security/u;
    // The owner forging another member as owner, and another organization than the context.
    await expect(insertAs(ids.orgA, ids.userOrgA, { id: activityIds.forged, orgId: ids.orgA, userId: ids.userStranger })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgA, { id: activityIds.forged, orgId: ids.orgB, userId: ids.userOrgA })).rejects.toThrow(rls);
    // A coach with a run grant, writing for the runner who granted it.
    await expect(insertAs(ids.orgB, ids.userDual, { id: activityIds.forged, orgId: ids.orgB, userId: ids.userOrgB })).rejects.toThrow(rls);
    // A grantee in org A, writing for the run owner.
    await expect(insertAs(ids.orgA, ids.userDual, { id: activityIds.forged, orgId: ids.orgA, userId: ids.userOrgA })).rejects.toThrow(rls);
    // An inactive member for themself; a member of another organization for themself.
    await expect(insertAs(ids.orgA, ids.userInactive, { id: activityIds.forged, orgId: ids.orgA, userId: ids.userInactive })).rejects.toThrow(rls);
    await expect(insertAs(ids.orgA, ids.userOrgB, { id: activityIds.forged, orgId: ids.orgA, userId: ids.userOrgB })).rejects.toThrow(rls);
    expect(await storedIds()).not.toContain(activityIds.forged);
  });

  it('does not let a coach, a grantee, another organization or an inactive member delete an activity', async () => {
    const attempts: Array<[string, string]> = [
      [ids.orgA, ids.userDual],
      [ids.orgA, ids.userStranger],
      [ids.orgA, ids.userInactive],
      [ids.orgA, ids.userOrgB],
      [ids.orgB, ids.userDual],
    ];
    for (const [orgId, userId] of attempts) {
      const deleted = await asRuntime(orgId, userId, (client) =>
        client.query('DELETE FROM activities WHERE id = ANY($1::uuid[])', [
          [activityIds.orgAOwnerRun, activityIds.orgAOwnerRide, activityIds.orgBOwner],
        ]),
      );
      expect(deleted.rowCount).toBe(0);
    }
    expect(await storedIds()).toEqual([
      activityIds.orgAOwnerRun,
      activityIds.orgAOwnerRide,
      activityIds.orgACoach,
      activityIds.orgBOwner,
    ]);
  });

  it('never grants UPDATE or TRUNCATE to the runtime role, even to the owner', async () => {
    await expect(
      asRuntime(ids.orgA, ids.userOrgA, (client) =>
        client.query('UPDATE activities SET notes = $1 WHERE id = $2', ['changed', activityIds.orgAOwnerRun]),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asRuntime(ids.orgA, ids.userOrgA, (client) =>
        client.query(
          `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, created_at)
           VALUES ($1, $2, $3, 'run', $4, 60, $5)
           ON CONFLICT (org_id, id) DO UPDATE SET notes = 'changed'`,
          [ids.orgA, activityIds.orgAOwnerRun, ids.userOrgA, startedAt, createdAt],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(asRuntime(ids.orgA, ids.userOrgA, (client) => client.query('TRUNCATE activities'))).rejects.toThrow(
      /permission denied/u,
    );
    const stored = await ownerPool.query<{ notes: string }>('SELECT notes FROM activities WHERE id = $1', [activityIds.orgAOwnerRun]);
    expect(stored.rows).toEqual([{ notes: 'tempo' }]);
  });

  it('exposes nothing through joins from runs, run_shares or memberships', async () => {
    const joins = (orgId: string, userId: string) =>
      asRuntime(orgId, userId, async (client) => {
        const viaRuns = await client.query<{ id: string }>(
          `SELECT activity.id
           FROM runs AS run
           JOIN activities AS activity ON activity.org_id = run.org_id AND activity.user_id = run.user_id`,
        );
        const viaShares = await client.query<{ id: string }>(
          `SELECT activity.id
           FROM run_shares AS share
           JOIN runs AS run ON run.org_id = share.org_id AND run.id = share.run_id
           JOIN activities AS activity ON activity.org_id = run.org_id AND activity.user_id = run.user_id`,
        );
        const viaMemberships = await client.query<{ id: string }>(
          `SELECT activity.id
           FROM memberships AS membership
           JOIN activities AS activity ON activity.org_id = membership.org_id`,
        );
        const lateral = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
           FROM runs AS run
           LEFT JOIN LATERAL (SELECT 1 FROM activities WHERE activities.user_id = run.user_id) AS hit ON true
           WHERE hit IS NOT NULL`,
        );
        const visibleRuns = await client.query('SELECT 1 FROM runs');
        return {
          lateral: lateral.rows[0]?.n,
          viaMemberships: viaMemberships.rows.map(({ id }) => id),
          viaRuns: viaRuns.rows.map(({ id }) => id),
          viaShares: viaShares.rows.map(({ id }) => id),
          visibleRuns: visibleRuns.rowCount,
        };
      });

    // The grantee can see the owner's runs, so the joins have rows to start from, and still reach no activity.
    const grantee = await joins(ids.orgA, ids.userDual);
    expect(grantee.visibleRuns).toBeGreaterThan(0);
    expect(grantee).toMatchObject({ lateral: '0', viaMemberships: [], viaRuns: [], viaShares: [] });

    const coachB = await joins(ids.orgB, ids.userDual);
    expect(coachB.visibleRuns).toBeGreaterThan(0);
    expect(coachB).toMatchObject({ lateral: '0', viaMemberships: [], viaRuns: [], viaShares: [] });

    // The org-A coach sees only their own activity through their own membership.
    const coachA = await joins(ids.orgA, ids.userStranger);
    expect(coachA).toMatchObject({ viaMemberships: [activityIds.orgACoach], viaRuns: [], viaShares: [] });
  });

  it('removes the owner\'s access as soon as the membership is deactivated', async () => {
    await ownerPool.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readActivities(ids.orgA, ids.userOrgA)).resolves.toEqual([]);
    const deleted = await asRuntime(ids.orgA, ids.userOrgA, (client) =>
      client.query('DELETE FROM activities WHERE id = $1', [activityIds.orgAOwnerRun]),
    );
    expect(deleted.rowCount).toBe(0);
    await expect(
      insertAs(ids.orgA, ids.userOrgA, { id: activityIds.inserted, orgId: ids.orgA, userId: ids.userOrgA }),
    ).rejects.toThrow(/row-level security/u);
    await ownerPool.query('UPDATE memberships SET active = true WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);
    await expect(readActivities(ids.orgA, ids.userOrgA)).resolves.toHaveLength(2);
  });

  it('keeps the maintenance role without any access', async () => {
    const denied = /permission denied/u;
    await expect(maintenancePool.query('SELECT * FROM activities')).rejects.toThrow(denied);
    await expect(maintenancePool.query('DELETE FROM activities')).rejects.toThrow(denied);
    await expect(
      maintenancePool.query(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, created_at)
         VALUES ($1, $2, $3, 'run', $4, 60, $5)`,
        [ids.orgA, activityIds.forged, ids.userOrgA, startedAt, createdAt],
      ),
    ).rejects.toThrow(denied);
    await expect(maintenancePool.query('UPDATE activities SET rpe = 1')).rejects.toThrow(denied);
  });

  it('declares exactly the intended RLS, policies, privileges and owner index', async () => {
    const relation = await ownerPool.query<{ relforcerowsecurity: boolean; relrowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'public.activities'::regclass`,
    );
    expect(relation.rows).toEqual([{ relforcerowsecurity: false, relrowsecurity: true }]);

    const policies = await ownerPool.query<{ cmd: string; policyname: string; roles: string[] }>(
      `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'activities'
       ORDER BY policyname`,
    );
    expect(policies.rows).toEqual([
      { cmd: 'DELETE', policyname: 'activities_delete_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'INSERT', policyname: 'activities_insert_owner', roles: ['running_tracker_runtime'] },
      { cmd: 'SELECT', policyname: 'activities_select_owner', roles: ['running_tracker_runtime'] },
    ]);

    const privileges = await ownerPool.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'activities' AND grantee <> 'running_tracker_owner'
       ORDER BY grantee, privilege_type`,
    );
    expect(privileges.rows).toEqual([
      { grantee: 'running_tracker_runtime', privilege_type: 'DELETE' },
      { grantee: 'running_tracker_runtime', privilege_type: 'INSERT' },
      { grantee: 'running_tracker_runtime', privilege_type: 'SELECT' },
    ]);
    const columns = await ownerPool.query<{ update: boolean }>(
      `SELECT has_any_column_privilege('running_tracker_runtime', 'public.activities', 'UPDATE') AS update`,
    );
    expect(columns.rows).toEqual([{ update: false }]);

    const index = await ownerPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'activities_owner_started_idx'`,
    );
    expect(index.rows[0]?.indexdef).toBe(
      'CREATE INDEX activities_owner_started_idx ON public.activities USING btree (org_id, user_id, started_at DESC, id DESC)',
    );
  });

  describe('constraints', () => {
    const base = {
      created_at: createdAt,
      distance_m: null as number | string | null,
      duration_s: 600 as number,
      notes: null as string | null,
      rpe: null as number | null,
      source: 'manual',
      started_at: startedAt,
      type: 'run',
    };
    const insertRow = (overrides: Partial<typeof base>, id: string = activityIds.inserted) => {
      const row = { ...base, ...overrides };
      return ownerPool.query(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [ids.orgA, id, ids.userOrgA, row.type, row.started_at, row.duration_s, row.distance_m, row.rpe, row.notes, row.source, row.created_at],
      );
    };
    const violates = (constraint: string): unknown => expect.objectContaining({ code: '23514', constraint });

    it.each([
      ['activities_type_known', { type: 'yoga' }],
      ['activities_type_known', { type: 'Run' }],
      ['activities_started_at_range', { started_at: '1999-12-31T23:59:59.999Z' }],
      ['activities_started_at_range', { started_at: 'infinity' }],
      ['activities_duration_range', { duration_s: 0 }],
      ['activities_duration_range', { duration_s: 172_801 }],
      ['activities_distance_range', { distance_m: -0.001 }],
      ['activities_distance_range', { distance_m: 1_000_000.001 }],
      ['activities_distance_range', { distance_m: 'NaN' }],
      ['activities_distance_range', { distance_m: 'Infinity' }],
      ['activities_distance_range', { distance_m: '-Infinity' }],
      ['activities_rpe_range', { rpe: 0 }],
      ['activities_rpe_range', { rpe: 11 }],
      ['activities_notes_length', { notes: '' }],
      ['activities_notes_length', { notes: 'x'.repeat(1_001) }],
      ['activities_source_known', { source: 'tcx' }],
      ['activities_source_known', { source: 'GPX' }],
      // Migration 0041 (ADR-0086): a gpx row needs its import attempt's key (and its fingerprint, checked below).
      ['activities_gpx_idempotency_key_present', { source: 'gpx' }],
      ['activities_created_at_finite', { created_at: 'infinity' }],
    ] as const)('%s rejects %j', async (constraint, overrides) => {
      await expect(insertRow(overrides)).rejects.toEqual(violates(constraint));
    });

    describe('GPX imports (migration 0041, ADR-0086)', () => {
      const fingerprint = Buffer.alloc(32, 7);
      const key = 'bf000000-0000-4000-8000-0000000000c1';
      const insertImport = (
        values: { fingerprint?: Buffer | null; id?: string; key?: string | null; orgId?: string; source?: string; userId?: string } = {},
      ) =>
        ownerPool.query(
          `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, idempotency_key, source, import_fingerprint, created_at)
           VALUES ($1, $2, $3, 'ride', $4, 3600, 20000, $5, $6, $7, $8)`,
          [
            values.orgId ?? ids.orgA,
            values.id ?? activityIds.inserted,
            values.userId ?? ids.userOrgA,
            startedAt,
            values.key === undefined ? key : values.key,
            values.source ?? 'gpx',
            values.fingerprint === undefined ? fingerprint : values.fingerprint,
            createdAt,
          ],
        );

      it('accepts a gpx row with a 32-byte fingerprint and a key, and refuses every other shape', async () => {
        await insertImport();
        const other = { id: activityIds.forged, key: 'bf000000-0000-4000-8000-0000000000c3' };
        await expect(insertImport({ ...other, fingerprint: Buffer.alloc(31) })).rejects.toEqual(violates('activities_import_fingerprint_length'));
        await expect(insertImport({ ...other, fingerprint: null })).rejects.toEqual(violates('activities_import_fingerprint_matches_source'));
        await expect(insertImport({ ...other, fingerprint: Buffer.alloc(32, 8), source: 'manual' })).rejects.toEqual(
          violates('activities_import_fingerprint_matches_source'),
        );
        await expect(insertImport({ ...other, fingerprint: Buffer.alloc(32, 8), key: null })).rejects.toEqual(
          violates('activities_gpx_idempotency_key_present'),
        );
      });

      it('makes a track unique per owner and organization only', async () => {
        await insertImport();
        await expect(insertImport({ id: activityIds.forged, key: 'bf000000-0000-4000-8000-0000000000c2' })).rejects.toMatchObject({
          code: '23505',
          constraint: 'activities_owner_import_fingerprint_unique',
        });
        // Another member of the organization, and the same track in another organization, are independent.
        await insertImport({ id: activityIds.forged, userId: ids.userStranger });
        await insertImport({ id: activityIds.forged, orgId: ids.orgB, userId: ids.userOrgB });
      });

      it('shows an import only to its owner, and lets nobody else read or delete it through the runtime role', async () => {
        await insertImport();
        expect(await readActivities(ids.orgA, ids.userOrgA)).toContain(activityIds.inserted);
        for (const [orgId, userId] of [[ids.orgA, ids.userStranger], [ids.orgA, ids.userDual], [ids.orgA, ids.userInactive], [ids.orgB, ids.userDual]] as const) {
          expect(await readActivities(orgId, userId)).not.toContain(activityIds.inserted);
          const fingerprints = await asRuntime(orgId, userId, (client) =>
            client.query('SELECT 1 FROM activities WHERE import_fingerprint = $1', [fingerprint]),
          ).catch(() => ({ rowCount: 0 }));
          expect(fingerprints.rowCount).toBe(0);
          await asRuntime(orgId, userId, (client) => client.query('DELETE FROM activities WHERE id = $1', [activityIds.inserted])).catch(() => undefined);
        }
        expect(await storedIds()).toContain(activityIds.inserted);
      });

      it('declares the new constraints exactly', async () => {
        const definitions = await ownerPool.query<{ conname: string; definition: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE conrelid = 'public.activities'::regclass
             AND conname IN ('activities_source_known', 'activities_import_fingerprint_length',
                             'activities_import_fingerprint_matches_source', 'activities_gpx_idempotency_key_present',
                             'activities_owner_import_fingerprint_unique')
           ORDER BY conname`,
        );
        expect(definitions.rows).toEqual([
          { conname: 'activities_gpx_idempotency_key_present', definition: "CHECK (((source <> 'gpx'::text) OR (idempotency_key IS NOT NULL)))" },
          { conname: 'activities_import_fingerprint_length', definition: 'CHECK (((import_fingerprint IS NULL) OR (octet_length(import_fingerprint) = 32)))' },
          { conname: 'activities_import_fingerprint_matches_source', definition: "CHECK (((source = 'gpx'::text) = (import_fingerprint IS NOT NULL)))" },
          { conname: 'activities_owner_import_fingerprint_unique', definition: 'UNIQUE (org_id, user_id, import_fingerprint)' },
          { conname: 'activities_source_known', definition: "CHECK ((source = ANY (ARRAY['manual'::text, 'gpx'::text])))" },
        ]);
      });
    });

    it('accepts the boundary values and stores the source as manual by default', async () => {
      await insertRow({ distance_m: 0, duration_s: 1, notes: 'x', rpe: 1, started_at: '2000-01-01T00:00:00.000Z' }, activityIds.inserted);
      await insertRow({ distance_m: 1_000_000, duration_s: 172_800, notes: 'é'.repeat(1_000), rpe: 10 }, activityIds.forged);
      await ownerPool.query(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, created_at)
         VALUES ($1, 'ac000000-0000-4000-8000-000000000012', $2, 'other', $3, 60, $4)`,
        [ids.orgA, ids.userOrgA, startedAt, createdAt],
      );
      const defaulted = await ownerPool.query<{ source: string }>(
        `SELECT source FROM activities WHERE id = 'ac000000-0000-4000-8000-000000000012'`,
      );
      expect(defaulted.rows).toEqual([{ source: 'manual' }]);
    });

    it('does not enforce a future-start bound in the database (the service owns it, ADR-0072)', async () => {
      await expect(insertRow({ started_at: '2099-01-01T00:00:00.000Z' })).resolves.toBeDefined();
    });

    it('scopes the id to the organization and binds the owner to a membership of that organization', async () => {
      // The same id in another organization is a different activity.
      await ownerPool.query(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, created_at)
         VALUES ($1, $2, $3, 'run', $4, 60, $5)`,
        [ids.orgB, activityIds.orgAOwnerRun, ids.userOrgB, startedAt, createdAt],
      );
      await expect(
        ownerPool.query(
          `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, created_at)
           VALUES ($1, $2, $3, 'run', $4, 60, $5)`,
          [ids.orgA, activityIds.orgAOwnerRun, ids.userOrgA, startedAt, createdAt],
        ),
      ).rejects.toEqual(expect.objectContaining({ code: '23505', constraint: 'activities_pkey' }));
      // userOrgB has no membership in org A.
      await expect(
        ownerPool.query(
          `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, created_at)
           VALUES ($1, $2, $3, 'run', $4, 60, $5)`,
          [ids.orgA, activityIds.forged, ids.userOrgB, startedAt, createdAt],
        ),
      ).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'activities_owner_membership_fk' }));
      // A membership that still owns activities cannot be deleted. userStranger owns an activity and no run, so the
      // only foreign key that can refuse it is the activities one.
      await expect(
        ownerPool.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userStranger]),
      ).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'activities_owner_membership_fk' }));
    });
  });
});
