import { describe, expect, it, vi } from 'vitest';

import {
  ArchiveTileGenerationAbortedError,
  ArchiveTileGenerationScheduler,
} from './archive-tile-scheduler.js';

interface Deferred {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
}

function deferred(): Deferred {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  return {
    promise: new Promise<void>((settle, fail) => {
      resolve = settle;
      reject = fail;
    }),
    reject,
    resolve,
  };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Deterministic test condition was not reached');
}

describe('P09.6 archive tile generation scheduler', () => {
  it('admits two generators, bounds the queue at sixteen, and rejects request nineteen', async () => {
    const scheduler = new ArchiveTileGenerationScheduler();
    const started: Deferred[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const task = vi.fn(async () => {
      const gate = deferred();
      started.push(gate);
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      try {
        await gate.promise;
      } finally {
        concurrent -= 1;
      }
      return started.length;
    });

    const accepted = Array.from({ length: 18 }, () => scheduler.schedule(task));
    await settleMicrotasks();
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.queueDepth).toBe(16);
    expect(task).toHaveBeenCalledTimes(2);

    const overflow = scheduler.schedule(task);
    await expect(overflow).rejects.toMatchObject({
      code: 'TILE_BUSY',
      statusCode: 503,
    });
    expect(scheduler.queueDepth).toBe(16);

    started[0]?.resolve();
    await waitFor(() => task.mock.calls.length === 3);
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.queueDepth).toBe(15);
    expect(task).toHaveBeenCalledTimes(3);

    started[1]?.reject(new Error('generation failed'));
    await expect(accepted[1]).rejects.toThrow('generation failed');
    await waitFor(() => task.mock.calls.length === 4);
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.queueDepth).toBe(14);
    expect(task).toHaveBeenCalledTimes(4);

    let nextToRelease = 2;
    while (nextToRelease < 18) {
      while (nextToRelease < started.length) {
        started[nextToRelease]?.resolve();
        nextToRelease += 1;
      }
      await settleMicrotasks();
    }
    await Promise.all(accepted.filter((_promise, index) => index !== 1));
    expect(maximumConcurrent).toBe(2);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.queueDepth).toBe(0);
  });

  it('removes an aborted waiter without consuming a permit', async () => {
    const scheduler = new ArchiveTileGenerationScheduler(1, 1);
    const active = deferred();
    const first = scheduler.schedule(() => active.promise);
    await settleMicrotasks();

    const abortController = new AbortController();
    const queuedTask = vi.fn(() => Promise.resolve());
    const queued = scheduler.schedule(queuedTask, abortController.signal);
    expect(scheduler.queueDepth).toBe(1);
    abortController.abort();

    await expect(queued).rejects.toBeInstanceOf(ArchiveTileGenerationAbortedError);
    expect(scheduler.queueDepth).toBe(0);
    active.resolve();
    await first;
    expect(queuedTask).not.toHaveBeenCalled();
    expect(scheduler.activeCount).toBe(0);
  });
});
