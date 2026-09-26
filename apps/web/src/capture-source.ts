import {
  createGpsScenario,
  type GpsScenarioName,
} from '@running-tracker/fixtures';

import type { PointMeasurement } from './runner-storage.js';

export type SourceMeasurement = Omit<PointMeasurement, 'segmentId'>;

export interface CaptureSink {
  complete(): void;
  error(error: Error): void;
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
  geolocation?: GeolocationPort;
  positionOptions?: PositionOptions;
}

function geolocationError(error: GeolocationPositionError): Error {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return new Error('Location permission was denied. Choose the simulator or allow location access.');
    case error.POSITION_UNAVAILABLE:
      return new Error('The device could not determine a current location.');
    case error.TIMEOUT:
      return new Error('The location provider timed out while waiting for a fresh measurement.');
    default:
      return new Error('The location provider failed.');
  }
}

export class GeolocationCaptureSource implements CaptureSource {
  public readonly label = 'Device GPS';
  readonly #geolocation: GeolocationPort | undefined;
  readonly #positionOptions: PositionOptions;

  public constructor(options: GeolocationCaptureSourceOptions = {}) {
    this.#geolocation = options.geolocation
      ?? (typeof navigator === 'undefined' ? undefined : navigator.geolocation);
    this.#positionOptions = options.positionOptions ?? {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10_000,
    };
  }

  public start(sink: CaptureSink): CaptureSubscription {
    if (this.#geolocation === undefined) {
      throw new Error('Geolocation is unavailable in this browser. Choose the simulator instead.');
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
        if (active) sink.error(geolocationError(error));
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
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
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
