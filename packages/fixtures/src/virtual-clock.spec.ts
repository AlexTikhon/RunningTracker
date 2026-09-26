import { describe, expect, it, vi } from 'vitest';

import { VirtualClock } from './virtual-clock.js';

describe('VirtualClock', () => {
  it('advances UTC and monotonic time without waiting on the wall clock', () => {
    const clock = new VirtualClock('2026-01-01T08:00:00.000Z');

    clock.advanceBy(2_500);

    expect(clock.monotonicNow()).toBe(2_500);
    expect(clock.utcNow().toISOString()).toBe('2026-01-01T08:00:02.500Z');
  });

  it('runs timers by due time and insertion order, including newly scheduled timers', () => {
    const clock = new VirtualClock('2026-01-01T08:00:00.000Z');
    const calls: string[] = [];
    clock.setTimeout(() => calls.push('late'), 20);
    clock.setTimeout(() => {
      calls.push('first');
      clock.setTimeout(() => calls.push('nested'), 0);
    }, 10);
    clock.setTimeout(() => calls.push('second'), 10);

    clock.runAll();

    expect(calls).toEqual(['first', 'second', 'nested', 'late']);
    expect(clock.monotonicNow()).toBe(20);
  });

  it('cancels timers and rejects invalid or backwards movement', () => {
    const clock = new VirtualClock('2026-01-01T08:00:00.000Z');
    const callback = vi.fn();
    const handle = clock.setTimeout(callback, 1);
    clock.clearTimeout(handle);
    clock.advanceTo(10);

    expect(callback).not.toHaveBeenCalled();
    expect(clock.pendingTimerCount()).toBe(0);
    expect(() => clock.advanceTo(9)).toThrow('cannot move backwards');
    expect(() => clock.setTimeout(callback, Number.NaN)).toThrow('nonnegative finite');
  });
});
