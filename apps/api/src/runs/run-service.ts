import {
  ingestPointsResponseSchema,
  liveTrackResponseSchema,
  pointsResponseSchema,
  revisionSchema,
  runListResponseSchema,
  runCommandResponseSchema,
  runShareResponseSchema,
  runViewSchema,
  timestampSchema,
  uuidSchema,
  seqSchema,
  type CreateRunRequest,
  type IngestPointsRequest,
  type IngestPointsResponse,
  type LiveTrackChangesQuery,
  type LiveTrackQuery,
  type LiveTrackResponse,
  type PointInput,
  type PointsQuery,
  type PointsResponse,
  type RunListQuery,
  type RunListResponse,
  type RunCommandRequest,
  type RunCommandResponse,
  type RunCommandType,
  type RunShareResponse,
  type RunStatus,
  type UpsertRunShareRequest,
  type RunView,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { StoredSession } from '../auth/session-store.js';
import { lockArchiveRevisionForAclChange } from '../archive/archive-service.js';
import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import {
  InvalidLiveTrackCursorError,
  type LiveTrackChangesCursor,
  type LiveTrackCursorCodec,
  type LiveTrackSnapshotCursor,
} from './live-track-cursor.js';

interface RunRow {
  control_revision: string;
  data_revision: string;
  finished_at: Date | null;
  raw_state: 'available' | 'purging' | 'purged';
  run_id: string;
  started_at: string;
  status: RunStatus;
  summary_algorithm_version: string | null;
  summary_distance_m: number | null;
  summary_observed_duration_s: number | null;
  summary_quality_stats: unknown;
  summary_source_revision: string | null;
}

interface OwnedRunRow extends RunRow {
  creation_payload_matches: boolean;
}

interface LockedRunRow {
  control_revision: string;
  data_revision: string;
  finished_at: Date | null;
  status: RunStatus;
}

interface LockedIngestionRunRow {
  data_revision: string;
  finished_at: Date | null;
  raw_state: 'available' | 'purging' | 'purged';
}

interface StoredPointRow {
  accuracy_m: number;
  latitude: number;
  longitude: number;
  recorded_at: string;
  segment_id: number;
  seq: string;
}

interface RawPointCursor {
  dataRevision: string;
  lastSeq: string;
  orgId: string;
  runId: string;
}

interface RawPointPageRow {
  accuracy_m: number | null;
  data_revision: string;
  latitude: number | null;
  longitude: number | null;
  raw_state: 'available' | 'purging' | 'purged';
  recorded_at: string | null;
  segment_id: number | null;
  seq: string | null;
}

interface LiveTrackSnapshotPageRow {
  accuracy_m: number | null;
  algorithm_version: string;
  connect_from_previous: boolean | null;
  current_revision: string;
  latitude: number | null;
  longitude: number | null;
  predecessor_seq: string | null;
  raw_state: 'available' | 'purging' | 'purged';
  recorded_at: string | null;
  segment_id: number | null;
  seq: string | null;
}

type LiveTrackChangesPageRow = LiveTrackSnapshotPageRow;

interface StoredCommandRow {
  payload_matches: boolean;
  response: unknown;
}

interface PostgresErrorLike {
  code?: unknown;
  constraint?: unknown;
}

const runListCursorSchema = z.strictObject({
  runId: uuidSchema,
  startedAt: timestampSchema,
});

const rawPointCursorSchema = z.strictObject({
  dataRevision: revisionSchema,
  lastSeq: seqSchema,
  orgId: uuidSchema,
  runId: uuidSchema,
});

export const POINTS_PER_RUN_MAX = 50_000;
const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1_000;

type RunListCursor = z.infer<typeof runListCursorSchema>;

export interface CreateRunResult {
  created: boolean;
  run: RunView;
}

const runViewProjection = `
         run.id AS run_id,
         run.status,
         to_char(
           run.started_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS started_at,
         run.finished_at,
         run.data_revision,
         run.control_revision,
         run.raw_state,
         summary.source_revision AS summary_source_revision,
         summary.algorithm_version AS summary_algorithm_version,
         summary.distance_m AS summary_distance_m,
         summary.observed_duration_s AS summary_observed_duration_s,
         summary.quality_stats AS summary_quality_stats`;

const runViewJoin = `
  FROM runs AS run
  LEFT JOIN run_summaries AS summary
    ON summary.org_id = run.org_id
   AND summary.run_id = run.id
   AND run.status = 'finished'`;

const ownedRunViewSelect = `
  SELECT ${runViewProjection},
         run.started_at = $4::timestamptz AS creation_payload_matches
  ${runViewJoin}
  WHERE run.org_id = $1 AND run.id = $2 AND run.user_id = $3`;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as PostgresErrorLike;
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as PostgresErrorLike;
  return candidate.code === '23503' && candidate.constraint === constraint;
}

function isCheckViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as PostgresErrorLike;
  return candidate.code === '23514' && candidate.constraint === constraint;
}

