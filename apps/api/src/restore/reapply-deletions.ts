import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import {
  parseDeletionJournalFile,
  type DeletionJournalEntry,
} from '../maintenance/deletion-journal-format.js';
import {
  listDeletionJournalFiles,
  readDeletionJournalFile,
} from '../maintenance/deletion-journal-sink.js';

export const reapplyOutcomes = [
  'deleted',
  'expired',
  'marker_present',
  'marker_restored',
  'skipped_newer_run',
  'skipped_unknown_membership',
  'skipped_unknown_organization',
] as const;

export type ReapplyOutcome = (typeof reapplyOutcomes)[number];

export interface ReapplyDeletionsReport {
  entries: number;
  files: number;
  outcomes: Record<ReapplyOutcome, number>;
}

function isReapplyOutcome(value: unknown): value is ReapplyOutcome {
  return (reapplyOutcomes as readonly unknown[]).includes(value);
}

/** Reads every journal file before touching the database, so a bad file changes nothing. */
export async function loadDeletionJournal(
  directory: string,
): Promise<{ entries: DeletionJournalEntry[]; files: number }> {
  const fileNames = await listDeletionJournalFiles(directory);
  const entries: DeletionJournalEntry[] = [];
  for (const fileName of fileNames) {
    entries.push(
      ...parseDeletionJournalFile(fileName, await readDeletionJournalFile(directory, fileName)),
    );
  }
  return { entries, files: fileNames.length };
}

/**
 * Reapplies exported deletions to a restored database that is not yet open to
 * the application. Each entry is its own short transaction, so an interrupted
 * run is resumed by simply running it again: reapplication is idempotent. The
 * pool must authenticate as the object owner; the database function is granted
 * to nobody else.
 */
export async function reapplyDeletions(
  pool: Pick<Pool, 'connect'>,
  clock: Pick<Clock, 'utcNow'>,
  journal: { entries: readonly DeletionJournalEntry[]; files: number },
): Promise<ReapplyDeletionsReport> {
  const effectiveNow = clock.utcNow();
  if (!Number.isFinite(effectiveNow.getTime())) {
    throw new Error('The clock returned an invalid UTC time');
  }

  const outcomes = Object.fromEntries(reapplyOutcomes.map((name) => [name, 0])) as Record<
    ReapplyOutcome,
    number
  >;
  const client = await pool.connect();
  let releaseWithError = false;
  try {
    for (const entry of journal.entries) {
      await client.query('BEGIN');
      try {
        const result = await client.query<{ outcome: unknown }>(
          `SELECT app_private.reapply_journaled_deletion($1, $2, $3, $4, $5) AS outcome`,
          [entry.orgId, entry.runId, entry.ownerUserId, entry.deletedAt, effectiveNow.toISOString()],
        );
        const outcome = result.rows[0]?.outcome;
        if (!isReapplyOutcome(outcome)) {
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
