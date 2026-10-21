import {
  createGpsScenario,
  type GpsScenarioName,
} from '@running-tracker/fixtures';

import type { PointMeasurement } from './runner-storage.js';

export type SourceMeasurement = Omit<PointMeasurement, 'segmentId'>;

export type LocationFailureKind =
  | 'permission-denied'
  | 'position-unavailable'
  | 'timeout'
  | 'unknown'
  | 'unsupported';

const locationFailureMessages: Record<LocationFailureKind, string> = {
  'permission-denied': 'Location permission was denied. Choose the simulator or allow location access.',
  'position-unavailable': 'The device could not determine a current location.',
  timeout: 'The location provider timed out while waiting for a fresh measurement.',
  unknown: 'The location provider failed.',
  unsupported: 'Geolocation is unavailable in this browser. Choose the simulator instead.',
};

// A classified failure of the location receiver. Only a TIMEOUT or POSITION_UNAVAILABLE is temporary: the browser
// keeps the registered watch and tries again by itself (W3C Geolocation, "request a position"). Anything that is
// not a LocationFailure is never treated as temporary.
export class LocationFailure extends Error {
  public readonly kind: LocationFailureKind;

  public constructor(kind: LocationFailureKind, message = locationFailureMessages[kind]) {
    super(message);
    this.name = 'LocationFailure';
    this.kind = kind;
  }

  public get temporary(): boolean {
    return this.kind === 'timeout' || this.kind === 'position-unavailable';
  }
}

export interface CaptureSink {
  complete(): void;
  // The subscription is over: the source delivers nothing more.
  error(error: Error): void;
  // A temporary failure of a subscription that stays live: the next measurement may still arrive.
  interrupted(failure: LocationFailure): void;
  measurement(measurement: SourceMeasurement): void;
}

export interface CaptureSubscription {
  stop(): void;
}

export interface CaptureSource {
  readonly label: string;
  start(sink: CaptureSink): CaptureSubscription;
}

type GeolocationPort = Pick<Geolocation, 'clearWatch' | 'watchPosition'>;

export interface GeolocationCaptureSourceOptions {
  // null stands for a browser without geolocation; omitted, navigator.geolocation is used.
  geolocation?: GeolocationPort | null;
  positionOptions?: PositionOptions;
}

function geolocationFailure(error: GeolocationPositionError): LocationFailure {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return new LocationFailure('permission-denied');
    case error.POSITION_UNAVAILABLE:
      return new LocationFailure('position-unavailable');
    case error.TIMEOUT:
      return new LocationFailure('timeout');
    default:
      return new LocationFailure('unknown');
  }
}

export class GeolocationCaptureSource implements CaptureSource {
  public readonly label = 'Device GPS';
  readonly #geolocation: GeolocationPort | undefined;
  readonly #positionOptions: PositionOptions;

  public constructor(options: GeolocationCaptureSourceOptions = {}) {
    this.#geolocation = options.geolocation === null
      ? undefined
      : options.geolocation ?? (typeof navigator === 'undefined' ? undefined : navigator.geolocation);
    this.#positionOptions = options.positionOptions ?? {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10_000,
    };
  }

  public start(sink: CaptureSink): CaptureSubscription {
    if (this.#geolocation === undefined) {
      throw new LocationFailure('unsupported');
    }
    let active = true;
    const watchId = this.#geolocation.watchPosition(
      (position) => {
        if (!active) return;
        sink.measurement({
          accuracyM: position.coords.accuracy,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          recordedAt: new Date(position.timestamp).toISOString(),
        });
      },
      (error) => {
        if (!active) return;
        // A temporary failure leaves the watch registered: the browser keeps acquiring and the next fix still comes
        // to this callback. Only a terminal failure ends the subscription; the consumer then stops it.
        const failure = geolocationFailure(error);
        if (failure.temporary) sink.interrupted(failure);
        else sink.error(failure);
      },
      this.#positionOptions,
    );
    return {
      stop: () => {
        if (!active) return;
        active = false;
        this.#geolocation?.clearWatch(watchId);
      },
    };
  }
}

export interface SimulatorCaptureSourceOptions {
  name?: GpsScenarioName;
  now?: () => Date;
  seed?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class SimulatorCaptureSource implements CaptureSource {
  public readonly label: string;
  readonly #clearTimer: typeof clearTimeout;
  readonly #name: GpsScenarioName;
  readonly #now: () => Date;
  readonly #seed: number;
  readonly #setTimer: typeof setTimeout;

  public constructor(options: SimulatorCaptureSourceOptions = {}) {
    this.#name = options.name ?? 'normal';
    this.#seed = options.seed ?? 1;
    this.#now = options.now ?? (() => new Date());
    // Bound to the global object: a browser rejects the native timers when they run with this source as receiver.
    this.#setTimer = options.setTimer ?? setTimeout.bind(globalThis);
    this.#clearTimer = options.clearTimer ?? clearTimeout.bind(globalThis);
    this.label = `Simulator · ${this.#name} · seed ${this.#seed}`;
  }

  public start(sink: CaptureSink): CaptureSubscription {
    const scenario = createGpsScenario({
      name: this.#name,
      seed: this.#seed,
      startAt: this.#now(),
    });
    let active = true;
    const timers = scenario.captures.map((capture, index) => this.#setTimer(() => {
      if (!active) return;
      const { accuracyM, latitude, longitude, recordedAt } = capture.point;
      sink.measurement({ accuracyM, latitude, longitude, recordedAt });
      if (index === scenario.captures.length - 1) sink.complete();
    }, capture.atMs));
    return {
      stop: () => {
        if (!active) return;
        active = false;
        for (const timer of timers) this.#clearTimer(timer);
      },
    };
  }
}
