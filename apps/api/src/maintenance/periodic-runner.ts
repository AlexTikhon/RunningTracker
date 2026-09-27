import type { Clock } from '../clock.js';

export interface PeriodicRunnerOptions {
  clock: Clock;
  intervalMs: number;
  onError?: (error: unknown) => void;
  runOnce: () => Promise<unknown>;
  taskName: string;
}

export class PeriodicRunner {
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #runOnce: () => Promise<unknown>;
  #running = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: PeriodicRunnerOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error(`${options.taskName} interval must be a positive integer`);
    }
    this.#clock = options.clock;
    this.#intervalMs = options.intervalMs;
    this.#onError =
      options.onError ??
      ((error) => console.error(`${options.taskName} cycle failed`, error));
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
    try {
      await this.#runOnce();
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }
}
