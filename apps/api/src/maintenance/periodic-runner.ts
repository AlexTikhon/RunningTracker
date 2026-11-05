import type { Clock } from '../clock.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import { defaultLogger, describeError, type Logger } from '../observability/logger.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_FAILURE_DELAY_MS = 300_000;

export interface PeriodicRunnerOptions {
  clock: Clock;
  intervalMs: number;
  logger?: Logger;
  metrics?: ApiMetrics['maintenance'];
  onError?: (error: unknown) => void;
  random?: () => number;
  runOnce: () => Promise<unknown>;
  taskName: string;
}

export class PeriodicRunner {
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #logger: Logger;
  readonly #metrics: ApiMetrics['maintenance'] | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #random: () => number;
  readonly #runOnce: () => Promise<unknown>;
  readonly #taskLabel: string;
  #retryCeilingMs: number;
  #nextDelayMs: number;
  #consecutiveFailures = 0;
  #running = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: PeriodicRunnerOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0 || options.intervalMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`${options.taskName} interval must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
    }
    const logger = options.logger ?? defaultLogger;
    this.#logger = logger;
    this.#clock = options.clock;
    this.#intervalMs = options.intervalMs;
    this.#retryCeilingMs = options.intervalMs;
    this.#nextDelayMs = options.intervalMs;
    this.#random = options.random ?? Math.random;
    this.#metrics = options.metrics;
    this.#taskLabel = options.taskName.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '');
    this.#onError =
      options.onError ??
      ((error) =>
        logger.error('maintenance.cycle.failed', {
          task: this.#taskLabel, count: this.#consecutiveFailures,
          retryDelayMs: this.#nextDelayMs, ...describeError(error),
        }));
    this.#runOnce = options.runOnce;
    this.#metrics?.consecutiveFailures.set({ task: this.#taskLabel }, 0);
    this.#metrics?.retryDelaySeconds.set({ task: this.#taskLabel }, 0);
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
    this.#metrics?.retryDelaySeconds.set({ task: this.#taskLabel }, 0);
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #scheduleNext(): void {
    if (!this.#started || this.#running || this.#timer !== undefined) {
      return;
    }
    this.#metrics?.retryDelaySeconds.set(
      { task: this.#taskLabel }, this.#consecutiveFailures > 0 ? this.#nextDelayMs / 1_000 : 0,
    );
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#metrics?.retryDelaySeconds.set({ task: this.#taskLabel }, 0);
      void this.#executeCycle();
    }, this.#nextDelayMs);
  }

  async #executeCycle(): Promise<void> {
    if (!this.#started || this.#running) {
      return;
    }
    this.#running = true;
    const startedAt = this.#clock.monotonicNow();
    try {
      await this.#runOnce();
      const failures = this.#consecutiveFailures;
      this.#consecutiveFailures = 0;
      this.#retryCeilingMs = this.#intervalMs;
      this.#nextDelayMs = this.#intervalMs;
      this.#record('ok', startedAt);
      if (failures > 0) {
        this.#logger.info('maintenance.cycle.recovered', { task: this.#taskLabel, count: failures });
      }
    } catch (error) {
      this.#consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, this.#consecutiveFailures + 1);
      this.#retryCeilingMs = Math.min(
        Math.max(this.#intervalMs, MAX_FAILURE_DELAY_MS),
        this.#retryCeilingMs * 2,
      );
      // Equal jitter spreads retries without a zero-delay loop or a retry faster than normal polling.
      const sample = this.#random();
      const random = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
      this.#nextDelayMs = Math.max(this.#intervalMs, Math.floor(this.#retryCeilingMs * (0.5 + random / 2)));
      this.#record('error', startedAt);
      try {
        this.#onError(error);
      } catch (observerError) {
        // An observer cannot turn a settled job failure into an unhandled scheduler rejection.
        this.#logger.error('maintenance.error_handler.failed', { task: this.#taskLabel, ...describeError(observerError) });
      }
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
    metrics.consecutiveFailures.set({ task }, this.#consecutiveFailures);
    metrics.cycles.inc({ outcome, task });
    metrics.durationSeconds.observe({ task }, Math.max(0, (this.#clock.monotonicNow() - startedAt) / 1_000));
    if (outcome === 'ok') {
      metrics.lastSuccessTimestampSeconds.set({ task }, Math.floor(this.#clock.utcNow().getTime() / 1_000));
    }
  }
}
