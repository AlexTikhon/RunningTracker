import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import {
  serializeDeletionJournalEntries,
  type DeletionJournalEntry,
} from './deletion-journal-format.js';
import type { DeletionJournalSink } from './deletion-journal-sink.js';
import { exportJournalBatchOnce, type JournalExportCycleResult } from './journal-export.js';

export const DELETION_JOURNAL_EXPORT_BATCH_LIMIT = 500;

interface JournalRow {
  deleted_at: Date;
  journal_seq: string;
  org_id: string;
  owner_user_id: string;
  run_id: string;
}

export type DeletionJournalExportCycleResult = JournalExportCycleResult;

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

/**
 * Exports at most one bounded batch. One transaction spans the claim, the
 * durable external write, and the acknowledgement, so rows leave the database
 * only after the file is durable: a failure anywhere earlier rolls back and the
 * rows stay. A crash after the write but before COMMIT re-exports the batch
 * later (at-least-once); reapplication is idempotent.
 */
export function runDeletionJournalExportOnce(
  pool: Pick<Pool, 'connect'>,
  sink: Pick<DeletionJournalSink, 'write'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<DeletionJournalExportCycleResult> {
  return exportJournalBatchOnce<JournalRow, DeletionJournalEntry>(pool, sink, clock, {
    ackSql: 'SELECT app_private.ack_deletion_journal_batch($1::bigint[]) AS acknowledged',
    batchLimit: DELETION_JOURNAL_EXPORT_BATCH_LIMIT,
    claimSql: `SELECT journal_seq::text AS journal_seq, org_id, run_id, owner_user_id, deleted_at
               FROM app_private.claim_deletion_journal_batch($1)`,
    filePrefix: 'deletion-journal',
    label: 'deletion',
    serialize: serializeDeletionJournalEntries,
    toEntry,
  });
}
