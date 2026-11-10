import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import { defaultLogger, describeError, type Logger } from '../observability/logger.js';

/** The outboxes whose export protects a deletion against a restore from an older backup (ADR-0037, ADR-0073). */
export type BacklogJournal = 'deletion' | 'erasure';

const ageStatements: Record<BacklogJournal, string> = {
  deletion: 'SELECT app_private.run_deletion_journal_oldest_unexported_age_seconds() AS age',
  erasure: 'SELECT app_private.erasure_ledger_oldest_unexported_age_seconds() AS age',
};

/** Age in seconds of the oldest row of `journal` not yet exported off-host; 0 when the outbox is empty (migration 0040). */
export async function readOldestUnexportedAgeSeconds(pool: Pick<Pool, 'query'>, journal: BacklogJournal): Promise<number> {
  const result = await pool.query<{ age: number | string | null }>(ageStatements[journal]);
  const raw = result.rows[0]?.age;
  // Number(null) and Number('') are 0: without this check a missing value would publish as a fresh "drained".
  const age = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : Number.NaN;
  if (!Number.isFinite(age) || age < 0) {
    throw new Error(`The ${journal} journal returned an invalid backlog age`);
  }
  return age;
}

export interface BacklogMeasuredExportOptions<Result> {
  /** Stamps each successful measurement; injected so tests control time. */
  clock: Pick<Clock, 'utcNow'>;
  exportOnce: () => Promise<Result>;
  journal: BacklogJournal;
  logger?: Logger;
  metrics?: ApiMetrics['maintenance'];
  pool: Pick<Pool, 'query'>;
}

/**
 * Wraps one journal's export cycle so that every cycle is followed by a backlog-age measurement, successful export or
 * not. A cycle exports at most one batch, so success alone does not mean the outbox is drained.
 *
 * The age is a sample: it is only as current as `journal_export_backlog_age_measured_timestamp_seconds`, which is set
 * here, from `clock`, only after a valid age has been read and published. An export that never settles never reaches
 * the measurement, and a failed or invalid read is logged and leaves both gauges at their last values, so in either
 * case the timestamp stops advancing and the age reads as stale rather than current. Creating the wrapper publishes 0
 * for the timestamp: "enabled, never measured in this process". A disabled exporter is never wrapped and has no series.
 *
 * The cycle's own result or error is returned or rethrown unchanged; a measurement never fails a cycle.
 */
export function createBacklogMeasuredExport<Result>(options: BacklogMeasuredExportOptions<Result>): () => Promise<Result> {
  const labels = { journal: options.journal };
  options.metrics?.journalBacklogAgeMeasuredTimestampSeconds.set(labels, 0);

  const measure = async (): Promise<void> => {
    try {
      const age = await readOldestUnexportedAgeSeconds(options.pool, options.journal);
      options.metrics?.journalOldestUnexportedAgeSeconds.set(labels, age);
      options.metrics?.journalBacklogAgeMeasuredTimestampSeconds.set(
        labels, Math.floor(options.clock.utcNow().getTime() / 1_000),
      );
    } catch (error) {
      (options.logger ?? defaultLogger).warn('journal.backlog_age.unavailable', { ...describeError(error), task: options.journal });
    }
  };

  return async () => {
    let outcome: { ok: true; value: Result } | { error: unknown; ok: false };
    try {
      outcome = { ok: true, value: await options.exportOnce() };
    } catch (error) {
      outcome = { error, ok: false };
    }
    await measure();
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  };
}
