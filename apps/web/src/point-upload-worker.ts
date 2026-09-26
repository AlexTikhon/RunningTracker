import type { IngestPointsResponse, PointInput } from '@running-tracker/contracts';

import { RunnerApiError } from './runner-api.js';
import type { IndexedDbRunnerStorage, RunScope } from './runner-storage.js';
import type { UploadState } from './runner-state.js';

const BATCH_LIMIT = 100;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 300_000;

type UploadStorage = Pick<
  IndexedDbRunnerStorage,
  'acknowledgePointBatch' | 'countPoints' | 'readPointBatch'
>;

export interface PointUploadWorkerOptions {
  onAcknowledged?: (dataRevision: string) => void;
  onPermanentError?: (error: unknown) => Promise<void> | void;
  onState: (state: UploadState) => void;
  random?: () => number;
  scope: RunScope;
  send: (points: PointInput[]) => Promise<IngestPointsResponse>;
  storage: UploadStorage;
}

export class PointUploadProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PointUploadProtocolError';
  }
}

function isPermanent(error: unknown): boolean {
  if (error instanceof PointUploadProtocolError) {
    return true;
  }
  return error instanceof RunnerApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status);
}

function retryDelayMs(error: unknown, attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.min(attempt, 10)));
  const jittered = Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
  const retryAfter = error instanceof RunnerApiError && error.retryAfterMs !== null
    ? Math.min(MAX_RETRY_AFTER_MS, error.retryAfterMs)
    : 0;
  return Math.max(jittered, retryAfter);
}

function errorMessage(error: unknown): string {
  if (error instanceof RunnerApiError) {
    const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
    return `${error.message} (${error.code}).${reference}`;
  }
  return error instanceof Error ? error.message : 'Point upload failed for an unknown reason.';
}

export class PointUploadWorker {
  readonly #options: PointUploadWorkerOptions;
  readonly #random: () => number;
  #attempt = 0;
  #halted = false;
  #online = false;
  #running = false;
  #stopped = true;
  #timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: PointUploadWorkerOptions) {
    this.#options = options;
    this.#random = options.random ?? Math.random;
  }

  public start(online: boolean): void {
    if (!this.#stopped) {
      return;
    }
    this.#stopped = false;
    this.#online = online;
    if (online) {
      this.#schedule(0);
    }
  }

  public setOnline(online: boolean): void {
    this.#online = online;
    if (this.#stopped || this.#halted) {
      return;
    }
    if (!online) {
      this.#clearTimer();
      return;
    }
    this.#attempt = 0;
    this.#schedule(0);
  }

  public wake(): void {
    if (!this.#stopped && !this.#halted && this.#online) {
      this.#schedule(0);
    }
  }

  public stop(): void {
    this.#stopped = true;
    this.#clearTimer();
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== null || this.#running || this.#stopped || this.#halted || !this.#online) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#uploadNextBatch();
    }, delayMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #pendingCount(fallback: number): Promise<number> {
    try {
      return await this.#options.storage.countPoints(this.#options.scope);
    } catch {
      return fallback;
    }
  }

  async #uploadNextBatch(): Promise<void> {
    if (this.#running || this.#stopped || this.#halted || !this.#online) {
      return;
    }
    this.#running = true;
    let batch: PointInput[] = [];
    try {
      batch = await this.#options.storage.readPointBatch(this.#options.scope, BATCH_LIMIT);
      if (batch.length === 0) {
        this.#options.onState({ message: null, pendingCount: 0, status: 'idle' });
        return;
      }

      const beforeCount = await this.#pendingCount(batch.length);
      this.#options.onState({ message: null, pendingCount: beforeCount, status: 'uploading' });
      const result = await this.#options.send(batch);
      if (result.insertedCount + result.duplicateCount !== batch.length) {
        throw new PointUploadProtocolError(
          'The server acknowledgement does not account for every point in the sent batch',
        );
      }
      await this.#options.storage.acknowledgePointBatch(
        this.#options.scope,
        batch.map((point) => point.seq),
        result.dataRevision,
      );
      this.#attempt = 0;
      const pendingCount = await this.#pendingCount(Math.max(0, beforeCount - batch.length));
      if (!this.#stopped) {
        this.#options.onAcknowledged?.(result.dataRevision);
        this.#options.onState({
          message: null,
          pendingCount,
          status: pendingCount === 0 ? 'idle' : 'uploading',
        });
      }
      if (!this.#stopped && this.#online && pendingCount > 0) {
        queueMicrotask(() => this.#schedule(0));
      }
    } catch (error) {
      const pendingCount = await this.#pendingCount(batch.length);
      if (isPermanent(error)) {
        this.#halted = true;
        if (!this.#stopped) {
          try {
            await this.#options.onPermanentError?.(error);
          } catch {
            // The upload error remains authoritative; reconciliation is best-effort.
          }
        }
        if (!this.#stopped) {
          this.#options.onState({ message: errorMessage(error), pendingCount, status: 'error' });
        }
        return;
      }
      if (!this.#online || this.#stopped) {
        return;
      }
      const delayMs = retryDelayMs(error, this.#attempt, this.#random);
      this.#attempt += 1;
      this.#options.onState({
        message: `Retrying in ${(delayMs / 1_000).toFixed(1)}s. ${errorMessage(error)}`,
        pendingCount,
        status: 'retrying',
      });
      queueMicrotask(() => this.#schedule(delayMs));
    } finally {
      this.#running = false;
    }
  }
}
