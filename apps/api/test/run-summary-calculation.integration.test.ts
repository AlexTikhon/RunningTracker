import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';

interface SummaryCalculation {
  accepted_chain_count: number;
  accepted_chain_point_counts: number[] | null;
  accepted_chains_wkt: string | null;
  distance_m: number;
  observed_duration_s: number;
  quality_stats: {
    acceptedEdgeCount: number;
    acceptedPointCount: number;
    excessiveSpeedCount: number;
    excessiveTimeGapCount: number;
    insufficientData: boolean;
    nonpositiveTimeDeltaCount: number;
    poorAccuracyPointCount: number;
    rawPointCount: number;
    segmentBreakCount: number;
    seqGapCount: number;
  };
}

interface TestPoint {
  accuracyM?: number;
  ingestedRevision?: string;
  latitude?: number;
  longitude: number;
  receivedAt?: string;
  recordedAt: string;
  segmentId?: number;
  seq: string;
}

const ids = {
  org: '60000000-0000-4000-8000-000000000001',
  run: '60000000-0000-4000-8000-000000000002',
  user: '60000000-0000-4000-8000-000000000003',
} as const;

async function cleanupFixture(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM runs WHERE org_id = $1', [ids.org]);
  await pool.query('DELETE FROM memberships WHERE org_id = $1', [ids.org]);
  await pool.query('DELETE FROM organizations WHERE id = $1', [ids.org]);
  await pool.query('DELETE FROM users WHERE id = $1', [ids.user]);
}

