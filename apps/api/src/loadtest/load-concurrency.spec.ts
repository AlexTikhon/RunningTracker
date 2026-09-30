import { describe, expect, it } from 'vitest';

import { runBounded, sleep } from './load-concurrency.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runBounded', () => {
  it('never runs more than the limit at once and returns results in item order', async () => {
    let active = 0;
    let peak = 0;
    const results = await runBounded(3, [1, 2, 3, 4, 5, 6, 7], async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return item * 10;
    });
    expect(peak).toBe(3);
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('stops starting new work after the first failure and rejects with it', async () => {
    const started: number[] = [];
    const gate = deferred();
    const outcome = runBounded(2, [1, 2, 3, 4, 5], async (item) => {
      started.push(item);
      if (item === 2) {
        throw new Error('boom');
      }
      await gate.promise;
      return item;
    });
    await expect(outcome).rejects.toThrow('boom');
    gate.resolve();
    await sleep(10);
    expect(started).toEqual([1, 2]);
  });

  it('does not start work when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    let calls = 0;
    await expect(
      runBounded(
        2,
        [1, 2],
        () => {
          calls += 1;
          return Promise.resolve();
        },
        controller.signal,
      ),
    ).rejects.toThrow('stopped');
    expect(calls).toBe(0);
  });

  it('rejects an invalid limit', async () => {
    await expect(runBounded(0, [1], () => Promise.resolve(1))).rejects.toThrow();
    await expect(runBounded(1.5, [1], () => Promise.resolve(1))).rejects.toThrow();
  });
});

describe('sleep', () => {
  it('rejects promptly on abort and leaves no timer behind', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort(new Error('cancel'));
    await expect(pending).rejects.toThrow('cancel');
  });
});
