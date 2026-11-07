import { describe, expect, it } from 'vitest';

import { SerialJobQueue, type QueuedJob, type Reservation } from './insight-queue.js';

function held() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { done, release };
}

const queue = (maxQueued = 2, maxPerOwner = 2, errors: unknown[] = []) =>
  new SerialJobQueue({ maxPerOwner, maxQueued, onError: (error) => errors.push(error) });

function reserve(target: SerialJobQueue, owner: string): Reservation {
  const reservation = target.reserve(owner);
  if (typeof reservation === 'string') throw new Error(`refused: ${reservation}`);
  return reservation;
}

const job = (id: string, run: QueuedJob['run'] = () => Promise.resolve()): QueuedJob => ({ id, run, token: `t-${id}` });

describe('weekly insight queue with reservations (ADR-0076)', () => {
  it('runs one job at a time, in reservation order', async () => {
    const target = queue();
    const order: string[] = [];
    const first = held();
    reserve(target, 'a').start(job('1', async () => {
      order.push('1 start');
      await first.done;
      order.push('1 end');
    }));
    reserve(target, 'b').start(job('2', () => {
      order.push('2');
      return Promise.resolve();
    }));
    expect(target.activeCount).toBe(1);
    expect(target.waitingCount).toBe(1);
    first.release();
    await target.whenIdle();
    expect(order).toEqual(['1 start', '1 end', '2']);
  });

  it('counts reservations against the limits, so a request that is still deciding holds its place', () => {
    const target = queue(1, 1);
    const running = held();
    reserve(target, 'a').start(job('1', () => running.done));
    const deciding = reserve(target, 'b');
    expect(target.reserve('c')).toBe('full');
    expect(target.reserve('b')).toBe('owner_limit');
    deciding.release();
    expect(typeof target.reserve('c')).toBe('object');
    running.release();
  });

  it('gives a place back only when the reservation is released or its job has settled', async () => {
    const target = queue(0, 1);
    const running = held();
    reserve(target, 'a').start(job('1', () => running.done));
    expect(target.reserve('b')).toBe('full');
    expect(target.reserve('a')).toBe('owner_limit');
    running.release();
    await target.whenIdle();
    expect(typeof target.reserve('a')).toBe('object');
  });

  it('reports how many jobs are ahead of a reservation (for the lease of a queued row)', () => {
    const target = queue(4, 4);
    const running = held();
    expect(reserve(target, 'a').ahead).toBe(0);
    const target2 = queue(4, 4);
    reserve(target2, 'a').start(job('1', () => running.done));
    reserve(target2, 'b');
    expect(reserve(target2, 'c').ahead).toBe(2);
    running.release();
  });

  it('a reservation is used once; releasing after starting changes nothing', () => {
    const target = queue();
    const reservation = reserve(target, 'a');
    reservation.start(job('1'));
    expect(() => reservation.start(job('2'))).toThrow('once');
    reservation.release();
  });

  it('cancels a waiting job by dropping it and a running one by aborting its signal', async () => {
    const target = queue();
    let aborted = false;
    reserve(target, 'a').start(job('1', (signal) => new Promise<void>((resolve) => {
      if (signal.aborted) {
        aborted = true;
        resolve();
        return;
      }
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      }, { once: true });
    })));
    let ranSecond = false;
    reserve(target, 'b').start(job('2', () => {
      ranSecond = true;
      return Promise.resolve();
    }));
    expect(target.has('2')).toBe(true);
    target.cancel('2');
    expect(target.has('2')).toBe(false);
    target.cancel('1');
    await target.whenIdle();
    expect(aborted).toBe(true);
    expect(ranSecond).toBe(false);
  });

  it('stops: refuses new work, aborts the running job, waits for it and returns the dropped ones', async () => {
    const target = queue();
    const settled: string[] = [];
    reserve(target, 'a').start(job('1', (signal) => new Promise<void>((resolve) => {
      if (signal.aborted) {
        settled.push('1');
        resolve();
        return;
      }
      signal.addEventListener('abort', () => {
        settled.push('1');
        resolve();
      }, { once: true });
    })));
    reserve(target, 'b').start(job('2'));
    const pending = reserve(target, 'c');
    const dropped = await target.stop();
    expect(settled).toEqual(['1']);
    expect(dropped.map((entry) => entry.token)).toEqual(['t-2']);
    expect(target.reserve('d')).toBe('stopped');
    pending.start(job('3'));
    expect(target.has('3')).toBe(false);
  });

  it('reports a job that rejects and moves on', async () => {
    const errors: unknown[] = [];
    const target = queue(2, 2, errors);
    reserve(target, 'a').start(job('1', () => Promise.reject(new Error('boom'))));
    let ran = false;
    reserve(target, 'b').start(job('2', () => {
      ran = true;
      return Promise.resolve();
    }));
    await target.whenIdle();
    expect(errors).toHaveLength(1);
    expect(ran).toBe(true);
  });

  it('validates its limits', () => {
    expect(() => queue(-1, 1)).toThrow(RangeError);
    expect(() => queue(1, 0)).toThrow(RangeError);
  });
});