async function seedRun(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users (id, external_identity) VALUES ($1, $2)', [
      ids.user,
      `summary-${ids.user}`,
    ]);
    await client.query('INSERT INTO organizations (id) VALUES ($1)', [ids.org]);
    await client.query(
      `INSERT INTO memberships (org_id, user_id, role)
       VALUES ($1, $2, 'runner')`,
      [ids.org, ids.user],
    );
    await client.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at, data_revision
       ) VALUES (
         $1, $2, $3, 'finished',
         '2026-09-26T08:00:00.000Z',
         '2026-09-26T08:00:00.000Z',
         '2026-09-26T09:00:00.000Z',
         2
       )`,
      [ids.org, ids.run, ids.user],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertPoints(pool: Pool, points: TestPoint[]): Promise<void> {
  if (points.length === 0) {
    return;
  }

  await pool.query(
    `INSERT INTO run_points (
       org_id, run_id, seq, segment_id, recorded_at, received_at,
       geom, accuracy_m, ingested_revision
     )
     SELECT $1,
            $2,
            point.seq,
            point.segment_id,
            point.recorded_at,
            point.received_at,
            ST_SetSRID(ST_MakePoint(point.longitude, point.latitude), 4326),
            point.accuracy_m,
            point.ingested_revision
     FROM unnest(
       $3::bigint[],
       $4::integer[],
       $5::timestamptz[],
       $6::timestamptz[],
       $7::double precision[],
       $8::double precision[],
       $9::double precision[],
       $10::bigint[]
     ) AS point(
       seq,
       segment_id,
       recorded_at,
       received_at,
       longitude,
       latitude,
       accuracy_m,
       ingested_revision
     )`,
    [
      ids.org,
      ids.run,
      points.map(({ seq }) => seq),
      points.map(({ segmentId = 0 }) => segmentId),
      points.map(({ recordedAt }) => recordedAt),
      points.map(({ receivedAt = '2026-09-27T12:00:00.000Z' }) => receivedAt),
      points.map(({ longitude }) => longitude),
      points.map(({ latitude = 0 }) => latitude),
      points.map(({ accuracyM = 5 }) => accuracyM),
      points.map(({ ingestedRevision = '1' }) => ingestedRevision),
    ],
  );
}

async function calculate(
  pool: Pool,
  sourceRevision = '2',
  algorithmVersion = 'v1',
): Promise<SummaryCalculation> {
  const result = await pool.query<SummaryCalculation>(
    `SELECT
       calculation.distance_m,
       calculation.observed_duration_s,
       calculation.quality_stats,
       ST_AsText(calculation.accepted_chains) AS accepted_chains_wkt,
       coalesce(ST_NumGeometries(calculation.accepted_chains), 0)::integer
         AS accepted_chain_count,
       CASE
         WHEN calculation.accepted_chains IS NULL THEN NULL
         ELSE ARRAY(
           SELECT ST_NPoints(ST_GeometryN(calculation.accepted_chains, part))::integer
           FROM generate_series(
             1,
             ST_NumGeometries(calculation.accepted_chains)
           ) AS part
           ORDER BY part
         )
       END AS accepted_chain_point_counts
     FROM app_private.calculate_run_summary($1, $2, $3, $4) AS calculation`,
    [ids.org, ids.run, sourceRevision, algorithmVersion],
  );

  const calculation = result.rows[0];
  if (!calculation) {
    throw new Error('Run summary calculation returned no row');
  }
  return calculation;
}

describe('P06.2 revision-bound run summary calculation', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    runtimePool = new Pool({
      application_name: 'running-tracker-summary-runtime',
      connectionString: config.runtime.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-summary-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-summary-owner',
      connectionString: config.migration.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await cleanupFixture(ownerPool);
    await seedRun(ownerPool);
  });

  afterAll(async () => {
    if (ownerPool) {
      await cleanupFixture(ownerPool);
    }
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  it('exposes only the narrow maintenance calculation capability', async () => {
    const privileges = await ownerPool.query<{
      fixed_search_path: boolean;
      maintenance_can_execute: boolean;
      maintenance_can_read_points: boolean;
      maintenance_can_read_runs: boolean;
      parallel_unsafe: boolean;
      public_can_execute: boolean;
      runtime_can_execute: boolean;
      security_definer: boolean;
      stable: boolean;
      strict: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'running_tracker_runtime',
           'app_private.calculate_run_summary(uuid,uuid,bigint,text)',
           'EXECUTE'
         ) AS runtime_can_execute,
         has_function_privilege(
           'running_tracker_maintenance',
           'app_private.calculate_run_summary(uuid,uuid,bigint,text)',
           'EXECUTE'
         ) AS maintenance_can_execute,
         has_table_privilege(
           'running_tracker_maintenance',
           'public.run_points',
           'SELECT'
         ) AS maintenance_can_read_points,
         has_table_privilege(
           'running_tracker_maintenance',
           'public.runs',
           'SELECT'
         ) AS maintenance_can_read_runs,
         (
           SELECT procedure.prosecdef
           FROM pg_proc AS procedure
           WHERE procedure.oid =
             'app_private.calculate_run_summary(uuid,uuid,bigint,text)'::regprocedure
         ) AS security_definer,
         (
           SELECT procedure.provolatile = 's'
           FROM pg_proc AS procedure
           WHERE procedure.oid =
             'app_private.calculate_run_summary(uuid,uuid,bigint,text)'::regprocedure
         ) AS stable,
         (
           SELECT procedure.proisstrict
           FROM pg_proc AS procedure
           WHERE procedure.oid =
             'app_private.calculate_run_summary(uuid,uuid,bigint,text)'::regprocedure
         ) AS strict,
         (
           SELECT procedure.proparallel = 'u'
           FROM pg_proc AS procedure
           WHERE procedure.oid =
             'app_private.calculate_run_summary(uuid,uuid,bigint,text)'::regprocedure
         ) AS parallel_unsafe,
         (
           SELECT procedure.proconfig @> ARRAY['search_path=pg_catalog']
           FROM pg_proc AS procedure
           WHERE procedure.oid =
             'app_private.calculate_run_summary(uuid,uuid,bigint,text)'::regprocedure
         ) AS fixed_search_path,
         EXISTS (
           SELECT 1
           FROM pg_proc AS procedure
           CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
           WHERE procedure.oid =
             'app_private.calculate_run_summary(uuid,uuid,bigint,text)'::regprocedure
             AND privilege.grantee = 0
             AND privilege.privilege_type = 'EXECUTE'
         ) AS public_can_execute`,
    );

    expect(privileges.rows[0]).toEqual({
      fixed_search_path: true,
      maintenance_can_execute: true,
      maintenance_can_read_points: false,
      maintenance_can_read_runs: false,
      parallel_unsafe: true,
      public_can_execute: false,
      runtime_can_execute: false,
      security_definer: true,
      stable: true,
      strict: true,
    });
    await expect(calculate(runtimePool)).rejects.toMatchObject({ code: '42501' });
  });

  it('returns explicit insufficient data for empty and isolated-point inputs', async () => {
    await expect(calculate(maintenancePool)).resolves.toEqual({
      accepted_chain_count: 0,
      accepted_chain_point_counts: null,
      accepted_chains_wkt: null,
      distance_m: 0,
      observed_duration_s: 0,
      quality_stats: {
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
      },
    });

    await insertPoints(ownerPool, [
      {
        accuracyM: 31,
        longitude: 21,
        recordedAt: '2026-09-26T08:00:00.000Z',
        seq: '1',
      },
    ]);

    await expect(calculate(maintenancePool)).resolves.toMatchObject({
      accepted_chain_count: 0,
      accepted_chains_wkt: null,
      distance_m: 0,
      observed_duration_s: 0,
      quality_stats: {
        acceptedEdgeCount: 0,
        acceptedPointCount: 0,
        insufficientData: true,
        poorAccuracyPointCount: 1,
        rawPointCount: 1,
      },
    });
  });

  it('aggregates only accepted edges and preserves separate accepted chains', async () => {
    await insertPoints(ownerPool, [
      { seq: '1', longitude: 0, recordedAt: '2026-09-26T08:00:00.000Z' },
      { seq: '2', longitude: 0.00005, recordedAt: '2026-09-26T08:00:01.000Z' },
      { seq: '4', longitude: 0.0001, recordedAt: '2026-09-26T08:00:02.000Z' },
      {
        seq: '5',
        segmentId: 1,
        longitude: 0.00015,
        recordedAt: '2026-09-26T08:00:03.000Z',
      },
      {
        seq: '6',
        segmentId: 1,
        accuracyM: 31,
        longitude: 0.0002,
        recordedAt: '2026-09-26T08:00:04.000Z',
      },
      {
        seq: '7',
        segmentId: 1,
        longitude: 0.00025,
        recordedAt: '2026-09-26T08:00:05.000Z',
      },
      {
        seq: '8',
        segmentId: 1,
        longitude: 0.0003,
        recordedAt: '2026-09-26T08:00:05.000Z',
      },
      {
        seq: '9',
        segmentId: 1,
        longitude: 0.00035,
        recordedAt: '2026-09-26T08:00:16.000Z',
      },
      {
        seq: '10',
        segmentId: 1,
        longitude: 0.00135,
        recordedAt: '2026-09-26T08:00:17.000Z',
      },
      {
        seq: '11',
        segmentId: 1,
        longitude: 0.0014,
        recordedAt: '2026-09-26T08:00:18.000Z',
      },
    ]);

    const calculation = await calculate(maintenancePool);

    expect(calculation.distance_m).toBeCloseTo(11.131949, 5);
    expect(calculation.observed_duration_s).toBe(2);
    expect(calculation.accepted_chain_count).toBe(2);
    expect(calculation.accepted_chain_point_counts).toEqual([2, 2]);
    expect(calculation.accepted_chains_wkt).toBe(
      'MULTILINESTRING((0 0,0.00005 0),(0.00135 0,0.0014 0))',
    );
    expect(calculation.quality_stats).toEqual({
      acceptedEdgeCount: 2,
      acceptedPointCount: 4,
      excessiveSpeedCount: 1,
      excessiveTimeGapCount: 1,
      insufficientData: false,
      nonpositiveTimeDeltaCount: 1,
      poorAccuracyPointCount: 1,
      rawPointCount: 10,
      segmentBreakCount: 1,
      seqGapCount: 1,
    });
  });

  it('binds the calculation to source revision and ignores delivery time', async () => {
    await insertPoints(ownerPool, [
      {
        seq: '1',
        ingestedRevision: '1',
        longitude: 0,
        receivedAt: '2026-09-26T10:00:00.000Z',
        recordedAt: '2026-09-26T08:00:00.000Z',
      },
      {
        seq: '3',
        ingestedRevision: '1',
        longitude: 0.0002,
        receivedAt: '2026-09-26T10:00:01.000Z',
        recordedAt: '2026-09-26T08:00:02.000Z',
      },
      {
        seq: '2',
        ingestedRevision: '2',
        longitude: 0.0001,
        receivedAt: '2026-09-27T10:00:00.000Z',
        recordedAt: '2026-09-26T08:00:01.000Z',
      },
    ]);

    const firstRevision = await calculate(maintenancePool, '1');
    expect(firstRevision).toMatchObject({
      accepted_chain_count: 0,
      distance_m: 0,
      observed_duration_s: 0,
      quality_stats: {
        acceptedEdgeCount: 0,
        acceptedPointCount: 0,
        insufficientData: true,
        rawPointCount: 2,
        seqGapCount: 1,
      },
    });

    const secondRevision = await calculate(maintenancePool, '2');
    expect(secondRevision.distance_m).toBeCloseTo(22.263898, 5);
    expect(secondRevision.observed_duration_s).toBe(2);
    expect(secondRevision.accepted_chain_count).toBe(1);
    expect(secondRevision.accepted_chain_point_counts).toEqual([3]);
    expect(secondRevision.quality_stats).toMatchObject({
      acceptedEdgeCount: 2,
      acceptedPointCount: 3,
      insufficientData: false,
      rawPointCount: 3,
      seqGapCount: 0,
    });
  });

  it('fails closed for an invalid revision or algorithm version', async () => {
    await expect(calculate(maintenancePool, '-1')).rejects.toMatchObject({
      code: '22023',
      message: 'source revision must be nonnegative: -1',
    });
    await expect(calculate(maintenancePool, '2', 'v2')).rejects.toMatchObject({
      code: '22023',
      message: 'unsupported track algorithm version: v2',
    });
  });
});
