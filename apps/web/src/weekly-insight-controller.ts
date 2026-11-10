import {
  WEEKLY_INSIGHT_RETRY_LIMIT,
  WEEKLY_INSIGHTS_BUSY,
  WEEKLY_INSIGHTS_DISABLED,
  type WeeklyInsightAccepted,
  type WeeklyInsightView,
} from '@running-tracker/contracts';

import { RunnerApiError, type CsrfCredentials, type WeeklyInsightTarget } from './runner-api.js';

// Framework-free controller of the weekly Insights panel (ADR-0076). It belongs to one session, person and
// organization: a change of any of them means a new controller, and disposing the old one (or ending its session)
// aborts its request, stops its polling timer and silences it, so a late answer can never reach the new scope.
//
// Polling is bounded: while the insight is queued or running the controller reads it again after POLL_DELAYS_MS
// (growing), at most POLL_LIMIT times; then it stops and says so, and the person can check again. The server's own
// lease guarantees the row leaves queued/running in bounded time, so a reader that comes back sees an end state.

export const POLL_DELAYS_MS = [1_000, 1_500, 2_000, 3_000, 5_000] as const;
/** Reads after one generate or select; with the delays above, about four minutes, longer than the server's budget. */
export const POLL_LIMIT = 50;

export type InsightLoad =
  /** The week is being read. */
  | { kind: 'loading' }
  /** No insight exists for this week: never asked for, or deleted together with one of its source records. */
  | { kind: 'none' }
  | { kind: 'view'; view: WeeklyInsightView }
  | { kind: 'error'; message: string }
  | { kind: 'access-denied'; message: string };

export interface InsightPanelSnapshot {
  load: InsightLoad;
  /** Polling stopped after POLL_LIMIT reads while the insight was still queued or running. */
  pollingExhausted: boolean;
  /** A generation request is being sent, or its last attempt failed (with `requestMessage`). */
  request: 'failed' | 'idle' | 'pending';
  requestMessage: string | null;
  /** The server said generation is turned off: the button is hidden, stored insights are still shown. */
  generationDisabled: boolean;
  weekStart: string;
}

export const loadingInsight = (weekStart: string): InsightPanelSnapshot => ({
  generationDisabled: false,
  load: { kind: 'loading' },
  pollingExhausted: false,
  request: 'idle',
  requestMessage: null,
  weekStart,
});

export type InsightReader = (target: WeeklyInsightTarget, signal: AbortSignal) => Promise<WeeklyInsightView | null>;
export type InsightRequester = (
  input: WeeklyInsightTarget & { timeZone: string },
  csrf: CsrfCredentials,
  signal: AbortSignal,
) => Promise<WeeklyInsightAccepted>;

export interface InsightTimers {
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

export interface WeeklyInsightControllerOptions {
  csrf: () => CsrfCredentials;
  onChange: (snapshot: InsightPanelSnapshot) => void;
  orgId: string;
  read: InsightReader;
  request: InsightRequester;
  signal?: AbortSignal;
  timeZone: string;
  timers?: InsightTimers;
  weekStart: string;
}

const isActive = (view: WeeklyInsightView) => view.status === 'queued' || view.status === 'running';

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function serverText(error: RunnerApiError): string {
  const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
}

/** Whether the panel offers Generate/Regenerate for this state. */
export function canGenerate(snapshot: InsightPanelSnapshot): boolean {
  if (snapshot.generationDisabled || snapshot.request === 'pending') return false;
  const { load } = snapshot;
  if (load.kind === 'none') return true;
  if (load.kind !== 'view') return false;
  return !isActive(load.view) && load.view.retryable;
}

export class WeeklyInsightController {
  readonly #csrf: () => CsrfCredentials;
  readonly #onChange: (snapshot: InsightPanelSnapshot) => void;
  readonly #orgId: string;
  readonly #read: InsightReader;
  readonly #request: InsightRequester;
  readonly #timeZone: string;
  readonly #timers: InsightTimers;
  #disposed = false;
  readonly #onSessionEnd = (): void => this.dispose();
  #session: AbortSignal | undefined;
  #inFlight: AbortController | null = null;
  #polls = 0;
  #snapshot: InsightPanelSnapshot;
  #timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: WeeklyInsightControllerOptions) {
    this.#csrf = options.csrf;
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#read = options.read;
    this.#request = options.request;
    this.#timeZone = options.timeZone;
    this.#timers = options.timers ?? {
      clearTimeout: (handle) => clearTimeout(handle),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    };
    this.#snapshot = loadingInsight(options.weekStart);
    const signal = options.signal;
    if (signal?.aborted) this.dispose();
    else if (signal !== undefined) {
      // Kept so that dispose() can remove it: the session outlives this controller.
      this.#session = signal;
      signal.addEventListener('abort', this.#onSessionEnd, { once: true });
    }
  }

