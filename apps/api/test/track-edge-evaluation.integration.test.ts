import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';

interface EdgeEvaluation {
  accepted: boolean;
  distance_m: number;
  duration_s: number;
  rejection_reason: string | null;
}

interface EdgeInput {
  algorithmVersion: string;
  predecessorAccuracyM: number;
  predecessorLatitude: number;
  predecessorLongitude: number;
  predecessorRecordedAt: string;
  predecessorSegmentId: number;
  predecessorSeq: string;
  successorAccuracyM: number;
  successorLatitude: number;
  successorLongitude: number;
  successorRecordedAt: string;
  successorSegmentId: number;
  successorSeq: string;
}

const acceptedEdge: EdgeInput = {
  algorithmVersion: 'v1',
  predecessorAccuracyM: 5,
  predecessorLatitude: 52,
  predecessorLongitude: 21,
  predecessorRecordedAt: '2026-09-26T08:00:00.000Z',
  predecessorSegmentId: 0,
  predecessorSeq: '1',
  successorAccuracyM: 5,
  successorLatitude: 52,
  successorLongitude: 21.0001,
  successorRecordedAt: '2026-09-26T08:00:01.000Z',
  successorSegmentId: 0,
  successorSeq: '2',
};

async function evaluateEdge(
  pool: Pool,
  overrides: Partial<EdgeInput> = {},
): Promise<EdgeEvaluation> {
  const edge = { ...acceptedEdge, ...overrides };
  const result = await pool.query<EdgeEvaluation>(
    `SELECT accepted, rejection_reason, distance_m, duration_s
     FROM app_private.evaluate_track_edge(
       $1::text,
       $2::bigint,
       $3::integer,
       $4::timestamptz,
       ST_SetSRID(ST_MakePoint($5, $6), 4326),
       $7::double precision,
       $8::bigint,
       $9::integer,
       $10::timestamptz,
       ST_SetSRID(ST_MakePoint($11, $12), 4326),
       $13::double precision
     )`,
    [
      edge.algorithmVersion,
      edge.predecessorSeq,
      edge.predecessorSegmentId,
      edge.predecessorRecordedAt,
      edge.predecessorLongitude,
      edge.predecessorLatitude,
      edge.predecessorAccuracyM,
      edge.successorSeq,
      edge.successorSegmentId,
      edge.successorRecordedAt,
      edge.successorLongitude,
      edge.successorLatitude,
      edge.successorAccuracyM,
    ],
  );

  const evaluation = result.rows[0];
  if (!evaluation) {
    throw new Error('Track edge evaluation returned no row');
  }
  return evaluation;
}

