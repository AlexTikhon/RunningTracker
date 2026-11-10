import { Pool } from 'pg';

import { guardBorrowedClients } from '../database/borrowed-client-guard.js';
import { loadErasureLedger, reapplyErasures } from './reapply-erasures.js';

const usage =
  'Usage: RESTORE_DATABASE_URL=postgres://running_tracker_owner:...@host/db ' +
  'npm run restore:reapply-erasures -- --journal-dir <directory>';

export function parseReapplyErasuresArguments(argv: readonly string[]): { journalDir: string } {
  if (argv.length !== 2 || argv[0] !== '--journal-dir' || !argv[1]) {
    throw new Error(usage);
  }
  return { journalDir: argv[1] };
}

export interface ReapplyErasuresCliDependencies {
  argv: readonly string[];
  createPool?: (connectionString: string) => Pick<Pool, 'connect' | 'end' | 'query'>;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * Restore-time entry point for the erasure ledger (ADR-0073). Same contract as restore:reapply-deletions: the RESTORED
 * database, as the object owner, with the application offline; it prints only counts and outcome names, never
 * identifiers, and returns a process exit code.
 */
export async function runReapplyErasuresCli(dependencies: ReapplyErasuresCliDependencies): Promise<number> {
  const log = dependencies.log ?? ((line: string) => console.info(line));
  const { journalDir } = parseReapplyErasuresArguments(dependencies.argv);
  const connectionString = dependencies.env.RESTORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(`RESTORE_DATABASE_URL is required. ${usage}`);
  }

  const ledger = await loadErasureLedger(journalDir);
  const pool =
    dependencies.createPool?.(connectionString) ??
    guardBorrowedClients(new Pool({ application_name: 'running-tracker-restore-erasures', connectionString, max: 1 }), 'running-tracker-restore-erasures');
  try {
    const identity = await pool.query<{ database_name: string; role_name: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    if (identity.rows[0]?.role_name !== 'running_tracker_owner') {
      throw new Error('RESTORE_DATABASE_URL must authenticate as running_tracker_owner');
    }
    const report = await reapplyErasures(pool, ledger);
    log(`database: ${identity.rows[0].database_name}`);
    log(`ledger files: ${report.files}`);
    log(`ledger entries: ${report.entries}`);
    for (const [outcome, count] of Object.entries(report.outcomes)) {
      log(`${outcome}: ${count}`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}
