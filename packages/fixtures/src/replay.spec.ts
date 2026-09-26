import { describe, expect, it, vi } from 'vitest';

import { replayGpsScenario, scheduleGpsScenario } from './replay.js';
import { createGpsScenario } from './scenarios.js';
import { VirtualClock } from './virtual-clock.js';

describe('GPS scenario replay', () => {
  it('emits one deterministic virtual-time timeline', () => {
    const scenario = createGpsScenario({ name: 'normal', seed: 42 });
    const events = replayGpsScenario(scenario);

    expect(events.map(({ atMs }) => atMs)).toEqual([0, 2_000, 4_000, 4_500, 6_000, 8_000, 10_000, 10_500]);
    expect(events[0]).toMatchObject({ observedAt: scenario.startAt, type: 'capture' });
    expect(events.at(-1)).toMatchObject({
      observedAt: '2026-01-01T08:00:10.500Z',
      type: 'upload-attempt',
    });
  });

  it('can cancel a scheduled replay before virtual time advances', () => {
    const scenario = createGpsScenario({ name: 'normal', seed: 42 });
    const clock = new VirtualClock(scenario.startAt);
    const emit = vi.fn();
    const replay = scheduleGpsScenario(scenario, clock, emit);

    replay.cancel();
    clock.runAll();

    expect(emit).not.toHaveBeenCalled();
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('requires a fresh clock with the matching UTC epoch', () => {
    const scenario = createGpsScenario({ name: 'normal', seed: 42 });
    const wrongEpoch = new VirtualClock('2026-01-02T08:00:00.000Z');
    expect(() => scheduleGpsScenario(scenario, wrongEpoch, vi.fn())).toThrow('start must match');

    const advanced = new VirtualClock(scenario.startAt);
    advanced.advanceBy(1);
    expect(() => scheduleGpsScenario(scenario, advanced, vi.fn())).toThrow('fresh virtual clock');
  });
});
