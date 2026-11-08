import type { Pool } from 'pg';

import type { Clock } from '../clock.js';

export const OIDC_LOGIN_PURGE_BATCH_LIMIT = 500;

export type OidcLoginPurgeCycleResult = { status: 'idle' } | { purgedCount: number; status: 'purged' };

/**
 * Removes at most one bounded batch of pending OIDC logins that expired at or before now (ADR-0081). An expired attempt
 * already completes nothing; this only keeps the table small. Every reservation also sweeps expired rows under the
 * capacity lock, so a failing purge never blocks sign-in, and a live attempt is never touched.
 */
export async function runOidcLoginPurgeOnce(
  pool: Pick<Pool, 'query'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<OidcLoginPurgeCycleResult> {
  const now = clock.utcNow();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }
  const result = await pool.query<{ purged_count: unknown }>(
    'SELECT app_private.purge_expired_oidc_logins($1, $2) AS purged_count',
    [now.toISOString(), OIDC_LOGIN_PURGE_BATCH_LIMIT],
  );
  const purged = result.rows.length === 1 ? result.rows[0]?.purged_count : undefined;
  if (typeof purged !== 'number' || !Number.isInteger(purged) || purged < 0 || purged > OIDC_LOGIN_PURGE_BATCH_LIMIT) {
    throw new Error('The pending login purge function returned an invalid result');
  }
  return purged === 0 ? { status: 'idle' } : { purgedCount: purged, status: 'purged' };
}
