import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import type { DeletionJournalSink } from './deletion-journal-sink.js';

export type JournalExportCycleResult =
  | { status: 'idle' }
  | { exportedCount: number; fileName: string; status: 'exported' };

export interface JournalExportSpec<Row, Entry extends { seq: string }> {
  /** SQL that claims at most `batchLimit` rows (bound as $1) and row-locks them. */
  claimSql: string;
  /** SQL that acknowledges the claimed sequences (bound as one bigint[] $1) and returns `acknowledged`. */
  ackSql: string;
  batchLimit: number;
  /** Used in error messages: "deletion" or "access". */
  label: string;
  /** File-name prefix, for example `deletion-journal`. */
  filePrefix: string;
  /** Throws when the row is not a valid entry. */
  toEntry(row: Row): Entry;
  serialize(entries: readonly Entry[]): string;
}

function exportFileName(prefix: string, exportedAt: Date, first: string, last: string): string {
  // The source sequence restarts after a restore, and two exporters may run,
  // so the sequence range alone is not unique: the export instant and a random
  // suffix keep every file name distinct and never overwrite an older file.
  const stamp = exportedAt.toISOString().replace(/[-:]/gu, '').replace('.', '');
  return `${prefix}-${stamp}-${first}-${last}-${randomUUID().slice(0, 8)}.ndjson`;
}

/**
 * Exports at most one bounded batch. One transaction spans the claim, the
 * durable external write, and the acknowledgement, so rows leave the database
 * only after the file is durable: a failure anywhere earlier rolls back and the
 * rows stay. A crash after the write but before COMMIT re-exports the batch
 * later (at-least-once); reapplication is idempotent.
 */
export async function exportJournalBatchOnce<Row, Entry extends { seq: string }>(
  pool: Pick<Pool, 'connect'>,
  sink: Pick<DeletionJournalSink, 'write'>,
  clock: Pick<Clock, 'utcNow'>,
  spec: JournalExportSpec<Row, Entry>,
): Promise<JournalExportCycleResult> {
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

    const claimed = await client.query<Row & object>(spec.claimSql, [spec.batchLimit]);
    if (claimed.rows.length > spec.batchLimit) {
      throw new Error(`The ${spec.label} journal returned an invalid result`);
    }
    if (claimed.rows.length === 0) {
      commitStarted = true;
      await client.query('COMMIT');
      transactionActive = false;
      return { status: 'idle' };
    }

    const entries = claimed.rows.map((row) => spec.toEntry(row));
    const first = entries[0]!.seq;
    const last = entries[entries.length - 1]!.seq;
    const fileName = exportFileName(spec.filePrefix, exportedAt, first, last);
    await sink.write(fileName, spec.serialize(entries));

    const acknowledged = await client.query<{ acknowledged: number }>(spec.ackSql, [
      entries.map((entry) => entry.seq),
    ]);
    if (acknowledged.rows[0]?.acknowledged !== entries.length) {
      throw new Error(`The ${spec.label} journal acknowledgement did not match the exported batch`);
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
