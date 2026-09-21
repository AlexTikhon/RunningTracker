import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

type ChildTable = 'run_points' | 'run_summaries';

interface DatabaseErrorShape {
  code: string;
  column?: string;
  constraint?: string;
}

interface AccessMatrixCase {
  canReadHistory: boolean;
  canReadLive: boolean;
  grant: 'both' | 'history-only' | 'live-only' | 'no-grant';
  status: 'finished' | 'paused' | 'recording';
}

const accessMatrix = (
  ['recording', 'paused', 'finished'] as const
).flatMap((status) =>
  [
    { canReadHistory: false, canReadLive: true, grant: 'live-only' as const, status },
    { canReadHistory: true, canReadLive: false, grant: 'history-only' as const, status },
    { canReadHistory: true, canReadLive: true, grant: 'both' as const, status },
    { canReadHistory: false, canReadLive: false, grant: 'no-grant' as const, status },
  ] satisfies AccessMatrixCase[],
);

const matrixOwnerId = '88888888-8888-4888-8888-888888888888';
const matrixRunId = 'd0000000-0000-4000-8000-000000000001';
const transactionRunId = 'e0000000-0000-4000-8000-000000000001';

async function expectDatabaseError(
  operation: Promise<unknown>,
  expected: DatabaseErrorShape,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error(`Expected PostgreSQL error ${expected.code}`);
}

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

  const canReadChild = (
    table: ChildTable,
    orgId: string,
    userId: string,
    runId: string,
    joinRuns: boolean,
  ) =>
    withTenantTransaction(runtimePool, { orgId, userId }, async (client) => {
      const result = await client.query<{ visible: boolean }>(
        joinRuns
          ? `SELECT EXISTS (
               SELECT 1
               FROM ${table} AS child
               JOIN runs AS parent
                 ON parent.org_id = child.org_id AND parent.id = child.run_id
               WHERE child.org_id = $1 AND child.run_id = $2
             ) AS visible`
          : `SELECT EXISTS (
               SELECT 1 FROM ${table}
               WHERE org_id = $1 AND run_id = $2
             ) AS visible`,
        [orgId, runId],
      );
      return result.rows[0]?.visible ?? false;
    });

  const withVerifiedOwnerTransaction = async (
    mutation: (client: PoolClient) => Promise<void>,
  ): Promise<void> => {
    const client = await ownerPool.connect();
    let releaseError: Error | undefined;

    try {
      const identity = await client.query<{ database_name: string; role_name: string }>(
        'SELECT current_database() AS database_name, current_user AS role_name',
      );
      expect(identity.rows[0]).toEqual({
        database_name: expectedOwner.database,
        role_name: expectedOwner.user,
      });

      await client.query('BEGIN');
      await mutation(client);
      await client.query('COMMIT');
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error('Owner fixture mutation failed');
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release(releaseError);
    }
  };

  const seedAccessMatrixCase = (matrixCase: AccessMatrixCase) =>
    withVerifiedOwnerTransaction(async (client) => {
      const finishedAt = matrixCase.status === 'finished' ? '2026-09-20T09:00:00.000Z' : null;

      await client.query(
        `INSERT INTO users (id, external_identity) VALUES ($1, 'fixture-matrix-owner')`,
        [matrixOwnerId],
      );
      await client.query(
        `INSERT INTO memberships (org_id, user_id, role, active)
         VALUES ($1, $2, 'runner', true)`,
        [ids.orgA, matrixOwnerId],
      );
      await client.query(
        `INSERT INTO runs (
           org_id, id, user_id, status, started_at, created_at, finished_at
         ) VALUES ($1, $2, $3, $4, $5, $5, $6)`,
        [
          ids.orgA,
          matrixRunId,
          matrixOwnerId,
          matrixCase.status,
          '2026-09-20T08:00:00.000Z',
          finishedAt,
        ],
      );
      if (matrixCase.grant !== 'no-grant') {
        await client.query(
          `INSERT INTO run_shares (
             org_id, run_id, grantee_user_id, can_read_live, can_read_history
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            ids.orgA,
            matrixRunId,
            ids.userDual,
            matrixCase.canReadLive,
            matrixCase.canReadHistory,
          ],
        );
      }
      await client.query(pointInsertSql, pointValues(ids.orgA, matrixRunId, { seq: '1' }));
      await client.query(
        `INSERT INTO run_summaries (
           org_id, run_id, source_revision, algorithm_version,
           distance_m, observed_duration_s, quality_stats
         ) VALUES ($1, $2, 1, 'matrix-v1', 1, 1, '{}'::jsonb)`,
        [ids.orgA, matrixRunId],
      );
    });

  it.each(accessMatrix)(
    'enforces $grant access for $status points and summaries in direct reads and joins',
    async (matrixCase) => {
      await seedAccessMatrixCase(matrixCase);

      const pointVisible =
        matrixCase.status === 'finished'
          ? matrixCase.canReadHistory
          : matrixCase.canReadLive;
      const summaryVisible = matrixCase.status === 'finished' && matrixCase.canReadHistory;

      for (const joinRuns of [false, true]) {
        await expect(
          canReadChild(
            'run_points',
            ids.orgA,
            ids.userDual,
            matrixRunId,
            joinRuns,
          ),
        ).resolves.toBe(pointVisible);
        await expect(
          canReadChild(
            'run_summaries',
            ids.orgA,
            ids.userDual,
            matrixRunId,
            joinRuns,
          ),
        ).resolves.toBe(summaryVisible);
      }
    },
  );

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

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', '', true)");
      await client.query("SELECT set_config('app.org_id', '', true)");
      const empty = await client.query<{ points: string; summaries: string }>(
        `SELECT
           (SELECT count(*)::text FROM run_points) AS points,
           (SELECT count(*)::text FROM run_summaries) AS summaries`,
      );
      expect(empty.rows[0]).toEqual({ points: '0', summaries: '0' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    for (const userId of [ids.userStranger, ids.userOrgB]) {
      await expect(
        canReadChild('run_points', ids.orgA, userId, ids.runRecording, false),
      ).resolves.toBe(false);
      await expect(
        canReadChild('run_summaries', ids.orgA, userId, ids.runRecording, false),
      ).resolves.toBe(false);
    }

    const switchedOrganization = await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgB, userId: ids.userDual },
      async (switchedClient) => {
        const result = await switchedClient.query<{ points: string; summaries: string }>(
          `SELECT
             (SELECT count(*)::text FROM run_points
              WHERE org_id = $1 AND run_id = $2) AS points,
             (SELECT count(*)::text FROM run_summaries
              WHERE org_id = $1 AND run_id = $2) AS summaries`,
          [ids.orgA, ids.runRecording],
        );
        return result.rows[0];
      },
    );
    expect(switchedOrganization).toEqual({ points: '0', summaries: '0' });
  });

  it('observes committed grant revocation on the next READ COMMITTED statement', async () => {
    const granteeClient = await runtimePool.connect();
    const readTarget = () =>
      granteeClient.query<{ points: string; summaries: string }>(
        `SELECT
           (SELECT count(*)::text FROM run_points
            WHERE org_id = $1 AND run_id = $2) AS points,
           (SELECT count(*)::text FROM run_summaries
            WHERE org_id = $1 AND run_id = $2) AS summaries`,
        [ids.orgA, ids.runFinishedHistory],
      );

    try {
      await granteeClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await granteeClient.query(
        `SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)`,
        [ids.userDual, ids.orgA],
      );

      const beforeRevocation = await readTarget();
      expect(beforeRevocation.rows[0]).toEqual({ points: '1', summaries: '1' });

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

      const afterRevocation = await readTarget();
      expect(afterRevocation.rows[0]).toEqual({ points: '0', summaries: '0' });
      await granteeClient.query('COMMIT');
    } catch (error) {
      await granteeClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      granteeClient.release();
    }

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

  it('allows owner child reads and inserts, then denies both after membership deactivation', async () => {
    await expect(
      canReadChild('run_points', ids.orgA, ids.userOrgA, ids.runRecording, false),
    ).resolves.toBe(true);
    await expect(
      canReadChild('run_summaries', ids.orgA, ids.userOrgA, ids.runRecording, false),
    ).resolves.toBe(true);

    await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userOrgA },
      (client) =>
        client.query(pointInsertSql, pointValues(ids.orgA, ids.runRecording, { seq: '2' })),
    );

    await ownerPool.query(
      'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
      [ids.orgA, ids.userOrgA],
    );

    await expect(
      canReadChild('run_points', ids.orgA, ids.userOrgA, ids.runRecording, false),
    ).resolves.toBe(false);
    await expect(
      canReadChild('run_summaries', ids.orgA, ids.userOrgA, ids.runRecording, false),
    ).resolves.toBe(false);
    await expectDatabaseError(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        (client) =>
          client.query(pointInsertSql, pointValues(ids.orgA, ids.runRecording, { seq: '3' })),
      ),
      { code: '42501' },
    );
  });

  it('supports run RETURNING followed by point RETURNING in the same tenant transaction', async () => {
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userStranger },
        async (client) => {
          const run = await client.query<{ id: string }>(
            `INSERT INTO runs (org_id, id, user_id, status)
             VALUES ($1, $2, $3, 'recording')
             RETURNING id`,
            [ids.orgA, transactionRunId, ids.userStranger],
          );
          const point = await client.query<{ seq: string }>(
            `${pointInsertSql} RETURNING seq`,
            pointValues(ids.orgA, transactionRunId, { seq: '9007199254740993' }),
          );
          return { pointSeq: point.rows[0]?.seq, runId: run.rows[0]?.id };
        },
      ),
    ).resolves.toEqual({
      pointSeq: '9007199254740993',
      runId: transactionRunId,
    });
  });

  it('rejects runtime ON CONFLICT DO UPDATE and preserves the original point', async () => {
    const before = await ownerPool.query<{ accuracy_m: number; ewkt: string }>(
      `SELECT accuracy_m, ST_AsEWKT(geom) AS ewkt
       FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      [ids.orgA, ids.runRecording],
    );

    await expectDatabaseError(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        (client) =>
          client.query(
            `${pointInsertSql}
             ON CONFLICT (org_id, run_id, seq)
             DO UPDATE SET accuracy_m = EXCLUDED.accuracy_m
             RETURNING accuracy_m`,
            pointValues(ids.orgA, ids.runRecording, { accuracyM: 99, seq: '1' }),
          ),
      ),
      { code: '42501' },
    );

    const after = await ownerPool.query<{ accuracy_m: number; ewkt: string }>(
      `SELECT accuracy_m, ST_AsEWKT(geom) AS ewkt
       FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      [ids.orgA, ids.runRecording],
    );
    expect(after.rows).toEqual(before.rows);
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
    await expectDatabaseError(
      ownerPool.query(
        pointInsertSql,
        pointValues(ids.orgB, ids.runRecording, { seq: '1001' }),
      ),
      { code: '23503', constraint: 'run_points_run_fk' },
    );

    const invalidPoints = [
      { constraint: 'run_points_seq_positive', overrides: { seq: '0' } },
      {
        constraint: 'run_points_segment_id_nonnegative',
        overrides: { segmentId: -1, seq: '1002' },
      },
      {
        constraint: 'run_points_longitude_in_range',
        overrides: { longitude: 181, seq: '1003' },
      },
      {
        constraint: 'run_points_latitude_in_range',
        overrides: { latitude: -91, seq: '1004' },
      },
      {
        constraint: 'run_points_accuracy_finite_nonnegative',
        overrides: { accuracyM: -1, seq: '1005' },
      },
      {
        constraint: 'run_points_ingested_revision_nonnegative',
        overrides: { ingestedRevision: '-1', seq: '1006' },
      },
    ] as const;

    for (const { constraint, overrides } of invalidPoints) {
      await expectDatabaseError(
        ownerPool.query(pointInsertSql, pointValues(ids.orgA, ids.runRecording, overrides)),
        { code: '23514', constraint },
      );
    }

    for (const [index, value] of ['NaN', 'Infinity', '-Infinity'].entries()) {
      await expectDatabaseError(
        ownerPool.query(
          pointInsertSql,
          pointValues(ids.orgA, ids.runRecording, {
            accuracyM: value,
            seq: `${1100 + index}`,
          }),
        ),
        { code: '23514', constraint: 'run_points_accuracy_finite_nonnegative' },
      );
    }

    for (const [coordinateIndex, [coordinate, constraint]] of [
      ['longitude', 'run_points_longitude_in_range'],
      ['latitude', 'run_points_latitude_in_range'],
    ].entries() as IterableIterator<
      [number, readonly ['longitude' | 'latitude', string]]
    >) {
      for (const [valueIndex, value] of ['NaN', 'Infinity', '-Infinity'].entries()) {
        await expectDatabaseError(
          ownerPool.query(
            pointInsertSql,
            pointValues(ids.orgA, ids.runRecording, {
              [coordinate]: value,
              seq: `${1200 + coordinateIndex * 10 + valueIndex}`,
            }),
          ),
          { code: '23514', constraint },
        );
      }
    }

    for (const [valueIndex, constraint] of [
      [4, 'run_points_recorded_at_finite'],
      [5, 'run_points_received_at_finite'],
    ] as const) {
      const values = pointValues(ids.orgA, ids.runRecording);
      values[2] = `${1300 + valueIndex}`;
      values[valueIndex] = 'infinity';
      await expectDatabaseError(ownerPool.query(pointInsertSql, values), {
        code: '23514',
        constraint,
      });
    }

    await expectDatabaseError(
      ownerPool.query(
        pointInsertSql,
        pointValues(ids.orgA, ids.runRecording, { segmentId: 2_147_483_648, seq: '1400' }),
      ),
      { code: '22003' },
    );

    await expectDatabaseError(
      ownerPool.query(
        pointInsertSql.replace(
          'ST_SetSRID(ST_MakePoint($7, $8), 4326)',
          'ST_GeomFromText($7, $8)',
        ),
        [
          ...pointValues(ids.orgA, ids.runRecording, { seq: '1401' }).slice(0, 6),
          'POINT EMPTY',
          4326,
          4.5,
          '2',
        ],
      ),
      { code: '23514', constraint: 'run_points_geom_not_empty' },
    );
    await expect(
      ownerPool.query(
        pointInsertSql.replace(
          'ST_SetSRID(ST_MakePoint($7, $8), 4326)',
          'ST_SetSRID(ST_MakePoint($7, $8), 3857)',
        ),
        pointValues(ids.orgA, ids.runRecording, { seq: '1402' }),
      ),
    ).rejects.toThrow(/SRID/u);
    await expect(
      ownerPool.query(
        pointInsertSql.replace(
          'ST_SetSRID(ST_MakePoint($7, $8), 4326)',
          'ST_GeomFromText($7, $8)',
        ),
        [
          ...pointValues(ids.orgA, ids.runRecording, { seq: '1403' }).slice(0, 6),
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
    await expectDatabaseError(
      ownerPool.query(
        pointInsertSql,
        pointValues(ids.orgA, ids.runRecording, { accuracyM: 99, seq: '1' }),
      ),
      { code: '23505', constraint: 'run_points_pkey' },
    );
    const after = await ownerPool.query<{ accuracy_m: number; ewkt: string }>(
      `SELECT accuracy_m, ST_AsEWKT(geom) AS ewkt
       FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND seq = 1`,
      [ids.orgA, ids.runRecording],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('enforces summary tenant, revision, version, metric, and timestamp constraints', async () => {
    await expectDatabaseError(
      ownerPool.query(
        `UPDATE run_summaries SET org_id = $1
         WHERE org_id = $2 AND run_id = $3`,
        [ids.orgB, ids.orgA, ids.runRecording],
      ),
      { code: '23503', constraint: 'run_summaries_run_fk' },
    );

    for (const [column, value, constraint] of [
      ['source_revision', '-1', 'run_summaries_source_revision_nonnegative'],
      ['algorithm_version', ' ', 'run_summaries_algorithm_version_valid'],
      ['algorithm_version', 'é'.repeat(65), 'run_summaries_algorithm_version_valid'],
      ['distance_m', -1, 'run_summaries_distance_finite_nonnegative'],
      ['observed_duration_s', -1, 'run_summaries_duration_finite_nonnegative'],
    ] as const) {
      await expectDatabaseError(
        ownerPool.query(
          `UPDATE run_summaries SET ${column} = $1
           WHERE org_id = $2 AND run_id = $3`,
          [value, ids.orgA, ids.runRecording],
        ),
        { code: '23514', constraint },
      );
    }

    for (const [column, value, constraint] of [
      ['distance_m', 'NaN', 'run_summaries_distance_finite_nonnegative'],
      ['distance_m', 'Infinity', 'run_summaries_distance_finite_nonnegative'],
      ['distance_m', '-Infinity', 'run_summaries_distance_finite_nonnegative'],
      ['observed_duration_s', 'NaN', 'run_summaries_duration_finite_nonnegative'],
      ['observed_duration_s', 'Infinity', 'run_summaries_duration_finite_nonnegative'],
      ['observed_duration_s', '-Infinity', 'run_summaries_duration_finite_nonnegative'],
    ] as const) {
      await expectDatabaseError(
        ownerPool.query(
          `UPDATE run_summaries SET ${column} = $1::double precision
           WHERE org_id = $2 AND run_id = $3`,
          [value, ids.orgA, ids.runRecording],
        ),
        { code: '23514', constraint },
      );
    }

    await expectDatabaseError(
      ownerPool.query(
        `UPDATE run_summaries SET computed_at = 'infinity'
         WHERE org_id = $1 AND run_id = $2`,
        [ids.orgA, ids.runRecording],
      ),
      { code: '23514', constraint: 'run_summaries_computed_at_finite' },
    );
  });

  it('distinguishes SQL NULL from JSON null and rejects non-object quality_stats', async () => {
    const validQualityStats = {
      acceptedEdgeCount: 1,
      acceptedPointCount: 2,
      excessiveSpeedCount: 0,
      excessiveTimeGapCount: 0,
      insufficientData: false,
      nonpositiveTimeDeltaCount: 0,
      poorAccuracyPointCount: 0,
      rawPointCount: 2,
      segmentBreakCount: 0,
      seqGapCount: 0,
    };
    await ownerPool.query(
      `UPDATE run_summaries SET quality_stats = $1::jsonb
       WHERE org_id = $2 AND run_id = $3`,
      [JSON.stringify(validQualityStats), ids.orgA, ids.runRecording],
    );
    const stored = await ownerPool.query<{ quality_stats: unknown }>(
      `SELECT quality_stats FROM run_summaries WHERE org_id = $1 AND run_id = $2`,
      [ids.orgA, ids.runRecording],
    );
    expect(stored.rows[0]?.quality_stats).toEqual(validQualityStats);

    for (const value of [[], 'scalar', 42, true, null]) {
      await expectDatabaseError(
        ownerPool.query(
          `UPDATE run_summaries SET quality_stats = $1::jsonb
           WHERE org_id = $2 AND run_id = $3`,
          [JSON.stringify(value), ids.orgA, ids.runRecording],
        ),
        { code: '23514', constraint: 'run_summaries_quality_stats_object' },
      );
    }

    await expectDatabaseError(
      ownerPool.query(
        `UPDATE run_summaries SET quality_stats = $1
         WHERE org_id = $2 AND run_id = $3`,
        [null, ids.orgA, ids.runRecording],
      ),
      { code: '23502', column: 'quality_stats' },
    );
  });

  it('validates every display_geom coordinate and preserves valid global routes and NULL', async () => {
    const updateGeometry = (expression: string) =>
      ownerPool.query(
        `UPDATE run_summaries SET display_geom = ${expression}
         WHERE org_id = $1 AND run_id = $2`,
        [ids.orgA, ids.runRecording],
      );

    for (const wkt of [
      'MULTILINESTRING((NaN 52, 21 52, 22 53))',
      'MULTILINESTRING((21 52, NaN 52, 22 53))',
      'MULTILINESTRING((21 52, 22 53, NaN 52))',
      'MULTILINESTRING((21 52, 22 53),(30 40, NaN 41, 31 42))',
      'MULTILINESTRING((181 52, 22 53))',
      'MULTILINESTRING((21 -91, 22 53))',
    ]) {
      await expectDatabaseError(
        updateGeometry(`ST_GeomFromText('${wkt}', 4326)`),
        { code: '23514', constraint: 'run_summaries_display_geom_coordinates_valid' },
      );
    }

    for (const wkt of [
      'MULTILINESTRING((21 52, Infinity 52))',
      'MULTILINESTRING((21 52, -Infinity 52))',
    ]) {
      await expectDatabaseError(updateGeometry(`ST_GeomFromText('${wkt}', 4326)`), {
        code: 'XX000',
      });
    }

    await expectDatabaseError(
      updateGeometry("ST_GeomFromText('MULTILINESTRING EMPTY', 4326)"),
      { code: '23514', constraint: 'run_summaries_display_geom_coordinates_valid' },
    );
    await expectDatabaseError(
      updateGeometry(
        "ST_GeomFromText('MULTILINESTRING((21 52, 22 53))', 3857)",
      ),
      { code: '22023' },
    );
    await expectDatabaseError(
      updateGeometry("ST_GeomFromText('POINT(21 52)', 4326)"),
      { code: '22023' },
    );

    await expect(
      updateGeometry(
        "ST_GeomFromText('MULTILINESTRING((179.5 10, -179.5 10.5),(-75 -45, 75 45))', 4326)",
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(updateGeometry('NULL')).resolves.toMatchObject({ rowCount: 1 });
    const nullable = await ownerPool.query<{ display_geom: unknown }>(
      `SELECT display_geom FROM run_summaries WHERE org_id = $1 AND run_id = $2`,
      [ids.orgA, ids.runRecording],
    );
    expect(nullable.rows[0]?.display_geom).toBeNull();
  });

  it('keeps bigint/timestamp representations and the intended indexes explicit', async () => {
    const largeBigint = '9007199254740993';
    const precisePointValues = pointValues(ids.orgA, ids.runRecording, {
      ingestedRevision: largeBigint,
      latitude: 52.9876543210987,
      longitude: 21.1234567890123,
      segmentId: 2_147_483_647,
      seq: largeBigint,
    });
    precisePointValues[4] = '2026-09-20T08:15:02.1236Z';
    precisePointValues[5] = '2026-09-20T08:15:03.4564Z';
    await ownerPool.query(pointInsertSql, precisePointValues);
    await ownerPool.query(
      `UPDATE run_summaries
       SET source_revision = $1, computed_at = $2
       WHERE org_id = $3 AND run_id = $4`,
      [largeBigint, '2026-09-20T09:15:00.7896Z', ids.orgA, ids.runRecording],
    );

    const pointRoundTrip = await ownerPool.query<{
      coordinate_type: string;
      ingested_revision: string;
      latitude: number;
      longitude: number;
      received_at: Date;
      recorded_at: Date;
      segment_id: number;
      seq: string;
    }>(
      `SELECT seq,
              segment_id,
              recorded_at,
              received_at,
              ST_X(geom) AS longitude,
              ST_Y(geom) AS latitude,
              pg_typeof(ST_X(geom))::text AS coordinate_type,
              ingested_revision
       FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND seq = $3`,
      [ids.orgA, ids.runRecording, largeBigint],
    );
    expect(pointRoundTrip.rows[0]).toEqual({
      coordinate_type: 'double precision',
      ingested_revision: largeBigint,
      latitude: 52.9876543210987,
      longitude: 21.1234567890123,
      received_at: new Date('2026-09-20T08:15:03.456Z'),
      recorded_at: new Date('2026-09-20T08:15:02.124Z'),
      segment_id: 2_147_483_647,
      seq: largeBigint,
    });

    const summaryRoundTrip = await ownerPool.query<{
      computed_at: Date;
      source_revision: string;
    }>(
      `SELECT source_revision, computed_at
       FROM run_summaries
       WHERE org_id = $1 AND run_id = $2`,
      [ids.orgA, ids.runRecording],
    );
    expect(summaryRoundTrip.rows[0]).toEqual({
      computed_at: new Date('2026-09-20T09:15:00.790Z'),
      source_revision: largeBigint,
    });

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

  it('cascades point and summary deletion from an owner-created parent run', async () => {
    const cascadeRunId = 'f0000000-0000-4000-8000-000000000001';
    await withVerifiedOwnerTransaction(async (client) => {
      await client.query(
        `INSERT INTO runs (
           org_id, id, user_id, status, started_at, created_at, finished_at
         ) VALUES ($1, $2, $3, 'finished', $4, $4, $5)`,
        [
          ids.orgA,
          cascadeRunId,
          ids.userStranger,
          '2026-09-20T08:00:00.000Z',
          '2026-09-20T09:00:00.000Z',
        ],
      );
      await client.query(pointInsertSql, pointValues(ids.orgA, cascadeRunId, { seq: '1' }));
      await client.query(
        `INSERT INTO run_summaries (
           org_id, run_id, source_revision, algorithm_version,
           distance_m, observed_duration_s, quality_stats
         ) VALUES ($1, $2, 1, 'cascade-v1', 1, 1, '{}'::jsonb)`,
        [ids.orgA, cascadeRunId],
      );
    });

    await ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      cascadeRunId,
    ]);
    const remaining = await ownerPool.query<{ points: string; summaries: string }>(
      `SELECT
         (SELECT count(*)::text FROM run_points
          WHERE org_id = $1 AND run_id = $2) AS points,
         (SELECT count(*)::text FROM run_summaries
          WHERE org_id = $1 AND run_id = $2) AS summaries`,
      [ids.orgA, cascadeRunId],
    );
    expect(remaining.rows[0]).toEqual({ points: '0', summaries: '0' });
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

  it('keeps coordinate validation immutable, invoker-owned, and unexecutable by runtime roles', async () => {
    const result = await ownerPool.query<{
      maintenance_execute: boolean;
      owner: string;
      proconfig: string[];
      proisstrict: boolean;
      proparallel: string;
      prosecdef: boolean;
      provolatile: string;
      runtime_execute: boolean;
    }>(
      `SELECT pg_get_userbyid(procedure.proowner) AS owner,
              procedure.prosecdef,
              procedure.provolatile,
              procedure.proparallel,
              procedure.proisstrict,
              procedure.proconfig,
              has_function_privilege(
                'running_tracker_runtime',
                'app_private.display_geom_coordinates_valid(geometry)',
                'EXECUTE'
              ) AS runtime_execute,
              has_function_privilege(
                'running_tracker_maintenance',
                'app_private.display_geom_coordinates_valid(geometry)',
                'EXECUTE'
              ) AS maintenance_execute
       FROM pg_proc AS procedure
       WHERE procedure.oid =
         'app_private.display_geom_coordinates_valid(geometry)'::regprocedure`,
    );
    expect(result.rows[0]).toEqual({
      maintenance_execute: false,
      owner: 'running_tracker_owner',
      proconfig: ['search_path=pg_catalog'],
      proisstrict: true,
      proparallel: 's',
      prosecdef: false,
      provolatile: 'i',
      runtime_execute: false,
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
