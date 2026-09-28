import { ApiError } from '../http/errors.js';

export const ARCHIVE_TILE_GENERATION_CONCURRENCY = 2;
export const ARCHIVE_TILE_GENERATION_MAX_QUEUE = 16;

interface QueuedGeneration<Result> {
  reject: (reason: unknown) => void;
  resolve: (value: Result | PromiseLike<Result>) => void;
  run: () => Promise<Result>;
  signal?: AbortSignal;
  abort?: () => void;
}

export class ArchiveTileGenerationAbortedError extends Error {
  public constructor() {
    super('Archive tile generation was cancelled before admission');
    this.name = 'ArchiveTileGenerationAbortedError';
  }
}

export class ArchiveTileGenerationScheduler {
  readonly #maxConcurrency: number;
  readonly #maxQueue: number;
  readonly #queue: QueuedGeneration<unknown>[] = [];
  #activeCount = 0;

  public constructor(
    maxConcurrency = ARCHIVE_TILE_GENERATION_CONCURRENCY,
    maxQueue = ARCHIVE_TILE_GENERATION_MAX_QUEUE,
  ) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new TypeError('maxConcurrency must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new TypeError('maxQueue must be a nonnegative safe integer');
    }
    this.#maxConcurrency = maxConcurrency;
    this.#maxQueue = maxQueue;
  }

  public get activeCount(): number {
    return this.#activeCount;
  }

  public get queueDepth(): number {
    return this.#queue.length;
  }

  public schedule<Result>(run: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    if (signal?.aborted) {
      return Promise.reject(new ArchiveTileGenerationAbortedError());
    }
    if (this.#activeCount < this.#maxConcurrency) {
      return this.#start(run);
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(
        new ApiError(503, 'TILE_BUSY', 'Archive tile generation is currently busy'),
      );
    }

    return new Promise<Result>((resolve, reject) => {
      const queued: QueuedGeneration<Result> = {
        reject,
        resolve,
        run,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        queued.abort = () => {
          const index = this.#queue.indexOf(queued as QueuedGeneration<unknown>);
          if (index < 0) {
            return;
          }
          this.#queue.splice(index, 1);
          reject(new ArchiveTileGenerationAbortedError());
        };
        signal.addEventListener('abort', queued.abort, { once: true });
      }
      this.#queue.push(queued as QueuedGeneration<unknown>);
    });
  }

  #start<Result>(run: () => Promise<Result>): Promise<Result> {
    this.#activeCount += 1;
    return Promise.resolve()
      .then(run)
      .finally(() => {
        this.#activeCount -= 1;
        this.#admitNext();
      });
  }

  #admitNext(): void {
    const queued = this.#queue.shift();
    if (!queued) {
      return;
    }
    if (queued.abort && queued.signal) {
      queued.signal.removeEventListener('abort', queued.abort);
    }
    void this.#start(queued.run).then(queued.resolve, queued.reject);
  }
}