function transportTimestamp(value: string): string {
  const matched = /^(.*\.)(\d{6})Z$/u.exec(value);
  if (!matched) {
    throw new Error('PostgreSQL returned an unexpected UTC timestamp representation');
  }
  const fraction = matched[2]!.replace(/0+$/u, '').padEnd(3, '0');
  return `${matched[1]}${fraction}Z`;
}

function canonicalCommandPayload(command: RunCommandRequest): {
  expectedControlRevision: string;
  type: RunCommandType;
} {
  return {
    expectedControlRevision: BigInt(command.expectedControlRevision).toString(),
    type: command.type,
  };
}

function mapRunView(row: RunRow): RunView {
  const summary =
    row.summary_source_revision === null ||
    row.summary_algorithm_version === null ||
    row.summary_distance_m === null ||
    row.summary_observed_duration_s === null ||
    row.summary_quality_stats === null
      ? null
      : {
          algorithmVersion: row.summary_algorithm_version,
          distanceM: row.summary_distance_m,
          observedDurationS: row.summary_observed_duration_s,
          qualityStats: row.summary_quality_stats,
          sourceRevision: row.summary_source_revision,
        };

  return runViewSchema.parse({
    controlRevision: row.control_revision,
    dataRevision: row.data_revision,
    finishedAt: row.finished_at?.toISOString() ?? null,
    rawState: row.raw_state,
    runId: row.run_id,
    startedAt: transportTimestamp(row.started_at),
    status: row.status,
    summary,
  });
}

function encodeRunListCursor(cursor: RunListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeRunListCursor(cursor: string): RunListCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error('The cursor is not base64url encoded');
    }
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = runListCursorSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error('The cursor payload is invalid');
    }
    return { runId: parsed.data.runId.toLowerCase(), startedAt: parsed.data.startedAt };
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', 'The run-list cursor is invalid');
  }
}

function encodeRawPointCursor(cursor: RawPointCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeRawPointCursor(cursor: string, orgId: string, runId: string): RawPointCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error('The cursor is not base64url encoded');
    }
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = rawPointCursorSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error('The cursor payload is invalid');
    }
    const canonical = {
      ...parsed.data,
      orgId: parsed.data.orgId.toLowerCase(),
      runId: parsed.data.runId.toLowerCase(),
    };
    if (canonical.orgId !== orgId || canonical.runId !== runId) {
      throw new Error('The cursor belongs to a different raw-point history');
    }
    return canonical;
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', 'The point-history cursor is invalid');
  }
}

function decodeLiveTrackSnapshotCursor(
  codec: LiveTrackCursorCodec,
  cursor: string,
  userId: string,
  orgId: string,
  runId: string,
): LiveTrackSnapshotCursor {
  try {
    return codec.decodeSnapshot(cursor, { orgId, runId, userId });
  } catch (error) {
    if (!(error instanceof InvalidLiveTrackCursorError)) {
      throw error;
    }
    throw new ApiError(400, 'INVALID_CURSOR', 'The live-track cursor is invalid');
  }
}

function decodeLiveTrackChangesCursor(
  codec: LiveTrackCursorCodec,
  cursor: string,
  userId: string,
  orgId: string,
  runId: string,
): LiveTrackChangesCursor {
  try {
    return codec.decodeChanges(cursor, { orgId, runId, userId });
  } catch (error) {
    if (!(error instanceof InvalidLiveTrackCursorError)) {
      throw error;
    }
    throw new ApiError(400, 'INVALID_CURSOR', 'The live-track cursor is invalid');
  }
}

/**
 * A tombstone is authoritative for exactly as long as its row exists. This
 * check deliberately ignores `expires_at`: that column only says when the
 * maintenance reclaim job may remove the row (ADR-0036). A run ID becomes
 * reusable when the row is actually gone, never merely because a clock passed
 * `expires_at`, so a delayed reclaim can only extend protection. Visibility is
 * still owner-scoped by RLS, which keeps other members from learning that
 * someone else's marker exists.
 */
async function isTombstoned(
  client: PoolClient,
  orgId: string,
  runId: string,
): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM run_tombstones WHERE org_id = $1 AND run_id = $2',
    [orgId, runId],
  );
  return result.rowCount === 1;
}

async function throwMissingRun(client: PoolClient, orgId: string, runId: string): Promise<never> {
  if (await isTombstoned(client, orgId, runId)) {
    throw new ApiError(410, 'RUN_DELETED', 'The run has been deleted');
  }
  throw new ApiError(404, 'RUN_NOT_FOUND', 'The run does not exist or is not accessible');
}

interface DeleteRunRow {
  outcome: 'already_deleted' | 'deleted' | 'not_found';
}

