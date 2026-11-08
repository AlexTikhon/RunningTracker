import { Pool } from 'pg';

import { clearRestoredAuthentication } from './clear-sessions.js';

const usage =
  'Usage: RESTORE_DATABASE_URL=postgres://running_tracker_owner:...@host/db npm run restore:clear-sessions';

export interface ClearSessionsCliDependencies {
  argv: readonly string[];
  createPool?: (connectionString: string) => Pick<Pool, 'end' | 'query'>;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * Restore-time entry point, the last step before a restored database is reopened. It clears all temporary
 * authentication state: stored sessions (ADR-0080) and pending OIDC logins (ADR-0081). The command keeps its ADR-0080
 * name and its first three output lines, so existing runbooks and scripts keep working; the pending-login counts are
 * added as separate lines after them (ADR-0081 compatibility decision). Same contract as the restore:reapply-*
 * commands: the RESTORED database, as the object owner, with the application offline. It prints only the database
 * name and counts, never a digest, user, token or login material, and returns a process exit code.
 */
export async function runClearSessionsCli(dependencies: ClearSessionsCliDependencies): Promise<number> {
  const log = dependencies.log ?? ((line: string) => console.info(line));
  if (dependencies.argv.length !== 0) {
    throw new Error(usage);
  }
  const connectionString = dependencies.env.RESTORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(`RESTORE_DATABASE_URL is required. ${usage}`);
  }
  const pool =
    dependencies.createPool?.(connectionString) ??
    new Pool({ application_name: 'running-tracker-restore-sessions', connectionString, max: 1 });
  try {
    const identity = await pool.query<{ database_name: string; role_name: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    if (identity.rows[0]?.role_name !== 'running_tracker_owner') {
      throw new Error('RESTORE_DATABASE_URL must authenticate as running_tracker_owner');
    }
    const report = await clearRestoredAuthentication(pool);
    log(`database: ${identity.rows[0].database_name}`);
    log(`sessions cleared: ${report.sessions.cleared}`);
    log(`sessions remaining: ${report.sessions.remaining}`);
    log(`pending logins cleared: ${report.pendingLogins.cleared}`);
    log(`pending logins remaining: ${report.pendingLogins.remaining}`);
    return 0;
  } finally {
    await pool.end();
  }
}
