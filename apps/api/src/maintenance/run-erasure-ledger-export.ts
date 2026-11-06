import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import type { DeletionJournalSink } from './deletion-journal-sink.js';
import {
  erasureEntityTypes,
  serializeErasureLedgerEntries,
  type ErasureLedgerEntry,
} from './erasure-ledger-format.js';
import { exportJournalBatchOnce, type JournalExportCycleResult } from './journal-export.js';

export const ERASURE_LEDGER_EXPORT_BATCH_LIMIT = 500;

interface LedgerRow {
  entity_type: string;
  erased_at: string;
  ledger_seq: string;
  org_id: string;
  owner_user_id: string;
  record_created_at: string;
  record_id: string;
}

function toEntry(row: LedgerRow): ErasureLedgerEntry {
  if (!(erasureEntityTypes as readonly string[]).includes(row.entity_type)) {
    throw new Error('The erasure ledger returned an invalid result');
  }
  return {
    entityType: row.entity_type as ErasureLedgerEntry['entityType'],
    erasedAt: row.erased_at,
    orgId: row.org_id,
    ownerUserId: row.owner_user_id,
    recordCreatedAt: row.record_created_at,
    recordId: row.record_id,
    seq: row.ledger_seq,
    v: 1,
  };
}

const utcMicroseconds = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Exports at most one bounded batch of the erasure ledger (ADR-0073) to the same off-host directory as the run
 * deletion journal. Rows leave the database only after the file is durable; a failure anywhere earlier rolls back and
 * the rows stay for the next cycle. Export is at-least-once; replay is idempotent.
 */
export function runErasureLedgerExportOnce(
  pool: Pick<Pool, 'connect'>,
  sink: Pick<DeletionJournalSink, 'write'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<JournalExportCycleResult> {
  return exportJournalBatchOnce<LedgerRow, ErasureLedgerEntry>(pool, sink, clock, {
    ackSql: 'SELECT app_private.ack_erasure_ledger_batch($1::bigint[]) AS acknowledged',
    batchLimit: ERASURE_LEDGER_EXPORT_BATCH_LIMIT,
    claimSql: `SELECT ledger_seq::text AS ledger_seq, entity_type, org_id, record_id, owner_user_id,
                      ${utcMicroseconds('record_created_at')} AS record_created_at,
                      ${utcMicroseconds('erased_at')} AS erased_at
               FROM app_private.claim_erasure_ledger_batch($1)`,
    filePrefix: 'erasure-ledger',
    label: 'erasure',
    serialize: serializeErasureLedgerEntries,
    toEntry,
  });
}
