import type { ArchiveMetadataResponse } from '@running-tracker/contracts';

import { RunnerApiError } from './runner-api.js';

export const ARCHIVE_METADATA_POLL_INTERVAL_MS = 30_000;

export interface ArchivePeriod {
  from: string;
  to: string;
}

export type ArchiveSourceStatus =
  | 'access-denied'
  | 'error'
  | 'loading'
  | 'ready'
  | 'refreshing';

export interface ArchiveSourceSnapshot {
  checkedAt: number | null;
  message: string | null;
  metadata: ArchiveMetadataResponse | null;
  status: ArchiveSourceStatus;
}

export interface ArchiveMetadataInput extends ArchivePeriod {
  orgId: string;
}

export type ArchiveMetadataLoader = (
  input: ArchiveMetadataInput,
  signal: AbortSignal,
) => Promise<ArchiveMetadataResponse>;

export type ArchivePollScheduler = (
  callback: () => void,
  intervalMs: number,
) => () => void;

export type ArchiveFocusSubscriber = (callback: () => void) => () => void;

export interface ArchiveSourceControllerOptions extends ArchiveMetadataInput {
  loadMetadata: ArchiveMetadataLoader;
  now?: () => number;
  onChange: (snapshot: ArchiveSourceSnapshot) => void;
  pollIntervalMs?: number;
  schedulePoll?: ArchivePollScheduler;
  subscribeFocus?: ArchiveFocusSubscriber;
}

const defaultPollScheduler: ArchivePollScheduler = (callback, intervalMs) => {
  const timer = window.setInterval(callback, intervalMs);
  return () => window.clearInterval(timer);
};

const defaultFocusSubscriber: ArchiveFocusSubscriber = (callback) => {
  const onFocus = () => callback();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      callback();
    }
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isAccessLoss(error: unknown): boolean {
  return error instanceof RunnerApiError && (error.status === 401 || error.status === 403);
}

function metadataIdentity(metadata: ArchiveMetadataResponse): string {
  return JSON.stringify([
    metadata.archiveRevision,
    metadata.filter.from,
    metadata.filter.to,
    metadata.sourceLayer,
    metadata.minzoom,
    metadata.maxzoom,
    metadata.tiles,
  ]);
}

function failureMessage(error: unknown): string {
  if (error instanceof RunnerApiError) {
    const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
    return `${error.message} (${error.code}).${reference}`;
  }
  return error instanceof Error
    ? error.message
    : 'Archive metadata could not be refreshed.';
}

export class ArchiveSourceController {
  readonly #input: ArchiveMetadataInput;
  readonly #loadMetadata: ArchiveMetadataLoader;
  readonly #now: () => number;
  readonly #onChange: ArchiveSourceControllerOptions['onChange'];
  readonly #pollIntervalMs: number;
  readonly #schedulePoll: ArchivePollScheduler;
  readonly #subscribeFocus: ArchiveFocusSubscriber;
  #abortController: AbortController | null = null;
  #cancelFocus: (() => void) | null = null;
  #cancelPoll: (() => void) | null = null;
  #queuedRefresh = false;
  #snapshot: ArchiveSourceSnapshot = {
    checkedAt: null,
    message: null,
    metadata: null,
    status: 'loading',
  };
  #started = false;

  public constructor(options: ArchiveSourceControllerOptions) {
    this.#input = { from: options.from, orgId: options.orgId, to: options.to };
    this.#loadMetadata = options.loadMetadata;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange;
    this.#pollIntervalMs = options.pollIntervalMs ?? ARCHIVE_METADATA_POLL_INTERVAL_MS;
    this.#schedulePoll = options.schedulePoll ?? defaultPollScheduler;
    this.#subscribeFocus = options.subscribeFocus ?? defaultFocusSubscriber;
  }

  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#emit(this.#snapshot);
    this.#cancelFocus = this.#subscribeFocus(() => this.refreshNow());
    this.#cancelPoll = this.#schedulePoll(
      () => this.refreshNow(),
      this.#pollIntervalMs,
    );
    this.refreshNow();
  }

  public refreshNow(): void {
    if (!this.#started) {
      return;
    }
    if (this.#abortController !== null) {
      this.#queuedRefresh = true;
      return;
    }
    const controller = new AbortController();
    this.#abortController = controller;
    this.#emit({
      ...this.#snapshot,
      message: null,
      status: this.#snapshot.metadata === null ? 'loading' : 'refreshing',
    });
    void this.#loadMetadata(this.#input, controller.signal)
      .then((metadata) => {
        if (!this.#started || controller.signal.aborted) {
          return;
        }
        const current = this.#snapshot.metadata;
        const nextMetadata = current !== null
          && metadataIdentity(current) === metadataIdentity(metadata)
          ? current
          : metadata;
        this.#emit({
          checkedAt: this.#now(),
          message: null,
          metadata: nextMetadata,
          status: 'ready',
        });
      })
      .catch((error: unknown) => {
        if (!this.#started || controller.signal.aborted || isAbortError(error)) {
          return;
        }
        if (isAccessLoss(error)) {
          this.#emit({
            checkedAt: this.#now(),
            message: failureMessage(error),
            metadata: null,
            status: 'access-denied',
          });
          return;
        }
        this.#emit({
          checkedAt: this.#now(),
          message: failureMessage(error),
          metadata: this.#snapshot.metadata,
          status: 'error',
        });
      })
      .finally(() => {
        if (this.#abortController === controller) {
          this.#abortController = null;
        }
        if (this.#started && this.#queuedRefresh) {
          this.#queuedRefresh = false;
          this.refreshNow();
        }
      });
  }

  public handleTileError(status: number): void {
    if (!this.#started) {
      return;
    }
    if (status === 401 || status === 403) {
      this.#emit({
        checkedAt: this.#now(),
        message: 'Archive access was revoked. The archive layer was cleared.',
        metadata: null,
        status: 'access-denied',
      });
      return;
    }
    if (status === 409) {
      this.refreshNow();
      return;
    }
    this.#emit({
      ...this.#snapshot,
      message: `The archive tile request failed with HTTP ${status}.`,
      status: 'error',
    });
  }

  public dispose(): void {
    this.#started = false;
    this.#queuedRefresh = false;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#cancelFocus?.();
    this.#cancelFocus = null;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
  }

  #emit(snapshot: ArchiveSourceSnapshot): void {
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }
}
