import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  expectedTotals,
  geographyAnchors,
  planDataset,
  smokeProfile,
  type DatasetPlan,
} from '../src/loadtest/dataset-plan.js';
import {
  loadDatabaseSuffix,
  seedDataset,
  type DatasetManifest,
  type SeedOptions,
} from '../src/loadtest/seed-dataset.js';

const asOf = new Date('2032-03-01T00:00:00.000Z');
const seeds = { alternate: 77, primary: 42 } as const;

describe('P11.2 seeded load datasets', () => {
  let ownerPool: Pool;
  let maintenancePool: Pool;
  let runtimePool: Pool;
  const seededOrganizations = new Set<string>();

  function options(overrides: Partial<SeedOptions> = {}): SeedOptions {
    return {
      allowedDatabaseSuffixes: ['_test'],
      asOf,
      profile: smokeProfile,
      requireEmptyDatabase: false,
      seed: seeds.primary,
      ...overrides,
    };
  }

  async function seed(overrides: Partial<SeedOptions> = {}): Promise<DatasetManifest> {
    const manifest = await seedDataset(ownerPool, options(overrides));
    seededOrganizations.add(manifest.organizationId);
    return manifest;
  }

  async function cleanUp(organizationId: string, userIds: readonly string[]): Promise<void> {
    await ownerPool.query('DELETE FROM runs WHERE org_id = $1', [organizationId]);
    await ownerPool.query('DELETE FROM memberships WHERE org_id = $1', [organizationId]);
    await ownerPool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  }

  async function removeAll(): Promise<void> {
    for (const seedValue of Object.values(seeds)) {
      const plan = planDataset(smokeProfile, seedValue, asOf);
      await cleanUp(
        plan.organizationId,
        plan.users.map((user) => user.id),
      );
    }
    seededOrganizations.clear();
  }

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    ownerPool = new Pool({
      application_name: 'running-tracker-p112-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p112-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 2,
    });
    runtimePool = new Pool({
      application_name: 'running-tracker-p112-runtime',
      connectionString: integration.runtime.connectionString,
      max: 2,
    });
    await removeAll();
  });

  afterEach(async () => {
    await removeAll();
  });

  afterAll(async () => {
    await removeAll();
    await Promise.all([ownerPool.end(), maintenancePool.end(), runtimePool.end()]);
  });

  it('writes exactly the planned volumes and passes every schema constraint', async () => {
    const manifest = await seed();
    const totals = expectedTotals(smokeProfile, seeds.primary);

    expect(manifest.counts).toEqual(totals);
    expect(manifest.digest).toMatch(/^[0-9a-f]{32}$/);
    expect(manifest.users).toHaveLength(smokeProfile.users);
    expect(manifest.users.filter((user) => user.role === 'coach')).toHaveLength(smokeProfile.coaches);
    expect(manifest.relationSizes.runPointsBytes).toBeGreaterThan(0);
    expect(Object.keys(manifest.timingsMs)).toEqual(
      expect.arrayContaining(['identity', 'runs', 'points', 'summaries', 'shares', 'analyze', 'digest']),
    );

    const runs = await ownerPool.query<{ finished: string; purged: string; active: string }>(
      `SELECT count(*) FILTER (WHERE status = 'finished') AS finished,
              count(*) FILTER (WHERE raw_state = 'purged') AS purged,
              count(*) FILTER (WHERE status <> 'finished') AS active
       FROM runs WHERE org_id = $1`,
      [manifest.organizationId],
    );
    expect(runs.rows[0]).toEqual({
      active: '0',
      finished: String(totals.runs),
      purged: String(totals.runs - totals.rawRuns),
    });
  });

  it('keeps points contiguous, ordered, batch-revisioned, and consistent with the run revision', async () => {
    const manifest = await seed();
    const plan = planDataset(smokeProfile, seeds.primary, asOf);

    const perRun = await ownerPool.query<{
      data_revision: string;
      gaps: string;
      max_revision: string;
      max_seq: string;
      points: string;
      unordered: string;
    }>(
      `SELECT r.data_revision::text, count(p.seq)::text AS points, coalesce(max(p.seq), 0)::text AS max_seq,
              coalesce(max(p.ingested_revision), 0)::text AS max_revision,
              count(*) FILTER (WHERE p.recorded_at <= p.previous_recorded_at)::text AS unordered,
              count(*) FILTER (WHERE p.received_at < p.recorded_at)::text AS gaps
       FROM runs r
       LEFT JOIN (
         SELECT run_id, seq, ingested_revision, recorded_at, received_at,
                lag(recorded_at) OVER (PARTITION BY run_id ORDER BY seq) AS previous_recorded_at
         FROM run_points WHERE org_id = $1
       ) p ON p.run_id = r.id
       WHERE r.org_id = $1 AND r.raw_state = 'available'
       GROUP BY r.id, r.data_revision`,
      [manifest.organizationId],
    );
    expect(perRun.rows).toHaveLength(smokeProfile.users * smokeProfile.rawDays);
    for (const row of perRun.rows) {
      expect(row.points).toBe(row.max_seq);
      expect(row.unordered).toBe('0');
      expect(row.gaps).toBe('0');
      expect(Number(row.data_revision)).toBe(Number(row.max_revision) + 1);
    }
    expect(perRun.rows.reduce((sum, row) => sum + Number(row.points), 0)).toBe(
      smokeProfile.rawPointBudget,
    );

    const purgedPoints = await ownerPool.query<{ count: string }>(
      `SELECT count(*) FROM run_points p JOIN runs r ON r.org_id = p.org_id AND r.id = p.run_id
       WHERE r.org_id = $1 AND r.raw_state = 'purged'`,
      [manifest.organizationId],
    );
    expect(purgedPoints.rows[0]?.count).toBe('0');

    const perSequence = await ownerPool.query<{ recorded_at: Date; run_id: string; seq: string }>(
      `SELECT run_id, seq::text, recorded_at FROM run_points WHERE org_id = $1 AND seq = 1`,
      [manifest.organizationId],
    );
    for (const row of perSequence.rows) {
      const run = plan.runs.find((candidate) => candidate.id === row.run_id);
      const offset = row.recorded_at.getTime() - Date.parse(run?.startedAt ?? '');
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(400);
    }
  });

  it('publishes valid current summaries that the summary worker considers up to date', async () => {
    const manifest = await seed();

    const summaries = await ownerPool.query<{
      current: boolean;
      invalid_quality: string;
      invalid_geometry: string;
      not_multiline: string;
      revision_mismatch: string;
    }>(
      `SELECT bool_and(s.algorithm_version = app_private.current_track_algorithm_version()) AS current,
              count(*) FILTER (WHERE NOT app_private.run_summary_quality_stats_valid(s.quality_stats))::text
                AS invalid_quality,
              count(*) FILTER (WHERE s.display_geom IS NULL OR NOT ST_IsValid(s.display_geom))::text
                AS invalid_geometry,
              count(*) FILTER (WHERE GeometryType(s.display_geom) <> 'MULTILINESTRING')::text AS not_multiline,
              count(*) FILTER (WHERE s.source_revision <> r.data_revision)::text AS revision_mismatch
       FROM run_summaries s JOIN runs r ON r.org_id = s.org_id AND r.id = s.run_id
       WHERE s.org_id = $1`,
      [manifest.organizationId],
    );
    expect(summaries.rows[0]).toEqual({
      current: true,
      invalid_geometry: '0',
      invalid_quality: '0',
      not_multiline: '0',
      revision_mismatch: '0',
    });

    const staleSeeded = await maintenancePool.query<{ count: string }>(
      `SELECT count(*) FROM app_private.find_stale_run_summaries(1000) AS stale
       WHERE stale.org_id = $1`,
      [manifest.organizationId],
    );
    expect(staleSeeded.rows[0]?.count).toBe('0');
  });

  it('covers both hemispheres of the antimeridian and splits its display geometry', async () => {
    const manifest = await seed();
    const antimeridianIndex = geographyAnchors.findIndex((anchor) => anchor.longitude === 180);
    expect(antimeridianIndex).toBeLessThan(smokeProfile.users);
    const userId = manifest.users[antimeridianIndex]?.id;

    const points = await ownerPool.query<{ east: string; west: string }>(
      `SELECT count(*) FILTER (WHERE ST_X(p.geom) > 179.9)::text AS east,
              count(*) FILTER (WHERE ST_X(p.geom) < -179.9)::text AS west
       FROM run_points p JOIN runs r ON r.org_id = p.org_id AND r.id = p.run_id
       WHERE r.org_id = $1 AND r.user_id = $2`,
      [manifest.organizationId, userId],
    );
    expect(Number(points.rows[0]?.east)).toBeGreaterThan(0);
    expect(Number(points.rows[0]?.west)).toBeGreaterThan(0);

    const geometry = await ownerPool.query<{ max_parts: string; wrapped_in_range: boolean }>(
      `SELECT max(ST_NumGeometries(s.display_geom))::text AS max_parts,
              bool_and(ST_XMin(s.display_geom) >= -180 AND ST_XMax(s.display_geom) <= 180) AS wrapped_in_range
       FROM run_summaries s JOIN runs r ON r.org_id = s.org_id AND r.id = s.run_id
       WHERE r.org_id = $1 AND r.user_id = $2`,
      [manifest.organizationId, userId],
    );
    expect(Number(geometry.rows[0]?.max_parts)).toBeGreaterThanOrEqual(2);
    expect(geometry.rows[0]?.wrapped_in_range).toBe(true);

    const otherPoints = await ownerPool.query<{ spans: string }>(
      `SELECT count(*)::text AS spans FROM (
         SELECT r.id FROM run_points p JOIN runs r ON r.org_id = p.org_id AND r.id = p.run_id
         WHERE r.org_id = $1 AND r.user_id <> $2
         GROUP BY r.id HAVING max(ST_X(p.geom)) - min(ST_X(p.geom)) > 1
       ) crossing`,
      [manifest.organizationId, userId],
    );
    expect(otherPoints.rows[0]?.spans).toBe('0');
  });

  it('is byte-for-byte reproducible for one seed and different for another', async () => {
    const first = await seed();
    await cleanUp(
      first.organizationId,
      first.users.map((user) => user.id),
    );
    const repeat = await seed();
    expect(repeat.digest).toBe(first.digest);
    expect(repeat.organizationId).toBe(first.organizationId);
    expect(repeat.users).toEqual(first.users);
    expect(repeat.counts).toEqual(first.counts);

    const other = await seed({ seed: seeds.alternate });
    expect(other.digest).not.toBe(first.digest);
    expect(other.organizationId).not.toBe(first.organizationId);
  });

  it('rolls the whole dataset back when any statement fails', async () => {
    const plan = planDataset(smokeProfile, seeds.primary, asOf);
    await ownerPool.query('INSERT INTO users (id, external_identity) VALUES ($1, $2)', [
      plan.users[0]?.id,
      'collides-with-planned-user',
    ]);
    try {
      await expect(seed()).rejects.toThrow();
      const remaining = await ownerPool.query<{ count: string }>(
        'SELECT count(*) FROM runs WHERE org_id = $1',
        [plan.organizationId],
      );
      expect(remaining.rows[0]?.count).toBe('0');
      const organizations = await ownerPool.query<{ count: string }>(
        'SELECT count(*) FROM organizations WHERE id = $1',
        [plan.organizationId],
      );
      expect(organizations.rows[0]?.count).toBe('0');
    } finally {
      await ownerPool.query('DELETE FROM users WHERE id = $1', [plan.users[0]?.id]);
    }
  });

  it('refuses unsafe targets, the wrong role, and a non-empty database before writing', async () => {
    await expect(seed({ allowedDatabaseSuffixes: [loadDatabaseSuffix] })).rejects.toThrow(/Refusing to seed/);
    await expect(seed({ reset: true })).rejects.toThrow(/--reset is only allowed/);
    await expect(seedDataset(runtimePool, options())).rejects.toThrow(/running_tracker_owner/);

    await seed();
    await expect(seed({ requireEmptyDatabase: true, seed: seeds.alternate })).rejects.toThrow(/not empty/);
    const alternate = planDataset(smokeProfile, seeds.alternate, asOf);
    const written = await ownerPool.query<{ count: string }>('SELECT count(*) FROM runs WHERE org_id = $1', [
      alternate.organizationId,
    ]);
    expect(written.rows[0]?.count).toBe('0');
  });

  describe('access control on the seeded data under the runtime role', () => {
    async function visible(
      plan: DatasetPlan,
      manifest: DatasetManifest,
      userIndex: number,
    ): Promise<{ points: number; runs: number; summaries: number }> {
      const user = manifest.users[userIndex];
      if (!user) {
        throw new Error('Unknown seeded user');
      }
      return withTenantTransaction(
        runtimePool,
        { orgId: plan.organizationId, userId: user.id },
        async (client) => {
          const result = await client.query<{ points: string; runs: string; summaries: string }>(
            `SELECT (SELECT count(*) FROM runs)::text AS runs,
                    (SELECT count(*) FROM run_summaries)::text AS summaries,
                    (SELECT count(*) FROM run_points)::text AS points`,
          );
          return {
            points: Number(result.rows[0]?.points),
            runs: Number(result.rows[0]?.runs),
            summaries: Number(result.rows[0]?.summaries),
          };
        },
      );
    }

    it('shows each member exactly the runs the planned history grants allow', async () => {
      const manifest = await seed();
      const plan = planDataset(smokeProfile, seeds.primary, asOf);
      const rawPointsByUser = new Map<number, number>();
      for (const run of plan.runs) {
        rawPointsByUser.set(
          run.userIndex,
          (rawPointsByUser.get(run.userIndex) ?? 0) + (run.hasRaw ? run.pointCount : 0),
        );
      }

      const distinctCounts = new Set<number>();
      for (const user of plan.users) {
        const owners = new Set<number>([user.index]);
        for (const share of plan.shares) {
          if (share.granteeIndex === user.index && share.canReadHistory) {
            owners.add(share.ownerIndex);
          }
        }
        const expectedRuns = owners.size * smokeProfile.archiveDays;
        const expectedPoints = [...owners].reduce((sum, owner) => sum + (rawPointsByUser.get(owner) ?? 0), 0);

        const seen = await visible(plan, manifest, user.index);
        expect(seen, `user ${user.index}`).toEqual({
          points: expectedPoints,
          runs: expectedRuns,
          summaries: expectedRuns,
        });
        distinctCounts.add(seen.runs);
      }
      expect(distinctCounts.size).toBeGreaterThan(1);
    });

    it('shows a member of another organization nothing', async () => {
      const manifest = await seed();
      const plan = planDataset(smokeProfile, seeds.primary, asOf);
      const outsider = planDataset(smokeProfile, seeds.alternate, asOf);
      await seed({ seed: seeds.alternate });

      const seen = await withTenantTransaction(
        runtimePool,
        { orgId: outsider.organizationId, userId: outsider.users[0]?.id ?? '' },
        async (client) => {
          const result = await client.query<{ count: string }>(
            'SELECT count(*) FROM runs WHERE org_id = $1',
            [plan.organizationId],
          );
          return result.rows[0]?.count;
        },
      );
      expect(seen).toBe('0');
      expect(manifest.counts.runs).toBeGreaterThan(0);
    });
  });
});
