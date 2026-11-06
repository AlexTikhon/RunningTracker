import { describe, expect, it, vi } from 'vitest';

import { SerialJobQueue } from './insight-queue.js';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const queue = (options: Partial<ConstructorParameters<typeof SerialJobQueue>[0]> = {}) =>
  new SerialJobQueue({ maxPerOwner: 5, maxQueued: 5, onError: () => undefined, ...options });

describe('serial insight queue (ADR-0076)', () => {
  it('runs one job at a time, in arrival order', async () => {
    const subject = queue();
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const gates = [deferred(), deferred(), deferred()];
    gates.forEach((gate, index) => {
      subject.enqueue({
        id: `job-${index}`,
        owner: `owner-${index}`,
        run: async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          order.push(`start-${index}`);
          await gate.promise;
          order.push(`end-${index}`);
          running -= 1;
        },
      });
    });
    expect(subject.activeCount + subject.waitingCount).toBe(3);
    gates.forEach((gate) => gate.release());
    await subject.whenIdle();
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('does not add a job for an insight that is already queued or running', async () => {
    const subject = queue();
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    expect(subject.enqueue({ id: 'same', owner: 'a', run })).toBe('queued');
    expect(subject.enqueue({ id: 'same', owner: 'a', run })).toBe('already_queued');
    expect(subject.has('same')).toBe(true);
    gate.release();
    await subject.whenIdle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(subject.has('same')).toBe(false);
  });

  it('bounds the waiting line and the jobs of one person', async () => {
    const gate = deferred();
    const subject = queue({ maxPerOwner: 2, maxQueued: 1 });
    expect(subject.enqueue({ id: '1', owner: 'a', run: () => gate.promise })).toBe('queued'); // running
    expect(subject.enqueue({ id: '2', owner: 'a', run: () => gate.promise })).toBe('queued'); // waiting
    expect(subject.admission('a')).toBe('owner_limit');
    expect(subject.enqueue({ id: '3', owner: 'a', run: () => gate.promise })).toBe('owner_limit');
    expect(subject.enqueue({ id: '4', owner: 'b', run: () => gate.promise })).toBe('full');
    gate.release();
    await subject.whenIdle();
    expect(subject.admission('a')).toBe('ok');
  });

  it('keeps going after a job rejects, reporting the error', async () => {
    const onError = vi.fn();
    const subject = queue({ onError });
    const after = vi.fn(() => Promise.resolve());
    subject.enqueue({ id: '1', owner: 'a', run: () => Promise.reject(new Error('boom')) });
    subject.enqueue({ id: '2', owner: 'a', run: after });
    await subject.whenIdle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('stop cancels the running job, drops the waiting ones and refuses new jobs', async () => {
    const subject = queue();
    let seenSignal: AbortSignal | undefined;
    const waiting = vi.fn(() => Promise.resolve());
    subject.enqueue({
      id: '1',
      owner: 'a',
      run: (signal) =>
        new Promise<void>((resolve) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => resolve());
        }),
    });
    subject.enqueue({ id: '2', owner: 'b', run: waiting });
    await Promise.resolve();
    await subject.stop();
    expect(seenSignal?.aborted).toBe(true);
    expect(waiting).not.toHaveBeenCalled();
    expect(subject.enqueue({ id: '3', owner: 'c', run: waiting })).toBe('stopped');
    await expect(subject.whenIdle()).resolves.toBeUndefined();
  });

  it('refuses invalid limits', () => {
    expect(() => queue({ maxQueued: -1 })).toThrow(RangeError);
    expect(() => queue({ maxPerOwner: 0 })).toThrow(RangeError);
  });
});
