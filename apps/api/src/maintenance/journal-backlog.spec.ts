import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../clock.js';
import { createApiMetrics } from '../observability/api-metrics.js';
import { createLogger } from '../observability/logger.js';
import { createBacklogMeasuredExport, type BacklogJournal } from './journal-backlog.js';
import { PeriodicRunner } from './periodic-runner.js';

// F04 follow-up: the backlog age is a sample. journal_export_backlog_age_measured_timestamp_seconds says when it was
// last read and published, so an exporter that hangs before measuring, or a read that fails, shows as stale instead
// of leaving an old age (often 0) looking current. 0 means "never measured in this process".
const START_SECONDS = 1_988_928_000; // 2033-01-10T00:00:00Z

function createControlledClock(): Clock & { advanceBy(ms: number): void } {
  let monotonicTime = 0;
  let nextHandle = 1;
  const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; dueAt: number }>();
  return {
    advanceBy(milliseconds) {
      monotonicTime += milliseconds;
      for (const [handle, timer] of [...timers]) {
        if (timer.dueAt <= monotonicTime) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    clearTimeout: (handle) => void timers.delete(handle),
    monotonicNow: () => monotonicTime,
    setTimeout(callback, delayMs) {
      const handle = nextHandle as unknown as ReturnType<typeof setTimeout>;
      nextHandle += 1;
      timers.set(handle, { callback, dueAt: monotonicTime + delayMs });
      return handle;
    },
    utcNow: () => new Date(START_SECONDS * 1_000 + monotonicTime),
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

/** A maintenance pool stand-in answering the age query from a queue of outcomes. */
function agePool(...answers: Array<number | string | null | Error>) {
  const query = vi.fn(() => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ rows: [{ age: next }] });
  });
  return { query } as unknown as { query: typeof query } & Parameters<typeof createBacklogMeasuredExport>[0]['pool'];
}

function sample(metrics: ReturnType<typeof createApiMetrics>, name: string, journal: BacklogJournal): number | undefined {
  const match = new RegExp(`^${name}\\{journal="${journal}"\\} (\\S+)$`, 'mu').exec(metrics.registry.render());
  return match === null ? undefined : Number(match[1]);
}

const age = (metrics: ReturnType<typeof createApiMetrics>, journal: BacklogJournal) =>
  sample(metrics, 'journal_export_oldest_unexported_age_seconds', journal);
const measuredAt = (metrics: ReturnType<typeof createApiMetrics>, journal: BacklogJournal) =>
  sample(metrics, 'journal_export_backlog_age_measured_timestamp_seconds', journal);

