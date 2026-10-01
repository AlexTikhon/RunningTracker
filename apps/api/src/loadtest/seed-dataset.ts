import type { Pool, PoolClient } from 'pg';

import {
  expectedTotals,
  ingestionBatchSize,
  metersPerDegree,
  planDataset,
  pointIntervalMs,
  type DatasetPlan,
  type DatasetProfile,
  type ExpectedTotals,
} from './dataset-plan.js';

/** The command-line tool only ever seeds databases with this suffix. */
export const loadDatabaseSuffix = '_load_test';

const seededTables = [
  'access_restriction_journal',
  'run_deletion_journal',
  'run_shares',
  'run_summaries',
  'run_points',
  'run_commands',
  'run_tombstones',
  'runs',
  'memberships',
  'organizations',
  'users',
] as const;

export interface SeedOptions {
  asOf: Date;
  /** Database-name suffixes this call may write to; the CLI passes only `_load_test`. */
  allowedDatabaseSuffixes: readonly string[];
  log?: (line: string) => void;
  profile: DatasetProfile;
  /** Refuse to run when the database already holds any user, organization, or run. */
  requireEmptyDatabase: boolean;
  /** Truncate every dataset table first. Only honoured on a `_load_test` database. */
  reset?: boolean;
  seed: number;
}

export interface RelationSizes {
  runPointsBytes: number;
  runSharesBytes: number;
  runSummariesBytes: number;
  runsBytes: number;
}

export interface DatasetManifest {
  asOf: string;
  counts: {
    rawPoints: number;
    rawRuns: number;
    runShares: number;
    runs: number;
    summaries: number;
    users: number;
  };
  database: string;
  digest: string;
  organizationId: string;
  profile: string;
  relationSizes: RelationSizes;
  seed: number;
  timingsMs: Record<string, number>;
  users: { id: string; index: number; role: 'coach' | 'runner' }[];
}

interface CountRow {
  count: string;
}

function toCount(row: CountRow | undefined): number {
  return Number(row?.count ?? '0');
}

const insertPointsForRun = `
WITH run AS (
  SELECT * FROM seed_runs WHERE id = $1::uuid
), point AS (
  SELECT run.id, run.started_at, run.point_count, run.phase, run.laps, run.radius_m,
    run.center_lon, run.center_lat, gs.seq,
    md5(format('%s:%s:%s', $2::text, run.run_index, gs.seq)) AS digest
  FROM run
  CROSS JOIN LATERAL generate_series(1, run.point_count) AS gs(seq)
), noise AS (
  SELECT point.*,
    (('x' || substr(digest, 1, 8))::bit(32)::bigint)::float8 / 4294967296.0::float8 AS n1,
    (('x' || substr(digest, 9, 8))::bit(32)::bigint)::float8 / 4294967296.0::float8 AS n2,
    (('x' || substr(digest, 17, 8))::bit(32)::bigint)::float8 / 4294967296.0::float8 AS n3,
    (('x' || substr(digest, 25, 8))::bit(32)::bigint)::float8 / 4294967296.0::float8 AS n4
  FROM point
), located AS (
  SELECT noise.*,
    noise.phase + 2.0 * pi() * noise.laps
      * ((noise.seq - 1)::float8 / greatest(noise.point_count - 1, 1)::float8) AS angle
  FROM noise
), positioned AS (
  SELECT located.*,
    located.center_lat + (located.radius_m * sin(located.angle) + (located.n1 - 0.5) * 6.0) / $3::float8 AS lat,
    located.center_lon + (located.radius_m * cos(located.angle) + (located.n2 - 0.5) * 6.0)
      / ($3::float8 * cos(radians(located.center_lat))) AS lon_unwrapped
  FROM located
)
INSERT INTO run_points (
  org_id, run_id, seq, segment_id, recorded_at, received_at, geom, accuracy_m, ingested_revision
)
SELECT $4::uuid, positioned.id, positioned.seq, 0,
  positioned.started_at
    + ((positioned.seq - 1) * $5::int + floor(positioned.n4 * 400.0)::int) * interval '1 millisecond',
  positioned.started_at
    + ((positioned.seq - 1) * $5::int + floor(positioned.n4 * 400.0)::int + 500
      + floor(positioned.n3 * 1000.0)::int) * interval '1 millisecond',
  ST_SetSRID(
    ST_MakePoint(
      positioned.lon_unwrapped - 360.0 * floor((positioned.lon_unwrapped + 180.0) / 360.0),
      positioned.lat
    ),
    4326
  ),
  3.0 + 12.0 * positioned.n3 * positioned.n3,
  ceil(positioned.seq::float8 / $6::float8)::bigint
FROM positioned
ORDER BY positioned.seq
`;