export async function deleteRun(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  clock: Clock,
): Promise<void> {
  const effectiveNow = clock.utcNow();
  const result = await client.query<DeleteRunRow>(
    `SELECT outcome
     FROM app_private.delete_run_as_owner($1, $2, $3, $4)`,
    [orgId, runId, session.userId, effectiveNow.toISOString()],
  );
  const outcome = result.rows[0]?.outcome;
  if (outcome !== 'deleted' && outcome !== 'already_deleted' && outcome !== 'not_found') {
    throw new Error('The run deletion function returned an invalid result');
  }
  if (outcome === 'not_found') {
    throw new ApiError(404, 'RUN_NOT_FOUND', 'The run does not exist or is not accessible');
  }
}

async function readOwnedRun(
  client: PoolClient,
  orgId: string,
  runId: string,
  userId: string,
  startedAt: string,
): Promise<{ creationPayloadMatches: boolean; run: RunView } | undefined> {
  const result = await client.query<OwnedRunRow>(ownedRunViewSelect, [
    orgId,
    runId,
    userId,
    startedAt,
  ]);
  const row = result.rows[0];
  return row
    ? { creationPayloadMatches: row.creation_payload_matches, run: mapRunView(row) }
    : undefined;
}

async function ensureOwnedRun(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
): Promise<void> {
  const result = await client.query(
    'SELECT 1 FROM runs WHERE org_id = $1 AND id = $2 AND user_id = $3',
    [orgId, runId, session.userId],
  );
  if (result.rowCount !== 1) {
    await throwMissingRun(client, orgId, runId);
  }
}

export const listRunsSql = `SELECT ${runViewProjection}
     ${runViewJoin}
     WHERE run.org_id = $1
       AND run.started_at >= $2::timestamptz
       AND run.started_at < $3::timestamptz
       AND (
         $4::timestamptz IS NULL
         OR (run.started_at, run.id) < ($4::timestamptz, $5::uuid)
       )
     ORDER BY run.started_at DESC, run.id DESC
     LIMIT $6`;

export async function listRuns(
  client: PoolClient,
  orgId: string,
  query: RunListQuery,
): Promise<RunListResponse> {
  const cursor = query.cursor ? decodeRunListCursor(query.cursor) : undefined;
  const limit = query.limit ?? 100;
  const result = await client.query<RunRow>(
    listRunsSql,
    [orgId, query.from, query.to, cursor?.startedAt ?? null, cursor?.runId ?? null, limit + 1],
  );
  const pageRows = result.rows.slice(0, limit);
  const last = pageRows.at(-1);
  return runListResponseSchema.parse({
    items: pageRows.map(mapRunView),
    nextCursor:
      result.rows.length > limit && last
        ? encodeRunListCursor({
            runId: last.run_id,
            startedAt: transportTimestamp(last.started_at),
          })
        : null,
  });
}

export async function readRun(
  client: PoolClient,
  orgId: string,
  runId: string,
): Promise<RunView> {
  const result = await client.query<RunRow>(
    `SELECT ${runViewProjection}
     ${runViewJoin}
     WHERE run.org_id = $1 AND run.id = $2`,
    [orgId, runId],
  );
  const row = result.rows[0];
  if (!row) {
    return throwMissingRun(client, orgId, runId);
  }
  return mapRunView(row);
}

export const rawPointsPageSql = `SELECT run.data_revision,
            run.raw_state,
            point.seq,
            point.segment_id,
            point.recorded_at,
            point.longitude,
            point.latitude,
            point.accuracy_m
     FROM runs AS run
     LEFT JOIN LATERAL (
       SELECT seq,
              segment_id,
              to_char(
                recorded_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS recorded_at,
              ST_X(geom) AS longitude,
              ST_Y(geom) AS latitude,
              accuracy_m
       FROM run_points
       WHERE org_id = run.org_id
         AND run_id = run.id
         AND run.raw_state = 'available'
         AND ($3::bigint IS NULL OR run.data_revision = $3::bigint)
         AND ($4::bigint IS NULL OR seq > $4::bigint)
       ORDER BY seq
       LIMIT $5
     ) AS point ON true
     WHERE run.org_id = $1
       AND run.id = $2
       AND app_private.can_read_run_history(run.org_id, run.id)
     ORDER BY point.seq NULLS LAST`;