  public get snapshot(): InsightPanelSnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#disposed) return;
    this.#readNow(true);
  }

  /** Shows another week: whatever was in flight for the previous one is dropped. */
  public select(weekStart: string): void {
    if (this.#disposed || weekStart === this.#snapshot.weekStart) return;
    this.#stopAll();
    this.#emit({ ...loadingInsight(weekStart), generationDisabled: this.#snapshot.generationDisabled });
    this.#readNow(true);
  }

  /** The week's data may have changed (a check-in was saved or deleted): read it again. */
  public refresh(): void {
    if (this.#disposed || this.#snapshot.request === 'pending') return;
    this.#readNow(true);
  }

  public generate(): void {
    if (this.#disposed || !canGenerate(this.#snapshot)) return;
    this.#stopAll();
    const controller = new AbortController();
    this.#inFlight = controller;
    const weekStart = this.#snapshot.weekStart;
    this.#emit({ ...this.#snapshot, pollingExhausted: false, request: 'pending', requestMessage: null });
    void this.#sendRequest(controller, weekStart);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#session?.removeEventListener('abort', this.#onSessionEnd);
    this.#session = undefined;
    this.#stopAll();
  }

  #emit(snapshot: InsightPanelSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }

  #stopAll(): void {
    this.#inFlight?.abort();
    this.#inFlight = null;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #readNow(resetPolls: boolean): void {
    this.#stopAll();
    if (resetPolls) this.#polls = 0;
    const controller = new AbortController();
    this.#inFlight = controller;
    void this.#runRead(controller, this.#snapshot.weekStart);
  }

  #schedulePoll(): void {
    if (this.#disposed) return;
    if (this.#polls >= POLL_LIMIT) {
      this.#emit({ ...this.#snapshot, pollingExhausted: true });
      return;
    }
    const delay = POLL_DELAYS_MS[Math.min(this.#polls, POLL_DELAYS_MS.length - 1)]!;
    this.#polls += 1;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.#readNow(false);
    }, delay);
  }

  async #runRead(controller: AbortController, weekStart: string): Promise<void> {
    const current = () => !this.#disposed && this.#inFlight === controller && this.#snapshot.weekStart === weekStart;
    let view: WeeklyInsightView | null;
    try {
      view = await this.#read({ orgId: this.#orgId, weekStart }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#inFlight = null;
      if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
        this.#emit({ ...this.#snapshot, load: { kind: 'access-denied', message: 'You no longer have access to insights in this organization.' } });
        return;
      }
      this.#emit({
        ...this.#snapshot,
        load: {
          kind: 'error',
          message: error instanceof RunnerApiError ? serverText(error) : 'The insight could not be loaded. Check your connection and try again.',
        },
      });
      return;
    }
    if (!current()) return;
    this.#inFlight = null;
    this.#emit({ ...this.#snapshot, load: view === null ? { kind: 'none' } : { kind: 'view', view }, pollingExhausted: false });
    if (view !== null && isActive(view)) this.#schedulePoll();
  }

  async #sendRequest(controller: AbortController, weekStart: string): Promise<void> {
    const current = () => !this.#disposed && this.#inFlight === controller && this.#snapshot.weekStart === weekStart;
    try {
      await this.#request({ orgId: this.#orgId, timeZone: this.#timeZone, weekStart }, this.#csrf(), controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#inFlight = null;
      if (error instanceof RunnerApiError && error.code === WEEKLY_INSIGHTS_DISABLED) {
        this.#emit({ ...this.#snapshot, generationDisabled: true, request: 'idle', requestMessage: null });
        return;
      }
      const message =
        error instanceof RunnerApiError && error.code === WEEKLY_INSIGHTS_BUSY
          ? 'The insight generator is busy right now. Nothing was started; try again in a little while.'
          : error instanceof RunnerApiError && error.code === WEEKLY_INSIGHT_RETRY_LIMIT
            ? 'This week\'s insight failed too many times for the same data. It can be generated again after the week\'s data changes.'
            : error instanceof RunnerApiError
              ? serverText(error)
              : 'The request could not be sent. Check your connection and try again.';
      this.#emit({ ...this.#snapshot, request: 'failed', requestMessage: message });
      return;
    }
    if (!current()) return;
    this.#inFlight = null;
    this.#emit({ ...this.#snapshot, request: 'idle', requestMessage: null });
    this.#readNow(true);
  }
}