const insertSummaries = `
WITH vertex AS (
  SELECT r.id, k.k,
    r.center_lat + (r.radius_m * sin(r.phase + 2.0 * pi() * r.laps * (k.k::float8 / (r.vertex_count - 1)::float8)))
      / $1::float8 AS lat,
    r.center_lon + (r.radius_m * cos(r.phase + 2.0 * pi() * r.laps * (k.k::float8 / (r.vertex_count - 1)::float8)))
      / ($1::float8 * cos(radians(r.center_lat))) AS lon_unwrapped
  FROM seed_runs r
  CROSS JOIN LATERAL generate_series(0, r.vertex_count - 1) AS k(k)
), located AS (
  SELECT vertex.*, floor((vertex.lon_unwrapped + 180.0) / 360.0) AS world FROM vertex
), stepped AS (
  SELECT located.*,
    lag(located.world) OVER (PARTITION BY located.id ORDER BY located.k) AS previous_world
  FROM located
), parted AS (
  SELECT stepped.*,
    sum(CASE WHEN stepped.world IS DISTINCT FROM stepped.previous_world THEN 1 ELSE 0 END)
      OVER (PARTITION BY stepped.id ORDER BY stepped.k) AS part
  FROM stepped
), lines AS (
  SELECT parted.id, parted.part,
    ST_MakeLine(
      ST_SetSRID(ST_MakePoint(parted.lon_unwrapped - 360.0 * parted.world, parted.lat), 4326)
      ORDER BY parted.k
    ) AS geom
  FROM parted
  GROUP BY parted.id, parted.part
  HAVING count(*) >= 2
), display AS (
  SELECT lines.id, ST_Multi(ST_Collect(lines.geom ORDER BY lines.part)) AS geom
  FROM lines
  GROUP BY lines.id
)
INSERT INTO run_summaries (
  org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s,
  quality_stats, computed_at
)
SELECT $2::uuid, r.id, r.data_revision, app_private.current_track_algorithm_version(), display.geom,
  r.distance_m, r.duration_s,
  jsonb_build_object(
    'rawPointCount', r.point_count,
    'acceptedPointCount', r.point_count - r.poor_accuracy_points - r.excessive_speed_count,
    'acceptedEdgeCount', r.point_count - r.poor_accuracy_points - r.excessive_speed_count - 1,
    'poorAccuracyPointCount', r.poor_accuracy_points,
    'seqGapCount', 0,
    'segmentBreakCount', 0,
    'nonpositiveTimeDeltaCount', 0,
    'excessiveTimeGapCount', 0,
    'excessiveSpeedCount', r.excessive_speed_count,
    'insufficientData', false
  ),
  r.finished_at + interval '60 seconds'
FROM seed_runs r
LEFT JOIN display ON display.id = r.id
ORDER BY r.run_index
`;

const digestQuery = `
SELECT md5(concat_ws('|',
  (SELECT md5(string_agg(format('%s,%s,%s,%s,%s,%s', id, user_id, started_at, finished_at, data_revision, raw_state),
      ';' ORDER BY id))
   FROM runs WHERE org_id = $1::uuid),
  (SELECT md5(string_agg(per_run.hash, ';' ORDER BY per_run.run_id))
   FROM (
     SELECT run_id, md5(string_agg(
       format('%s,%s,%s,%s,%s', seq, recorded_at, encode(ST_AsBinary(geom), 'hex'), accuracy_m, ingested_revision),
       ';' ORDER BY seq)) AS hash
     FROM run_points WHERE org_id = $1::uuid GROUP BY run_id
   ) AS per_run),
  (SELECT md5(string_agg(format('%s,%s,%s,%s,%s,%s', run_id, source_revision,
        encode(ST_AsBinary(display_geom), 'hex'), distance_m, observed_duration_s, quality_stats::text),
      ';' ORDER BY run_id))
   FROM run_summaries WHERE org_id = $1::uuid),
  (SELECT md5(string_agg(format('%s,%s,%s,%s', run_id, grantee_user_id, can_read_history, can_read_live),
      ';' ORDER BY run_id, grantee_user_id))
   FROM run_shares WHERE org_id = $1::uuid)
)) AS digest
`;

async function timed<T>(
  timings: Record<string, number>,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
}

async function assertTarget(client: PoolClient, options: SeedOptions): Promise<string> {
  const identity = await client.query<{ database_name: string; role_name: string }>(
    'SELECT current_database() AS database_name, current_user AS role_name',
  );
  const database = identity.rows[0]?.database_name ?? '';
  if (identity.rows[0]?.role_name !== 'running_tracker_owner') {
    throw new Error('Dataset seeding requires the running_tracker_owner role');
  }
  if (!options.allowedDatabaseSuffixes.some((suffix) => database.endsWith(suffix))) {
    throw new Error(
      `Refusing to seed database ${database}; allowed suffixes: ${options.allowedDatabaseSuffixes.join(', ')}`,
    );
  }
  return database;
}

