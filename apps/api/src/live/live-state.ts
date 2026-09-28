import { liveStateRunSchema, type LiveStateRun } from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

interface LiveStateRow {
  accuracy_m: number | null;
  data_revision: string;
  edge_accepted: boolean | null;
  edge_rejection_reason: string | null;
  latitude: number | null;
  longitude: number | null;
  recorded_at: Date | null;
  run_id: string;
  seq: string | null;
  status: 'paused' | 'recording';
}

export interface LiveStateSnapshot {
  algorithmVersion: string;
  runs: LiveStateRun[];
  serverTime: string;
}

const unconfirmedEdgeReasons = new Set(['poor_accuracy', 'segment_break', 'seq_gap']);

function transportTimestamp(value: Date): string {
  return value.toISOString();
}

function liveRunFromRow(row: LiveStateRow): LiveStateRun {
  let position: LiveStateRun['position'] = null;

  if (
    row.seq !== null &&
    row.recorded_at !== null &&
    row.longitude !== null &&
    row.latitude !== null &&
    row.accuracy_m !== null &&
    row.accuracy_m <= 30
  ) {
    const quality = row.edge_accepted
      ? 'confirmed'
      : row.edge_rejection_reason === null ||
          unconfirmedEdgeReasons.has(row.edge_rejection_reason)
        ? 'unconfirmed'
        : null;

    if (quality !== null) {
      position = {
        accuracyM: row.accuracy_m,
        coordinates: [row.longitude, row.latitude],
        quality,
        recordedAt: transportTimestamp(row.recorded_at),
        seq: row.seq,
      };
    }
  }

  return liveStateRunSchema.parse({
    dataRevision: row.data_revision,
    position,
    runId: row.run_id,
    status: row.status,
  });
}

export async function readLiveState(
  client: PoolClient,
  orgId: string,
): Promise<LiveStateSnapshot> {
  const result = await client.query<LiveStateRow & { algorithm_version: string; server_time: Date }>(
    `WITH context AS MATERIALIZED (
       SELECT clock_timestamp() AS server_time,
              app_private.current_track_algorithm_version() AS algorithm_version
     )
     SELECT context.server_time,
            context.algorithm_version,
            run.id AS run_id,
            run.status,
            run.data_revision,
            latest.seq,
            latest.recorded_at,
            latest.accuracy_m,
            public.ST_X(latest.geom) AS longitude,
            public.ST_Y(latest.geom) AS latitude,
            evaluation.accepted AS edge_accepted,
            evaluation.rejection_reason AS edge_rejection_reason
     FROM context
     JOIN runs AS run
       ON run.org_id = $1
      AND run.status IN ('recording', 'paused')
      AND run.raw_state = 'available'
     LEFT JOIN LATERAL (
       SELECT point.seq,
              point.segment_id,
              point.recorded_at,
              point.geom,
              point.accuracy_m
       FROM run_points AS point
       WHERE point.org_id = run.org_id
         AND point.run_id = run.id
       ORDER BY point.seq DESC
       LIMIT 1
     ) AS latest ON true
     LEFT JOIN LATERAL (
       SELECT point.seq,
              point.segment_id,
              point.recorded_at,
              point.geom,
              point.accuracy_m
       FROM run_points AS point
       WHERE point.org_id = run.org_id
         AND point.run_id = run.id
         AND point.seq < latest.seq
       ORDER BY point.seq DESC
       LIMIT 1
     ) AS predecessor ON true
     LEFT JOIN LATERAL app_private.evaluate_track_edge(
       context.algorithm_version,
       predecessor.seq,
       predecessor.segment_id,
       predecessor.recorded_at,
       predecessor.geom,
       predecessor.accuracy_m,
       latest.seq,
       latest.segment_id,
       latest.recorded_at,
       latest.geom,
       latest.accuracy_m
     ) AS evaluation ON true
     ORDER BY run.started_at, run.id`,
    [orgId],
  );

  const first = result.rows[0];
  if (!first) {
    const context = await client.query<{ algorithm_version: string; server_time: Date }>(
      `SELECT clock_timestamp() AS server_time,
              app_private.current_track_algorithm_version() AS algorithm_version`,
    );
    const row = context.rows[0];
    if (!row) {
      throw new Error('The live-state context query returned no row');
    }
    return {
      algorithmVersion: row.algorithm_version,
      runs: [],
      serverTime: transportTimestamp(row.server_time),
    };
  }

  return {
    algorithmVersion: first.algorithm_version,
    runs: result.rows.map(liveRunFromRow),
    serverTime: transportTimestamp(first.server_time),
  };
}
