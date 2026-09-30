import type { Pool } from 'pg';

import type { Clock } from '../clock.js';

export const RUN_TOMBSTONE_RECLAIM_BATCH_LIMIT = 500;

interface TombstoneReclaimRow {
  reclaimed_count: number;
}

export type RunTombstoneReclaimCycleResult =
  | { status: 'idle' }
  | { reclaimedCount: number; status: 'reclaimed' };

function effectiveNowIso(clock: Pick<Clock, 'utcNow'>): string {
  const effectiveNow = clock.utcNow();
  if (!Number.isFinite(effectiveNow.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }
  return effectiveNow.toISOString();
}

function validateReclaimedCount(row: TombstoneReclaimRow | undefined): number {
  if (
    row === undefined ||
    typeof row.reclaimed_count !== 'number' ||
    !Number.isInteger(row.reclaimed_count) ||
    row.reclaimed_count < 0 ||
    row.reclaimed_count > RUN_TOMBSTONE_RECLAIM_BATCH_LIMIT
  ) {
    throw new Error('The tombstone reclaim function returned an invalid result');
  }
  return row.reclaimed_count;
}

/**
 * Reclaims at most one bounded batch of expired tombstones. The database
 * function is a single atomic statement, so an autocommit query is already one
 * transaction: a failure leaves every marker in place and a retry is safe.
 * Only a marker that this call removes makes its run ID reusable.
 */
export async function runTombstoneReclaimOnce(
  pool: Pick<Pool, 'query'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<RunTombstoneReclaimCycleResult> {
  const effectiveNow = effectiveNowIso(clock);
  const result = await pool.query<TombstoneReclaimRow>(
    `SELECT app_private.reclaim_expired_run_tombstones($1, $2) AS reclaimed_count`,
    [effectiveNow, RUN_TOMBSTONE_RECLAIM_BATCH_LIMIT],
  );
  if (result.rows.length !== 1) {
    throw new Error('The tombstone reclaim function returned an invalid result');
  }
  const reclaimedCount = validateReclaimedCount(result.rows[0]);
  return reclaimedCount === 0 ? { status: 'idle' } : { reclaimedCount, status: 'reclaimed' };
}