/**
 * Writes one deterministic organization as the object owner (RLS does not apply to the owner), in a single
 * transaction: a failure leaves no partial dataset. Runs are finished and, older than the raw window, purged
 * with only their summary. Raw points are generated set-wise in the database so a 3,000,000-point stress
 * load needs no client-side row stream.
 */
export async function seedDataset(
  pool: Pick<Pool, 'connect'>,
  options: SeedOptions,
): Promise<DatasetManifest> {
  const log = options.log ?? (() => undefined);
  const plan: DatasetPlan = planDataset(options.profile, options.seed, options.asOf);
  const expected: ExpectedTotals = expectedTotals(options.profile, options.seed);
  const timings: Record<string, number> = {};
  const client = await pool.connect();

  try {
    const database = await assertTarget(client, options);
    await client.query("SET TIME ZONE 'UTC'");

    if (options.reset) {
      if (!database.endsWith(loadDatabaseSuffix)) {
        throw new Error(`--reset is only allowed on a database ending in ${loadDatabaseSuffix}`);
      }
      await client.query(`TRUNCATE ${seededTables.join(', ')} RESTART IDENTITY`);
      log(`reset: truncated ${seededTables.length} tables`);
    }
    if (options.requireEmptyDatabase) {
      const existing = await client.query<CountRow>(
        `SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM organizations)
           + (SELECT count(*) FROM runs) AS count`,
      );
      if (toCount(existing.rows[0]) > 0) {
        throw new Error('Database is not empty; pass --reset on a _load_test database to replace its data');
      }
    }

    const organizationId = plan.organizationId;
    await client.query('BEGIN');
    try {
      await timed(timings, 'identity', async () => {
        await client.query(
          'INSERT INTO users (id, external_identity) SELECT * FROM unnest($1::uuid[], $2::text[])',
          [plan.users.map((user) => user.id), plan.users.map((user) => user.externalIdentity)],
        );
        await client.query('INSERT INTO organizations (id) VALUES ($1)', [organizationId]);
        await client.query(
          'INSERT INTO memberships (org_id, user_id, role) SELECT $1, * FROM unnest($2::uuid[], $3::text[])',
          [organizationId, plan.users.map((user) => user.id), plan.users.map((user) => user.role)],
        );
      });

      await client.query(`
        CREATE TEMP TABLE seed_runs (
          run_index integer PRIMARY KEY, id uuid NOT NULL, user_id uuid NOT NULL,
          started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL, point_count integer NOT NULL,
          has_raw boolean NOT NULL, data_revision bigint NOT NULL, center_lon float8 NOT NULL,
          center_lat float8 NOT NULL, radius_m float8 NOT NULL, laps float8 NOT NULL, phase float8 NOT NULL,
          distance_m float8 NOT NULL, duration_s float8 NOT NULL, vertex_count integer NOT NULL,
          poor_accuracy_points integer NOT NULL, excessive_speed_count integer NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(
        `INSERT INTO seed_runs
         SELECT r.run_index, r.id, r.user_id, r.started_at, r.finished_at, r.point_count, r.has_raw,
           r.data_revision, r.center_lon, r.center_lat, r.radius_m, r.laps, r.phase, r.distance_m,
           r.duration_s, r.vertex_count, r.poor_accuracy_points, r.excessive_speed_count
         FROM jsonb_to_recordset($1::jsonb) AS r(
           run_index integer, id uuid, user_id uuid, started_at timestamptz, finished_at timestamptz,
           point_count integer, has_raw boolean, data_revision bigint, center_lon float8, center_lat float8,
           radius_m float8, laps float8, phase float8, distance_m float8, duration_s float8,
           vertex_count integer, poor_accuracy_points integer, excessive_speed_count integer)`,
        [
          JSON.stringify(
            plan.runs.map((run) => ({
              center_lat: run.centerLatitude,
              center_lon: run.centerLongitude,
              data_revision: run.dataRevision,
              distance_m: run.distanceM,
              duration_s: run.durationS,
              excessive_speed_count: run.excessiveSpeedCount,
              finished_at: run.finishedAt,
              has_raw: run.hasRaw,
              id: run.id,
              laps: run.laps,
              phase: run.phase,
              point_count: run.pointCount,
              poor_accuracy_points: run.poorAccuracyPointCount,
              radius_m: run.radiusM,
              run_index: run.index,
              started_at: run.startedAt,
              user_id: plan.users[run.userIndex]?.id,
              vertex_count: run.vertexCount,
            })),
          ),
        ],
      );

      await timed(timings, 'runs', async () => {
        await client.query(
          `INSERT INTO runs (
             org_id, id, user_id, status, started_at, created_at, finished_at, data_revision,
             control_revision, raw_state
           )
           SELECT $1, id, user_id, 'finished', started_at, started_at, finished_at, data_revision, 1,
             CASE WHEN has_raw THEN 'available' ELSE 'purged' END
           FROM seed_runs ORDER BY run_index`,
          [organizationId],
        );
      });

      const rawRuns = plan.runs.filter((run) => run.hasRaw);
      await timed(timings, 'points', async () => {
        for (const [position, run] of rawRuns.entries()) {
          await client.query(insertPointsForRun, [
            run.id,
            String(plan.seed),
            metersPerDegree,
            organizationId,
            pointIntervalMs,
            ingestionBatchSize,
          ]);
          if ((position + 1) % 10 === 0 || position + 1 === rawRuns.length) {
            log(`points: ${position + 1}/${rawRuns.length} raw runs`);
          }
        }
      });

      await timed(timings, 'summaries', async () => {
        await client.query(insertSummaries, [metersPerDegree, organizationId]);
      });

      await timed(timings, 'shares', async () => {
        await client.query(
          `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_history, can_read_live)
           SELECT $1, r.id, g.grantee_user_id, g.can_read_history, g.can_read_live
           FROM seed_runs r
           JOIN unnest($2::uuid[], $3::uuid[], $4::boolean[], $5::boolean[])
             AS g(owner_user_id, grantee_user_id, can_read_history, can_read_live)
             ON g.owner_user_id = r.user_id`,
          [
            organizationId,
            plan.shares.map((share) => plan.users[share.ownerIndex]?.id),
            plan.shares.map((share) => plan.users[share.granteeIndex]?.id),
            plan.shares.map((share) => share.canReadHistory),
            plan.shares.map((share) => share.canReadLive),
          ],
        );
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    await timed(timings, 'analyze', async () => {
      await client.query('ANALYZE users, organizations, memberships, runs, run_points, run_summaries, run_shares');
    });

    const counts = await client.query<{
      raw_points: string;
      raw_runs: string;
      run_shares: string;
      runs: string;
      summaries: string;
      users: string;
    }>(
      `SELECT
         (SELECT count(*) FROM memberships WHERE org_id = $1) AS users,
         (SELECT count(*) FROM runs WHERE org_id = $1) AS runs,
         (SELECT count(*) FROM runs WHERE org_id = $1 AND raw_state = 'available') AS raw_runs,
         (SELECT count(*) FROM run_points WHERE org_id = $1) AS raw_points,
         (SELECT count(*) FROM run_summaries WHERE org_id = $1) AS summaries,
         (SELECT count(*) FROM run_shares WHERE org_id = $1) AS run_shares`,
      [organizationId],
    );
    const row = counts.rows[0];
    const actual = {
      rawPoints: Number(row?.raw_points),
      rawRuns: Number(row?.raw_runs),
      runShares: Number(row?.run_shares),
      runs: Number(row?.runs),
      summaries: Number(row?.summaries),
      users: Number(row?.users),
    };
    for (const [name, value] of Object.entries(actual)) {
      if (value !== expected[name as keyof ExpectedTotals]) {
        throw new Error(
          `Seeded ${name} ${value} differs from the planned ${expected[name as keyof ExpectedTotals]}`,
        );
      }
    }

    const digest = await timed(timings, 'digest', async () => {
      const result = await client.query<{ digest: string }>(digestQuery, [organizationId]);
      return result.rows[0]?.digest ?? '';
    });
    const sizes = await client.query<Record<string, string>>(
      `SELECT pg_total_relation_size('runs') AS runs, pg_total_relation_size('run_points') AS run_points,
              pg_total_relation_size('run_summaries') AS run_summaries,
              pg_total_relation_size('run_shares') AS run_shares`,
    );

    return {
      asOf: plan.asOf,
      counts: actual,
      database,
      digest,
      organizationId,
      profile: plan.profile.name,
      relationSizes: {
        runPointsBytes: Number(sizes.rows[0]?.run_points),
        runSharesBytes: Number(sizes.rows[0]?.run_shares),
        runSummariesBytes: Number(sizes.rows[0]?.run_summaries),
        runsBytes: Number(sizes.rows[0]?.runs),
      },
      seed: plan.seed,
      timingsMs: timings,
      users: plan.users.map((user) => ({ id: user.id, index: user.index, role: user.role })),
    };
  } finally {
    client.release();
  }
}