describe('journal backlog age freshness', () => {
  it('reports "never measured" (0) for an enabled exporter before its first cycle, and no age yet', () => {
    const metrics = createApiMetrics();
    const pool = agePool(0);

    createBacklogMeasuredExport({
      clock: createControlledClock(),
      exportOnce: () => Promise.resolve({ status: 'idle' }),
      journal: 'erasure',
      metrics: metrics.maintenance,
      pool,
    });

    expect(measuredAt(metrics, 'erasure')).toBe(0);
    expect(age(metrics, 'erasure')).toBeUndefined();
    // A disabled exporter is never constructed, so it has no series at all.
    expect(measuredAt(metrics, 'deletion')).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('stamps a successful measurement, including a fresh zero, with the injected clock', async () => {
    const clock = createControlledClock();
    const metrics = createApiMetrics();
    const exportOnce = createBacklogMeasuredExport({
      clock,
      exportOnce: () => Promise.resolve({ exportedCount: 3, status: 'exported' }),
      journal: 'deletion',
      metrics: metrics.maintenance,
      pool: agePool(0),
    });

    clock.advanceBy(42_000);
    await expect(exportOnce()).resolves.toEqual({ exportedCount: 3, status: 'exported' });

    expect(age(metrics, 'deletion')).toBe(0);
    expect(measuredAt(metrics, 'deletion')).toBe(START_SECONDS + 42);
  });

  it('keeps the previous timestamp and age when the read fails or is invalid, without failing the cycle', async () => {
    const clock = createControlledClock();
    const metrics = createApiMetrics();
    const logged: string[] = [];
    const logger = createLogger({ clock, write: (_level, line) => void logged.push(line) });
    const readFailure = Object.assign(new Error('connection to postgresql://u:secret@h/db failed'), { code: '57014' });
    const exportOnce = createBacklogMeasuredExport({
      clock,
      exportOnce: () => Promise.resolve({ status: 'idle' }),
      journal: 'erasure',
      logger,
      metrics: metrics.maintenance,
      pool: agePool(120, readFailure, -1, null, '', 'not a number'),
    });

    await exportOnce();
    expect(measuredAt(metrics, 'erasure')).toBe(START_SECONDS);
    expect(age(metrics, 'erasure')).toBe(120);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock.advanceBy(30_000);
      await expect(exportOnce()).resolves.toEqual({ status: 'idle' });
      expect(measuredAt(metrics, 'erasure')).toBe(START_SECONDS);
      expect(age(metrics, 'erasure')).toBe(120);
    }

    expect(logged).toHaveLength(5);
    for (const line of logged) {
      expect(JSON.parse(line)).toMatchObject({ event: 'journal.backlog_age.unavailable', task: 'erasure' });
      expect(line).not.toContain('secret');
    }
  });

  it('stamps a valid measurement after a failed export and still rethrows the export error unchanged', async () => {
    const clock = createControlledClock();
    const metrics = createApiMetrics();
    const storageDown = new Error('journal storage unavailable');
    const exportOnce = createBacklogMeasuredExport({
      clock,
      exportOnce: () => Promise.reject(storageDown),
      journal: 'erasure',
      metrics: metrics.maintenance,
      pool: agePool(300),
    });

    clock.advanceBy(5_000);
    await expect(exportOnce()).rejects.toBe(storageDown);

    expect(age(metrics, 'erasure')).toBe(300);
    expect(measuredAt(metrics, 'erasure')).toBe(START_SECONDS + 5);
  });

  it('leaves freshness stale while an export hangs and time advances, and starts no overlapping cycle', async () => {
    const clock = createControlledClock();
    const metrics = createApiMetrics();
    const pool = agePool(0);
    let calls = 0;
    const runner = new PeriodicRunner({
      clock,
      intervalMs: 30_000,
      metrics: metrics.maintenance,
      runOnce: createBacklogMeasuredExport({
        clock,
        exportOnce: () => {
          calls += 1;
          // The first cycle drains the outbox; the second never settles (a stuck filesystem write).
          return calls === 1 ? Promise.resolve({ status: 'idle' }) : new Promise<never>(() => undefined);
        },
        journal: 'deletion',
        metrics: metrics.maintenance,
        pool,
      }),
      taskName: 'Run deletion journal export',
    });

    runner.start();
    clock.advanceBy(30_000);
    await settle();
    expect(measuredAt(metrics, 'deletion')).toBe(START_SECONDS + 30);
    expect(age(metrics, 'deletion')).toBe(0);

    clock.advanceBy(30_000); // the second cycle starts and hangs in its export
    await settle();
    for (let minute = 0; minute < 60; minute += 1) {
      clock.advanceBy(60_000);
      await settle();
    }

    const nowSeconds = Math.floor(clock.utcNow().getTime() / 1_000);
    expect(calls).toBe(2);
    expect(pool.query).toHaveBeenCalledTimes(1);
    // The zero is still there, but it is an hour old: an alert on (now - measured) > threshold fires.
    expect(age(metrics, 'deletion')).toBe(0);
    expect(measuredAt(metrics, 'deletion')).toBe(START_SECONDS + 30);
    expect(nowSeconds - measuredAt(metrics, 'deletion')!).toBeGreaterThanOrEqual(3_600);
    runner.stop();
  });

  it('keeps deletion and erasure freshness on separate, static labels', async () => {
    const clock = createControlledClock();
    const metrics = createApiMetrics();
    const deletion = createBacklogMeasuredExport({
      clock,
      exportOnce: () => Promise.resolve({ status: 'idle' }),
      journal: 'deletion',
      metrics: metrics.maintenance,
      pool: agePool(0),
    });
    const erasure = createBacklogMeasuredExport({
      clock,
      exportOnce: () => Promise.resolve({ status: 'idle' }),
      journal: 'erasure',
      logger: createLogger({ clock, write: () => undefined }),
      metrics: metrics.maintenance,
      pool: agePool(75, new Error('read failed')),
    });

    clock.advanceBy(10_000);
    await erasure();
    clock.advanceBy(10_000);
    await deletion();
    clock.advanceBy(10_000);
    await erasure(); // fails: erasure keeps its earlier stamp, deletion is untouched

    expect(measuredAt(metrics, 'erasure')).toBe(START_SECONDS + 10);
    expect(age(metrics, 'erasure')).toBe(75);
    expect(measuredAt(metrics, 'deletion')).toBe(START_SECONDS + 20);
    expect(age(metrics, 'deletion')).toBe(0);
    const series = metrics.registry
      .render()
      .split('\n')
      .filter((line) => line.startsWith('journal_export_backlog_age_measured_timestamp_seconds'));
    expect(series.sort()).toEqual([
      `journal_export_backlog_age_measured_timestamp_seconds{journal="deletion"} ${START_SECONDS + 20}`,
      `journal_export_backlog_age_measured_timestamp_seconds{journal="erasure"} ${START_SECONDS + 10}`,
    ]);
  });
});
