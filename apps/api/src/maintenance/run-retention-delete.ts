import type { Pool } from 'pg';

import type { Clock } from '../clock.js';

interface RetentionCandidateRow {
  org_id: string;
  run_id: string;
}

interface RetentionDeletionRow {
  archive_revision: string;
}

export type RunRetentionDeleteCycleResult =
  | { status: 'idle' }
  | {
      archiveRevision: string;
      orgId: string;
      runId: string;
      status: 'deleted';
    };

const candidateScanLimit = 1_000;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function effectiveNowIso(clock: Pick<Clock, 'utcNow'>): string {
  const effectiveNow = clock.utcNow();
  if (!Number.isFinite(effectiveNow.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }
  return effectiveNow.toISOString();
}

function validateCandidate(
  row: RetentionCandidateRow | undefined,
): RetentionCandidateRow | undefined {
  if (row === undefined) return undefined;
  if (!canonicalUuidPattern.test(row.org_id) || !canonicalUuidPattern.test(row.run_id)) {
    throw new Error('The run deletion candidate function returned an invalid result');
  }
  return row;
}

function validateArchiveRevision(row: RetentionDeletionRow | undefined): string {
  if (row === undefined || typeof row.archive_revision !== 'string' || !/^\d+$/u.test(row.archive_revision)) {
    throw new Error('The run deletion function returned an invalid result');
  }
  return row.archive_revision;
}

export async function runRetentionDeleteOnce(
  pool: Pick<Pool, 'connect'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<RunRetentionDeleteCycleResult> {
  const effectiveNow = effectiveNowIso(clock);
  const client = await pool.connect();
  let releaseWithError = false;
  let transactionActive = false;
  let commitStarted = false;
  try {
    await client.query('BEGIN');
    transactionActive = true;

    const candidates = await client.query<RetentionCandidateRow>(
      `SELECT org_id, run_id
       FROM app_private.claim_run_deletion_candidate($1, $2)`,
      [effectiveNow, candidateScanLimit],
    );
    const candidate = validateCandidate(candidates.rows[0]);
    if (candidate === undefined) {
      commitStarted = true;
      await client.query('COMMIT');
      transactionActive = false;
      return { status: 'idle' };
    }

    const deletion = await client.query<RetentionDeletionRow>(
      `SELECT app_private.delete_run_for_retention($1, $2, $3)::text AS archive_revision`,
      [candidate.org_id, candidate.run_id, effectiveNow],
    );
    const archiveRevision = validateArchiveRevision(deletion.rows[0]);
    commitStarted = true;
    await client.query('COMMIT');
    transactionActive = false;
    return {
      archiveRevision,
      orgId: candidate.org_id,
      runId: candidate.run_id,
      status: 'deleted',
    };
  } catch (error) {
    if (transactionActive && !commitStarted) {
      try {
        await client.query('ROLLBACK');
        transactionActive = false;
      } catch {
        releaseWithError = true;
      }
    } else {
      releaseWithError = true;
    }
    throw error;
  } finally {
    if (releaseWithError) {
      client.release(true);
    } else {
      client.release();
    }
  }
}
