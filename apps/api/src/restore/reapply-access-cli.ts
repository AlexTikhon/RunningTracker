import { Pool } from 'pg';

import { loadAccessJournal, reapplyAccessRestrictions } from './reapply-access.js';

const usage =
  'Usage: RESTORE_DATABASE_URL=postgres://running_tracker_owner:...@host/db ' +
  'npm run restore:reapply-access -- --journal-dir <directory>';

export function parseReapplyAccessArguments(argv: readonly string[]): { journalDir: string } {
  if (argv.length !== 2 || argv[0] !== '--journal-dir' || !argv[1]) {
    throw new Error(usage);
  }
  return { journalDir: argv[1] };
}

export interface ReapplyAccessCliDependencies {
  argv: readonly string[];
  createPool?: (connectionString: string) => Pick<Pool, 'connect' | 'end' | 'query'>;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * Restore-time entry point. It talks to the RESTORED database as the object
 * owner while the application is still offline, prints only counts and outcome
 * names (never identifiers), and returns a process exit code. It removes access
 * and never adds it.
 */
export async function runReapplyAccessCli(dependencies: ReapplyAccessCliDependencies): Promise<number> {
  const log = dependencies.log ?? ((line: string) => console.info(line));
  const { journalDir } = parseReapplyAccessArguments(dependencies.argv);
  const connectionString = dependencies.env.RESTORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(`RESTORE_DATABASE_URL is required. ${usage}`);
  }

  const journal = await loadAccessJournal(journalDir);
  const pool =
    dependencies.createPool?.(connectionString) ??
    new Pool({
      application_name: 'running-tracker-restore-reapply-access',
      connectionString,
      max: 1,
    });
  try {
    const identity = await pool.query<{ database_name: string; role_name: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    if (identity.rows[0]?.role_name !== 'running_tracker_owner') {
      throw new Error('RESTORE_DATABASE_URL must authenticate as running_tracker_owner');
    }
    const report = await reapplyAccessRestrictions(pool, journal);
    log(`database: ${identity.rows[0].database_name}`);
    log(`journal files: ${report.files}`);
    log(`journal entries: ${report.entries}`);
    for (const [outcome, count] of Object.entries(report.outcomes)) {
      log(`${outcome}: ${count}`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}
