import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';

interface GeometryFacts {
  all_coordinates_valid: boolean | null;
  antimeridian_vertex_count: number;
  component_count: number;
  component_lengths_m: number[] | null;
  maximum_longitude_jump: number | null;
  point_count: number;
  shared_boundary_errors_m: number[] | null;
  wkt: string | null;
}

async function simplify(
  pool: Pool,
  wkt: string,
  algorithmVersion = 'v1',
): Promise<GeometryFacts> {
  const result = await pool.query<GeometryFacts>(
    `WITH simplified AS (
       SELECT app_private.simplify_display_geometry(
         ST_GeomFromText($1, 4326),
         $2
       ) AS geom
     ),
     components AS (
       SELECT dumped.path[1] AS component_index, dumped.geom
       FROM simplified
       CROSS JOIN LATERAL ST_Dump(simplified.geom) AS dumped
     ),
     points AS (
       SELECT
         component.component_index,
         point.path[1] AS point_index,
         ST_X(point.geom) AS longitude,
         ST_Y(point.geom) AS latitude,
         lag(ST_X(point.geom)) OVER (
           PARTITION BY component.component_index
           ORDER BY point.path[1]
         ) AS previous_longitude
       FROM components AS component
       CROSS JOIN LATERAL ST_DumpPoints(component.geom) AS point
     )
     SELECT
       ST_AsText(simplified.geom) AS wkt,
       coalesce(ST_NumGeometries(simplified.geom), 0)::integer AS component_count,
       coalesce(ST_NPoints(simplified.geom), 0)::integer AS point_count,
       (
         SELECT array_agg(ST_Length(component.geom::geography) ORDER BY component_index)
         FROM components AS component
       ) AS component_lengths_m,
       (
         SELECT max(abs(longitude - previous_longitude))
         FROM points
         WHERE previous_longitude IS NOT NULL
       ) AS maximum_longitude_jump,
       (
         SELECT bool_and(
           longitude BETWEEN -180.0 AND 180.0
           AND latitude BETWEEN -90.0 AND 90.0
         )
         FROM points
       ) AS all_coordinates_valid,
       (
         SELECT count(*)::integer
         FROM points
         WHERE abs(abs(longitude) - 180.0) < 1e-9
       ) AS antimeridian_vertex_count,
       (
         SELECT array_agg(
           ST_Distance(
             ST_EndPoint(predecessor.geom)::geography,
             ST_StartPoint(successor.geom)::geography
           )
           ORDER BY predecessor.component_index
         )
         FROM components AS predecessor
         JOIN components AS successor
           ON successor.component_index = predecessor.component_index + 1
       ) AS shared_boundary_errors_m
     FROM simplified
     GROUP BY simplified.geom`,
    [wkt, algorithmVersion],
  );

  const facts = result.rows[0];
  if (!facts) {
    throw new Error('Display geometry simplification returned no row');
  }
  return facts;
}

