import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { insertPointsSql } from '../runs/run-service.js';
import { ASSUMED_ACCURACY_M, anchorTrace } from './replay.js';
import {
  edgeStatistics,
  sourceCharacteristics,
  type EdgeResult,
  type EdgeStatistics,
  type SourceCharacteristics,
} from './statistics.js';
import type { Scenario, SanitizedTrace, TraceSource } from './trace-schema.js';

// Replays a sanitized trace through what the product actually runs and reports what came out. Nothing here decides
// whether a point is good: the verdicts come from the production SQL functions
//   app_private.evaluate_track_edge        per-edge accept/reject and reason,
//   app_private.calculate_run_summary      the canonical distance and the accepted chains,
//   app_private.simplify_display_geometry  the display line,
// applied to rows written with the production insert statement and validated with the production point contract.
// The per-edge query below only wires evaluate_track_edge the way calculate_run_summary does, so that the verdict of
// each edge can be reported; its totals are checked against the production summary, and a mismatch is reported.
//
// The work happens in one transaction on the integration test database that is always rolled back.

const IDS = {
  org: '67000000-0000-4000-8000-000000000001',
  run: '67000000-0000-4000-8000-000000000002',
  user: '67000000-0000-4000-8000-000000000003',
} as const;
const SOURCE_REVISION = 1;
const DISPLAY_TOLERANCE_M = 5;

export interface DistanceReport {
  /** Canonical accepted distance minus raw observed distance; negative when edges were rejected. */
  readonly canonicalM: number;
  readonly canonicalVsReferencePercent: number | null;
  readonly differenceM: number;
  readonly differencePercent: number | null;
  /** Sum of every consecutive-fix distance, rejected edges included. Not ground truth. */
  readonly rawObservedM: number;
  readonly rawVsReferencePercent: number | null;
  /** An independently measured length from the fixture, if it has one. Optional. */
  readonly referenceM: number | null;
}

export interface DisplayReport {
  readonly acceptedChainCount: number;
  readonly acceptedLengthM: number | null;
  readonly acceptedVertexCount: number;
  /** Largest distance from any accepted vertex to the simplified line: the metric of the synthetic D10 test. */
  readonly maxDeviationM: number | null;
  readonly reductionPercent: number | null;
  readonly simplifiedLengthM: number | null;
  readonly simplifiedVertexCount: number | null;
  readonly toleranceM: number;
}

export interface TraceReport {
  readonly algorithmVersion: string;
  readonly characteristics: SourceCharacteristics;
  /** Whether the per-edge verdicts reproduce the production summary's own counters and totals. */
  readonly consistency: { readonly agreesWithProductionSummary: boolean; readonly mismatches: string[] };
  readonly contentSha256: string;
  readonly display: DisplayReport;
  readonly distance: DistanceReport;
  readonly edges: EdgeStatistics;
  readonly name: string;
  readonly replay: { readonly accuracyAssumed: boolean; readonly assumedAccuracyM: number | null };
  readonly scenario: Scenario;
  readonly sourceKind: TraceSource;
}

interface EdgeRow {
  accepted: boolean;
  distance_m: number;
  duration_s: number;
  rejection_reason: string | null;
}

interface SummaryRow {
  accepted_chain_count: number | null;
  accepted_length_m: number | null;
  accepted_vertex_count: number | null;
  distance_m: number;
  max_deviation_m: number | null;
  observed_duration_s: number;
  quality_stats: Record<string, number | boolean>;
  simplified_length_m: number | null;
  simplified_vertex_count: number | null;
}

