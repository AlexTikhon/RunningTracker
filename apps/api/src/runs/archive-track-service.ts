import {
  ARCHIVE_TRACK_MAX_BYTES,
  ARCHIVE_TRACK_MAX_VERTICES,
  archiveTrackResponseSchema,
  type ArchiveTrackResponse,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import { ApiError } from '../http/errors.js';

// One statement snapshot owns run metadata, summary provenance, metrics and geometry. No raw points are read.
// The vertex guard bounds encoding work; the byte guard prevents a large value from crossing into Node.
export const archiveTrackSql = `SELECT run.id AS run_id,
       to_char(run.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
       to_char(run.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at,
       run.data_revision, run.raw_state,
       summary.source_revision, summary.algorithm_version,
       CASE WHEN summary.source_revision = run.data_revision THEN summary.distance_m END AS distance_m,
       CASE WHEN summary.source_revision = run.data_revision THEN summary.observed_duration_s END AS observed_duration_s,
       CASE WHEN summary.source_revision = run.data_revision THEN summary.quality_stats END AS quality_stats,
       CASE WHEN octet_length(encoded.geometry_json) <= $4 THEN encoded.geometry_json END AS geometry_json,
       COALESCE(summary.source_revision = run.data_revision AND
         (public.ST_NPoints(summary.display_geom) > $3 OR octet_length(encoded.geometry_json) > $4), false) AS too_complex
  FROM runs AS run
  LEFT JOIN run_summaries AS summary ON summary.org_id = run.org_id AND summary.run_id = run.id
  LEFT JOIN LATERAL (
    SELECT CASE WHEN summary.source_revision = run.data_revision
                     AND public.ST_NPoints(summary.display_geom) <= $3
                THEN public.ST_AsGeoJSON(summary.display_geom, 15, 0) END AS geometry_json
  ) AS encoded ON true
  WHERE run.org_id = $1 AND run.id = $2 AND run.status = 'finished'`;

interface ArchiveTrackRow {
  algorithm_version: string | null;
  data_revision: string;
  distance_m: number | null;
  finished_at: string;
  geometry_json: string | null;
  observed_duration_s: number | null;
  quality_stats: unknown;
  raw_state: 'available' | 'purging' | 'purged';
  run_id: string;
  source_revision: string | null;
  started_at: string;
  too_complex: boolean;
}

function tooComplex(): ApiError {
  return new ApiError(422, 'ARCHIVE_TRACK_TOO_COMPLEX', 'The complete archive track exceeds its response limit', {
    maxBytes: ARCHIVE_TRACK_MAX_BYTES,
    maxVertices: ARCHIVE_TRACK_MAX_VERTICES,
  });
}

/** Called inside the authenticated tenant transaction; existing run/summary RLS enforces history access. */
export async function readArchiveTrack(client: PoolClient, orgId: string, runId: string): Promise<ArchiveTrackResponse> {
  const result = await client.query<ArchiveTrackRow>(archiveTrackSql, [
    orgId, runId, ARCHIVE_TRACK_MAX_VERTICES, ARCHIVE_TRACK_MAX_BYTES,
  ]);
  const row = result.rows[0];
  if (row === undefined) {
    // Owner-scoped RLS preserves the existing 410 behavior without exposing someone else's tombstone.
    const deleted = await client.query('SELECT 1 FROM run_tombstones WHERE org_id = $1 AND run_id = $2', [orgId, runId]);
    if (deleted.rowCount === 1) throw new ApiError(410, 'RUN_DELETED', 'The run has been deleted');
    throw new ApiError(404, 'RUN_NOT_FOUND', 'The finished run does not exist or is not accessible');
  }
  if (row.too_complex) throw tooComplex();
  const summaryState = row.source_revision === null ? 'pending'
    : row.source_revision === row.data_revision ? 'ready' : 'stale';
  const feature = archiveTrackResponseSchema.parse({
    geometry: row.geometry_json === null ? null : JSON.parse(row.geometry_json) as unknown,
    properties: {
      algorithmVersion: row.algorithm_version,
      dataRevision: row.data_revision,
      distanceM: row.distance_m,
      finishedAt: row.finished_at,
      observedDurationS: row.observed_duration_s,
      qualityStats: row.quality_stats,
      rawState: row.raw_state,
      runId: row.run_id,
      sourceRevision: row.source_revision,
      startedAt: row.started_at,
      summaryState,
    },
    type: 'Feature',
  });
  // Geometry alone may fit while its envelope does not. Never silently truncate either representation.
  if (Buffer.byteLength(JSON.stringify(feature), 'utf8') > ARCHIVE_TRACK_MAX_BYTES) throw tooComplex();
  return feature;
}
