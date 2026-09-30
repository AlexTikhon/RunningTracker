import type { Clock } from '../clock.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import { defaultLogger, describeError, type Logger } from '../observability/logger.js';

export interface PeriodicRunnerOptions {
  clock: Clock;
  intervalMs: number;
  logger?: Logger;
  metrics?: ApiMetrics['maintenance'];
  onError?: (error: unknown) => void;
  runOnce: () => Promise<unknown>;
  taskName: string;
}

export class PeriodicRunner {
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #metrics: ApiMetrics['maintenance'] | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #runOnce: () => Promise<unknown>;
  readonly #taskLabel: string;
  #running = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: PeriodicRunnerOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error(`${options.taskName} interval must be a positive integer`);
    }
    const logger = options.logger ?? defaultLogger;
    this.#clock = options.clock;
    this.#intervalMs = options.intervalMs;
    this.#metrics = options.metrics;
    this.#taskLabel = options.taskName.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '');
    this.#onError =
      options.onError ??
      ((error) =>
        logger.error('maintenance.cycle.failed', { task: this.#taskLabel, ...describeError(error) }));
    this.#runOnce = options.runOnce;
  }

  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#scheduleNext();
  }

  public stop(): void {
    this.#started = false;
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #scheduleNext(): void {
    if (!this.#started || this.#running || this.#timer !== undefined) {
      return;
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      void this.#executeCycle();
    }, this.#intervalMs);
  }

  async #executeCycle(): Promise<void> {
    if (!this.#started || this.#running) {
      return;
    }
    this.#running = true;
    const startedAt = this.#clock.monotonicNow();
    try {
      await this.#runOnce();
      this.#record('ok', startedAt);
    } catch (error) {
      this.#record('error', startedAt);
      this.#onError(error);
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  #record(outcome: 'error' | 'ok', startedAt: number): void {
    const metrics = this.#metrics;
    if (metrics === undefined) {
      return;
    }
    const task = this.#taskLabel;
    metrics.cycles.inc({ outcome, task });
    metrics.durationSeconds.observe({ task }, Math.max(0, (this.#clock.monotonicNow() - startedAt) / 1_000));
    if (outcome === 'ok') {
      metrics.lastSuccessTimestampSeconds.set({ task }, Math.floor(this.#clock.utcNow().getTime() / 1_000));
    }
  }
}
