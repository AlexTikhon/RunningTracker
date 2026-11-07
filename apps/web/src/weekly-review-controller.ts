import type { WeeklyReview } from '@running-tracker/contracts';

import { RunnerApiError, type WeeklyReviewTarget } from './runner-api.js';

// Framework-free controller of the Weekly review section. It belongs to one session, person and organization: a change
// of any of them means a new controller (the screen is keyed by them), and disposing the old one, or ending its session,
// aborts its request and silences it, so a late answer can never reach the new scope.
//
// No polling: the review is recomputed by the server on each read, and is read again only when the week changes, after
// a check-in of this person is saved or deleted (refresh), or when the person asks for it. The latest request wins:
// starting another one aborts the one in flight, and an answer for another week or an older request is dropped.

export type ReviewLoad =
  | { kind: 'loading' }
  /** `refreshing`: a newer read of the same week is in flight; the review shown is the previous answer. */
  | { kind: 'ready'; refreshing: boolean; review: WeeklyReview }
  | { kind: 'error'; message: string }
  | { kind: 'access-denied'; message: string };

export interface ReviewSnapshot {
  load: ReviewLoad;
  weekStart: string;
}

export const loadingReview = (weekStart: string): ReviewSnapshot => ({ load: { kind: 'loading' }, weekStart });

export type ReviewReader = (target: WeeklyReviewTarget, signal: AbortSignal) => Promise<WeeklyReview>;

export interface WeeklyReviewControllerOptions {
  onChange: (snapshot: ReviewSnapshot) => void;
  orgId: string;
  read: ReviewReader;
  signal?: AbortSignal;
  timeZone: string;
  weekStart: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function serverText(error: RunnerApiError): string {
  const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
}

export class WeeklyReviewController {
  readonly #onChange: (snapshot: ReviewSnapshot) => void;
  readonly #orgId: string;
  readonly #read: ReviewReader;
  readonly #timeZone: string;
  #disposed = false;
  #inFlight: AbortController | null = null;
  #snapshot: ReviewSnapshot;

  public constructor(options: WeeklyReviewControllerOptions) {
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#read = options.read;
    this.#timeZone = options.timeZone;
    this.#snapshot = loadingReview(options.weekStart);
    const signal = options.signal;
    if (signal?.aborted) this.dispose();
    else signal?.addEventListener('abort', () => this.dispose(), { once: true });
  }

  public get snapshot(): ReviewSnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#disposed) return;
    this.#readNow();
  }

  /** Shows another week: nothing of the previous week stays on screen, and its request is dropped. */
  public select(weekStart: string): void {
    if (this.#disposed || weekStart === this.#snapshot.weekStart) return;
    this.#emit(loadingReview(weekStart));
    this.#readNow();
  }

  /** Reads the same week again (a check-in was saved or deleted, the person asked, or a retry after an error). */
  public refresh(): void {
    if (this.#disposed) return;
    const { load } = this.#snapshot;
    if (load.kind === 'ready') this.#emit({ ...this.#snapshot, load: { ...load, refreshing: true } });
    else this.#emit(loadingReview(this.#snapshot.weekStart));
    this.#readNow();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#inFlight?.abort();
    this.#inFlight = null;
  }

  #emit(snapshot: ReviewSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }

  #readNow(): void {
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    void this.#run(controller, this.#snapshot.weekStart);
  }

  async #run(controller: AbortController, weekStart: string): Promise<void> {
    const current = () => !this.#disposed && this.#inFlight === controller && this.#snapshot.weekStart === weekStart;
    let review: WeeklyReview;
    try {
      review = await this.#read({ orgId: this.#orgId, timeZone: this.#timeZone, weekStart }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#inFlight = null;
      if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
        this.#emit({ load: { kind: 'access-denied', message: 'You no longer have access to this organization.' }, weekStart });
        return;
      }
      // The previous answer is not kept: after a deletion it could still show the deleted record.
      this.#emit({
        load: {
          kind: 'error',
          message: error instanceof RunnerApiError ? serverText(error) : 'The weekly review could not be loaded. Check your connection and try again.',
        },
        weekStart,
      });
      return;
    }
    if (!current()) return;
    this.#inFlight = null;
    this.#emit({ load: { kind: 'ready', refreshing: false, review }, weekStart });
  }
}