describe('P06.1 versioned track edge evaluation', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    runtimePool = new Pool({
      application_name: 'running-tracker-edge-runtime',
      connectionString: config.runtime.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-edge-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-edge-owner',
      connectionString: config.migration.connectionString,
      max: 1,
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  it('exposes one current version to runtime and maintenance without PUBLIC execution', async () => {
    const [runtimeVersion, maintenanceVersion, privileges] = await Promise.all([
      runtimePool.query<{ algorithm_version: string }>(
        'SELECT app_private.current_track_algorithm_version() AS algorithm_version',
      ),
      maintenancePool.query<{ algorithm_version: string }>(
        'SELECT app_private.current_track_algorithm_version() AS algorithm_version',
      ),
      ownerPool.query<{
        maintenance_can_execute: boolean;
        public_can_execute: boolean;
        runtime_can_execute: boolean;
      }>(
        `SELECT
           has_function_privilege(
             'running_tracker_runtime',
             'app_private.evaluate_track_edge(text,bigint,integer,timestamp with time zone,geometry,double precision,bigint,integer,timestamp with time zone,geometry,double precision)',
             'EXECUTE'
           ) AS runtime_can_execute,
           has_function_privilege(
             'running_tracker_maintenance',
             'app_private.evaluate_track_edge(text,bigint,integer,timestamp with time zone,geometry,double precision,bigint,integer,timestamp with time zone,geometry,double precision)',
             'EXECUTE'
           ) AS maintenance_can_execute,
           EXISTS (
             SELECT 1
             FROM pg_proc AS procedure
             CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
             WHERE procedure.oid = 'app_private.evaluate_track_edge(text,bigint,integer,timestamp with time zone,geometry,double precision,bigint,integer,timestamp with time zone,geometry,double precision)'::regprocedure
               AND privilege.grantee = 0
               AND privilege.privilege_type = 'EXECUTE'
           ) AS public_can_execute`,
      ),
    ]);

    expect(runtimeVersion.rows[0]?.algorithm_version).toBe('v1');
    expect(maintenanceVersion.rows[0]?.algorithm_version).toBe('v1');
    expect(privileges.rows[0]).toEqual({
      maintenance_can_execute: true,
      public_can_execute: false,
      runtime_can_execute: true,
    });
  });

  it('accepts a consecutive same-segment edge at inclusive quality and time limits', async () => {
    const evaluation = await evaluateEdge(runtimePool, {
      predecessorAccuracyM: 30,
      successorAccuracyM: 30,
      successorRecordedAt: '2026-09-26T08:00:10.000Z',
    });

    expect(evaluation).toMatchObject({
      accepted: true,
      duration_s: 10,
      rejection_reason: null,
    });
    expect(evaluation.distance_m).toBeGreaterThan(6);
    expect(evaluation.distance_m).toBeLessThan(8);
  });

  it.each([
    {
      expectedReason: 'seq_gap',
      overrides: { predecessorAccuracyM: 31, successorSeq: '3' },
    },
    {
      expectedReason: 'segment_break',
      overrides: { predecessorAccuracyM: 31, successorSegmentId: 1 },
    },
    {
      expectedReason: 'poor_accuracy',
      overrides: { successorAccuracyM: 30.0001 },
    },
    {
      expectedReason: 'nonpositive_time_delta',
      overrides: { successorRecordedAt: '2026-09-26T08:00:00.000Z' },
    },
    {
      expectedReason: 'nonpositive_time_delta',
      overrides: { successorRecordedAt: '2026-09-26T07:59:59.999Z' },
    },
    {
      expectedReason: 'excessive_time_gap',
      overrides: { successorRecordedAt: '2026-09-26T08:00:10.001Z' },
    },
    {
      expectedReason: 'excessive_speed',
      overrides: { successorLongitude: 21.001 },
    },
  ])('rejects an edge as $expectedReason using deterministic precedence', async ({
    expectedReason,
    overrides,
  }) => {
    await expect(evaluateEdge(runtimePool, overrides)).resolves.toMatchObject({
      accepted: false,
      rejection_reason: expectedReason,
    });
  });

  it('uses geodesic distance across the antimeridian instead of a longitude-plane jump', async () => {
    const evaluation = await evaluateEdge(maintenancePool, {
      predecessorLatitude: 0,
      predecessorLongitude: 179.9999,
      successorLatitude: 0,
      successorLongitude: -179.9999,
      successorRecordedAt: '2026-09-26T08:00:02.000Z',
    });

    expect(evaluation).toMatchObject({
      accepted: true,
      duration_s: 2,
      rejection_reason: null,
    });
    expect(evaluation.distance_m).toBeGreaterThan(22);
    expect(evaluation.distance_m).toBeLessThan(23);
  });

  it('uses geodesic distance at high latitude without a Web Mercator assumption', async () => {
    const evaluation = await evaluateEdge(runtimePool, {
      predecessorLatitude: 89.9,
      predecessorLongitude: 21,
      successorLatitude: 89.9,
      successorLongitude: 21.01,
    });

    expect(evaluation).toMatchObject({
      accepted: true,
      duration_s: 1,
      rejection_reason: null,
    });
    expect(evaluation.distance_m).toBeGreaterThan(1);
    expect(evaluation.distance_m).toBeLessThan(3);
  });

  it('fails closed for an unsupported algorithm version', async () => {
    await expect(evaluateEdge(runtimePool, { algorithmVersion: 'v2' })).rejects.toMatchObject({
      code: '22023',
      message: 'unsupported track algorithm version: v2',
    });
  });
});
