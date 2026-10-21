import type { PointInput } from '@running-tracker/contracts';

import {
  LocationFailure,
  type CaptureSource,
  type CaptureSubscription,
  type SourceMeasurement,
} from './capture-source.js';
import type {
  IndexedDbRunnerStorage,
  RunScope,
  WriterLease,
} from './runner-storage.js';

const MAX_PENDING_CALLBACKS = 100;

type CaptureStorage = Pick<
  IndexedDbRunnerStorage,
  'allocateCaptureSegment' | 'appendPointForWriter'
>;

// Why capture stopped (ADR-0061). Each one is reported on its own; only the GPS failures ('permission-denied' and an
// unclassified receiver failure, 'location') may be retried, and only explicitly. 'source' is an exception from the
// source that is not a classified location failure; 'storage' is anything thrown while proving the lease or
// persisting. A lost writer is the separate 'lost' state.
export type CaptureFailureReason =
  | 'location'
  | 'overflow'
  | 'permission-denied'
  | 'source'
  | 'storage'
  | 'unsupported';

// What the current watch delivered last: nothing yet, a fix that was persisted, or a temporary failure.
export type CaptureSignal = 'live' | 'no-fix' | 'waiting';

// What this controller has persisted. Kept through temporary failures and explicit retries; the time is on the
// injected monotonic clock, not the wall clock and not the measurement's own timestamp.
export interface CaptureFacts {
  capturedCount: number;
  lastPersistedAtMs: number | null;
  lastRecordedAt: string | null;
}

export type CaptureState =
  | { status: 'idle' }
  | (CaptureFacts & { source: string; status: 'starting' })
  | (CaptureFacts & {
      consecutiveFailures: number;
      segmentId: number;
      signal: CaptureSignal;
      source: string;
      // When the current watch was started, on the monotonic clock.
      startedAtMs: number;
      status: 'capturing' | 'complete';
      // The last temporary failure since the last persisted fix.
      warning: string | null;
    })
  | (CaptureFacts & { message: string; reason: CaptureFailureReason; source: string; status: 'error' })
  | (CaptureFacts & { message: string; source: string; status: 'lost' });

export interface CaptureControllerOptions {
  assertOwnedLease: () => Promise<WriterLease | null>;
  // A monotonic clock in milliseconds, for the freshness the page shows. Defaults to performance.now().
  now?: () => number;
  onPoint: (point: PointInput) => void;
  onState: (state: CaptureState) => void;
  scope: RunScope;
  source: CaptureSource;
  storage: CaptureStorage;
}

export function captureFailureMayRetry(reason: CaptureFailureReason): boolean {
  return reason === 'permission-denied' || reason === 'location';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Capture failed for an unknown reason.';
}

function sourceFailureReason(error: unknown): CaptureFailureReason {
  if (!(error instanceof LocationFailure)) return 'source';
  if (error.kind === 'permission-denied' || error.kind === 'unsupported') return error.kind;
  return 'location';
}

export class CaptureController {
  readonly #now: () => number;
  readonly #options: CaptureControllerOptions;
  #capturedCount = 0;
  #consecutiveFailures = 0;
  #failure: CaptureFailureReason | 'lost' | null = null;
  #generation = 0;
  #lastPersistedAtMs: number | null = null;
  #lastRecordedAt: string | null = null;
  #pendingCallbacks = 0;
  #queue: Promise<void> = Promise.resolve();
  #segmentId: number | null = null;
  #signal: CaptureSignal = 'no-fix';
  #starting: Promise<boolean> | null = null;
  #startedAtMs = 0;
  #stopped = false;
  #subscription: CaptureSubscription | null = null;
  #warning: string | null = null;

