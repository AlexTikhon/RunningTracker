import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GeolocationCaptureSource,
  LocationFailure,
  SimulatorCaptureSource,
  type CaptureSink,
} from './capture-source.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A browser Geolocation stand-in that keeps the registered callbacks, so a test can play the receiver's answers in
// order. The codes are the GeolocationPositionError constants: 1 denied, 2 unavailable, 3 timeout.
function geolocationHarness() {
  let success: PositionCallback | undefined;
  let failure: PositionErrorCallback | null | undefined;
  const geolocation = {
    clearWatch: vi.fn(),
    watchPosition: vi.fn((next: PositionCallback, error?: PositionErrorCallback | null) => {
      success = next;
      failure = error;
      return 17;
    }),
  };
  return {
    fail: (code: number) => failure?.({
      code,
      message: 'browser message',
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    }),
    geolocation,
    succeed: (latitude: number, recordedAt: string) => success?.({
      coords: {
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude,
        longitude: 21.0122,
        speed: null,
        toJSON: () => ({}),
      },
      timestamp: Date.parse(recordedAt),
      toJSON: () => ({}),
    }),
  };
}

function recordingSink() {
  return {
    complete: vi.fn(),
    error: vi.fn<(error: Error) => void>(),
    interrupted: vi.fn<(failure: LocationFailure) => void>(),
    measurement: vi.fn(),
  } satisfies CaptureSink;
}

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
      interrupted: vi.fn(),
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

  it.each([
    ['TIMEOUT', 3, 'timeout'],
    ['POSITION_UNAVAILABLE', 2, 'position-unavailable'],
  ] as const)('reports %s as a temporary interruption of the same live watch, then delivers the next fix', (_name, code, kind) => {
    const browser = geolocationHarness();
    const sink = recordingSink();
    const source = new GeolocationCaptureSource({ geolocation: browser.geolocation });

    source.start(sink);
    browser.fail(code);
    browser.fail(code);
    browser.succeed(52.2297, '2026-09-26T08:00:05.000Z');

    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.interrupted).toHaveBeenCalledTimes(2);
    const failure = sink.interrupted.mock.calls[0]?.[0];
    expect(failure).toBeInstanceOf(LocationFailure);
    expect(failure).toMatchObject({ kind, temporary: true });
    expect(sink.measurement).toHaveBeenCalledOnce();
    expect(browser.geolocation.watchPosition).toHaveBeenCalledOnce();
    expect(browser.geolocation.clearWatch).not.toHaveBeenCalled();
  });

  it('reports a permission denial as a terminal failure with its own kind', () => {
    const browser = geolocationHarness();
    const sink = recordingSink();
    const source = new GeolocationCaptureSource({ geolocation: browser.geolocation });

    source.start(sink);
    browser.fail(1);

    expect(sink.interrupted).not.toHaveBeenCalled();
    expect(sink.error).toHaveBeenCalledOnce();
    expect(sink.error.mock.calls[0]?.[0]).toMatchObject({ kind: 'permission-denied', temporary: false });
  });

  it('reports an unknown provider failure as terminal, never as temporary', () => {
    const browser = geolocationHarness();
    const sink = recordingSink();

    new GeolocationCaptureSource({ geolocation: browser.geolocation }).start(sink);
    browser.fail(99);

    expect(sink.interrupted).not.toHaveBeenCalled();
    expect(sink.error.mock.calls[0]?.[0]).toMatchObject({ kind: 'unknown', temporary: false });
  });

  it('refuses to start without geolocation with an unsupported failure', () => {
    // null stands for a browser without navigator.geolocation.
    const source = new GeolocationCaptureSource({ geolocation: null });

    expect(() => source.start(recordingSink())).toThrow(LocationFailure);
    expect(() => source.start(recordingSink())).toThrow(expect.objectContaining({ kind: 'unsupported', temporary: false }) as Error);
  });

  it('delivers nothing from a watch after it was stopped', () => {
    const browser = geolocationHarness();
    const sink = recordingSink();

    const subscription = new GeolocationCaptureSource({ geolocation: browser.geolocation }).start(sink);
    subscription.stop();
    subscription.stop();
    browser.fail(3);
    browser.succeed(52.2297, '2026-09-26T08:00:05.000Z');

    expect(browser.geolocation.clearWatch).toHaveBeenCalledOnce();
    expect(sink.interrupted).not.toHaveBeenCalled();
    expect(sink.measurement).not.toHaveBeenCalled();
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

    source.start({ complete, error: vi.fn(), interrupted: vi.fn(), measurement: (value) => measurements.push(value) });
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

    const subscription = source.start({ complete: vi.fn(), error: vi.fn(), interrupted: vi.fn(), measurement: vi.fn() });
    subscription.stop();

    expect(strictSetTimeout).toHaveBeenCalledTimes(6);
    expect(strictClearTimeout).toHaveBeenCalledTimes(6);
  });
});
