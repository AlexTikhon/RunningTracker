import type { Pool } from 'pg';

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
  const age = Number(result.rows[0]?.age);
  if (!Number.isFinite(age) || age < 0) {
    throw new Error(`The ${journal} journal returned an invalid backlog age`);
  }
  return age;
}

export interface BacklogMeasuredExportOptions<Result> {
  exportOnce: () => Promise<Result>;
  journal: BacklogJournal;
  logger?: Logger;
  metrics?: ApiMetrics['maintenance'];
  pool: Pick<Pool, 'query'>;
}

/**
 * Runs one export cycle, then publishes the outbox's oldest-unexported age whether the cycle succeeded or failed. A
 * cycle exports at most one batch, so success alone does not mean the outbox is drained: the age is the recovery
 * window actually in force. The cycle's own outcome is returned or rethrown unchanged; a failed measurement is logged
 * and leaves the gauge at its last value without failing the cycle.
 */
export async function exportAndMeasureBacklog<Result>(options: BacklogMeasuredExportOptions<Result>): Promise<Result> {
  let outcome: { ok: true; value: Result } | { error: unknown; ok: false };
  try {
    outcome = { ok: true, value: await options.exportOnce() };
  } catch (error) {
    outcome = { error, ok: false };
  }
  try {
    const age = await readOldestUnexportedAgeSeconds(options.pool, options.journal);
    options.metrics?.journalOldestUnexportedAgeSeconds.set({ journal: options.journal }, age);
  } catch (error) {
    (options.logger ?? defaultLogger).warn('journal.backlog_age.unavailable', { ...describeError(error), task: options.journal });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
