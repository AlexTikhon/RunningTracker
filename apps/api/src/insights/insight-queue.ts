// In-process generation queue for weekly insights (ADR-0076): concurrency 1, bounded, in memory. No Redis, no table of
// jobs: what is lost on a restart is only the place in the line, because the insight row stays `pending` and the next
// request for the same week puts it back in the queue.
//
// Every check and every reservation happens in one synchronous call, as in the interpreter's admission control, so two
// requests can never both take the last place.

export type QueueAdmission = 'full' | 'ok' | 'owner_limit' | 'stopped';
export type EnqueueResult = 'already_queued' | 'queued' | Exclude<QueueAdmission, 'ok'>;

export interface QueuedJob {
  /** The insight id: a job for an id that is already queued or running is not added again. */
  id: string;
  /** Whose job it is, for the per-person limit. */
  owner: string;
  /** Must not reject; a rejection is reported to `onError` and the queue moves on. */
  run: (signal: AbortSignal) => Promise<void>;
}

export interface SerialJobQueueOptions {
  /** Jobs that may wait behind the running one. */
  maxQueued: number;
  /** Jobs (waiting or running) one person may have at once. */
  maxPerOwner: number;
  onError: (error: unknown) => void;
}

export class SerialJobQueue {
  readonly #maxQueued: number;
  readonly #maxPerOwner: number;
  readonly #onError: (error: unknown) => void;
  readonly #waiting: QueuedJob[] = [];
  #active: { controller: AbortController; done: Promise<void>; job: QueuedJob } | undefined;
  #idleWaiters: (() => void)[] = [];
  #stopped = false;

  public constructor(options: SerialJobQueueOptions) {
    for (const [name, value, minimum] of [
      ['maxQueued', options.maxQueued, 0],
      ['maxPerOwner', options.maxPerOwner, 1],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer of at least ${minimum}`);
    }
    this.#maxQueued = options.maxQueued;
    this.#maxPerOwner = options.maxPerOwner;
    this.#onError = options.onError;
  }

  public get activeCount(): number {
    return this.#active === undefined ? 0 : 1;
  }

  public get waitingCount(): number {
    return this.#waiting.length;
  }

  /** True while a job for this insight id is waiting or running in this process. */
  public has(id: string): boolean {
    return this.#active?.job.id === id || this.#waiting.some((job) => job.id === id);
  }

  /** Whether a new job of `owner` would be accepted now. Reserves nothing. */
  public admission(owner: string): QueueAdmission {
    if (this.#stopped) return 'stopped';
    const owned = this.#waiting.filter((job) => job.owner === owner).length + (this.#active?.job.owner === owner ? 1 : 0);
    if (owned >= this.#maxPerOwner) return 'owner_limit';
    if (this.#active !== undefined && this.#waiting.length >= this.#maxQueued) return 'full';
    return 'ok';
  }

  public enqueue(job: QueuedJob): EnqueueResult {
    if (this.has(job.id)) return 'already_queued';
    const admission = this.admission(job.owner);
    if (admission !== 'ok') return admission;
    this.#waiting.push(job);
    this.#startNext();
    return 'queued';
  }

  /** Resolves when nothing is waiting or running. */
  public whenIdle(): Promise<void> {
    if (this.#active === undefined && this.#waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Refuses new jobs, drops the waiting ones, cancels the running one and resolves when it has settled. */
  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#waiting.length = 0;
    const active = this.#active;
    if (active) {
      active.controller.abort();
      await active.done;
    }
    this.#notifyIdle();
  }

  #startNext(): void {
    if (this.#active !== undefined || this.#stopped) return;
    const job = this.#waiting.shift();
    if (!job) {
      this.#notifyIdle();
      return;
    }
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => job.run(controller.signal))
      .catch((error: unknown) => this.#onError(error))
      .finally(() => {
        this.#active = undefined;
        this.#startNext();
      });
    this.#active = { controller, done, job };
  }

  #notifyIdle(): void {
    if (this.#active !== undefined || this.#waiting.length > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
