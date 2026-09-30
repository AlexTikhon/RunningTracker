import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import {
  serializeDeletionJournalEntries,
  type DeletionJournalEntry,
} from './deletion-journal-format.js';
import type { DeletionJournalSink } from './deletion-journal-sink.js';

export const DELETION_JOURNAL_EXPORT_BATCH_LIMIT = 500;

interface JournalRow {
  deleted_at: Date;
  journal_seq: string;
  org_id: string;
  owner_user_id: string;
  run_id: string;
}

export type DeletionJournalExportCycleResult =
  | { status: 'idle' }
  | { exportedCount: number; fileName: string; status: 'exported' };

function toEntry(row: JournalRow): DeletionJournalEntry {
  if (!(row.deleted_at instanceof Date) || !Number.isFinite(row.deleted_at.getTime())) {
    throw new Error('The deletion journal returned an invalid result');
  }
  return {
    deletedAt: row.deleted_at.toISOString(),
    orgId: row.org_id,
    ownerUserId: row.owner_user_id,
    runId: row.run_id,
    seq: row.journal_seq,
    v: 1,
  };
}

function exportFileName(exportedAt: Date, first: string, last: string): string {
  // The source sequence restarts after a restore, and two exporters may run,
  // so the sequence range alone is not unique: the export instant and a random
  // suffix keep every file name distinct and never overwrite an older file.
  const stamp = exportedAt.toISOString().replace(/[-:]/gu, '').replace('.', '');
  return `deletion-journal-${stamp}-${first}-${last}-${randomUUID().slice(0, 8)}.ndjson`;
}

/**
 * Exports at most one bounded batch. One transaction spans the claim, the
 * durable external write, and the acknowledgement, so rows leave the database
 * only after the file is durable: a failure anywhere earlier rolls back and the
 * rows stay. A crash after the write but before COMMIT re-exports the batch
 * later (at-least-once); reapplication is idempotent.
 */
export async function runDeletionJournalExportOnce(
  pool: Pick<Pool, 'connect'>,
  sink: Pick<DeletionJournalSink, 'write'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<DeletionJournalExportCycleResult> {
  const exportedAt = clock.utcNow();
  if (!Number.isFinite(exportedAt.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }

  const client = await pool.connect();
  let releaseWithError = false;
  let transactionActive = false;
  let commitStarted = false;
  try {
    await client.query('BEGIN');
    transactionActive = true;

    const claimed = await client.query<JournalRow>(
      `SELECT journal_seq::text AS journal_seq, org_id, run_id, owner_user_id, deleted_at
       FROM app_private.claim_deletion_journal_batch($1)`,
      [DELETION_JOURNAL_EXPORT_BATCH_LIMIT],
    );
    if (claimed.rows.length > DELETION_JOURNAL_EXPORT_BATCH_LIMIT) {
      throw new Error('The deletion journal returned an invalid result');
    }
    if (claimed.rows.length === 0) {
      commitStarted = true;
      await client.query('COMMIT');
      transactionActive = false;
      return { status: 'idle' };
    }

    const entries = claimed.rows.map(toEntry);
    const first = entries[0]!.seq;
    const last = entries[entries.length - 1]!.seq;
    const fileName = exportFileName(exportedAt, first, last);
    await sink.write(fileName, serializeDeletionJournalEntries(entries));

    const acknowledged = await client.query<{ acknowledged: number }>(
      'SELECT app_private.ack_deletion_journal_batch($1::bigint[]) AS acknowledged',
      [entries.map((entry) => entry.seq)],
    );
    if (acknowledged.rows[0]?.acknowledged !== entries.length) {
      throw new Error('The deletion journal acknowledgement did not match the exported batch');
    }

    commitStarted = true;
    await client.query('COMMIT');
    transactionActive = false;
    return { exportedCount: entries.length, fileName, status: 'exported' };
  } catch (error) {
    if (transactionActive && !commitStarted) {
      try {
        await client.query('ROLLBACK');
        transactionActive = false;
      } catch {
        releaseWithError = true;
      }
    } else {
      releaseWithError = true;
    }
    throw error;
  } finally {
    if (releaseWithError) {
      client.release(true);
    } else {
      client.release();
    }
  }
}
