import type { Pool } from 'pg';

import {
  parseAccessJournalFile,
  type AccessJournalEntry,
} from '../maintenance/access-journal-format.js';
import {
  listAccessJournalFiles,
  readDeletionJournalFile,
} from '../maintenance/deletion-journal-sink.js';

export const reapplyAccessOutcomes = [
  'applied',
  'already_applied',
  'skipped_unknown_organization',
] as const;

export type ReapplyAccessOutcome = (typeof reapplyAccessOutcomes)[number];

export interface ReapplyAccessReport {
  entries: number;
  files: number;
  outcomes: Record<ReapplyAccessOutcome, number>;
}

function isOutcome(value: unknown): value is ReapplyAccessOutcome {
  return (reapplyAccessOutcomes as readonly unknown[]).includes(value);
}

/** Reads every access journal file before touching the database, so a bad file changes nothing. */
export async function loadAccessJournal(
  directory: string,
): Promise<{ entries: AccessJournalEntry[]; files: number }> {
  const fileNames = await listAccessJournalFiles(directory);
  const entries: AccessJournalEntry[] = [];
  for (const fileName of fileNames) {
    entries.push(
      ...parseAccessJournalFile(fileName, await readDeletionJournalFile(directory, fileName)),
    );
  }
  return { entries, files: fileNames.length };
}

/**
 * Reapplies exported access restrictions to a restored database that is not yet
 * open to the application. Every entry only ever removes access (see migration
 * 0020), so replaying all of them, in any order and any number of times, can
 * leave the database more restricted than it was but never less. Each entry is
 * its own short transaction, so an interrupted run is resumed by running it
 * again. The pool must authenticate as the object owner; the database function
 * is granted to nobody else.
 */
export async function reapplyAccessRestrictions(
  pool: Pick<Pool, 'connect'>,
  journal: { entries: readonly AccessJournalEntry[]; files: number },
): Promise<ReapplyAccessReport> {
  const outcomes = Object.fromEntries(reapplyAccessOutcomes.map((name) => [name, 0])) as Record<
    ReapplyAccessOutcome,
    number
  >;
  const client = await pool.connect();
  let releaseWithError = false;
  try {
    for (const entry of journal.entries) {
      await client.query('BEGIN');
      try {
        const result = await client.query<{ outcome: unknown }>(
          'SELECT app_private.reapply_access_restriction($1, $2, $3, $4, $5, $6) AS outcome',
          [
            entry.kind,
            entry.orgId,
            entry.userId,
            entry.kind === 'membership_deactivated' ? null : entry.runId,
            entry.kind === 'share_narrowed' ? entry.canReadHistory : null,
            entry.kind === 'share_narrowed' ? entry.canReadLive : null,
          ],
        );
        const outcome = result.rows[0]?.outcome;
        if (!isOutcome(outcome)) {
          throw new Error('The reapplication function returned an invalid result');
        }
        await client.query('COMMIT');
        outcomes[outcome] += 1;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          releaseWithError = true;
        }
        throw error;
      }
    }
    return { entries: journal.entries.length, files: journal.files, outcomes };
  } catch (error) {
    releaseWithError = true;
    throw error;
  } finally {
    if (releaseWithError) {
      client.release(true);
    } else {
      client.release();
    }
  }
}
