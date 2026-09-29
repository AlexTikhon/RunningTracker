import type { Pool } from 'pg';

export const RUN_RAW_PURGE_BATCH_LIMIT = 1_000;

type RawState = 'available' | 'purged' | 'purging';

interface RawPurgeRow {
  completed: boolean;
  current_raw_state: string;
  deleted_count: number;
  has_more: boolean;
  previous_raw_state: string;
}

export interface RunRawPurgeResult {
  completed: boolean;
  currentRawState: RawState;
  deletedCount: number;
  hasMore: boolean;
  previousRawState: RawState;
}

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
): Promise<RunRawPurgeResult> {
  const result = await pool.query<RawPurgeRow>(
    `SELECT previous_raw_state, current_raw_state, deleted_count, completed, has_more
     FROM app_private.purge_run_raw_points_batch($1, $2, $3)`,
    [orgId, runId, RUN_RAW_PURGE_BATCH_LIMIT],
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new Error('The raw purge function returned an invalid result');
  }
  return validateResult(result.rows[0]);
}
