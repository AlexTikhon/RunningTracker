import type { ArchiveTrackResponse } from '@running-tracker/contracts';

import { RunnerApiError, type LiveTrackScope } from './runner-api.js';

export type RunDetailSnapshot =
  | { status: 'loading' }
  | { feature: ArchiveTrackResponse; signal: AbortSignal; status: 'ready' }
  | { message: string; retryable: boolean; status: 'error' };

interface RunDetailOptions {
  load: (scope: LiveTrackScope, signal: AbortSignal) => Promise<ArchiveTrackResponse>;
  onChange: (snapshot: RunDetailSnapshot) => void;
  scope: LiveTrackScope;
  signal: AbortSignal;
}

function failure(error: unknown): RunDetailSnapshot {
  if (error instanceof RunnerApiError) {
    if (error.status === 410) return { message: 'This run was deleted.', retryable: false, status: 'error' };
    if ([403, 404].includes(error.status)) return { message: 'This run is no longer available to this account.', retryable: false, status: 'error' };
    if (error.status === 401) return { message: 'Sign in again to view this run.', retryable: false, status: 'error' };
    if (error.code === 'ARCHIVE_TRACK_TOO_COMPLEX') return { message: 'This route is too large to display in full.', retryable: false, status: 'error' };
  }
  return { message: 'The run could not be loaded. Check your connection and try again.', retryable: true, status: 'error' };
}

// Each read owns the displayed result's lifetime too: replacing it aborts its map before a late result can draw.
export class RunDetailController {
  readonly #options: RunDetailOptions;
  #operation: AbortController | null = null;
  #disposed = false;

  public constructor(options: RunDetailOptions) {
    this.#options = options;
    options.signal.addEventListener('abort', this.dispose, { once: true });
    if (options.signal.aborted) this.dispose();
  }

  public async refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#operation?.abort();
    const operation = new AbortController();
    this.#operation = operation;
    this.#options.onChange({ status: 'loading' });
    try {
      const feature = await this.#options.load(this.#options.scope, operation.signal);
      if (!this.#current(operation)) return;
      if (feature.properties.runId !== this.#options.scope.runId) throw new Error('Mismatched run');
      this.#options.onChange({ feature, signal: operation.signal, status: 'ready' });
    } catch (error) {
      if (this.#current(operation)) this.#options.onChange(failure(error));
    }
  }

  public readonly dispose = (): void => {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#operation?.abort();
    this.#options.signal.removeEventListener('abort', this.dispose);
  };

  #current(operation: AbortController): boolean {
    return !this.#disposed && this.#operation === operation && !operation.signal.aborted;
  }
}
