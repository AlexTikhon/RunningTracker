import type { Pool } from 'pg';

import { listErasureLedgerFiles, readDeletionJournalFile } from '../maintenance/deletion-journal-sink.js';
import { parseErasureLedgerFile, type ErasureLedgerEntry } from '../maintenance/erasure-ledger-format.js';

export const reapplyErasureOutcomes = ['absent', 'erased', 'skipped_different_record'] as const;

export type ReapplyErasureOutcome = (typeof reapplyErasureOutcomes)[number];

export interface ReapplyErasuresReport {
  entries: number;
  files: number;
  outcomes: Record<ReapplyErasureOutcome, number>;
}

function isOutcome(value: unknown): value is ReapplyErasureOutcome {
  return (reapplyErasureOutcomes as readonly unknown[]).includes(value);
}

/** Reads every ledger file before touching the database, so a bad file changes nothing. */
export async function loadErasureLedger(
  directory: string,
): Promise<{ entries: ErasureLedgerEntry[]; files: number }> {
  const fileNames = await listErasureLedgerFiles(directory);
  const entries: ErasureLedgerEntry[] = [];
  for (const fileName of fileNames) {
    entries.push(...parseErasureLedgerFile(fileName, await readDeletionJournalFile(directory, fileName)));
  }
  return { entries, files: fileNames.length };
}

/**
 * Replays exported erasures (ADR-0073) on a restored database that is not yet open to the application. Each entry is
 * its own short transaction, so an interrupted replay is resumed by running it again: replay is idempotent (an entry
 * already applied reports `absent`). The pool must authenticate as the object owner; the database function is granted
 * to nobody else. No clock is involved: the record's creation instant, not "now", identifies what to erase.
 */
export async function reapplyErasures(
  pool: Pick<Pool, 'connect'>,
  ledger: { entries: readonly ErasureLedgerEntry[]; files: number },
): Promise<ReapplyErasuresReport> {
  const outcomes = Object.fromEntries(reapplyErasureOutcomes.map((name) => [name, 0])) as Record<
    ReapplyErasureOutcome,
    number
  >;
  const client = await pool.connect();
  let releaseWithError = false;
  try {
    for (const entry of ledger.entries) {
      await client.query('BEGIN');
      try {
        const result = await client.query<{ outcome: unknown }>(
          'SELECT app_private.reapply_erasure($1, $2, $3, $4, $5) AS outcome',
          [entry.entityType, entry.orgId, entry.recordId, entry.ownerUserId, entry.recordCreatedAt],
        );
        const outcome = result.rows[0]?.outcome;
        if (!isOutcome(outcome)) {
          throw new Error('The erasure replay function returned an invalid result');
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
    return { entries: ledger.entries.length, files: ledger.files, outcomes };
  } catch (error) {
    releaseWithError = true;
    throw error;
  } finally {
    client.release(releaseWithError);
  }
}
