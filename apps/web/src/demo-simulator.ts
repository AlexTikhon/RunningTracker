import type { CaptureSink, CaptureSource, CaptureSubscription, SourceMeasurement } from './capture-source.js';

// The Simulator of the local demo (docs/runbooks/demo.md), offered instead of the six-point seeded scenario only where
// the demo sign-in buttons are: a dev server started with VITE_LOCAL_DEMO_ENABLED=true. It lasts about two minutes
// per capture session, so a presenter can go offline while it is still capturing. Like every source it only supplies
// measurements: the capture controller numbers, fences and stores them, and the upload worker sends them.

export const DEMO_SIMULATOR_POINT_COUNT = 60;
export const DEMO_SIMULATOR_INTERVAL_MS = 2_000;
export const DEMO_SIMULATOR_LABEL = 'Simulator · local demo · about 2 min';

// One lap of a 57 m loop near Warsaw in 60 even steps of about 6 m (3 m/s, about 5:33 per kilometre). The last point
// is one step from the first, so a session that starts again after a complete one continues without a jump.
const radiusMetres = 57;
const centreLatitude = 52.2297;
const centreLongitude = 21.0122;
const metresPerDegreeLatitude = 111_320;

function round(value: number): number {
  return Math.round(value * 10_000_000) / 10_000_000;
}

// The measurements of one capture session that starts at `startAt`: the first at that time, then one every two
// seconds. Deterministic: the same start gives the same route.
export function demoSimulatorRoute(startAt: Date): readonly SourceMeasurement[] {
  const startMs = startAt.getTime();
  const angleStep = (2 * Math.PI) / DEMO_SIMULATOR_POINT_COUNT;
  const cosine = Math.cos((centreLatitude * Math.PI) / 180);
  return Array.from({ length: DEMO_SIMULATOR_POINT_COUNT }, (_, index) => {
    const angle = index * angleStep;
    return {
      accuracyM: 4 + (index % 3),
      latitude: round(centreLatitude + (radiusMetres * Math.sin(angle)) / metresPerDegreeLatitude),
      longitude: round(centreLongitude + (radiusMetres * Math.cos(angle)) / (metresPerDegreeLatitude * cosine)),
      recordedAt: new Date(startMs + index * DEMO_SIMULATOR_INTERVAL_MS).toISOString(),
    };
  });
}

export interface DemoSimulatorCaptureSourceOptions {
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class DemoSimulatorCaptureSource implements CaptureSource {
  public readonly label = DEMO_SIMULATOR_LABEL;
  readonly #clearTimer: typeof clearTimeout;
  readonly #now: () => Date;
  readonly #setTimer: typeof setTimeout;

  public constructor(options: DemoSimulatorCaptureSourceOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    // Bound to the global object: a browser rejects the native timers when they run with this source as receiver.
    this.#setTimer = options.setTimer ?? setTimeout.bind(globalThis);
    this.#clearTimer = options.clearTimer ?? clearTimeout.bind(globalThis);
  }

  public start(sink: CaptureSink): CaptureSubscription {
    const route = demoSimulatorRoute(this.#now());
    let active = true;
    const timers = route.map((measurement, index) => this.#setTimer(() => {
      if (!active) return;
      sink.measurement(measurement);
      // The consumer may have stopped this subscription from inside the measurement.
      if (active && index === route.length - 1) sink.complete();
    }, index * DEMO_SIMULATOR_INTERVAL_MS));
    return {
      stop: () => {
        if (!active) return;
        active = false;
        for (const timer of timers) this.#clearTimer(timer);
      },
    };
  }
}