describe('P06.3 metric display-geometry simplification', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    runtimePool = new Pool({
      application_name: 'running-tracker-display-geometry-runtime',
      connectionString: config.runtime.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-display-geometry-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-display-geometry-owner',
      connectionString: config.migration.connectionString,
      max: 1,
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  it('exposes only a pure maintenance geometry capability', async () => {
    const privileges = await ownerPool.query<{
      fixed_search_path: boolean;
      immutable: boolean;
      maintenance_can_execute: boolean;
      parallel_safe: boolean;
      public_can_execute: boolean;
      runtime_can_execute: boolean;
      security_invoker: boolean;
      strict: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'running_tracker_runtime',
           'app_private.simplify_display_geometry(geometry,text)',
           'EXECUTE'
         ) AS runtime_can_execute,
         has_function_privilege(
           'running_tracker_maintenance',
           'app_private.simplify_display_geometry(geometry,text)',
           'EXECUTE'
         ) AS maintenance_can_execute,
         NOT procedure.prosecdef AS security_invoker,
         procedure.provolatile = 'i' AS immutable,
         procedure.proisstrict AS strict,
         procedure.proparallel = 's' AS parallel_safe,
         procedure.proconfig @> ARRAY['search_path=pg_catalog'] AS fixed_search_path,
         EXISTS (
           SELECT 1
           FROM aclexplode(procedure.proacl) AS privilege
           WHERE privilege.grantee = 0
             AND privilege.privilege_type = 'EXECUTE'
         ) AS public_can_execute
       FROM pg_proc AS procedure
       WHERE procedure.oid =
         'app_private.simplify_display_geometry(geometry,text)'::regprocedure`,
    );

    expect(privileges.rows[0]).toEqual({
      fixed_search_path: true,
      immutable: true,
      maintenance_can_execute: true,
      parallel_safe: true,
      public_can_execute: false,
      runtime_can_execute: false,
      security_invoker: true,
      strict: true,
    });
    await expect(
      simplify(runtimePool, 'MULTILINESTRING((21 52,21.0001 52))'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('fails closed for unsupported versions and malformed geometry', async () => {
    await expect(
      simplify(maintenancePool, 'MULTILINESTRING((21 52,21.0001 52))', 'v2'),
    ).rejects.toMatchObject({
      code: '22023',
      message: 'unsupported track algorithm version: v2',
    });

    await expect(
      maintenancePool.query(
        `SELECT app_private.simplify_display_geometry(
           ST_GeomFromText('LINESTRING(21 52,21.0001 52)', 4326),
           'v1'
         )`,
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenancePool.query(
        `SELECT app_private.simplify_display_geometry(
           ST_GeomFromText('MULTILINESTRING((181 0,182 0))', 4326),
           'v1'
         )`,
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('returns NULL for absent, empty, and display-degenerate chains', async () => {
    const result = await maintenancePool.query<{
      empty_result: unknown;
      null_result: unknown;
      stationary_result: unknown;
    }>(
      `SELECT
         app_private.simplify_display_geometry(NULL, 'v1') AS null_result,
         app_private.simplify_display_geometry(
           ST_GeomFromText('MULTILINESTRING EMPTY', 4326),
           'v1'
         ) AS empty_result,
         app_private.simplify_display_geometry(
           ST_GeomFromText(
             'MULTILINESTRING((21 52,21 52,21.000001 52,21 52))',
             4326
           ),
           'v1'
         ) AS stationary_result`,
    );

    expect(result.rows[0]).toEqual({
      empty_result: null,
      null_result: null,
      stationary_result: null,
    });
  });

  it('removes sub-five-metre noise while preserving endpoints and a sharp turn', async () => {
    const wkt =
      'MULTILINESTRING((21 52,21.00003 52.00001,21.0001 52,21.0001 52.0002))';
    const facts = await simplify(maintenancePool, wkt);
    const landmarks = await maintenancePool.query<{
      corner_error_m: number;
      end_error_m: number;
      start_error_m: number;
    }>(
      `WITH simplified AS (
         SELECT app_private.simplify_display_geometry(
           ST_GeomFromText($1, 4326),
           'v1'
         ) AS geom
       )
       SELECT
         ST_Distance(
           ST_StartPoint(ST_GeometryN(geom, 1))::geography,
           ST_SetSRID(ST_MakePoint(21, 52), 4326)::geography
         ) AS start_error_m,
         ST_Distance(
           ST_PointN(ST_GeometryN(geom, 1), 2)::geography,
           ST_SetSRID(ST_MakePoint(21.0001, 52), 4326)::geography
         ) AS corner_error_m,
         ST_Distance(
           ST_EndPoint(ST_GeometryN(geom, 1))::geography,
           ST_SetSRID(ST_MakePoint(21.0001, 52.0002), 4326)::geography
         ) AS end_error_m
       FROM simplified`,
      [wkt],
    );

    expect(facts.component_count).toBe(1);
    expect(facts.point_count).toBe(3);
    expect(facts.all_coordinates_valid).toBe(true);
    expect(landmarks.rows[0]?.start_error_m).toBeLessThan(0.001);
    expect(landmarks.rows[0]?.corner_error_m).toBeLessThan(0.001);
    expect(landmarks.rows[0]?.end_error_m).toBeLessThan(0.001);
  });

  it('partitions long chains by cumulative geodesic distance with shared boundaries', async () => {
    const facts = await simplify(maintenancePool, 'MULTILINESTRING((0 0,0.45 0))');

    expect(facts.component_count).toBe(3);
    expect(facts.point_count).toBe(6);
    expect(facts.component_lengths_m).toHaveLength(3);
    for (const length of facts.component_lengths_m ?? []) {
      expect(length).toBeLessThanOrEqual(20_000.001);
      expect(length).toBeGreaterThan(0);
    }
    expect(facts.shared_boundary_errors_m).toHaveLength(2);
    for (const error of facts.shared_boundary_errors_m ?? []) {
      expect(error).toBeLessThan(0.001);
    }
  });

  it('splits and normalizes antimeridian crossings at ordinary and polar latitudes', async () => {
    const greenwich = await simplify(
      maintenancePool,
      'MULTILINESTRING((-0.05 10,0.05 10))',
    );
    expect(greenwich.component_count).toBe(1);
    expect(greenwich.antimeridian_vertex_count).toBe(0);
    expect(greenwich.maximum_longitude_jump).toBeLessThan(1);

    for (const wkt of [
      'MULTILINESTRING((179.96 10,179.98 10,-179.98 10,-179.96 10))',
      'MULTILINESTRING((179.8 89.9,-179.8 89.9))',
    ]) {
      const facts = await simplify(maintenancePool, wkt);

      expect(facts.component_count).toBe(2);
      expect(facts.all_coordinates_valid).toBe(true);
      expect(facts.antimeridian_vertex_count).toBe(2);
      expect(facts.maximum_longitude_jump).toBeLessThan(180);
      expect(facts.shared_boundary_errors_m).toHaveLength(1);
      expect(facts.shared_boundary_errors_m?.[0]).toBeLessThan(0.001);
    }
  });
});