export async function readRunPoints(
  client: PoolClient,
  orgId: string,
  runId: string,
  query: PointsQuery,
): Promise<PointsResponse> {
  const cursor = query.cursor ? decodeRawPointCursor(query.cursor, orgId, runId) : undefined;
  const limit = query.limit ?? 1_000;
  const result = await client.query<RawPointPageRow>(
    rawPointsPageSql,
    [orgId, runId, cursor?.dataRevision ?? null, cursor?.lastSeq ?? null, limit + 1],
  );
  const run = result.rows[0];
  if (!run) {
    return throwMissingRun(client, orgId, runId);
  }
  if (run.raw_state !== 'available') {
    throw new ApiError(410, 'RAW_HISTORY_UNAVAILABLE', 'Raw point history is unavailable');
  }
  if (cursor && cursor.dataRevision !== run.data_revision) {
    throw new ApiError(
      409,
      'HISTORY_REVISION_CHANGED',
      'The run changed while its raw point history was being read',
    );
  }

  const pointRows = result.rows.filter(
    (row): row is RawPointPageRow & {
      accuracy_m: number;
      latitude: number;
      longitude: number;
      recorded_at: string;
      segment_id: number;
      seq: string;
    } => row.seq !== null,
  );
  const pageRows = pointRows.slice(0, limit);
  const last = pageRows.at(-1);
  return pointsResponseSchema.parse({
    dataRevision: run.data_revision,
    nextCursor:
      pointRows.length > limit && last
        ? encodeRawPointCursor({
            dataRevision: run.data_revision,
            lastSeq: last.seq,
            orgId,
            runId,
          })
        : null,
    points: pageRows.map((point) => ({
      accuracyM: point.accuracy_m,
      latitude: point.latitude,
      longitude: point.longitude,
      recordedAt: point.recorded_at,
      segmentId: point.segment_id,
      seq: point.seq,
    })),
  });
}

export const liveTrackSnapshotSql = `SELECT run.data_revision AS current_revision,
            run.raw_state,
            app_private.current_track_algorithm_version() AS algorithm_version,
            point.seq,
            point.segment_id,
            point.recorded_at,
            point.longitude,
            point.latitude,
            point.accuracy_m,
            point.predecessor_seq,
            point.connect_from_previous
     FROM runs AS run
     LEFT JOIN LATERAL (
       WITH ordered_points AS MATERIALIZED (
         SELECT point.seq,
                point.segment_id,
                point.recorded_at,
                point.geom,
                point.accuracy_m,
                lag(point.seq) OVER point_order AS predecessor_seq,
                lag(point.segment_id) OVER point_order AS predecessor_segment_id,
                lag(point.recorded_at) OVER point_order AS predecessor_recorded_at,
                lag(point.geom) OVER point_order AS predecessor_geom,
                lag(point.accuracy_m) OVER point_order AS predecessor_accuracy_m
         FROM run_points AS point
         WHERE point.org_id = run.org_id
           AND point.run_id = run.id
           AND run.raw_state = 'available'
           AND point.ingested_revision <= COALESCE($3::bigint, run.data_revision)
         WINDOW point_order AS (ORDER BY point.seq)
       )
       SELECT point.seq,
              point.segment_id,
              to_char(
                point.recorded_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS recorded_at,
              ST_X(point.geom) AS longitude,
              ST_Y(point.geom) AS latitude,
              point.accuracy_m,
              point.predecessor_seq,
              coalesce(evaluation.accepted, false) AS connect_from_previous
       FROM ordered_points AS point
       LEFT JOIN LATERAL app_private.evaluate_track_edge(
         app_private.current_track_algorithm_version(),
         point.predecessor_seq,
         point.predecessor_segment_id,
         point.predecessor_recorded_at,
         point.predecessor_geom,
         point.predecessor_accuracy_m,
         point.seq,
         point.segment_id,
         point.recorded_at,
         point.geom,
         point.accuracy_m
       ) AS evaluation ON point.predecessor_seq IS NOT NULL
       WHERE ($4::bigint IS NULL OR point.seq > $4::bigint)
       ORDER BY point.seq
       LIMIT $5
     ) AS point ON true
     WHERE run.org_id = $1
       AND run.id = $2
       AND app_private.can_read_run(run.org_id, run.id)
     ORDER BY point.seq NULLS LAST`;

export async function readLiveTrackSnapshot(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  query: LiveTrackQuery,
  cursorCodec: LiveTrackCursorCodec,
): Promise<LiveTrackResponse> {
  const cursor = query.cursor
    ? decodeLiveTrackSnapshotCursor(cursorCodec, query.cursor, session.userId, orgId, runId)
    : undefined;
  const limit = query.limit ?? 1_000;
  const result = await client.query<LiveTrackSnapshotPageRow>(
    liveTrackSnapshotSql,
    [orgId, runId, cursor?.toRevision ?? null, cursor?.lastSeq ?? null, limit + 1],
  );
  const run = result.rows[0];
  if (!run) {
    return throwMissingRun(client, orgId, runId);
  }
  if (run.raw_state !== 'available') {
    throw new ApiError(410, 'RAW_HISTORY_UNAVAILABLE', 'Raw point history is unavailable');
  }
  if (
    cursor &&
    (BigInt(cursor.toRevision) > BigInt(run.current_revision) ||
      cursor.algorithmVersion !== run.algorithm_version)
  ) {
    throw new ApiError(400, 'INVALID_CURSOR', 'The live-track cursor is invalid');
  }

  const pointRows = result.rows.filter(
    (row): row is LiveTrackSnapshotPageRow & {
      accuracy_m: number;
      latitude: number;
      longitude: number;
      recorded_at: string;
      segment_id: number;
      seq: string;
    } => row.seq !== null,
  );
  const pageRows = pointRows.slice(0, limit);
  const last = pageRows.at(-1);
  const toRevision = cursor?.toRevision ?? run.current_revision;
  const algorithmVersion = cursor?.algorithmVersion ?? run.algorithm_version;
  return liveTrackResponseSchema.parse({
    algorithmVersion,
    fromRevision: null,
    nextCursor:
      pointRows.length > limit && last
        ? cursorCodec.encodeSnapshot({
            algorithmVersion,
            lastSeq: last.seq,
            operation: 'snapshot',
            orgId,
            runId,
            toRevision,
            userId: session.userId,
          }, cursor?.expiresAtMs)
        : null,
    toRevision,
    upserts: pageRows.map((point) => ({
      accuracyM: point.accuracy_m,
      connectFromPrevious: point.connect_from_previous,
      coordinates: [point.longitude, point.latitude],
      predecessorSeq: point.predecessor_seq,
      recordedAt: point.recorded_at,
      segmentId: point.segment_id,
      seq: point.seq,
    })),
  });
}

