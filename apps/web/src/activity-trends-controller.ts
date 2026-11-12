import type { ActivityHistorySource, ActivityTrends, ActivityType } from '@running-tracker/contracts';

import { RunnerApiError, type ActivityTrendsTarget } from './runner-api.js';

// Framework-free controller of the Activity section of Trends (ADR-0089), on the rules of the Trends controller
// (ADR-0084). It belongs to one session, person, organization and zone: a change of any of them means a new controller
// (the screen is keyed by them), and disposing the old one, or ending its session, aborts its request and silences it.
//
// Its filters are the end date, ONE source and ONE activity type. Changing any of them clears the previous answer at
// once and aborts its request; a late answer or failure for other filters, or for an older request, is dropped. No
// polling: read when the screen opens, when a filter changes, or when the person asks (Refresh, Retry). An error never
// keeps a previous answer (it could still show a deleted item).

export interface ActivityTrendsFilters {
  endDate: string;
  source: ActivityHistorySource;
  type: ActivityType;
}

export type ActivityTrendsLoad =
  | { kind: 'loading' }
  /** `refreshing`: a newer read of the same filters is in flight; the trends shown are the previous answer. */
  | { kind: 'ready'; refreshing: boolean; trends: ActivityTrends }
  | { kind: 'error'; message: string }
  | { kind: 'access-denied'; message: string };

export interface ActivityTrendsSnapshot {
  filters: ActivityTrendsFilters;
  load: ActivityTrendsLoad;
}

export const loadingActivityTrends = (filters: ActivityTrendsFilters): ActivityTrendsSnapshot => ({ filters, load: { kind: 'loading' } });

export const sameActivityTrendsFilters = (left: ActivityTrendsFilters, right: ActivityTrendsFilters): boolean =>
  left.endDate === right.endDate && left.source === right.source && left.type === right.type;

/** A recorded run is a run: choosing that source moves the type to `run`, the only one it has. */
export function normalizeActivityTrendsFilters(filters: ActivityTrendsFilters): ActivityTrendsFilters {
  return filters.source === 'recorded_run' && filters.type !== 'run' ? { ...filters, type: 'run' } : filters;
}

export type ActivityTrendsReader = (target: ActivityTrendsTarget, signal: AbortSignal) => Promise<ActivityTrends>;

export interface ActivityTrendsControllerOptions {
  filters: ActivityTrendsFilters;
  onChange: (snapshot: ActivityTrendsSnapshot) => void;
  orgId: string;
  read: ActivityTrendsReader;
  signal?: AbortSignal;
  timeZone: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function serverText(error: RunnerApiError): string {
  const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
}

export class ActivityTrendsController {
  readonly #onChange: (snapshot: ActivityTrendsSnapshot) => void;
  readonly #orgId: string;
  readonly #read: ActivityTrendsReader;
  readonly #timeZone: string;
  #disposed = false;
  readonly #onSessionEnd = (): void => this.dispose();
  #session: AbortSignal | undefined;
  #inFlight: AbortController | null = null;
  #snapshot: ActivityTrendsSnapshot;

  public constructor(options: ActivityTrendsControllerOptions) {
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#read = options.read;
    this.#timeZone = options.timeZone;
    this.#snapshot = loadingActivityTrends(normalizeActivityTrendsFilters(options.filters));
    const signal = options.signal;
    if (signal?.aborted) this.dispose();
    else if (signal !== undefined) {
      // Kept so that dispose() can remove it: the session outlives this controller.
      this.#session = signal;
      signal.addEventListener('abort', this.#onSessionEnd, { once: true });
    }
  }

  public get snapshot(): ActivityTrendsSnapshot {
    return this.#snapshot;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public start(): void {
    if (this.#disposed) return;
    this.#readNow();
  }

  /** Shows other filters: nothing of the previous answer stays on screen, and its request is dropped. */
  public select(next: ActivityTrendsFilters): void {
    const filters = normalizeActivityTrendsFilters(next);
    if (this.#disposed || sameActivityTrendsFilters(filters, this.#snapshot.filters)) return;
    this.#emit(loadingActivityTrends(filters));
    this.#readNow();
  }

  /** Reads the same filters again (the person asked, or a retry after an error). */
  public refresh(): void {
    if (this.#disposed) return;
    const { load } = this.#snapshot;
    if (load.kind === 'ready') this.#emit({ ...this.#snapshot, load: { ...load, refreshing: true } });
    else this.#emit(loadingActivityTrends(this.#snapshot.filters));
    this.#readNow();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#session?.removeEventListener('abort', this.#onSessionEnd);
    this.#session = undefined;
    this.#inFlight?.abort();
    this.#inFlight = null;
  }

  #emit(snapshot: ActivityTrendsSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }

  #readNow(): void {
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    void this.#run(controller, this.#snapshot.filters);
  }

  async #run(controller: AbortController, filters: ActivityTrendsFilters): Promise<void> {
    const current = () => !this.#disposed && this.#inFlight === controller && sameActivityTrendsFilters(this.#snapshot.filters, filters);
    let trends: ActivityTrends;
    try {
      trends = await this.#read({ ...filters, orgId: this.#orgId, timeZone: this.#timeZone }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#inFlight = null;
      if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
        this.#emit({ filters, load: { kind: 'access-denied', message: 'You no longer have access to this organization.' } });
        return;
      }
      this.#emit({
        filters,
        load: {
          kind: 'error',
          message:
            error instanceof RunnerApiError ? serverText(error) : 'These activity trends could not be loaded. Check your connection and try again.',
        },
      });
      return;
    }
    if (!current()) return;
    this.#inFlight = null;
    // readActivityTrends already refuses an answer for other filters; a reader that does not is not trusted either.
    if (trends.applied.endDate !== filters.endDate || trends.applied.source !== filters.source || trends.applied.type !== filters.type) {
      this.#emit({ filters, load: { kind: 'error', message: 'The answer was for other filters, so it is not shown. Try again.' } });
      return;
    }
    this.#emit({ filters, load: { kind: 'ready', refreshing: false, trends } });
  }
}
