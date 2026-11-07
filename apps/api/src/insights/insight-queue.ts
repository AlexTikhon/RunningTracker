// In-process generation queue for weekly insights (ADR-0076): concurrency 1, bounded, in memory. No Redis, no table of
// jobs: what a restart loses is the job itself, and its row tells the reader so (an expired lease is reported as
// `interrupted`; a new request may retry it).
//
// Capacity is RESERVED before the request touches the database and is held until the job's promise settles:
//   reserve() -> (database transaction) -> reservation.start(job) or reservation.release()
// so a request that cannot be served changes nothing (no row is left queued without a job), and a slot is never given
// back while the work it admitted is still running. Every check and every reservation happens in one synchronous call,
// so two requests can never both take the last place.

export type QueueRejection = 'full' | 'owner_limit' | 'stopped';

export interface QueuedJob {
  /** The insight id: one job per id. */
  id: string;
  /** Must not reject; a rejection is reported to `onError` and the queue moves on. */
  run: (signal: AbortSignal) => Promise<void>;
  /** The job token written to the row; reported back when the queue drops the job at shutdown. */
  token: string;
}

export interface Reservation {
  /** How many jobs (running or waiting) are ahead of this one, for the lease of a queued row. */
  readonly ahead: number;
  release(): void;
  start(job: QueuedJob): void;
}

export interface SerialJobQueueOptions {
  /** Jobs that may wait behind the running one (reservations included). */
  maxQueued: number;
  /** Jobs (reserved, waiting or running) one person may have at once. */
  maxPerOwner: number;
  onError: (error: unknown) => void;
}

interface Entry {
  controller: AbortController;
  job: QueuedJob | undefined;
  owner: string;
}

export class SerialJobQueue {
  readonly #maxQueued: number;
  readonly #maxPerOwner: number;
  readonly #onError: (error: unknown) => void;
  /** Reserved (job undefined) and waiting entries, in order. */
  readonly #pending: Entry[] = [];
  #active: { done: Promise<void>; entry: Entry } | undefined;
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

  /** Reserved and waiting jobs. */
  public get waitingCount(): number {
    return this.#pending.length;
  }

  /** True while a job for this insight id is waiting or running in this process. */
  public has(id: string): boolean {
    return this.#active?.entry.job?.id === id || this.#pending.some((entry) => entry.job?.id === id);
  }

  /** Takes a place for `owner`, or says why there is none. */
  public reserve(owner: string): QueueRejection | Reservation {
    if (this.#stopped) return 'stopped';
    const owned = this.#pending.filter((entry) => entry.owner === owner).length + (this.#active?.entry.owner === owner ? 1 : 0);
    if (owned >= this.#maxPerOwner) return 'owner_limit';
    if (this.#active !== undefined && this.#pending.length >= this.#maxQueued) return 'full';
    if (this.#active === undefined && this.#pending.length > this.#maxQueued) return 'full';
    const entry: Entry = { controller: new AbortController(), job: undefined, owner };
    const ahead = this.#pending.length + (this.#active ? 1 : 0);
    this.#pending.push(entry);
    let used = false;
    return {
      ahead,
      release: () => {
        if (used) return;
        used = true;
        this.#remove(entry);
        this.#startNext();
        this.#notifyIdle();
      },
      start: (job) => {
        if (used) throw new Error('A reservation can be used once');
        used = true;
        if (this.#stopped) {
          this.#remove(entry);
          return;
        }
        entry.job = job;
        this.#startNext();
      },
    };
  }

  /** Cancels the job of this insight id: a waiting one is dropped, a running one is aborted. */
  public cancel(id: string): void {
    const waiting = this.#pending.find((entry) => entry.job?.id === id);
    if (waiting) {
      this.#remove(waiting);
      this.#notifyIdle();
      return;
    }
    if (this.#active?.entry.job?.id === id) this.#active.entry.controller.abort();
  }

  /** Resolves when nothing is reserved, waiting or running. */
  public whenIdle(): Promise<void> {
    if (this.#active === undefined && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * Refuses new work, drops the waiting jobs, cancels the running one and resolves, once it has settled, with the jobs
   * that were dropped without running (the caller marks their rows interrupted).
   */
  public async stop(): Promise<QueuedJob[]> {
    this.#stopped = true;
    const dropped = this.#pending.splice(0).flatMap((entry) => (entry.job ? [entry.job] : []));
    const active = this.#active;
    if (active) {
      active.entry.controller.abort();
      await active.done;
    }
    this.#notifyIdle();
    return dropped;
  }

  #remove(entry: Entry): void {
    const index = this.#pending.indexOf(entry);
    if (index >= 0) this.#pending.splice(index, 1);
  }

  #startNext(): void {
    if (this.#active !== undefined || this.#stopped) return;
    // Jobs run in reservation order; a reservation still deciding blocks nothing behind it that is ready.
    const index = this.#pending.findIndex((entry) => entry.job !== undefined);
    if (index < 0) {
      this.#notifyIdle();
      return;
    }
    const [entry] = this.#pending.splice(index, 1) as [Entry];
    const job = entry.job!;
    const done = Promise.resolve()
      .then(() => job.run(entry.controller.signal))
      .catch((error: unknown) => this.#onError(error))
      .finally(() => {
        this.#active = undefined;
        this.#startNext();
        this.#notifyIdle();
      });
    this.#active = { done, entry };
  }

  #notifyIdle(): void {
    if (this.#active !== undefined || this.#pending.length > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