const EDGE_SQL = `
  WITH ordered_points AS (
    SELECT point.seq AS successor_seq,
           point.segment_id AS successor_segment_id,
           point.recorded_at AS successor_recorded_at,
           point.geom AS successor_geom,
           point.accuracy_m AS successor_accuracy_m,
           lag(point.seq) OVER point_order AS predecessor_seq,
           lag(point.segment_id) OVER point_order AS predecessor_segment_id,
           lag(point.recorded_at) OVER point_order AS predecessor_recorded_at,
           lag(point.geom) OVER point_order AS predecessor_geom,
           lag(point.accuracy_m) OVER point_order AS predecessor_accuracy_m
    FROM public.run_points AS point
    WHERE point.org_id = $1 AND point.run_id = $2 AND point.ingested_revision <= $3
    WINDOW point_order AS (ORDER BY point.seq)
  )
  SELECT evaluation.accepted, evaluation.rejection_reason, evaluation.distance_m, evaluation.duration_s
  FROM ordered_points AS point
  CROSS JOIN LATERAL app_private.evaluate_track_edge(
    $4,
    point.predecessor_seq, point.predecessor_segment_id, point.predecessor_recorded_at,
    point.predecessor_geom, point.predecessor_accuracy_m,
    point.successor_seq, point.successor_segment_id, point.successor_recorded_at,
    point.successor_geom, point.successor_accuracy_m
  ) AS evaluation
  WHERE point.predecessor_seq IS NOT NULL
  ORDER BY point.successor_seq`;

// The display metric is the one of the synthetic D10 test: the largest distance from an accepted vertex to the line.
const SUMMARY_SQL = `
  WITH calculation AS (
    SELECT * FROM app_private.calculate_run_summary($1::uuid, $2::uuid, $3::bigint, $4::text)
  ),
  simplification AS (
    SELECT calculation.*, app_private.simplify_display_geometry(calculation.accepted_chains, $4::text) AS simplified
    FROM calculation
  )
  SELECT distance_m,
         observed_duration_s,
         quality_stats,
         ST_NumGeometries(accepted_chains)::integer AS accepted_chain_count,
         ST_NPoints(accepted_chains)::integer AS accepted_vertex_count,
         ST_Length(accepted_chains::geography) AS accepted_length_m,
         ST_NPoints(simplified)::integer AS simplified_vertex_count,
         ST_Length(simplified::geography) AS simplified_length_m,
         (SELECT max(ST_Distance(vertex.geom::geography, simplified::geography))
            FROM ST_DumpPoints(accepted_chains) AS vertex) AS max_deviation_m
  FROM simplification`;

