import type { PointInput } from '@running-tracker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaptureController, type CaptureState } from './capture-controller.js';
import type { CaptureSink, SourceMeasurement } from './capture-source.js';
import {
  DEMO_SIMULATOR_INTERVAL_MS,
  DEMO_SIMULATOR_LABEL,
  DEMO_SIMULATOR_POINT_COUNT,
  DemoSimulatorCaptureSource,
  demoSimulatorRoute,
} from './demo-simulator.js';
import type { PointMeasurement, RunScope, WriterLease } from './runner-storage.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const startAt = new Date('2026-10-28T08:00:00.000Z');

function recordingSink() {
  const measurements: SourceMeasurement[] = [];
  const sink = {
    complete: vi.fn(),
    error: vi.fn(),
    interrupted: vi.fn(),
    measurement: vi.fn((measurement: SourceMeasurement) => { measurements.push(measurement); }),
  } satisfies CaptureSink;
  return { measurements, sink };
}

const scope = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userId: '11111111-1111-4111-8111-111111111111',
};
const lease: WriterLease = {
  expiresAt: '2026-10-28T08:01:00.000Z',
  fencingToken: '1',
  ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  userId: scope.userId,
};

// The demo source behind the real capture controller, with a storage stand-in that numbers points as the IndexedDB
// writer does: one segment per session, the next sequence number per append.
function demoCapture(assertOwnedLease: () => Promise<WriterLease | null> = () => Promise.resolve(lease)) {
  let nextSeq = 1;
  const points: PointInput[] = [];
  const states: CaptureState[] = [];
  const storage = {
    allocateCaptureSegment: vi.fn<(scope: RunScope, lease: WriterLease) => Promise<number>>(() => Promise.resolve(4)),
    appendPointForWriter: vi.fn<(scope: RunScope, value: PointMeasurement, lease: WriterLease) => Promise<PointInput>>(
      (_scope, value) => Promise.resolve({ ...value, seq: String(nextSeq++) }),
    ),
  };
  const controller = new CaptureController({
    assertOwnedLease,
    onPoint: (point) => points.push(point),
    onState: (state) => states.push(state),
    scope,
    source: new DemoSimulatorCaptureSource({ now: () => startAt }),
    storage,
  });
  return { controller, points, states, storage };
}

