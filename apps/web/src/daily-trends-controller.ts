import type { DailyTrends } from '@running-tracker/contracts';

import { RunnerApiError, type DailyTrendsTarget } from './runner-api.js';

// Framework-free controller of the Trends screen (ADR-0084), on the rules of the Today controller. It belongs to one
// session, person and organization: a change of any of them means a new controller (the screen is keyed by them), and
// disposing the old one, or ending its session, aborts its request and silences it, so a late answer can never reach the
// new scope.
//
// No polling: the trends are recomputed by the server on each read and read again only when the screen opens, the end
// date changes, or the person asks (Refresh, Retry). The latest request wins: starting another one aborts the one in
// flight, and an answer for another end date or an older request is dropped. Changing the end date clears the previous
// range at once, and an error never keeps a previous answer (it could still show a deleted record).

export type TrendsLoad =
  | { kind: 'loading' }
  /** `refreshing`: a newer read of the same range is in flight; the trends shown are the previous answer. */
  | { kind: 'ready'; refreshing: boolean; trends: DailyTrends }
  | { kind: 'error'; message: string }
  | { kind: 'access-denied'; message: string };

export interface TrendsSnapshot {
  endDate: string;
  load: TrendsLoad;
}

export const loadingTrends = (endDate: string): TrendsSnapshot => ({ endDate, load: { kind: 'loading' } });

export type TrendsReader = (target: DailyTrendsTarget, signal: AbortSignal) => Promise<DailyTrends>;

export interface DailyTrendsControllerOptions {
  endDate: string;
  onChange: (snapshot: TrendsSnapshot) => void;
  orgId: string;
  read: TrendsReader;
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

export class DailyTrendsController {
  readonly #onChange: (snapshot: TrendsSnapshot) => void;
  readonly #orgId: string;
  readonly #read: TrendsReader;
  readonly #timeZone: string;
  #disposed = false;
  #inFlight: AbortController | null = null;
  #snapshot: TrendsSnapshot;

  public constructor(options: DailyTrendsControllerOptions) {
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#read = options.read;
    this.#timeZone = options.timeZone;
    this.#snapshot = loadingTrends(options.endDate);
    const signal = options.signal;
    if (signal?.aborted) this.dispose();
    else signal?.addEventListener('abort', () => this.dispose(), { once: true });
  }

  public get snapshot(): TrendsSnapshot {
    return this.#snapshot;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public start(): void {
    if (this.#disposed) return;
    this.#readNow();
  }

  /** Shows the range ending on another date: nothing of the previous range stays on screen, and its request is dropped. */
  public select(endDate: string): void {
    if (this.#disposed || endDate === this.#snapshot.endDate) return;
    this.#emit(loadingTrends(endDate));
    this.#readNow();
  }

  /** Reads the same range again (the person asked, or a retry after an error). */
  public refresh(): void {
    if (this.#disposed) return;
    const { load } = this.#snapshot;
    if (load.kind === 'ready') this.#emit({ ...this.#snapshot, load: { ...load, refreshing: true } });
    else this.#emit(loadingTrends(this.#snapshot.endDate));
    this.#readNow();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#inFlight?.abort();
    this.#inFlight = null;
  }

  #emit(snapshot: TrendsSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }

  #readNow(): void {
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    void this.#run(controller, this.#snapshot.endDate);
  }

  async #run(controller: AbortController, endDate: string): Promise<void> {
    const current = () => !this.#disposed && this.#inFlight === controller && this.#snapshot.endDate === endDate;
    let trends: DailyTrends;
    try {
      trends = await this.#read({ endDate, orgId: this.#orgId, timeZone: this.#timeZone }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#inFlight = null;
      if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
        this.#emit({ endDate, load: { kind: 'access-denied', message: 'You no longer have access to this organization.' } });
        return;
      }
      this.#emit({
        endDate,
        load: {
          kind: 'error',
          message: error instanceof RunnerApiError ? serverText(error) : 'These dates could not be loaded. Check your connection and try again.',
        },
      });
      return;
    }
    if (!current()) return;
    this.#inFlight = null;
    this.#emit({ endDate, load: { kind: 'ready', refreshing: false, trends } });
  }
}
