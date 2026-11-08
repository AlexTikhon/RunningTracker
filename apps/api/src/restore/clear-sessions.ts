import type { Pool } from 'pg';

/**
 * Removes every stored session from a restored database (ADR-0080) so that no session cookie issued before the
 * restore authenticates afterwards, revoked or not, whatever backup was restored: application backups already carry
 * no session rows, but an older or hand-made dump might. Everyone signs in again once the database is reopened.
 * The pool must authenticate as the object owner; the database function is granted to nobody else. Idempotent: a
 * second run removes nothing.
 */
export async function clearRestoredSessions(pool: Pick<Pool, 'query'>): Promise<{ cleared: number; remaining: number }> {
  const result = await pool.query<{ cleared: string }>('SELECT app_private.clear_auth_sessions()::text AS cleared');
  const cleared = Number(result.rows[0]?.cleared);
  if (result.rows.length !== 1 || !Number.isSafeInteger(cleared) || cleared < 0) {
    throw new Error('The session clearing function returned an invalid result');
  }
  const left = await pool.query<{ remaining: string }>(
    'SELECT count(*)::text AS remaining FROM app_private.auth_sessions',
  );
  const remaining = Number(left.rows[0]?.remaining);
  if (remaining !== 0) {
    throw new Error('Sessions remain after clearing; do not reopen the database');
  }
  return { cleared, remaining };
}
