import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import {
  runSummaryPublicationBatch,
  runSummaryPublicationOnce,
} from '../src/maintenance/run-summary-publication.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as fixtureIds,
} from './tenant-isolation-fixtures.js';

const runIds = {
  deleted: 'a6400000-0000-4000-8000-000000000001',
  endToEnd: 'a6400000-0000-4000-8000-000000000002',
  finished: 'a6400000-0000-4000-8000-000000000003',
  current: 'a6400000-0000-4000-8000-000000000004',
  invalidCurrent: 'a6400000-0000-4000-8000-000000000008',
  parallelA: 'a6400000-0000-4000-8000-000000000009',
  parallelB: 'a6400000-0000-4000-8000-000000000010',
  purged: 'a6400000-0000-4000-8000-000000000005',
  recording: 'a6400000-0000-4000-8000-000000000006',
  revised: 'a6400000-0000-4000-8000-000000000007',
} as const;

const computedAt = '2026-09-26T18:30:00.000Z';
const validQualityStats = {
  acceptedEdgeCount: 0,
  acceptedPointCount: 0,
  excessiveSpeedCount: 0,
  excessiveTimeGapCount: 0,
  insufficientData: true,
  nonpositiveTimeDeltaCount: 0,
  poorAccuracyPointCount: 0,
  rawPointCount: 0,
  segmentBreakCount: 0,
  seqGapCount: 0,
};

const clock: Pick<Clock, 'utcNow'> = {
  utcNow: () => new Date(computedAt),
};

interface PublicationRow {
  archive_revision: string | null;
  published: boolean;
}

