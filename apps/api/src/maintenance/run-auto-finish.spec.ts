import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../clock.js';
import { RunAutoFinishRunner, runAutoFinishOnce } from './run-auto-finish.js';

interface ControlledClock extends Clock {
  advanceBy(milliseconds: number): void;
  timerCount(): number;
}

interface ScheduledTimer {
  callback: () => void;
  dueAt: number;
}

function createControlledClock(): ControlledClock {
  let monotonicTime = 0;
  let nextHandle = 1;
  const timers = new Map<ReturnType<typeof setTimeout>, ScheduledTimer>();

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
    clearTimeout(handle) {
      timers.delete(handle);
    },
    monotonicNow: () => monotonicTime,
    setTimeout(callback, delayMs) {
      const handle = nextHandle as unknown as ReturnType<typeof setTimeout>;
      nextHandle += 1;
      timers.set(handle, { callback, dueAt: monotonicTime + delayMs });
      return handle;
    },
    timerCount: () => timers.size,
    utcNow: () => new Date('2026-09-23T12:00:00.000Z'),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('runAutoFinishOnce', () => {
  it('passes one injected UTC timestamp to the narrow database function', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ finished_count: 3 }] });
    const clock = createControlledClock();

    await expect(runAutoFinishOnce({ query } as never, clock)).resolves.toBe(3);
    expect(query).toHaveBeenCalledWith(
      'SELECT app_private.auto_finish_runs($1::timestamptz) AS finished_count',
      ['2026-09-23T12:00:00.000Z'],
    );
  });
});
describe('RunAutoFinishRunner', () => {
  it('does not execute before the interval and executes when it is due', async () => {
    const clock = createControlledClock();
    const runOnce = vi.fn().mockResolvedValue(0);
    const runner = new RunAutoFinishRunner({ clock, intervalMs: 1_000, runOnce });

    runner.start();
    clock.advanceBy(999);
    expect(runOnce).not.toHaveBeenCalled();
    clock.advanceBy(1);
    await flushPromises();
    expect(runOnce).toHaveBeenCalledOnce();
    runner.stop();
  });

  it('never overlaps executions and schedules again only after settlement', async () => {
    const clock = createControlledClock();
    const first = deferred<number>();
    const runOnce = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(0);
    const runner = new RunAutoFinishRunner({ clock, intervalMs: 1_000, runOnce });

    runner.start();
    clock.advanceBy(1_000);
    expect(runOnce).toHaveBeenCalledOnce();
    expect(clock.timerCount()).toBe(0);
    clock.advanceBy(5_000);
    expect(runOnce).toHaveBeenCalledOnce();

    first.resolve(1);
    await flushPromises();
    expect(clock.timerCount()).toBe(1);
    clock.advanceBy(1_000);
    await flushPromises();
    expect(runOnce).toHaveBeenCalledTimes(2);
    runner.stop();
  });

  it('continues repeated scheduling after a failed cycle', async () => {
    const clock = createControlledClock();
    const failure = new Error('temporary database failure');
    const onError = vi.fn();
    const runOnce = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(0);
    const runner = new RunAutoFinishRunner({
      clock,
      intervalMs: 1_000,
      onError,
      runOnce,
    });

    runner.start();
    clock.advanceBy(1_000);
    await flushPromises();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(clock.timerCount()).toBe(1);

    clock.advanceBy(1_000);
    await flushPromises();
    expect(runOnce).toHaveBeenCalledTimes(2);
    runner.stop();
  });

  it('stop removes the pending timer and prevents future cycles', async () => {
    const clock = createControlledClock();
    const runOnce = vi.fn().mockResolvedValue(0);
    const runner = new RunAutoFinishRunner({ clock, intervalMs: 1_000, runOnce });

    runner.start();
    expect(clock.timerCount()).toBe(1);
    runner.stop();
    expect(clock.timerCount()).toBe(0);
    clock.advanceBy(10_000);
    await flushPromises();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('stop during a cycle prevents rescheduling after that cycle settles', async () => {
    const clock = createControlledClock();
    const active = deferred<number>();
    const runOnce = vi.fn(() => active.promise);
    const runner = new RunAutoFinishRunner({ clock, intervalMs: 1_000, runOnce });

    runner.start();
    clock.advanceBy(1_000);
    runner.stop();
    active.resolve(0);
    await flushPromises();

    expect(runOnce).toHaveBeenCalledOnce();
    expect(clock.timerCount()).toBe(0);
  });
});