export const liveTrackChangesSql = `SELECT run.data_revision AS current_revision,
            run.raw_state,
            app_private.current_track_algorithm_version() AS algorithm_version,
            point.seq,
            point.segment_id,
            point.recorded_at,
            point.longitude,
            point.latitude,
            point.accuracy_m,
            point.predecessor_seq,
            point.connect_from_previous
     FROM runs AS run
     LEFT JOIN LATERAL (
       WITH ordered_points AS MATERIALIZED (
         SELECT point.seq,
                point.segment_id,
                point.recorded_at,
                point.geom,
                point.accuracy_m,
                point.ingested_revision,
                lag(point.seq) OVER point_order AS predecessor_seq,
                lag(point.segment_id) OVER point_order AS predecessor_segment_id,
                lag(point.recorded_at) OVER point_order AS predecessor_recorded_at,
                lag(point.geom) OVER point_order AS predecessor_geom,
                lag(point.accuracy_m) OVER point_order AS predecessor_accuracy_m
         FROM run_points AS point
         WHERE point.org_id = run.org_id
           AND point.run_id = run.id
           AND run.raw_state = 'available'
           AND point.ingested_revision <= COALESCE($4::bigint, run.data_revision)
         WINDOW point_order AS (ORDER BY point.seq)
       ),
       changed AS (
         SELECT changed_point.seq
         FROM ordered_points AS changed_point
         WHERE changed_point.ingested_revision > $3::bigint
       ),
       upsert_sequences AS (
         SELECT changed.seq
         FROM changed
         UNION
         SELECT successor.seq
         FROM changed
         CROSS JOIN LATERAL (
           SELECT candidate.seq
           FROM ordered_points AS candidate
           WHERE candidate.seq > changed.seq
           ORDER BY candidate.seq
           LIMIT 1
         ) AS successor
       )
       SELECT stored.seq,
              stored.segment_id,
              to_char(
                stored.recorded_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS recorded_at,
              ST_X(stored.geom) AS longitude,
              ST_Y(stored.geom) AS latitude,
              stored.accuracy_m,
              stored.predecessor_seq,
              coalesce(evaluation.accepted, false) AS connect_from_previous
       FROM upsert_sequences
       JOIN ordered_points AS stored ON stored.seq = upsert_sequences.seq
       LEFT JOIN LATERAL app_private.evaluate_track_edge(
         app_private.current_track_algorithm_version(),
         stored.predecessor_seq,
         stored.predecessor_segment_id,
         stored.predecessor_recorded_at,
         stored.predecessor_geom,
         stored.predecessor_accuracy_m,
         stored.seq,
         stored.segment_id,
         stored.recorded_at,
         stored.geom,
         stored.accuracy_m
       ) AS evaluation ON stored.predecessor_seq IS NOT NULL
       WHERE ($5::bigint IS NULL OR stored.seq > $5::bigint)
       ORDER BY stored.seq
       LIMIT $6
     ) AS point ON true
     WHERE run.org_id = $1
       AND run.id = $2
       AND app_private.can_read_run(run.org_id, run.id)
     ORDER BY point.seq NULLS LAST`;

