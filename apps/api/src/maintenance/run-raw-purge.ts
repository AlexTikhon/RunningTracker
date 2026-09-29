import type { Pool } from 'pg';

import type { Clock } from '../clock.js';

export const RUN_RAW_PURGE_BATCH_LIMIT = 1_000;

type RawState = 'available' | 'purged' | 'purging';

interface RawPurgeRow {
  completed: boolean;
  current_raw_state: string;
  deleted_count: number;
  has_more: boolean;
  previous_raw_state: string;
}

interface RawPurgeCandidateRow {
  org_id: string;
  run_id: string;
}

export interface RunRawPurgeResult {
  completed: boolean;
  currentRawState: RawState;
  deletedCount: number;
  hasMore: boolean;
  previousRawState: RawState;
}

export type RunRawPurgeCycleResult =
  | { status: 'blocked' | 'idle' }
  | (RunRawPurgeResult & {
      orgId: string;
      runId: string;
      status: 'completed' | 'partial';
    });

const candidateScanLimit = 1_000;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isRawState(value: string): value is RawState {
  return value === 'available' || value === 'purging' || value === 'purged';
}

function validateResult(row: RawPurgeRow | undefined): RunRawPurgeResult {
  if (
    row === undefined ||
    !isRawState(row.previous_raw_state) ||
    !isRawState(row.current_raw_state) ||
    typeof row.deleted_count !== 'number' ||
    !Number.isInteger(row.deleted_count) ||
    row.deleted_count < 0 ||
    row.deleted_count > RUN_RAW_PURGE_BATCH_LIMIT ||
    typeof row.completed !== 'boolean' ||
    typeof row.has_more !== 'boolean' ||
    row.completed === row.has_more ||
    row.completed !== (row.current_raw_state === 'purged') ||
    row.has_more !== (row.current_raw_state === 'purging') ||
    (row.previous_raw_state === 'purged' &&
      (row.current_raw_state !== 'purged' || row.deleted_count !== 0)) ||
    row.current_raw_state === 'available'
  ) {
    throw new Error('The raw purge function returned an invalid result');
  }

  return {
    completed: row.completed,
    currentRawState: row.current_raw_state,
    deletedCount: row.deleted_count,
    hasMore: row.has_more,
    previousRawState: row.previous_raw_state,
  };
}

export async function purgeRunRawPointsBatch(
  pool: Pick<Pool, 'query'>,
  orgId: string,
  runId: string,
  clock: Pick<Clock, 'utcNow'>,
): Promise<RunRawPurgeResult> {
  const effectiveNow = effectiveNowIso(clock);
  return purgeRunRawPointsBatchAt(pool, orgId, runId, effectiveNow);
}

function effectiveNowIso(clock: Pick<Clock, 'utcNow'>): string {
  const effectiveNow = clock.utcNow();
  if (!Number.isFinite(effectiveNow.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }
  return effectiveNow.toISOString();
}

function validateCandidate(
  row: RawPurgeCandidateRow | undefined,
): RawPurgeCandidateRow | undefined {
  if (row === undefined) return undefined;
  if (!canonicalUuidPattern.test(row.org_id) || !canonicalUuidPattern.test(row.run_id)) {
    throw new Error('The raw purge candidate function returned an invalid result');
  }
  return row;
}

async function purgeRunRawPointsBatchAt(
  pool: Pick<Pool, 'query'>,
  orgId: string,
  runId: string,
  effectiveNow: string,
): Promise<RunRawPurgeResult> {
  const result = await pool.query<RawPurgeRow>(
    `SELECT previous_raw_state, current_raw_state, deleted_count, completed, has_more
     FROM app_private.purge_run_raw_points_batch($1, $2, $3, $4)`,
    [orgId, runId, RUN_RAW_PURGE_BATCH_LIMIT, effectiveNow],
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new Error('The raw purge function returned an invalid result');
  }
  return validateResult(result.rows[0]);
}

export async function runRawPurgeOnce(
  pool: Pick<Pool, 'connect'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<RunRawPurgeCycleResult> {
  const effectiveNow = effectiveNowIso(clock);
  const client = await pool.connect();
  let releaseWithError = false;
  let transactionActive = false;
  let commitStarted = false;
  try {
    await client.query('BEGIN');
    transactionActive = true;

    const candidates = await client.query<RawPurgeCandidateRow>(
      `SELECT org_id, run_id
       FROM app_private.claim_run_raw_purge_candidate($1, $2)`,
      [effectiveNow, candidateScanLimit],
    );
    const candidate = validateCandidate(candidates.rows[0]);
    if (candidate === undefined) {
      const blocked = await client.query<{ blocked: boolean }>(
        `SELECT app_private.has_overdue_raw_purge_summary_blocker($1) AS blocked`,
        [effectiveNow],
      );
      if (typeof blocked.rows[0]?.blocked !== 'boolean') {
        throw new Error('The raw purge backlog function returned an invalid result');
      }
      commitStarted = true;
      await client.query('COMMIT');
      transactionActive = false;
      return { status: blocked.rows[0].blocked ? 'blocked' : 'idle' };
    }

    const purge = await purgeRunRawPointsBatchAt(
      client,
      candidate.org_id,
      candidate.run_id,
      effectiveNow,
    );
    commitStarted = true;
    await client.query('COMMIT');
    transactionActive = false;
    return {
      ...purge,
      orgId: candidate.org_id,
      runId: candidate.run_id,
      status: purge.completed ? 'completed' : 'partial',
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
