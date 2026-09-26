import type { PointInput } from '@running-tracker/contracts';

import type { CaptureSource, CaptureSubscription, SourceMeasurement } from './capture-source.js';
import type {
  IndexedDbRunnerStorage,
  RunScope,
  WriterLease,
} from './runner-storage.js';

const MAX_PENDING_MEASUREMENTS = 100;

type CaptureStorage = Pick<
  IndexedDbRunnerStorage,
  'allocateCaptureSegment' | 'appendPointForWriter'
>;

export type CaptureState =
  | { status: 'idle' }
  | { source: string; status: 'starting' }
  | {
      capturedCount: number;
      lastRecordedAt: string | null;
      segmentId: number;
      source: string;
      status: 'capturing' | 'complete';
    }
  | { message: string; source: string; status: 'error' | 'lost' };

export interface CaptureControllerOptions {
  assertOwnedLease: () => Promise<WriterLease | null>;
  onPoint: (point: PointInput) => void;
  onState: (state: CaptureState) => void;
  scope: RunScope;
  source: CaptureSource;
  storage: CaptureStorage;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Capture failed for an unknown reason.';
}

export class CaptureController {
  readonly #options: CaptureControllerOptions;
  #capturedCount = 0;
  #generation = 0;
  #lastRecordedAt: string | null = null;
  #pendingMeasurements = 0;
  #queue: Promise<void> = Promise.resolve();
  #segmentId: number | null = null;
  #subscription: CaptureSubscription | null = null;

  public constructor(options: CaptureControllerOptions) {
    this.#options = options;
  }

  public async start(): Promise<boolean> {
    if (this.#subscription !== null || this.#segmentId !== null) {
      return false;
    }
    const generation = ++this.#generation;
    this.#options.onState({ source: this.#options.source.label, status: 'starting' });
    try {
      const lease = await this.#options.assertOwnedLease();
      if (lease === null || generation !== this.#generation) {
        if (generation === this.#generation) this.#lost();
        return false;
      }
      const segmentId = await this.#options.storage.allocateCaptureSegment(
        this.#options.scope,
        lease,
      );
      if (generation !== this.#generation) return false;
      this.#segmentId = segmentId;
      const subscription = this.#options.source.start({
        complete: () => this.#complete(generation),
        error: (error) => this.#fail(generation, error),
        measurement: (measurement) => this.#measurement(generation, segmentId, measurement),
      });
      if (generation !== this.#generation) {
        subscription.stop();
        return false;
      }
      this.#subscription = subscription;
      this.#emit('capturing');
      return true;
    } catch (error) {
      if (generation === this.#generation) this.#fail(generation, error);
      return false;
    }
  }

  public stop(): void {
    this.#generation += 1;
    this.#subscription?.stop();
    this.#subscription = null;
    this.#segmentId = null;
    this.#options.onState({ status: 'idle' });
  }

  public whenIdle(): Promise<void> {
    return this.#queue;
  }

  #measurement(generation: number, segmentId: number, measurement: SourceMeasurement): void {
    if (generation !== this.#generation || this.#segmentId !== segmentId) return;
    if (this.#pendingMeasurements >= MAX_PENDING_MEASUREMENTS) {
      this.#fail(generation, new Error(
        'Capture stopped because measurements arrived faster than local storage could persist them.',
      ));
      return;
    }
    this.#pendingMeasurements += 1;
    this.#enqueue(async () => {
      try {
        if (generation !== this.#generation || this.#segmentId !== segmentId) return;
        const lease = await this.#options.assertOwnedLease();
        if (generation !== this.#generation || this.#segmentId !== segmentId) return;
        if (lease === null) {
          this.#lost();
          return;
        }
        const point = await this.#options.storage.appendPointForWriter(
          this.#options.scope,
          { ...measurement, segmentId },
          lease,
        );
        if (generation !== this.#generation || this.#segmentId !== segmentId) return;
        this.#capturedCount += 1;
        this.#lastRecordedAt = point.recordedAt;
        this.#options.onPoint(point);
        this.#emit('capturing');
      } finally {
        this.#pendingMeasurements -= 1;
      }
    }, generation);
  }

  #complete(generation: number): void {
    this.#enqueue(() => {
      if (generation === this.#generation) this.#emit('complete');
    }, generation);
  }

  #fail(generation: number, error: unknown): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#subscription?.stop();
    this.#subscription = null;
    this.#segmentId = null;
    this.#options.onState({
      message: errorMessage(error),
      source: this.#options.source.label,
      status: 'error',
    });
  }

  #lost(): void {
    this.#generation += 1;
    this.#subscription?.stop();
    this.#subscription = null;
    this.#segmentId = null;
    this.#options.onState({
      message: 'Capture stopped because this tab no longer owns the writer lease.',
      source: this.#options.source.label,
      status: 'lost',
    });
  }

  #emit(status: 'capturing' | 'complete'): void {
    if (this.#segmentId === null) return;
    this.#options.onState({
      capturedCount: this.#capturedCount,
      lastRecordedAt: this.#lastRecordedAt,
      segmentId: this.#segmentId,
      source: this.#options.source.label,
      status,
    });
  }

  #enqueue(operation: () => Promise<void> | void, generation: number): void {
    this.#queue = this.#queue
      .then(operation)
      .catch((error: unknown) => {
        this.#fail(generation, error);
      });
  }
}
