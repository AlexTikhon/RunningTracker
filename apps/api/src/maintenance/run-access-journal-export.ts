import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import {
  serializeAccessJournalEntries,
  type AccessJournalEntry,
} from './access-journal-format.js';
import type { DeletionJournalSink } from './deletion-journal-sink.js';
import { exportJournalBatchOnce, type JournalExportCycleResult } from './journal-export.js';

export const ACCESS_JOURNAL_EXPORT_BATCH_LIMIT = 500;

export type AccessJournalExportCycleResult = JournalExportCycleResult;

interface AccessJournalRow {
  can_read_history: boolean | null;
  can_read_live: boolean | null;
  changed_at: Date;
  journal_seq: string;
  kind: string;
  org_id: string;
  run_id: string | null;
  user_id: string;
}

function invalidResult(): Error {
  return new Error('The access journal returned an invalid result');
}

/** Maps a claimed row to an entry; the strict serializer re-validates the shape before any write. */
function toEntry(row: AccessJournalRow): AccessJournalEntry {
  if (!(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) {
    throw invalidResult();
  }
  const common = {
    changedAt: row.changed_at.toISOString(),
    orgId: row.org_id,
    seq: row.journal_seq,
    userId: row.user_id,
    v: 1 as const,
  };
  if (row.kind === 'membership_deactivated' && row.run_id === null) {
    return { ...common, kind: row.kind };
  }
  if (row.kind === 'share_revoked' && row.run_id !== null) {
    return { ...common, kind: row.kind, runId: row.run_id };
  }
  if (
    row.kind === 'share_narrowed' &&
    row.run_id !== null &&
    typeof row.can_read_history === 'boolean' &&
    typeof row.can_read_live === 'boolean'
  ) {
    return {
      ...common,
      canReadHistory: row.can_read_history,
      canReadLive: row.can_read_live,
      kind: row.kind,
      runId: row.run_id,
    };
  }
  throw invalidResult();
}

/**
 * Exports at most one bounded batch of access restrictions to the same sink the
 * deletion journal uses. Same durability contract as the deletion exporter: the
 * rows leave the database only after the file is durable.
 */
export function runAccessJournalExportOnce(
  pool: Pick<Pool, 'connect'>,
  sink: Pick<DeletionJournalSink, 'write'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<AccessJournalExportCycleResult> {
  return exportJournalBatchOnce<AccessJournalRow, AccessJournalEntry>(pool, sink, clock, {
    ackSql: 'SELECT app_private.ack_access_journal_batch($1::bigint[]) AS acknowledged',
    batchLimit: ACCESS_JOURNAL_EXPORT_BATCH_LIMIT,
    claimSql: `SELECT journal_seq::text AS journal_seq, org_id, kind, user_id, run_id,
                      can_read_history, can_read_live, changed_at
               FROM app_private.claim_access_journal_batch($1)`,
    filePrefix: 'access-journal',
    label: 'access',
    serialize: serializeAccessJournalEntries,
    toEntry,
  });
}