export async function readLiveTrackChanges(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  query: LiveTrackChangesQuery,
  cursorCodec: LiveTrackCursorCodec,
): Promise<LiveTrackResponse> {
  let cursor: LiveTrackChangesCursor | undefined;
  let fromRevision: string;
  if ('cursor' in query) {
    cursor = decodeLiveTrackChangesCursor(
      cursorCodec,
      query.cursor,
      session.userId,
      orgId,
      runId,
    );
    fromRevision = cursor.fromRevision;
  } else {
    fromRevision = query.afterRevision;
  }
  const limit = query.limit ?? 1_000;
  const result = await client.query<LiveTrackChangesPageRow>(
    liveTrackChangesSql,
    [
      orgId,
      runId,
      fromRevision,
      cursor?.toRevision ?? null,
      cursor?.lastSeq ?? null,
      limit + 1,
    ],
  );
  const run = result.rows[0];
  if (!run) {
    return throwMissingRun(client, orgId, runId);
  }
  if (run.raw_state !== 'available') {
    throw new ApiError(410, 'RAW_HISTORY_UNAVAILABLE', 'Raw point history is unavailable');
  }
  if (cursor) {
    if (
      BigInt(cursor.toRevision) > BigInt(run.current_revision) ||
      cursor.algorithmVersion !== run.algorithm_version
    ) {
      throw new ApiError(400, 'INVALID_CURSOR', 'The live-track cursor is invalid');
    }
  } else if (BigInt(fromRevision) > BigInt(run.current_revision)) {
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      'The source revision must not exceed the current run revision',
    );
  }

  const pointRows = result.rows.filter(
    (row): row is LiveTrackChangesPageRow & {
      accuracy_m: number;
      latitude: number;
      longitude: number;
      recorded_at: string;
      segment_id: number;
      seq: string;
    } => row.seq !== null,
  );
  const pageRows = pointRows.slice(0, limit);
  const last = pageRows.at(-1);
  const toRevision = cursor?.toRevision ?? run.current_revision;
  const algorithmVersion = cursor?.algorithmVersion ?? run.algorithm_version;
  return liveTrackResponseSchema.parse({
    algorithmVersion,
    fromRevision,
    nextCursor:
      pointRows.length > limit && last
        ? cursorCodec.encodeChanges({
            algorithmVersion,
            fromRevision,
            lastSeq: last.seq,
            operation: 'changes',
            orgId,
            runId,
            toRevision,
            userId: session.userId,
          }, cursor?.expiresAtMs)
        : null,
    toRevision,
    upserts: pageRows.map((point) => ({
      accuracyM: point.accuracy_m,
      connectFromPrevious: point.connect_from_previous,
      coordinates: [point.longitude, point.latitude],
      predecessorSeq: point.predecessor_seq,
      recordedAt: point.recorded_at,
      segmentId: point.segment_id,
      seq: point.seq,
    })),
  });
}

export async function upsertRunShare(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  granteeUserId: string,
  request: UpsertRunShareRequest,
): Promise<RunShareResponse> {
  await lockArchiveRevisionForAclChange(client, orgId);
  await ensureOwnedRun(client, session, orgId, runId);
  try {
    const result = await client.query<{
      can_read_history: boolean;
      can_read_live: boolean;
    }>(
      `INSERT INTO run_shares (
         org_id, run_id, grantee_user_id, can_read_history, can_read_live
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, run_id, grantee_user_id)
       DO UPDATE SET can_read_history = EXCLUDED.can_read_history,
                     can_read_live = EXCLUDED.can_read_live
       RETURNING can_read_history, can_read_live`,
      [orgId, runId, granteeUserId, request.canReadHistory, request.canReadLive],
    );
    const share = result.rows[0];
    if (!share) {
      throw new Error('The share upsert did not return its persisted permissions');
    }
    return runShareResponseSchema.parse({
      canReadHistory: share.can_read_history,
      canReadLive: share.can_read_live,
    });
  } catch (error) {
    if (isForeignKeyViolation(error, 'run_shares_grantee_membership_fk')) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'The share recipient is not a member of this organization',
      );
    }
    throw error;
  }
}

