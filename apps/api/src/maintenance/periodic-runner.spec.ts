import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../clock.js';
import { createApiMetrics } from '../observability/api-metrics.js';
import { createLogger } from '../observability/logger.js';
import { PeriodicRunner } from './periodic-runner.js';

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
    utcNow: () => new Date('2033-01-10T00:00:00.000Z'),
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe('P11.1 periodic runner observability', () => {
  it('records cycle outcome, duration, and last-success time per task', async () => {
    const clock = createControlledClock();
    const metrics = createApiMetrics();
    const runner = new PeriodicRunner({
      clock,
      intervalMs: 1_000,
      metrics: metrics.maintenance,
      runOnce: () => {
        clock.advanceBy(0);
        return Promise.resolve({ status: 'idle' });
      },
      taskName: 'Run raw retention purge',
    });

    runner.start();
    clock.advanceBy(1_000);
    await settle();

    const output = metrics.registry.render();
    expect(output).toContain(
      'maintenance_cycles_total{task="run_raw_retention_purge",outcome="ok"} 1',
    );
    expect(output).toContain('maintenance_cycle_duration_seconds_count{task="run_raw_retention_purge"} 1');
    expect(output).toContain(
      'maintenance_last_success_timestamp_seconds{task="run_raw_retention_purge"} 1988928000',
    );
    runner.stop();
  });

  it('counts a failed cycle, keeps the last-success time, and logs only class and code', async () => {
    const clock = createControlledClock();
    const metrics = createApiMetrics();
    const logged: string[] = [];
    const logger = createLogger({ clock, write: (_level, line) => void logged.push(line) });
    const runOnce = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(
        Object.assign(new Error('connection to postgresql://u:secret@h/db failed'), { code: 'ECONNREFUSED' }),
      );
    const runner = new PeriodicRunner({
      clock,
      intervalMs: 1_000,
      logger,
      metrics: metrics.maintenance,
      runOnce,
      taskName: 'Run auto-finish',
    });

    runner.start();
    clock.advanceBy(1_000);
    await settle();

    const output = metrics.registry.render();
    expect(output).toContain('maintenance_cycles_total{task="run_auto_finish",outcome="error"} 1');
    expect(output).not.toContain('maintenance_last_success_timestamp_seconds{task="run_auto_finish"}');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? '')).toMatchObject({
      errorCode: 'ECONNREFUSED',
      errorName: 'Error',
      event: 'maintenance.cycle.failed',
      level: 'error',
      task: 'run_auto_finish',
    });
    expect(logged[0]).not.toMatch(/secret|postgresql/u);
    runner.stop();
  });

  it('still schedules the next cycle after a failure', async () => {
    const clock = createControlledClock();
    const runOnce = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('x')).mockResolvedValue(1);
    const runner = new PeriodicRunner({
      clock,
      intervalMs: 1_000,
      logger: createLogger({ clock, write: () => undefined }),
      runOnce,
      taskName: 'Job',
    });

    runner.start();
    clock.advanceBy(1_000);
    await settle();
    clock.advanceBy(1_000);
    await settle();

    expect(runOnce).toHaveBeenCalledTimes(2);
    runner.stop();
  });
});