// Great-circle distance in metres; plenty for steps of a few metres.
function distanceM(a: SourceMeasurement, b: SourceMeasurement): number {
  const radians = Math.PI / 180;
  const dLatitude = (b.latitude - a.latitude) * radians;
  const dLongitude = (b.longitude - a.longitude) * radians;
  const h = Math.sin(dLatitude / 2) ** 2
    + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(dLongitude / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

describe('demoSimulatorRoute', () => {
  const route = demoSimulatorRoute(startAt);

  it('is 60 measurements two seconds apart, strictly increasing from the start time', () => {
    expect(DEMO_SIMULATOR_POINT_COUNT).toBe(60);
    expect(DEMO_SIMULATOR_INTERVAL_MS).toBe(2_000);
    expect(route).toHaveLength(60);
    const times = route.map((measurement) => Date.parse(measurement.recordedAt));
    expect(times[0]).toBe(startAt.getTime());
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBe(2_000);
    }
    // About two minutes from the first measurement to the last.
    expect(times.at(-1)! - times[0]!).toBe(118_000);
  });

  it('is a plausible running loop: even steps at a running pace, a small accuracy, no jumps', () => {
    const steps = route.slice(1).map((measurement, index) => distanceM(route[index]!, measurement));
    for (const step of steps) {
      // Six metres in two seconds, 3 m/s or about 5:33 per kilometre, give or take the coordinate rounding.
      expect(step).toBeGreaterThan(5.5);
      expect(step).toBeLessThan(6.5);
    }
    // The loop closes, so a capture that starts again after the last point continues without a jump.
    expect(distanceM(route.at(-1)!, route[0]!)).toBeLessThan(6.5);
    // Every point stays near Warsaw, on a loop of under 60 m radius.
    const centre = { ...route[0]!, latitude: 52.2297, longitude: 21.0122 };
    for (const measurement of route) {
      expect(distanceM(centre, measurement)).toBeGreaterThan(55);
      expect(distanceM(centre, measurement)).toBeLessThan(60);
      expect(measurement.accuracyM).toBeGreaterThanOrEqual(4);
      expect(measurement.accuracyM).toBeLessThanOrEqual(6);
    }
    // Not one place repeated: every point of the lap is distinct.
    expect(new Set(route.map((measurement) => `${measurement.latitude},${measurement.longitude}`)).size).toBe(60);
  });

  it('carries measurements only: no sequence and no segment', () => {
    for (const measurement of route) {
      expect(Object.keys(measurement).sort()).toEqual(['accuracyM', 'latitude', 'longitude', 'recordedAt']);
    }
  });

  it('is deterministic: the same start gives the same route, a later start only later times', () => {
    expect(demoSimulatorRoute(startAt)).toEqual(route);
    const later = demoSimulatorRoute(new Date(startAt.getTime() + 300_000));
    expect(later.map(({ latitude, longitude }) => [latitude, longitude]))
      .toEqual(route.map(({ latitude, longitude }) => [latitude, longitude]));
    expect(Date.parse(later[0]!.recordedAt)).toBe(startAt.getTime() + 300_000);
  });
});

describe('DemoSimulatorCaptureSource', () => {
  it('names itself as the local demo simulator and says how long it lasts', () => {
    expect(new DemoSimulatorCaptureSource().label).toBe(DEMO_SIMULATOR_LABEL);
    expect(DEMO_SIMULATOR_LABEL).toBe('Simulator · local demo · about 2 min');
  });

  it('delivers one measurement at once, then one every two seconds, and completes once after the sixtieth', async () => {
    vi.useFakeTimers();
    const { measurements, sink } = recordingSink();
    const source = new DemoSimulatorCaptureSource({ now: () => startAt });

    source.start(sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(measurements).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(measurements).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(measurements).toHaveLength(2);

    // Well past the six points of the ordinary simulator, and still going.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(measurements).toHaveLength(12);
    expect(sink.complete).not.toHaveBeenCalled();

    // The last measurement is due 118 s after the first.
    await vi.advanceTimersByTimeAsync(118_000 - 22_000 - 1);
    expect(measurements).toHaveLength(59);
    expect(sink.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(measurements).toHaveLength(60);
    expect(sink.complete).toHaveBeenCalledOnce();
    // Completion comes after the last measurement, not before it.
    expect(sink.measurement.mock.invocationCallOrder.at(-1)!).toBeLessThan(sink.complete.mock.invocationCallOrder[0]!);

    await vi.runAllTimersAsync();
    expect(measurements).toHaveLength(60);
    expect(sink.complete).toHaveBeenCalledOnce();
    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.interrupted).not.toHaveBeenCalled();
    expect(measurements).toEqual(demoSimulatorRoute(startAt));
  });

  it('delivers nothing more, and never completes, once the subscription is stopped', async () => {
    vi.useFakeTimers();
    const { measurements, sink } = recordingSink();
    const subscription = new DemoSimulatorCaptureSource({ now: () => startAt }).start(sink);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(measurements).toHaveLength(6);
    subscription.stop();
    subscription.stop();
    await vi.runAllTimersAsync();

    expect(measurements).toHaveLength(6);
    expect(sink.complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delivers nothing when stopped before the first measurement', async () => {
    vi.useFakeTimers();
    const { sink } = recordingSink();
    new DemoSimulatorCaptureSource({ now: () => startAt }).start(sink).stop();
    await vi.runAllTimersAsync();

    expect(sink.measurement).not.toHaveBeenCalled();
    expect(sink.complete).not.toHaveBeenCalled();
  });

  it('stops at once when the consumer stops it from inside a measurement', async () => {
    vi.useFakeTimers();
    const source = new DemoSimulatorCaptureSource({ now: () => startAt });
    let subscription: { stop(): void } | null = null;
    const sink = {
      complete: vi.fn(),
      error: vi.fn(),
      interrupted: vi.fn(),
      // The capture controller stops the watch synchronously when it fails.
      measurement: vi.fn(() => subscription?.stop()),
    } satisfies CaptureSink;
    subscription = source.start(sink);
    await vi.runAllTimersAsync();

    expect(sink.measurement).toHaveBeenCalledOnce();
    expect(sink.complete).not.toHaveBeenCalled();
  });

  it('gives each subscription its own route from its own start time', async () => {
    vi.useFakeTimers();
    let now = startAt;
    const source = new DemoSimulatorCaptureSource({ now: () => now });
    const first = recordingSink();
    const second = recordingSink();

    const firstSubscription = source.start(first.sink);
    await vi.advanceTimersByTimeAsync(4_000);
    firstSubscription.stop();
    now = new Date(startAt.getTime() + 30_000);
    source.start(second.sink);
    await vi.runAllTimersAsync();

    expect(first.measurements).toHaveLength(3);
    expect(second.measurements).toHaveLength(60);
    expect(second.measurements[0]!.recordedAt).toBe('2026-10-28T08:00:30.000Z');
    // A later capture session never goes back before an earlier one.
    expect(Date.parse(second.measurements[0]!.recordedAt)).toBeGreaterThan(Date.parse(first.measurements.at(-1)!.recordedAt));
  });

  it('feeds the capture controller, which alone numbers, fences and stores the points', async () => {
    vi.useFakeTimers();
    const { controller, points, states, storage } = demoCapture();

    await controller.start();
    await vi.runAllTimersAsync();
    await controller.whenIdle();

    expect(storage.allocateCaptureSegment).toHaveBeenCalledOnce();
    expect(storage.appendPointForWriter).toHaveBeenCalledTimes(60);
    // Every append went in with the proven lease and the controller's segment; the sequence came from storage.
    for (const [appendScope, value, appendLease] of storage.appendPointForWriter.mock.calls) {
      expect(appendScope).toBe(scope);
      expect(appendLease).toBe(lease);
      expect(value).not.toHaveProperty('seq');
      expect(value).toMatchObject({ segmentId: 4 });
    }
    expect(points.map((point) => point.seq)).toEqual(Array.from({ length: 60 }, (_, index) => String(index + 1)));
    // Exhausted: capture completes once and stays complete. Nothing here touches the run's lifecycle.
    expect(states.filter((state) => state.status === 'complete')).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ capturedCount: 60, segmentId: 4, status: 'complete' });
  });

  it('stops capturing when the controller is stopped part-way, as Pause and Finish do', async () => {
    vi.useFakeTimers();
    const { controller, points, states } = demoCapture();

    await controller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await controller.whenIdle();
    expect(points).toHaveLength(11);
    controller.stop();
    await vi.runAllTimersAsync();
    await controller.whenIdle();

    expect(points).toHaveLength(11);
    expect(states.some((state) => state.status === 'complete')).toBe(false);
    expect(states.at(-1)).toEqual({ status: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops capturing when the writer lease is lost part-way', async () => {
    vi.useFakeTimers();
    let owned = true;
    const { controller, points, states } = demoCapture(() => Promise.resolve(owned ? lease : null));

    await controller.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await controller.whenIdle();
    owned = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await controller.whenIdle();
    await vi.runAllTimersAsync();
    await controller.whenIdle();

    expect(points).toHaveLength(3);
    expect(states.at(-1)).toMatchObject({ capturedCount: 3, status: 'lost' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls the default timers with the global object as receiver, as a browser requires', () => {
    const strictSetTimeout = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return 1;
    });
    const strictClearTimeout = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    });
    vi.stubGlobal('setTimeout', strictSetTimeout);
    vi.stubGlobal('clearTimeout', strictClearTimeout);

    const subscription = new DemoSimulatorCaptureSource().start(recordingSink().sink);
    subscription.stop();

    expect(strictSetTimeout).toHaveBeenCalledTimes(60);
    expect(strictClearTimeout).toHaveBeenCalledTimes(60);
  });
});
