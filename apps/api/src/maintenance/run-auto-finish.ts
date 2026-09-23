import type { Pool } from 'pg';

import type { Clock } from '../clock.js';

interface AutoFinishResultRow {
  finished_count: number;
}

export async function runAutoFinishOnce(
  pool: Pick<Pool, 'query'>,
  clock: Pick<Clock, 'utcNow'>,
): Promise<number> {
  const effectiveNow = clock.utcNow();
  if (!Number.isFinite(effectiveNow.getTime())) {
    throw new Error('The maintenance clock returned an invalid UTC time');
  }

  const result = await pool.query<AutoFinishResultRow>(
    'SELECT app_private.auto_finish_runs($1::timestamptz) AS finished_count',
    [effectiveNow.toISOString()],
  );
  const finishedCount = result.rows[0]?.finished_count;
  if (
    typeof finishedCount !== 'number' ||
    !Number.isInteger(finishedCount) ||
    finishedCount < 0
  ) {
    throw new Error('The auto-finish function returned an invalid result');
  }
  return finishedCount;
}

export interface RunAutoFinishRunnerOptions {
  clock: Clock;
  intervalMs: number;
  onError?: (error: unknown) => void;
  runOnce: () => Promise<number>;
}

export class RunAutoFinishRunner {
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #runOnce: () => Promise<number>;
  #running = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: RunAutoFinishRunnerOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error('The auto-finish interval must be a positive integer');
    }
    this.#clock = options.clock;
    this.#intervalMs = options.intervalMs;
    this.#onError = options.onError ?? ((error) => console.error('Run auto-finish cycle failed', error));
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
