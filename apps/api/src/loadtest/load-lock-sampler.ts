import type { Pool } from 'pg';

export interface LockWait {
  application: string;
  locktype: string;
  waiting: number;
}

/** One observation of every lock request that was not yet granted. `atMs` is relative to the scenario origin. */
export interface LockSample {
  atMs: number;
  waits: LockWait[];
}

export interface WaitSummary {
  peakWaiting: number;
  samplesWithWaiters: number;
}

export interface LockSampleSummary extends WaitSummary {
  byApplication: Record<string, WaitSummary>;
  byLockType: Record<string, WaitSummary>;
  sampleCount: number;
}

/**
 * `pg_locks` and the application name are readable by any role, while another role's state and wait event are
 * not. A request with `granted = false` is exactly a backend waiting for a lock, so the count of such requests
 * per lock type is what a role without `pg_read_all_stats` can observe. Statement text is never selected.
 */
const waitingLocksSql = `
  SELECT activity.application_name AS application,
         lock.locktype AS locktype,
         count(*)::int AS waiting
  FROM pg_locks AS lock
  JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
  WHERE NOT lock.granted
    AND activity.datname = current_database()
    AND activity.application_name IN ('running-tracker-api', 'running-tracker-maintenance')
  GROUP BY activity.application_name, lock.locktype
  ORDER BY activity.application_name, lock.locktype`;

export type SampleLocks = () => Promise<LockWait[]>;

export function createLockSampler(pool: Pick<Pool, 'query'>): SampleLocks {
  return async () => {
    const result = await pool.query<Record<string, unknown>>(waitingLocksSql);
    return result.rows.map((row) => {
      if (typeof row.application !== 'string' || typeof row.locktype !== 'string' || typeof row.waiting !== 'number') {
        throw new Error('The database returned a malformed lock sample');
      }
      return { application: row.application, locktype: row.locktype, waiting: row.waiting };
    });
  };
}

function note(target: Record<string, WaitSummary>, key: string, waiting: number): void {
  const entry = (target[key] ??= { peakWaiting: 0, samplesWithWaiters: 0 });
  entry.samplesWithWaiters += 1;
  entry.peakWaiting = Math.max(entry.peakWaiting, waiting);
}

/** Counts only: how often anything waited and the most that waited at once, in total and per key. */
export function summarizeLockSamples(samples: readonly LockSample[]): LockSampleSummary {
  const summary: LockSampleSummary = {
    byApplication: {},
    byLockType: {},
    peakWaiting: 0,
    sampleCount: samples.length,
    samplesWithWaiters: 0,
  };
  for (const sample of samples) {
    if (sample.waits.length === 0) {
      continue;
    }
    summary.samplesWithWaiters += 1;
    summary.peakWaiting = Math.max(summary.peakWaiting, sample.waits.reduce((sum, wait) => sum + wait.waiting, 0));
    const applications = new Map<string, number>();
    const lockTypes = new Map<string, number>();
    for (const wait of sample.waits) {
      applications.set(wait.application, (applications.get(wait.application) ?? 0) + wait.waiting);
      lockTypes.set(wait.locktype, (lockTypes.get(wait.locktype) ?? 0) + wait.waiting);
    }
    for (const [application, waiting] of applications) {
      note(summary.byApplication, application, waiting);
    }
    for (const [locktype, waiting] of lockTypes) {
      note(summary.byLockType, locktype, waiting);
    }
  }
  return summary;
}
