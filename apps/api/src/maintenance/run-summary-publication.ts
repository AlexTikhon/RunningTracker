import type { Pool } from 'pg';

import type { Clock } from '../clock.js';

interface SummaryCandidateRow {
  algorithm_version: string;
  org_id: string;
  run_id: string;
  source_revision: string;
}

interface SummaryPublicationRow {
  archive_revision: string | null;
  published: boolean;
}

export type SummaryPublicationResult =
  | { status: 'idle' }
  | {
      algorithmVersion: string;
      archiveRevision: string | null;
      orgId: string;
      runId: string;
      sourceRevision: string;
      status: 'published' | 'stale';
    };

const publishCandidateSql = `
  WITH calculation AS MATERIALIZED (
    SELECT
      calculated.distance_m,
      calculated.observed_duration_s,
      calculated.quality_stats,
      calculated.accepted_chains
    FROM app_private.calculate_run_summary($1, $2, $3, $4) AS calculated
  ),
  prepared AS MATERIALIZED (
    SELECT
      calculation.distance_m,
      calculation.observed_duration_s,
      calculation.quality_stats,
      CASE
        WHEN calculation.accepted_chains IS NULL THEN NULL
        ELSE app_private.simplify_display_geometry(
          calculation.accepted_chains,
          $4
        )
      END AS display_geom
    FROM calculation
  )
  SELECT publication.published, publication.archive_revision
  FROM prepared
  CROSS JOIN LATERAL app_private.publish_run_summary(
    $1,
    $2,
    $3,
    $4,
    prepared.display_geom,
    prepared.distance_m,
    prepared.observed_duration_s,
    prepared.quality_stats,
    $5
  ) AS publication`;

function validateCandidate(row: SummaryCandidateRow | undefined): SummaryCandidateRow | undefined {
  if (row === undefined) {
    return undefined;
  }
  if (
    typeof row.org_id !== 'string' ||
    typeof row.run_id !== 'string' ||
    typeof row.source_revision !== 'string' ||
    !/^\d+$/.test(row.source_revision) ||
    typeof row.algorithm_version !== 'string' ||
    row.algorithm_version.length === 0
  ) {
    throw new Error('The summary candidate function returned an invalid result');
  }
  return row;
}

export async function runSummaryPublicationOnce(
  pool: Pick<Pool, 'query'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<SummaryPublicationResult> {
  const effectiveNow = clock.utcNow();
  if (!Number.isFinite(effectiveNow.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }

  const candidates = await pool.query<SummaryCandidateRow>(
    `SELECT org_id, run_id, source_revision, algorithm_version
     FROM app_private.find_stale_run_summaries(1)`,
  );
  const candidate = validateCandidate(candidates.rows[0]);
  if (candidate === undefined) {
    return { status: 'idle' };
  }

  const publication = await pool.query<SummaryPublicationRow>(publishCandidateSql, [
    candidate.org_id,
    candidate.run_id,
    candidate.source_revision,
    candidate.algorithm_version,
    effectiveNow.toISOString(),
  ]);
  const result = publication.rows[0];
  if (
    result === undefined ||
    typeof result.published !== 'boolean' ||
    (result.archive_revision !== null &&
      (typeof result.archive_revision !== 'string' ||
        !/^\d+$/.test(result.archive_revision)))
  ) {
    throw new Error('The summary publication function returned an invalid result');
  }

  return {
    algorithmVersion: candidate.algorithm_version,
    archiveRevision: result.archive_revision,
    orgId: candidate.org_id,
    runId: candidate.run_id,
    sourceRevision: candidate.source_revision,
    status: result.published ? 'published' : 'stale',
  };
}