  public constructor(options: CaptureControllerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  // Starts one watch in a newly allocated durable segment. A stopped controller never starts again: pause, finish,
  // a replaced session or another writer end it, and the page creates a new controller for the next eligible run.
  public start(): Promise<boolean> {
    if (this.#stopped || this.#starting !== null || this.#subscription !== null || this.#segmentId !== null) {
      return Promise.resolve(false);
    }
    const starting = this.#start();
    this.#starting = starting;
    return starting;
  }

  // The explicit "Retry GPS": stops the current watch, if any, and starts one again through the same proof of the
  // writer lease and a new durable segment. Refused while a start is in flight (so repeated clicks start one watch),
  // after stop(), and after a failure that a new watch cannot fix (storage, overflow, unsupported, lost writer).
  public retry(): Promise<boolean> {
    if (this.#stopped || this.#starting !== null) return Promise.resolve(false);
    if (this.#failure === 'lost' || (this.#failure !== null && !captureFailureMayRetry(this.#failure))) {
      return Promise.resolve(false);
    }
    this.#release();
    return this.start();
  }

  public stop(): void {
    this.#stopped = true;
    this.#release();
    this.#options.onState({ status: 'idle' });
  }

  public whenIdle(): Promise<void> {
    return this.#queue;
  }

  async #start(): Promise<boolean> {
    const generation = ++this.#generation;
    this.#failure = null;
    this.#options.onState({ ...this.#facts(), source: this.#options.source.label, status: 'starting' });
    try {
      const lease = await this.#options.assertOwnedLease();
      if (generation !== this.#generation) return false;
      if (lease === null) {
        this.#lost();
        return false;
      }
      const segmentId = await this.#options.storage.allocateCaptureSegment(
        this.#options.scope,
        lease,
      );
      if (generation !== this.#generation) return false;
      this.#segmentId = segmentId;
      this.#signal = 'no-fix';
      this.#consecutiveFailures = 0;
      this.#warning = null;
      this.#startedAtMs = this.#now();
      let subscription: CaptureSubscription;
      try {
        subscription = this.#options.source.start({
          complete: () => this.#complete(generation),
          error: (error) => this.#fail(generation, error, sourceFailureReason(error)),
          interrupted: (failure) => this.#interrupted(generation, segmentId, failure),
          measurement: (measurement) => this.#measurement(generation, segmentId, measurement),
        });
      } catch (error) {
        this.#fail(generation, error, sourceFailureReason(error));
        return false;
      }
      if (generation !== this.#generation) {
        subscription.stop();
        return false;
      }
      this.#subscription = subscription;
      this.#emit('capturing');
      return true;
    } catch (error) {
      this.#fail(generation, error, 'storage');
      return false;
    } finally {
      this.#starting = null;
    }
  }

  #measurement(generation: number, segmentId: number, measurement: SourceMeasurement): void {
    this.#admit(generation, segmentId, async () => {
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
      this.#lastPersistedAtMs = this.#now();
      this.#signal = 'live';
      this.#consecutiveFailures = 0;
      this.#warning = null;
      this.#options.onPoint(point);
      this.#emit('capturing');
    });
  }

  // A temporary failure of the same live watch. It is applied in callback order, behind any fix still being
  // persisted, and changes only what the page shows: the watch, the segment and the sequence stay as they are.
  #interrupted(generation: number, segmentId: number, failure: LocationFailure): void {
    this.#admit(generation, segmentId, () => {
      this.#signal = 'waiting';
      this.#consecutiveFailures += 1;
      this.#warning = failure.message;
      this.#emit('capturing');
    });
  }

  // Queues one callback of the current watch, behind the callbacks before it. The queue is bounded: a source that
  // calls back faster than storage persists stops capture instead of growing memory.
  #admit(generation: number, segmentId: number, operation: () => Promise<void> | void): void {
    if (generation !== this.#generation || this.#segmentId !== segmentId) return;
    if (this.#pendingCallbacks >= MAX_PENDING_CALLBACKS) {
      this.#fail(generation, new Error(
        'Capture stopped because measurements arrived faster than local storage could persist them.',
      ), 'overflow');
      return;
    }
    this.#pendingCallbacks += 1;
    this.#enqueue(async () => {
      try {
        if (generation !== this.#generation || this.#segmentId !== segmentId) return;
        await operation();
      } finally {
        this.#pendingCallbacks -= 1;
      }
    }, generation);
  }

  #complete(generation: number): void {
    this.#enqueue(() => {
      if (generation === this.#generation) this.#emit('complete');
    }, generation);
  }

  #fail(generation: number, error: unknown, reason: CaptureFailureReason): void {
    if (generation !== this.#generation) return;
    this.#release();
    this.#failure = reason;
    this.#options.onState({
      ...this.#facts(),
      message: errorMessage(error),
      reason,
      source: this.#options.source.label,
      status: 'error',
    });
  }

  #lost(): void {
    this.#release();
    this.#failure = 'lost';
    this.#options.onState({
      ...this.#facts(),
      message: 'Capture stopped because this tab no longer owns the writer lease.',
      source: this.#options.source.label,
      status: 'lost',
    });
  }

  // Ends the current generation: its watch is stopped and every late callback of it is ignored.
  #release(): void {
    this.#generation += 1;
    this.#subscription?.stop();
    this.#subscription = null;
    this.#segmentId = null;
  }

  #facts(): CaptureFacts {
    return {
      capturedCount: this.#capturedCount,
      lastPersistedAtMs: this.#lastPersistedAtMs,
      lastRecordedAt: this.#lastRecordedAt,
    };
  }

  #emit(status: 'capturing' | 'complete'): void {
    if (this.#segmentId === null) return;
    this.#options.onState({
      ...this.#facts(),
      consecutiveFailures: this.#consecutiveFailures,
      segmentId: this.#segmentId,
      signal: this.#signal,
      source: this.#options.source.label,
      startedAtMs: this.#startedAtMs,
      status,
      warning: this.#warning,
    });
  }

  #enqueue(operation: () => Promise<void> | void, generation: number): void {
    this.#queue = this.#queue
      .then(operation)
      .catch((error: unknown) => {
        this.#fail(generation, error, 'storage');
      });
  }
}
