import type { Pool } from 'pg';

import type { Clock } from '../clock.js';

export const SESSION_PURGE_BATCH_LIMIT = 500;

export type SessionPurgeCycleResult = { status: 'idle' } | { purgedCount: number; status: 'purged' };

/**
 * Removes at most one bounded batch of sessions that expired at or before now (ADR-0080). Expired sessions already
 * authenticate nothing; this only keeps the table small and drops the identity-to-session link once it is useless.
 * Sign-in also sweeps expired rows under the capacity lock, so a failing purge never blocks sign-in.
 */
export async function runSessionPurgeOnce(
  pool: Pick<Pool, 'query'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<SessionPurgeCycleResult> {
  const now = clock.utcNow();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }
  const result = await pool.query<{ purged_count: unknown }>(
    'SELECT app_private.purge_expired_auth_sessions($1, $2) AS purged_count',
    [now.toISOString(), SESSION_PURGE_BATCH_LIMIT],
  );
  const purged = result.rows.length === 1 ? result.rows[0]?.purged_count : undefined;
  if (typeof purged !== 'number' || !Number.isInteger(purged) || purged < 0 || purged > SESSION_PURGE_BATCH_LIMIT) {
    throw new Error('The session purge function returned an invalid result');
  }
  return purged === 0 ? { status: 'idle' } : { purgedCount: purged, status: 'purged' };
}