describe('P06.4 revision-checked run summary publication', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    ownerPool = new Pool({
      application_name: 'running-tracker-summary-publication-owner',
      connectionString: config.migration.connectionString,
      max: 4,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-summary-publication-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 4,
    });
    runtimePool = new Pool({
      application_name: 'running-tracker-summary-publication-runtime',
      connectionString: config.runtime.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM runs');
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  async function insertRun(options: {
    dataRevision?: number;
    id: string;
    rawState?: 'available' | 'purged';
    status?: 'finished' | 'recording';
  }): Promise<void> {
    const status = options.status ?? 'finished';
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES (
         $1, $2, $3, $4, '2026-09-26T17:00:00.000Z',
         '2026-09-26T17:00:00.000Z', $5, $6, 0, $7
       )`,
      [
        fixtureIds.orgA,
        options.id,
        fixtureIds.userDual,
        status,
        status === 'finished' ? '2026-09-26T18:00:00.000Z' : null,
        options.dataRevision ?? 0,
        options.rawState ?? 'available',
      ],
    );
  }

  async function insertPoint(options: {
    ingestedRevision: number;
    longitude: number;
    runId: string;
    seq: number;
  }): Promise<void> {
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES (
         $1, $2, $3::bigint, 0,
         '2026-09-26T17:00:00.000Z'::timestamptz
           + ($3::double precision * interval '1 second'),
         '2026-09-26T17:30:00.000Z',
         ST_SetSRID(ST_MakePoint($4, 52.0), 4326), 5.0, $5
       )`,
      [fixtureIds.orgA, options.runId, options.seq, options.longitude, options.ingestedRevision],
    );
  }

  async function publish(
    runId: string,
    sourceRevision: string,
  ): Promise<PublicationRow> {
    const result = await maintenancePool.query<PublicationRow>(
      `SELECT published, archive_revision
       FROM app_private.publish_run_summary(
         $1,
         $2,
         $3,
         'v1',
         NULL::geometry,
         0.0,
         0.0,
         $4::jsonb,
         $5
       )`,
      [
        fixtureIds.orgA,
        runId,
        sourceRevision,
        JSON.stringify(validQualityStats),
        computedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Summary publication returned no row');
    }
    return row;
  }

  async function waitForBlockedPublication(processId: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await ownerPool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [processId],
      );
      if (activity.rows[0]?.blocked) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Summary publication did not reach the expected run lock wait');
  }

  it('exposes only narrow discovery/publication capabilities and validates quality shape', async () => {
    const privileges = await ownerPool.query<{
      maintenance_can_claim: boolean;
      maintenance_can_find: boolean;
      maintenance_can_publish: boolean;
      maintenance_can_write_summaries: boolean;
      public_can_claim: boolean;
      public_can_publish: boolean;
      runtime_can_claim: boolean;
      runtime_can_find: boolean;
      runtime_can_publish: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'running_tracker_maintenance',
           'app_private.claim_stale_run_summary(integer)',
           'EXECUTE'
         ) AS maintenance_can_claim,
         has_function_privilege(
           'running_tracker_maintenance',
           'app_private.find_stale_run_summaries(integer)',
           'EXECUTE'
         ) AS maintenance_can_find,
         has_function_privilege(
           'running_tracker_runtime',
           'app_private.find_stale_run_summaries(integer)',
           'EXECUTE'
         ) AS runtime_can_find,
         has_function_privilege(
           'running_tracker_runtime',
           'app_private.claim_stale_run_summary(integer)',
           'EXECUTE'
         ) AS runtime_can_claim,
         has_function_privilege(
           'public',
           'app_private.claim_stale_run_summary(integer)',
           'EXECUTE'
         ) AS public_can_claim,
         has_function_privilege(
           'running_tracker_maintenance',
           'app_private.publish_run_summary(uuid,uuid,bigint,text,geometry,double precision,double precision,jsonb,timestamp with time zone)',
           'EXECUTE'
         ) AS maintenance_can_publish,
         has_function_privilege(
           'running_tracker_runtime',
           'app_private.publish_run_summary(uuid,uuid,bigint,text,geometry,double precision,double precision,jsonb,timestamp with time zone)',
           'EXECUTE'
         ) AS runtime_can_publish,
         has_function_privilege(
           'public',
           'app_private.publish_run_summary(uuid,uuid,bigint,text,geometry,double precision,double precision,jsonb,timestamp with time zone)',
           'EXECUTE'
         ) AS public_can_publish,
         has_table_privilege(
           'running_tracker_maintenance',
           'public.run_summaries',
           'INSERT,UPDATE'
         ) AS maintenance_can_write_summaries`,
    );

    expect(privileges.rows[0]).toEqual({
      maintenance_can_claim: true,
      maintenance_can_find: true,
      maintenance_can_publish: true,
      maintenance_can_write_summaries: false,
      public_can_claim: false,
      public_can_publish: false,
      runtime_can_find: false,
      runtime_can_claim: false,
      runtime_can_publish: false,
    });
    await expect(
      runtimePool.query('SELECT * FROM app_private.find_stale_run_summaries(1)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query('SELECT * FROM app_private.claim_stale_run_summary(1)'),
    ).rejects.toMatchObject({ code: '42501' });

    await insertRun({ id: runIds.finished });
    await expect(
      maintenancePool.query(
        `SELECT * FROM app_private.publish_run_summary(
           $1, $2, 0, 'v1', NULL::geometry, 0.0, 0.0,
           '{"rawPointCount":0,"insufficientData":true}'::jsonb,
           $3
         )`,
        [fixtureIds.orgA, runIds.finished, computedAt],
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('discovers only finished raw-available runs with missing, stale, or invalid summaries', async () => {
    await insertRun({ dataRevision: 3, id: runIds.finished });
    await insertRun({ dataRevision: 3, id: runIds.current });
    await insertRun({ dataRevision: 3, id: runIds.invalidCurrent });
    await insertRun({ dataRevision: 3, id: runIds.purged, rawState: 'purged' });
    await insertRun({ dataRevision: 3, id: runIds.recording, status: 'recording' });
    await ownerPool.query(
      `INSERT INTO run_summaries (
         org_id, run_id, source_revision, algorithm_version, display_geom,
         distance_m, observed_duration_s, quality_stats, computed_at
       ) VALUES ($1, $2, 3, 'v1', NULL, 0.0, 0.0, $3::jsonb, $4)`,
      [fixtureIds.orgA, runIds.current, JSON.stringify(validQualityStats), computedAt],
    );
    await ownerPool.query(
      `INSERT INTO run_summaries (
         org_id, run_id, source_revision, algorithm_version, display_geom,
         distance_m, observed_duration_s, quality_stats, computed_at
       ) VALUES ($1, $2, 3, 'v1', NULL, 0.0, 0.0, '{"rawPointCount":0}', $3)`,
      [fixtureIds.orgA, runIds.invalidCurrent, computedAt],
    );

    const candidates = await maintenancePool.query<{
      algorithm_version: string;
      org_id: string;
      run_id: string;
      source_revision: string;
    }>('SELECT * FROM app_private.find_stale_run_summaries(10)');

    expect(candidates.rows).toEqual([
      {
        algorithm_version: 'v1',
        org_id: fixtureIds.orgA,
        run_id: runIds.finished,
        source_revision: '3',
      },
      {
        algorithm_version: 'v1',
        org_id: fixtureIds.orgA,
        run_id: runIds.invalidCurrent,
        source_revision: '3',
      },
    ]);
  });

  it('calculates, simplifies, publishes, and advances archive revision atomically', async () => {
    await insertRun({ dataRevision: 1, id: runIds.endToEnd });
    await insertPoint({
      ingestedRevision: 1,
      longitude: 21.0,
      runId: runIds.endToEnd,
      seq: 1,
    });
    await insertPoint({
      ingestedRevision: 1,
      longitude: 21.00005,
      runId: runIds.endToEnd,
      seq: 2,
    });

    await expect(runSummaryPublicationOnce(maintenancePool, clock)).resolves.toMatchObject({
      archiveRevision: '1',
      runId: runIds.endToEnd,
      sourceRevision: '1',
      status: 'published',
    });

    const stored = await ownerPool.query<{
      algorithm_version: string;
      archive_revision: string;
      computed_at: Date;
      distance_m: number;
      geometry_parts: number;
      observed_duration_s: number;
      quality_stats: typeof validQualityStats;
      source_revision: string;
    }>(
      `SELECT
         summary.source_revision,
         summary.algorithm_version,
         summary.distance_m,
         summary.observed_duration_s,
         summary.quality_stats,
         summary.computed_at,
         ST_NumGeometries(summary.display_geom)::integer AS geometry_parts,
         organization.archive_revision
       FROM run_summaries AS summary
       JOIN organizations AS organization ON organization.id = summary.org_id
       WHERE summary.org_id = $1 AND summary.run_id = $2`,
      [fixtureIds.orgA, runIds.endToEnd],
    );
    expect(stored.rows[0]).toMatchObject({
      algorithm_version: 'v1',
      archive_revision: '1',
      computed_at: new Date(computedAt),
      geometry_parts: 1,
      observed_duration_s: 1,
      source_revision: '1',
    });
    expect(stored.rows[0]?.distance_m).toBeGreaterThan(3);
    expect(stored.rows[0]?.quality_stats).toMatchObject({
      acceptedEdgeCount: 1,
      acceptedPointCount: 2,
      insufficientData: false,
      rawPointCount: 2,
    });
    await expect(runSummaryPublicationOnce(maintenancePool, clock)).resolves.toEqual({
      status: 'idle',
    });
  });

  it('claims distinct candidates across transactions and releases claims on rollback', async () => {
    await insertRun({ id: runIds.parallelA });
    await insertRun({ id: runIds.parallelB });
    const first = await maintenancePool.connect();
    const second = await maintenancePool.connect();
    const third = await maintenancePool.connect();
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN'), third.query('BEGIN')]);
      const firstClaim = await first.query<{ run_id: string }>(
        'SELECT run_id FROM app_private.claim_stale_run_summary(1000)',
      );
      const secondClaim = await second.query<{ run_id: string }>(
        'SELECT run_id FROM app_private.claim_stale_run_summary(1000)',
      );
      expect(
        [firstClaim.rows[0]?.run_id, secondClaim.rows[0]?.run_id].sort(),
      ).toEqual([runIds.parallelA, runIds.parallelB].sort());
      await expect(
        third.query('SELECT run_id FROM app_private.claim_stale_run_summary(1000)'),
      ).resolves.toMatchObject({ rowCount: 0 });

      await first.query('ROLLBACK');
      await expect(
        third.query<{ run_id: string }>(
          'SELECT run_id FROM app_private.claim_stale_run_summary(1000)',
        ),
      ).resolves.toMatchObject({ rows: [{ run_id: firstClaim.rows[0]?.run_id }] });
      await second.query('ROLLBACK');
      await third.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
      third.release();
    }
  });

  it('publishes a bounded concurrent batch without duplicate work', async () => {
    await insertRun({ id: runIds.parallelA });
    await insertRun({ id: runIds.parallelB });

    await expect(runSummaryPublicationBatch(maintenancePool, clock, 2)).resolves.toEqual({
      idleCount: 0,
      publishedCount: 2,
      staleCount: 0,
    });
    const state = await ownerPool.query<{ archive_revision: string; summary_count: string }>(
      `SELECT organization.archive_revision, count(summary.run_id) AS summary_count
       FROM organizations AS organization
       LEFT JOIN run_summaries AS summary ON summary.org_id = organization.id
       WHERE organization.id = $1
       GROUP BY organization.archive_revision`,
      [fixtureIds.orgA],
    );
    expect(state.rows[0]).toEqual({ archive_revision: '2', summary_count: '2' });
  });

  it('calculates without the run lock and discards a revision changed before publication', async () => {
    await insertRun({ dataRevision: 1, id: runIds.revised });
    await insertPoint({
      ingestedRevision: 1,
      longitude: 21,
      runId: runIds.revised,
      seq: 1,
    });

    const ingestion = await ownerPool.connect();
    const publisher = await maintenancePool.connect();
    try {
      await ingestion.query('BEGIN');
      await ingestion.query(
        'SELECT 1 FROM runs WHERE org_id = $1 AND id = $2 FOR UPDATE',
        [fixtureIds.orgA, runIds.revised],
      );
      await ingestion.query(
        `INSERT INTO run_points (
           org_id, run_id, seq, segment_id, recorded_at, received_at,
           geom, accuracy_m, ingested_revision
         ) VALUES (
           $1, $2, 2, 0, '2026-09-26T17:00:02.000Z',
           '2026-09-26T17:30:00.000Z',
           ST_SetSRID(ST_MakePoint(21.00005, 52.0), 4326), 5.0, 2
         )`,
        [fixtureIds.orgA, runIds.revised],
      );
      await ingestion.query(
        'UPDATE runs SET data_revision = 2 WHERE org_id = $1 AND id = $2',
        [fixtureIds.orgA, runIds.revised],
      );

      const publisherIdentity = await publisher.query<{ process_id: number }>(
        'SELECT pg_backend_pid() AS process_id',
      );
      const processId = publisherIdentity.rows[0]?.process_id;
      if (typeof processId !== 'number') {
        throw new Error('Missing maintenance backend identity');
      }
      const publication = runSummaryPublicationOnce(
        {
          connect: () => Promise.resolve({
            query: publisher.query.bind(publisher),
            release: () => undefined,
          }),
        } as never,
        clock,
      );
      await waitForBlockedPublication(processId);

      await expect(
        ownerPool.query(
          'SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE NOWAIT',
          [fixtureIds.orgA],
        ),
      ).rejects.toMatchObject({ code: '55P03' });

      await ingestion.query('COMMIT');
      await expect(publication).resolves.toMatchObject({
        archiveRevision: '0',
        sourceRevision: '1',
        status: 'stale',
      });
    } catch (error) {
      await ingestion.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      publisher.release();
      ingestion.release();
    }

    await expect(
      ownerPool.query(
        'SELECT 1 FROM run_summaries WHERE org_id = $1 AND run_id = $2',
        [fixtureIds.orgA, runIds.revised],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('does not resurrect a run deleted after calculation', async () => {
    await insertRun({ id: runIds.deleted });
    await ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [
      fixtureIds.orgA,
      runIds.deleted,
    ]);

    await expect(publish(runIds.deleted, '0')).resolves.toEqual({
      archive_revision: '0',
      published: false,
    });
    await expect(
      ownerPool.query(
        'SELECT 1 FROM run_summaries WHERE org_id = $1 AND run_id = $2',
        [fixtureIds.orgA, runIds.deleted],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('serializes duplicate publications and advances archive revision once', async () => {
    await insertRun({ id: runIds.finished });

    const publications = await Promise.all([
      publish(runIds.finished, '0'),
      publish(runIds.finished, '0'),
    ]);
    expect(publications.map((result) => result.published).sort()).toEqual([false, true]);

    const state = await ownerPool.query<{
      archive_revision: string;
      summary_count: string;
    }>(
      `SELECT
         organization.archive_revision,
         count(summary.run_id) AS summary_count
       FROM organizations AS organization
       LEFT JOIN run_summaries AS summary
         ON summary.org_id = organization.id
        AND summary.run_id = $2
       WHERE organization.id = $1
       GROUP BY organization.archive_revision`,
      [fixtureIds.orgA, runIds.finished],
    );
    expect(state.rows[0]).toEqual({ archive_revision: '1', summary_count: '1' });
  });
});
