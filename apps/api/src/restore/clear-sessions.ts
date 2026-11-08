import type { Pool } from 'pg';

export interface ClearedTable {
  cleared: number;
  remaining: number;
}

/** What restore:clear-sessions removed, per kind of authentication state. Counts only. */
export interface ClearedAuthentication {
  pendingLogins: ClearedTable;
  sessions: ClearedTable;
}

async function clearTable(
  pool: Pick<Pool, 'query'>,
  clearFunction: string,
  table: string,
  label: string,
): Promise<ClearedTable> {
  const result = await pool.query<{ cleared: string }>(`SELECT ${clearFunction}()::text AS cleared`);
  const cleared = Number(result.rows[0]?.cleared);
  if (result.rows.length !== 1 || !Number.isSafeInteger(cleared) || cleared < 0) {
    throw new Error(`The ${label} clearing function returned an invalid result`);
  }
  const left = await pool.query<{ remaining: string }>(`SELECT count(*)::text AS remaining FROM ${table}`);
  const remaining = Number(left.rows[0]?.remaining);
  if (remaining !== 0) {
    throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} remain after clearing; do not reopen the database`);
  }
  return { cleared, remaining };
}

/**
 * Removes every stored session (ADR-0080) and every pending OIDC login (ADR-0081) from a restored database, so that no
 * session cookie issued before the restore authenticates afterwards, revoked or not, and no sign-in started before it
 * can complete, whatever backup was restored: application backups already carry neither, but an older or hand-made
 * dump might. Everyone signs in again once the database is reopened. The pool must authenticate as the object owner;
 * the database functions are granted to nobody else. Idempotent: a second run removes nothing. Sessions are cleared
 * first, as before; a failure on either fails the whole step, and a rerun is safe.
 */
export async function clearRestoredAuthentication(pool: Pick<Pool, 'query'>): Promise<ClearedAuthentication> {
  const sessions = await clearTable(pool, 'app_private.clear_auth_sessions', 'app_private.auth_sessions', 'sessions');
  const pendingLogins = await clearTable(
    pool,
    'app_private.clear_oidc_pending_logins',
    'app_private.oidc_pending_logins',
    'pending logins',
  );
  return { pendingLogins, sessions };
}
