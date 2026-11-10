import type { DailyOverview } from '@running-tracker/contracts';

import { RunnerApiError, type DailyOverviewTarget } from './runner-api.js';

// Framework-free controller of the Today screen (ADR-0082). It belongs to one session, person and organization: a change
// of any of them means a new controller (the screen is keyed by them), and disposing the old one, or ending its session,
// aborts its request and silences it, so a late answer can never reach the new scope.
//
// No polling: the overview is recomputed by the server on each read, and is read again only when the screen opens, the
// date changes, or the person asks (Refresh, Retry). The latest request wins: starting another one aborts the one in
// flight, and an answer for another date or an older request is dropped. A date change clears the previous date's
// overview at once, and an error never keeps a previous answer (it could still show a deleted record).

export type OverviewLoad =
  | { kind: 'loading' }
  /** `refreshing`: a newer read of the same date is in flight; the overview shown is the previous answer. */
  | { kind: 'ready'; overview: DailyOverview; refreshing: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'access-denied'; message: string };

export interface OverviewSnapshot {
  load: OverviewLoad;
  localDate: string;
}

export const loadingOverview = (localDate: string): OverviewSnapshot => ({ load: { kind: 'loading' }, localDate });

export type OverviewReader = (target: DailyOverviewTarget, signal: AbortSignal) => Promise<DailyOverview>;

export interface DailyOverviewControllerOptions {
  localDate: string;
  onChange: (snapshot: OverviewSnapshot) => void;
  orgId: string;
  read: OverviewReader;
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

export class DailyOverviewController {
  readonly #onChange: (snapshot: OverviewSnapshot) => void;
  readonly #orgId: string;
  readonly #read: OverviewReader;
  readonly #timeZone: string;
  #disposed = false;
  readonly #onSessionEnd = (): void => this.dispose();
  #session: AbortSignal | undefined;
  #inFlight: AbortController | null = null;
  #snapshot: OverviewSnapshot;

  public constructor(options: DailyOverviewControllerOptions) {
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#read = options.read;
    this.#timeZone = options.timeZone;
    this.#snapshot = loadingOverview(options.localDate);
    const signal = options.signal;
    if (signal?.aborted) this.dispose();
    else if (signal !== undefined) {
      // Kept so that dispose() can remove it: the session outlives this controller.
      this.#session = signal;
      signal.addEventListener('abort', this.#onSessionEnd, { once: true });
    }
  }

  public get snapshot(): OverviewSnapshot {
    return this.#snapshot;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public start(): void {
    if (this.#disposed) return;
    this.#readNow();
  }

  /** Shows another date: nothing of the previous date stays on screen, and its request is dropped. */
  public select(localDate: string): void {
    if (this.#disposed || localDate === this.#snapshot.localDate) return;
    this.#emit(loadingOverview(localDate));
    this.#readNow();
  }

  /** Reads the same date again (the person asked, or a retry after an error). */
  public refresh(): void {
    if (this.#disposed) return;
    const { load } = this.#snapshot;
    if (load.kind === 'ready') this.#emit({ ...this.#snapshot, load: { ...load, refreshing: true } });
    else this.#emit(loadingOverview(this.#snapshot.localDate));
    this.#readNow();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#session?.removeEventListener('abort', this.#onSessionEnd);
    this.#session = undefined;
    this.#inFlight?.abort();
    this.#inFlight = null;
  }

  #emit(snapshot: OverviewSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }

  #readNow(): void {
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    void this.#run(controller, this.#snapshot.localDate);
  }

  async #run(controller: AbortController, localDate: string): Promise<void> {
    const current = () => !this.#disposed && this.#inFlight === controller && this.#snapshot.localDate === localDate;
    let overview: DailyOverview;
    try {
      overview = await this.#read({ localDate, orgId: this.#orgId, timeZone: this.#timeZone }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#inFlight = null;
      if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
        this.#emit({ load: { kind: 'access-denied', message: 'You no longer have access to this organization.' }, localDate });
        return;
      }
      this.#emit({
        load: {
          kind: 'error',
          message: error instanceof RunnerApiError ? serverText(error) : 'This day could not be loaded. Check your connection and try again.',
        },
        localDate,
      });
      return;
    }
    if (!current()) return;
    this.#inFlight = null;
    this.#emit({ load: { kind: 'ready', overview, refreshing: false }, localDate });
  }
}