export async function revokeRunShare(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  granteeUserId: string,
): Promise<void> {
  await lockArchiveRevisionForAclChange(client, orgId);
  await ensureOwnedRun(client, session, orgId, runId);
  await client.query(
    `DELETE FROM run_shares
     WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
    [orgId, runId, granteeUserId],
  );
}

function sameCanonicalPoint(stored: StoredPointRow, point: PointInput): boolean {
  return (
    stored.seq === point.seq &&
    stored.segment_id === point.segmentId &&
    stored.recorded_at === point.recordedAt &&
    stored.longitude === point.longitude &&
    stored.latitude === point.latitude &&
    stored.accuracy_m === point.accuracyM
  );
}

function uniqueCanonicalPoints(points: PointInput[]): {
  duplicateCount: number;
  points: PointInput[];
} {
  const unique = new Map<string, PointInput>();
  let duplicateCount = 0;
  for (const point of points) {
    const existing = unique.get(point.seq);
    if (!existing) {
      unique.set(point.seq, point);
      continue;
    }
    if (
      existing.segmentId !== point.segmentId ||
      existing.recordedAt !== point.recordedAt ||
      existing.longitude !== point.longitude ||
      existing.latitude !== point.latitude ||
      existing.accuracyM !== point.accuracyM
    ) {
      throw new ApiError(409, 'POINT_CONFLICT', 'One point sequence is bound to different payloads');
    }
    duplicateCount += 1;
  }
  return { duplicateCount, points: [...unique.values()] };
}

export const insertPointsSql = `INSERT INTO run_points (
       org_id, run_id, seq, segment_id, recorded_at, received_at,
       geom, accuracy_m, ingested_revision
     )
     SELECT $1,
            $2,
            input.seq,
            input.segment_id,
            input.recorded_at,
            $9::timestamptz,
            ST_SetSRID(ST_MakePoint(input.longitude, input.latitude), 4326),
            input.accuracy_m,
            $10::bigint
     FROM unnest(
       $3::bigint[], $4::integer[], $5::timestamptz[],
       $6::double precision[], $7::double precision[], $8::double precision[]
     ) AS input(seq, segment_id, recorded_at, longitude, latitude, accuracy_m)`;

export async function ingestRunPoints(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  request: IngestPointsRequest,
  clock: Clock,
): Promise<IngestPointsResponse> {
  const locked = await client.query<LockedIngestionRunRow>(
    `SELECT data_revision, finished_at, raw_state
     FROM runs
     WHERE org_id = $1 AND id = $2 AND user_id = $3
     FOR UPDATE`,
    [orgId, runId, session.userId],
  );
  const run = locked.rows[0];
  if (!run) {
    return throwMissingRun(client, orgId, runId);
  }
  if (run.raw_state !== 'available') {
    throw new ApiError(410, 'RAW_HISTORY_UNAVAILABLE', 'Raw point history is unavailable');
  }

  const batch = uniqueCanonicalPoints(request.points);
  const sequences = batch.points.map(({ seq }) => seq);
  const existingResult = await client.query<StoredPointRow>(
    `SELECT seq,
            segment_id,
            to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
            ST_X(geom) AS longitude,
            ST_Y(geom) AS latitude,
            accuracy_m
     FROM run_points
     WHERE org_id = $1 AND run_id = $2 AND seq = ANY($3::bigint[])`,
    [orgId, runId, sequences],
  );
  const requestedBySequence = new Map(batch.points.map((point) => [point.seq, point]));
  const existingSequences = new Set<string>();
  for (const stored of existingResult.rows) {
    const requested = requestedBySequence.get(stored.seq);
    if (!requested || !sameCanonicalPoint(stored, requested)) {
      throw new ApiError(409, 'POINT_CONFLICT', 'A point sequence is already bound to a different payload');
    }
    existingSequences.add(stored.seq);
  }

  const newPoints = batch.points.filter(({ seq }) => !existingSequences.has(seq));
  const duplicateCount = batch.duplicateCount + existingSequences.size;
  if (newPoints.length === 0) {
    return ingestPointsResponseSchema.parse({
      dataRevision: run.data_revision,
      duplicateCount,
      insertedCount: 0,
    });
  }

  const receivedAt = clock.utcNow();
  if (
    run.finished_at !== null &&
    receivedAt.getTime() > run.finished_at.getTime() + UPLOAD_WINDOW_MS
  ) {
    throw new ApiError(409, 'UPLOAD_WINDOW_CLOSED', 'The finished run upload window is closed');
  }

  const pointCount = await client.query<{ count: string }>(
    'SELECT count(*) FROM run_points WHERE org_id = $1 AND run_id = $2',
    [orgId, runId],
  );
  if (BigInt(pointCount.rows[0]?.count ?? '0') + BigInt(newPoints.length) > POINTS_PER_RUN_MAX) {
    throw new ApiError(422, 'RUN_POINT_LIMIT', 'The run cannot exceed 50000 points');
  }

  const revisionResult = await client.query<{ data_revision: string }>(
    `UPDATE runs
     SET data_revision = data_revision + 1
     WHERE org_id = $1 AND id = $2 AND user_id = $3
     RETURNING data_revision`,
    [orgId, runId, session.userId],
  );
  const dataRevision = revisionResult.rows[0]?.data_revision;
  if (!dataRevision) {
    throw new Error('The locked run disappeared before its point revision update');
  }

  await client.query(
    insertPointsSql,
    [
      orgId,
      runId,
      newPoints.map(({ seq }) => seq),
      newPoints.map(({ segmentId }) => segmentId),
      newPoints.map(({ recordedAt }) => recordedAt),
      newPoints.map(({ longitude }) => longitude),
      newPoints.map(({ latitude }) => latitude),
      newPoints.map(({ accuracyM }) => accuracyM),
      receivedAt.toISOString(),
      dataRevision,
    ],
  );

  return ingestPointsResponseSchema.parse({
    dataRevision,
    duplicateCount,
    insertedCount: newPoints.length,
  });
}

export function nextRunStatus(current: RunStatus, command: RunCommandType): RunStatus | undefined {
  if (command === 'finish') {
    return current === 'finished' ? undefined : 'finished';
  }
  if (current === 'recording' && command === 'pause') {
    return 'paused';
  }
  if (current === 'paused' && command === 'resume') {
    return 'recording';
  }
  return undefined;
}

export async function createRun(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  request: CreateRunRequest,
  clock: Clock,
): Promise<CreateRunResult> {
  const startedAt = request.startedAt;
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1::text || ':' || $2::text, 0)
     )`,
    [orgId, runId],
  );
  const existing = await readOwnedRun(client, orgId, runId, session.userId, startedAt);
  if (existing) {
    if (!existing.creationPayloadMatches) {
      throw new ApiError(409, 'ACTIVE_RUN_EXISTS', 'The run ID is already bound to a different creation payload');
    }
    return { created: false, run: existing.run };
  }

  if (await isTombstoned(client, orgId, runId)) {
    throw new ApiError(410, 'RUN_DELETED', 'The run has been deleted');
  }

  const createdAt = clock.utcNow();
  if (Date.parse(startedAt) > createdAt.getTime() + 24 * 60 * 60 * 1_000) {
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      'The run start time cannot be more than 24 hours after server creation time',
    );
  }

  let inserted: boolean;
  try {
    const result = await client.query(
      `INSERT INTO runs (org_id, id, user_id, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, id) DO NOTHING
       RETURNING id`,
      [orgId, runId, session.userId, startedAt, createdAt.toISOString()],
    );
    inserted = result.rowCount === 1;
  } catch (error) {
    if (isUniqueViolation(error, 'runs_one_active_per_user_idx')) {
      throw new ApiError(409, 'ACTIVE_RUN_EXISTS', 'The current identity already has an active run');
    }
    if (isCheckViolation(error, 'runs_start_within_auto_finish_window')) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'The run start time cannot be more than 24 hours after server creation time',
      );
    }
    throw error;
  }

  const existingAfterInsert = await readOwnedRun(client, orgId, runId, session.userId, startedAt);
  if (!existingAfterInsert) {
    return throwMissingRun(client, orgId, runId);
  }
  if (!existingAfterInsert.creationPayloadMatches) {
    throw new ApiError(409, 'ACTIVE_RUN_EXISTS', 'The run ID is already bound to a different creation payload');
  }
  return { created: inserted, run: existingAfterInsert.run };
}

