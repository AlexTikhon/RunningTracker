import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GeolocationCaptureSource,
  SimulatorCaptureSource,
  type CaptureSink,
} from './capture-source.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('capture sources', () => {
  it('adapts browser geolocation and clears the watch without exposing source-specific data', () => {
    let success: PositionCallback | undefined;
    const geolocation = {
      clearWatch: vi.fn(),
      watchPosition: vi.fn((next: PositionCallback) => {
        success = next;
        return 17;
      }),
    };
    const measurement = vi.fn();
    const sink: CaptureSink = {
      complete: vi.fn(),
      error: vi.fn(),
      measurement,
    };
    const source = new GeolocationCaptureSource({ geolocation });

    const subscription = source.start(sink);
    success?.({
      coords: {
        accuracy: 4.5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude: 52.2297,
        longitude: 21.0122,
        speed: null,
        toJSON: () => ({}),
      },
      timestamp: Date.parse('2026-09-26T08:00:00.000Z'),
      toJSON: () => ({}),
    });
    subscription.stop();

    expect(measurement).toHaveBeenCalledWith({
      accuracyM: 4.5,
      latitude: 52.2297,
      longitude: 21.0122,
      recordedAt: '2026-09-26T08:00:00.000Z',
    });
    expect(geolocation.clearWatch).toHaveBeenCalledWith(17);
  });

  it('replays the existing seeded simulator through the same measurement interface', async () => {
    vi.useFakeTimers();
    const measurements: unknown[] = [];
    const complete = vi.fn();
    const source = new SimulatorCaptureSource({
      name: 'normal',
      now: () => new Date('2026-09-26T08:00:00.000Z'),
      seed: 42,
    });

    source.start({ complete, error: vi.fn(), measurement: (value) => measurements.push(value) });
    await vi.runAllTimersAsync();

    expect(measurements).toHaveLength(6);
    expect(measurements[0]).toEqual(expect.objectContaining({
      recordedAt: '2026-09-26T08:00:00.000Z',
    }));
    expect(measurements[0]).not.toHaveProperty('seq');
    expect(measurements[0]).not.toHaveProperty('segmentId');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('calls the default timers with the global object as receiver, as a browser requires', () => {
    // A browser throws "Illegal invocation" when the native timer functions run with another receiver, such
    // as the source that holds them. These stand-ins reject any receiver but the global object.
    const strictSetTimeout = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return 1;
    });
    const strictClearTimeout = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    });
    vi.stubGlobal('setTimeout', strictSetTimeout);
    vi.stubGlobal('clearTimeout', strictClearTimeout);
    const source = new SimulatorCaptureSource({ name: 'normal', seed: 1 });

    const subscription = source.start({ complete: vi.fn(), error: vi.fn(), measurement: vi.fn() });
    subscription.stop();

    expect(strictSetTimeout).toHaveBeenCalledTimes(6);
    expect(strictClearTimeout).toHaveBeenCalledTimes(6);
  });
});