async function seedRun(client: PoolClient): Promise<void> {
  await client.query('INSERT INTO users (id, external_identity) VALUES ($1, $2)', [
    IDS.user,
    `gps-trace-${IDS.user}`,
  ]);
  await client.query('INSERT INTO organizations (id) VALUES ($1)', [IDS.org]);
  await client.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'runner')`, [
    IDS.org,
    IDS.user,
  ]);
  await client.query(
    `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision)
     VALUES ($1, $2, $3, 'finished',
             '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T12:00:00.000Z', $4)`,
    [IDS.org, IDS.run, IDS.user, SOURCE_REVISION],
  );
}

const percentOf = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100);

function consistencyMismatches(edges: EdgeStatistics, summary: SummaryRow): string[] {
  const mismatches: string[] = [];
  const stats = summary.quality_stats;
  const check = (label: string, perEdge: number, production: unknown) => {
    if (perEdge !== production) {
      mismatches.push(`${label}: per-edge ${String(perEdge)}, production summary ${String(production)}`);
    }
  };
  check('accepted edges', edges.acceptedCount, stats.acceptedEdgeCount);
  check('excessive_speed edges', edges.rejectionReasons.excessive_speed ?? 0, stats.excessiveSpeedCount);
  check('excessive_time_gap edges', edges.rejectionReasons.excessive_time_gap ?? 0, stats.excessiveTimeGapCount);
  check('nonpositive_time_delta edges', edges.rejectionReasons.nonpositive_time_delta ?? 0, stats.nonpositiveTimeDeltaCount);
  check('seq_gap edges', edges.rejectionReasons.seq_gap ?? 0, stats.seqGapCount);
  check('segment_break edges', edges.rejectionReasons.segment_break ?? 0, stats.segmentBreakCount);
  if (Math.abs(edges.acceptedDistanceM - summary.distance_m) > 1e-6) {
    mismatches.push(
      `accepted distance: per-edge sum and production summary differ by ${String(Math.abs(edges.acceptedDistanceM - summary.distance_m))} m`,
    );
  }
  return mismatches;
}

/**
 * Replays `trace` and measures it. `pool` must be connected to the integration test database as the schema owner
 * (obtain it from `loadIntegrationTestConfiguration`, which refuses any database whose name does not end in `_test`).
 */
export async function analyzeTrace(
  pool: Pick<Pool, 'connect'>,
  name: string,
  trace: SanitizedTrace,
  contentText?: string,
): Promise<TraceReport> {
  const points = anchorTrace(trace);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedRun(client);
    const versionResult = await client.query<{ version: string }>(
      'SELECT app_private.current_track_algorithm_version() AS version',
    );
    const algorithmVersion = versionResult.rows[0]?.version ?? '';

    await client.query(insertPointsSql, [
      IDS.org,
      IDS.run,
      points.map(({ seq }) => seq),
      points.map(({ segmentId }) => segmentId),
      points.map(({ recordedAt }) => recordedAt),
      points.map(({ longitude }) => longitude),
      points.map(({ latitude }) => latitude),
      points.map(({ accuracyM }) => accuracyM),
      '2000-01-01T00:00:00.000Z',
      SOURCE_REVISION,
    ]);

    const edgeRows = await client.query<EdgeRow>(EDGE_SQL, [IDS.org, IDS.run, SOURCE_REVISION, algorithmVersion]);
    const summaryResult = await client.query<SummaryRow>(SUMMARY_SQL, [
      IDS.org,
      IDS.run,
      SOURCE_REVISION,
      algorithmVersion,
    ]);
    const summary = summaryResult.rows[0];
    if (summary === undefined) {
      throw new Error('The production summary calculation returned no row');
    }

    const edgeResults: EdgeResult[] = edgeRows.rows.map((row) => ({
      accepted: row.accepted,
      distanceM: row.distance_m,
      durationS: row.duration_s,
      rejectionReason: row.rejection_reason,
    }));
    const hasAccuracy = trace.points.every((point) => point.accuracyM !== undefined);
    const edges = edgeStatistics(
      edgeResults,
      hasAccuracy ? trace.points.map((point) => point.accuracyM ?? 0) : undefined,
    );
    const mismatches = consistencyMismatches(edges, summary);

    const acceptedVertexCount = summary.accepted_vertex_count ?? 0;
    const referenceM = trace.referenceDistanceM ?? null;
    const canonicalM = summary.distance_m;
    return {
      algorithmVersion,
      characteristics: sourceCharacteristics(trace),
      consistency: { agreesWithProductionSummary: mismatches.length === 0, mismatches },
      contentSha256: createHash('sha256').update(contentText ?? JSON.stringify(trace)).digest('hex'),
      display: {
        acceptedChainCount: summary.accepted_chain_count ?? 0,
        acceptedLengthM: summary.accepted_length_m,
        acceptedVertexCount,
        maxDeviationM: summary.max_deviation_m,
        reductionPercent:
          summary.simplified_vertex_count === null || acceptedVertexCount === 0
            ? null
            : (1 - summary.simplified_vertex_count / acceptedVertexCount) * 100,
        simplifiedLengthM: summary.simplified_length_m,
        simplifiedVertexCount: summary.simplified_vertex_count,
        toleranceM: DISPLAY_TOLERANCE_M,
      },
      distance: {
        canonicalM,
        canonicalVsReferencePercent: referenceM === null ? null : ((canonicalM - referenceM) / referenceM) * 100,
        differenceM: canonicalM - edges.rawDistanceM,
        differencePercent: percentOf(canonicalM - edges.rawDistanceM, edges.rawDistanceM),
        rawObservedM: edges.rawDistanceM,
        rawVsReferencePercent: referenceM === null ? null : ((edges.rawDistanceM - referenceM) / referenceM) * 100,
        referenceM,
      },
      edges,
      name,
      replay: { accuracyAssumed: !hasAccuracy, assumedAccuracyM: hasAccuracy ? null : ASSUMED_ACCURACY_M },
      scenario: trace.scenario,
      sourceKind: trace.source,
    };
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