export async function applyRunCommand(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  runId: string,
  command: RunCommandRequest,
  clock: Clock,
): Promise<RunCommandResponse> {
  const normalizedCommandId = command.commandId.toLowerCase();
  const payload = canonicalCommandPayload(command);
  const locked = await client.query<LockedRunRow>(
    `SELECT status, finished_at, data_revision, control_revision
     FROM runs
     WHERE org_id = $1 AND id = $2 AND user_id = $3
     FOR UPDATE`,
    [orgId, runId, session.userId],
  );
  const run = locked.rows[0];
  if (!run) {
    return throwMissingRun(client, orgId, runId);
  }

  const duplicate = await client.query<StoredCommandRow>(
    `SELECT canonical_payload = $4::jsonb AS payload_matches, response
     FROM run_commands
     WHERE org_id = $1 AND run_id = $2 AND command_id = $3`,
    [orgId, runId, normalizedCommandId, JSON.stringify(payload)],
  );
  const stored = duplicate.rows[0];
  if (stored) {
    if (!stored.payload_matches) {
      throw new ApiError(409, 'CONTROL_REVISION_CONFLICT', 'The command ID is already bound to a different payload');
    }
    return runCommandResponseSchema.parse(stored.response);
  }

  if (run.control_revision !== payload.expectedControlRevision) {
    throw new ApiError(409, 'CONTROL_REVISION_CONFLICT', 'The expected control revision is stale');
  }

  const nextStatus = nextRunStatus(run.status, command.type);
  if (!nextStatus) {
    throw new ApiError(409, 'CONTROL_REVISION_CONFLICT', 'The lifecycle command is not valid for the current run state');
  }

  const finishedAt = nextStatus === 'finished' ? clock.utcNow().toISOString() : null;
  const updated = await client.query<LockedRunRow>(
    `UPDATE runs
     SET status = $4,
         finished_at = $5,
         data_revision = data_revision + 1,
         control_revision = control_revision + 1
     WHERE org_id = $1 AND id = $2 AND user_id = $3
     RETURNING status, finished_at, data_revision, control_revision`,
    [orgId, runId, session.userId, nextStatus, finishedAt],
  );
  const result = updated.rows[0];
  if (!result) {
    throw new Error('The locked run disappeared before its lifecycle update');
  }

  const response = runCommandResponseSchema.parse({
    commandId: normalizedCommandId,
    controlRevision: result.control_revision,
    dataRevision: result.data_revision,
    finishedAt: result.finished_at?.toISOString() ?? null,
    status: result.status,
  });
  await client.query(
    `INSERT INTO run_commands (org_id, run_id, command_id, canonical_payload, response)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [orgId, runId, normalizedCommandId, JSON.stringify(payload), JSON.stringify(response)],
  );
  return response;
}
