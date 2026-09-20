import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

type ChildTable = 'run_points' | 'run_summaries';

const pointInsertSql = `INSERT INTO run_points (
  org_id, run_id, seq, segment_id, recorded_at, received_at,
  geom, accuracy_m, ingested_revision
)
VALUES (
  $1, $2, $3, $4, $5, $6,
  ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, $10
)`;

const pointValues = (
  orgId: string,
  runId: string,
  overrides: Partial<{
    accuracyM: number | string;
    ingestedRevision: string;
    latitude: number | string;
    longitude: number | string;
    segmentId: number;
    seq: string;
  }> = {},
) => [
  orgId,
  runId,
  overrides.seq ?? '2',
  overrides.segmentId ?? 0,
  '2026-09-20T08:15:02.123Z',
  '2026-09-20T08:15:03.456Z',
  overrides.longitude ?? 21.002,
  overrides.latitude ?? 52.002,
  overrides.accuracyM ?? 4.5,
  overrides.ingestedRevision ?? '2',
];

describe('P02B run_points and run_summaries ACL', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-child-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-child-maintenance',
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

  const readChildren = (
    table: ChildTable,
    orgId: string,
    userId: string,
    joinRuns = false,
  ) =>
    withTenantTransaction(runtimePool, { orgId, userId }, async (client) => {
      const result = await client.query<{ run_id: string }>(
        joinRuns
          ? `SELECT child.run_id
             FROM ${table} AS child
             JOIN runs AS parent
               ON parent.org_id = child.org_id AND parent.id = child.run_id
             ORDER BY child.run_id`
          : `SELECT run_id FROM ${table} ORDER BY run_id`,
      );
      return result.rows.map(({ run_id }) => run_id);
    });

  it('applies the run ACL to direct point reads and to joins', async () => {
    const ownerExpected = [
      ids.runRecording,
      ids.runFinishedHistory,
      ids.runFinishedLiveOnly,
      ids.runFinishedBoth,
    ];
    const granteeExpected = [
      ids.runRecording,
      ids.runPaused,
      ids.runFinishedHistory,
      ids.runFinishedBoth,
    ];

    await expect(readChildren('run_points', ids.orgA, ids.userOrgA)).resolves.toEqual(
      ownerExpected,
    );
    await expect(readChildren('run_points', ids.orgA, ids.userDual)).resolves.toEqual(
      granteeExpected,
    );
    await expect(readChildren('run_points', ids.orgA, ids.userDual, true)).resolves.toEqual(
      granteeExpected,
    );
    await expect(readChildren('run_points', ids.orgA, ids.userStranger)).resolves.toEqual([]);
    await expect(readChildren('run_points', ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readChildren('run_points', ids.orgA, ids.userOrgB)).resolves.toEqual([]);
    await expect(readChildren('run_points', ids.orgB, ids.userDual)).resolves.toEqual([
      ids.runOrgBShared,
    ]);
  });

  it('requires finished history access for direct summary reads and joins', async () => {
    const ownerExpected = [
      ids.runRecording,
      ids.runFinishedHistory,
      ids.runFinishedLiveOnly,
      ids.runFinishedBoth,
    ];
    const historyExpected = [ids.runFinishedHistory, ids.runFinishedBoth];

    await expect(readChildren('run_summaries', ids.orgA, ids.userOrgA)).resolves.toEqual(
      ownerExpected,
    );
    await expect(readChildren('run_summaries', ids.orgA, ids.userDual)).resolves.toEqual(
      historyExpected,
    );
    await expect(readChildren('run_summaries', ids.orgA, ids.userDual, true)).resolves.toEqual(
      historyExpected,
    );
    await expect(readChildren('run_summaries', ids.orgA, ids.userStranger)).resolves.toEqual([]);
    await expect(readChildren('run_summaries', ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readChildren('run_summaries', ids.orgB, ids.userDual)).resolves.toEqual([
      ids.runOrgBShared,
    ]);
  });

  it('fails closed for missing and malformed child-table contexts', async () => {
    for (const table of ['run_points', 'run_summaries'] as const) {
      const missing = await runtimePool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(missing.rows[0]?.count).toBe('0');
    }

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', 'invalid', true)");
      await client.query("SELECT set_config('app.org_id', 'invalid', true)");
      const points = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM run_points',
      );
      const summaries = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM run_summaries',
      );
      expect({ points: points.rows[0]?.count, summaries: summaries.rows[0]?.count }).toEqual({
        points: '0',
        summaries: '0',
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('applies grant revocation and membership deactivation on the next statement', async () => {
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
    await expect(readChildren('run_points', ids.orgA, ids.userDual)).resolves.not.toContain(
      ids.runFinishedHistory,
    );
    await expect(readChildren('run_summaries', ids.orgA, ids.userDual)).resolves.not.toContain(
      ids.runFinishedHistory,
    );

    await ownerPool.query(
      'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
      [ids.orgA, ids.userDual],
    );
    await expect(readChildren('run_points', ids.orgA, ids.userDual)).resolves.toEqual([]);
    await expect(readChildren('run_summaries', ids.orgA, ids.userDual)).resolves.toEqual([]);
  });

  it('allows owner point INSERT RETURNING but keeps runtime points immutable', async () => {
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        async (client) => {
          const inserted = await client.query<{ seq: string }>(
            `${pointInsertSql} RETURNING seq::text AS seq`,
            pointValues(ids.orgA, ids.runRecording),
          );
          return inserted.rows[0]?.seq;
        },
      ),
    ).resolves.toBe('2');

    for (const statement of [
      `UPDATE run_points SET accuracy_m = 3
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      `DELETE FROM run_points WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
    ]) {
      await expect(
        withTenantTransaction(
          runtimePool,
          { orgId: ids.orgA, userId: ids.userOrgA },
          (client) => client.query(statement, [ids.orgA, ids.runRecording]),
        ),
      ).rejects.toThrow(/permission denied/u);
    }
  });

  it('prevents a grantee from inserting or changing points', async () => {
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userDual },
        (client) => client.query(pointInsertSql, pointValues(ids.orgA, ids.runRecording)),
      ),
    ).rejects.toThrow(/row-level security/u);

    for (const statement of [
      `UPDATE run_points SET accuracy_m = 3
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      `DELETE FROM run_points WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
    ]) {
      await expect(
        withTenantTransaction(
          runtimePool,
          { orgId: ids.orgA, userId: ids.userDual },
          (client) => client.query(statement, [ids.orgA, ids.runRecording]),
        ),
      ).rejects.toThrow(/permission denied/u);
    }
  });

  it('grants runtime SELECT only on summaries', async () => {
    const statements = [
      `INSERT INTO run_summaries (
         org_id, run_id, source_revision, algorithm_version,
         distance_m, observed_duration_s, quality_stats
       ) VALUES ($1, $2, 1, 'runtime-v1', 1, 1, '{}'::jsonb)`,
      `UPDATE run_summaries SET distance_m = 1 WHERE org_id = $1 AND run_id = $2`,
      `DELETE FROM run_summaries WHERE org_id = $1 AND run_id = $2`,
    ];

    for (const statement of statements) {
      await expect(
        withTenantTransaction(
          runtimePool,
          { orgId: ids.orgA, userId: ids.userOrgA },
          (client) => client.query(statement, [ids.orgA, ids.runRecording]),
        ),
      ).rejects.toThrow(/permission denied/u);
    }
  });

  it('enforces point keys, tenant FK, ranges, finiteness, geometry, and immutability', async () => {
    await expect(
      ownerPool.query(pointInsertSql, pointValues(ids.orgB, ids.runRecording)),
    ).rejects.toThrow(/run_points_run_fk/u);

    const invalidPoints = [
      { constraint: 'run_points_seq_positive', overrides: { seq: '0' } },
      { constraint: 'run_points_segment_id_nonnegative', overrides: { segmentId: -1 } },
      { constraint: 'run_points_longitude_in_range', overrides: { longitude: 181 } },
      { constraint: 'run_points_latitude_in_range', overrides: { latitude: -91 } },
      {
        constraint: 'run_points_accuracy_finite_nonnegative',
        overrides: { accuracyM: -1 },
      },
      {
        constraint: 'run_points_ingested_revision_nonnegative',
        overrides: { ingestedRevision: '-1' },
      },
    ] as const;

    for (const { constraint, overrides } of invalidPoints) {
      await expect(
        ownerPool.query(pointInsertSql, pointValues(ids.orgA, ids.runRecording, overrides)),
      ).rejects.toThrow(new RegExp(constraint, 'u'));
    }

    for (const value of ['NaN', 'Infinity', '-Infinity']) {
      await expect(
        ownerPool.query(pointInsertSql, pointValues(ids.orgA, ids.runRecording, { accuracyM: value })),
      ).rejects.toThrow(/run_points_accuracy_finite_nonnegative/u);
    }

    for (const [coordinate, constraint] of [
      ['longitude', 'run_points_longitude_in_range'],
      ['latitude', 'run_points_latitude_in_range'],
    ] as const) {
      for (const value of ['NaN', 'Infinity', '-Infinity']) {
        await expect(
          ownerPool.query(
            pointInsertSql,
            pointValues(ids.orgA, ids.runRecording, { [coordinate]: value }),
          ),
        ).rejects.toThrow(new RegExp(constraint, 'u'));
      }
    }

    for (const [valueIndex, constraint] of [
      [4, 'run_points_recorded_at_finite'],
      [5, 'run_points_received_at_finite'],
    ] as const) {
      const values = pointValues(ids.orgA, ids.runRecording);
      values[valueIndex] = 'infinity';
      await expect(ownerPool.query(pointInsertSql, values)).rejects.toThrow(
        new RegExp(constraint, 'u'),
      );
    }

    await expect(
      ownerPool.query(
        pointInsertSql.replace(
          'ST_SetSRID(ST_MakePoint($7, $8), 4326)',
          'ST_GeomFromText($7, $8)',
        ),
        [
          ...pointValues(ids.orgA, ids.runRecording).slice(0, 6),
          'POINT EMPTY',
          4326,
          4.5,
          '2',
        ],
      ),
    ).rejects.toThrow(/run_points_geom_not_empty/u);
    await expect(
      ownerPool.query(
        pointInsertSql.replace(
          'ST_SetSRID(ST_MakePoint($7, $8), 4326)',
          'ST_SetSRID(ST_MakePoint($7, $8), 3857)',
        ),
        pointValues(ids.orgA, ids.runRecording),
      ),
    ).rejects.toThrow(/SRID/u);
    await expect(
      ownerPool.query(
        pointInsertSql.replace(
          'ST_SetSRID(ST_MakePoint($7, $8), 4326)',
          'ST_GeomFromText($7, $8)',
        ),
        [
          ...pointValues(ids.orgA, ids.runRecording).slice(0, 6),
          'LINESTRING(21 52, 22 53)',
          4326,
          4.5,
          '2',
        ],
      ),
    ).rejects.toThrow(/Geometry type|does not match column type/u);

    const before = await ownerPool.query<{ accuracy_m: number; ewkt: string }>(
      `SELECT accuracy_m, ST_AsEWKT(geom) AS ewkt
       FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      [ids.orgA, ids.runRecording],
    );
    await expect(
      ownerPool.query(
        pointInsertSql,
        pointValues(ids.orgA, ids.runRecording, { accuracyM: 99, seq: '1' }),
      ),
    ).rejects.toThrow(/run_points_pkey/u);
    const after = await ownerPool.query<{ accuracy_m: number; ewkt: string }>(
      `SELECT accuracy_m, ST_AsEWKT(geom) AS ewkt
       FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      [ids.orgA, ids.runRecording],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('enforces summary tenant, revision, version, metric, JSON, and geometry constraints', async () => {
    const summaryInsertSql = `INSERT INTO run_summaries (
      org_id, run_id, source_revision, algorithm_version, display_geom,
      distance_m, observed_duration_s, quality_stats
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
    const validValues = [
      ids.orgA,
      ids.runRecording,
      '1',
      'fixture-v2',
      null,
      1,
      1,
      {},
    ];

    await expect(
      ownerPool.query(summaryInsertSql, [ids.orgB, ...validValues.slice(1)]),
    ).rejects.toThrow(/run_summaries_run_fk/u);

    const invalidSummaries = [
      {
        constraint: 'run_summaries_source_revision_nonnegative',
        values: [ids.orgA, ids.runRecording, '-1', 'fixture-v2', null, 1, 1, {}],
      },
      {
        constraint: 'run_summaries_algorithm_version_valid',
        values: [ids.orgA, ids.runRecording, '1', ' ', null, 1, 1, {}],
      },
      {
        constraint: 'run_summaries_algorithm_version_valid',
        values: [ids.orgA, ids.runRecording, '1', 'é'.repeat(65), null, 1, 1, {}],
      },
      {
        constraint: 'run_summaries_distance_finite_nonnegative',
        values: [ids.orgA, ids.runRecording, '1', 'fixture-v2', null, -1, 1, {}],
      },
      {
        constraint: 'run_summaries_duration_finite_nonnegative',
        values: [ids.orgA, ids.runRecording, '1', 'fixture-v2', null, 1, -1, {}],
      },
      {
        constraint: 'run_summaries_quality_stats_object',
        values: [ids.orgA, ids.runRecording, '1', 'fixture-v2', null, 1, 1, []],
      },
    ];

    for (const { constraint, values } of invalidSummaries) {
      await expect(ownerPool.query(summaryInsertSql, values)).rejects.toThrow(
        new RegExp(constraint, 'u'),
      );
    }

    for (const [column, value] of [
      ['distance_m', 'NaN'],
      ['distance_m', 'Infinity'],
      ['observed_duration_s', 'NaN'],
      ['observed_duration_s', 'Infinity'],
    ] as const) {
      await expect(
        ownerPool.query(
          `UPDATE run_summaries SET ${column} = $1::double precision
           WHERE org_id = $2 AND run_id = $3`,
          [value, ids.orgA, ids.runRecording],
        ),
      ).rejects.toThrow(/finite_nonnegative/u);
    }

    await expect(
      ownerPool.query(
        `UPDATE run_summaries
         SET display_geom = ST_GeomFromText('MULTILINESTRING EMPTY', 4326)
         WHERE org_id = $1 AND run_id = $2`,
        [ids.orgA, ids.runRecording],
      ),
    ).rejects.toThrow(/run_summaries_display_geom_not_empty/u);
    await expect(
      ownerPool.query(
        `UPDATE run_summaries
         SET display_geom = ST_GeomFromText('MULTILINESTRING((21 52, 22 53))', 3857)
         WHERE org_id = $1 AND run_id = $2`,
        [ids.orgA, ids.runRecording],
      ),
    ).rejects.toThrow(/SRID/u);
    await expect(
      ownerPool.query(
        `UPDATE run_summaries
         SET display_geom = ST_GeomFromText('LINESTRING(21 52, 22 53)', 4326)
         WHERE org_id = $1 AND run_id = $2`,
        [ids.orgA, ids.runRecording],
      ),
    ).rejects.toThrow(/Geometry type|does not match column type/u);
    await expect(
      ownerPool.query(
        `UPDATE run_summaries
         SET display_geom = ST_GeomFromText('MULTILINESTRING((181 52, 182 53))', 4326)
         WHERE org_id = $1 AND run_id = $2`,
        [ids.orgA, ids.runRecording],
      ),
    ).rejects.toThrow(/run_summaries_display_geom_coordinates_valid/u);
    await expect(
      ownerPool.query(
        `UPDATE run_summaries SET computed_at = 'infinity'
         WHERE org_id = $1 AND run_id = $2`,
        [ids.orgA, ids.runRecording],
      ),
    ).rejects.toThrow(/run_summaries_computed_at_finite/u);
  });

  it('keeps bigint/timestamp representations and the intended indexes explicit', async () => {
    const columns = await ownerPool.query<{
      column_name: string;
      data_type: string;
      datetime_precision: number | null;
    }>(
      `SELECT column_name, data_type, datetime_precision
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('run_points', 'run_summaries')
         AND column_name IN (
           'seq', 'segment_id', 'recorded_at', 'received_at', 'ingested_revision',
           'accuracy_m', 'source_revision', 'distance_m', 'observed_duration_s', 'computed_at'
         )`,
    );
    expect(columns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: 'seq', data_type: 'bigint' }),
        expect.objectContaining({ column_name: 'segment_id', data_type: 'integer' }),
        expect.objectContaining({ column_name: 'ingested_revision', data_type: 'bigint' }),
        expect.objectContaining({ column_name: 'accuracy_m', data_type: 'double precision' }),
        expect.objectContaining({ column_name: 'source_revision', data_type: 'bigint' }),
        expect.objectContaining({ column_name: 'distance_m', data_type: 'double precision' }),
        expect.objectContaining({
          column_name: 'observed_duration_s',
          data_type: 'double precision',
        }),
        expect.objectContaining({
          column_name: 'recorded_at',
          data_type: 'timestamp with time zone',
          datetime_precision: 3,
        }),
        expect.objectContaining({
          column_name: 'received_at',
          data_type: 'timestamp with time zone',
          datetime_precision: 3,
        }),
        expect.objectContaining({
          column_name: 'computed_at',
          data_type: 'timestamp with time zone',
          datetime_precision: 3,
        }),
      ]),
    );

    const geometryColumns = await ownerPool.query<{
      f_table_name: string;
      srid: number;
      type: string;
    }>(
      `SELECT f_table_name, type, srid
       FROM geometry_columns
       WHERE f_table_schema = 'public'
         AND f_table_name IN ('run_points', 'run_summaries')
       ORDER BY f_table_name`,
    );
    expect(geometryColumns.rows).toEqual([
      { f_table_name: 'run_points', srid: 4326, type: 'POINT' },
      { f_table_name: 'run_summaries', srid: 4326, type: 'MULTILINESTRING' },
    ]);

    const indexes = await ownerPool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('run_points', 'run_summaries')`,
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain(
      'run_points_revision_seq_idx',
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toContain(
      'run_summaries_display_geom_gist_idx',
    );
    expect(
      indexes.rows.some(
        ({ indexdef }) => indexdef.includes('USING gist') && indexdef.includes('run_points'),
      ),
    ).toBe(false);
  });

  it('keeps the history predicate stable, definer-owned, and narrowly executable', async () => {
    const result = await ownerPool.query<{
      maintenance_execute: boolean;
      owner: string;
      proconfig: string[];
      prosecdef: boolean;
      provolatile: string;
      runtime_execute: boolean;
    }>(
      `SELECT pg_get_userbyid(procedure.proowner) AS owner,
              procedure.prosecdef,
              procedure.provolatile,
              procedure.proconfig,
              has_function_privilege(
                'running_tracker_runtime',
                'app_private.can_read_run_history(uuid, uuid)',
                'EXECUTE'
              ) AS runtime_execute,
              has_function_privilege(
                'running_tracker_maintenance',
                'app_private.can_read_run_history(uuid, uuid)',
                'EXECUTE'
              ) AS maintenance_execute
       FROM pg_proc AS procedure
       WHERE procedure.oid = 'app_private.can_read_run_history(uuid, uuid)'::regprocedure`,
    );
    expect(result.rows[0]).toEqual({
      maintenance_execute: false,
      owner: 'running_tracker_owner',
      proconfig: ['search_path=pg_catalog'],
      prosecdef: true,
      provolatile: 's',
      runtime_execute: true,
    });
  });

  it('keeps maintenance without point or summary access', async () => {
    await expect(maintenancePool.query('SELECT * FROM run_points')).rejects.toThrow(
      /permission denied/u,
    );
    await expect(maintenancePool.query('SELECT * FROM run_summaries')).rejects.toThrow(
      /permission denied/u,
    );
  });
});
