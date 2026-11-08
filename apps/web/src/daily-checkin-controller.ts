import type { DailyMetricsListResponse, DailyMetricsView, PutDailyMetricsRequest } from '@running-tracker/contracts';

import { historyDays, historyRange, type CheckInValues, type HistoryDay } from './daily-checkin.js';
import { RunnerApiError, type CsrfCredentials, type DailyMetricsTarget } from './runner-api.js';

// Framework-free controllers for the Check-in tab (ADR-0074). Each belongs to one organization and one session: a
// change of person, organization or session means new controllers, and disposing an old one (or ending its session)
// aborts its request and silences it, so a late answer can never reach the new scope.

// The helpers below are shared with the Movement section's controllers (ADR-0078).
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function serverText(error: RunnerApiError): string {
  const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
}

export function followSession(signal: AbortSignal | undefined, dispose: () => void): void {
  if (signal === undefined) return;
  if (signal.aborted) {
    dispose();
    return;
  }
  signal.addEventListener('abort', dispose, { once: true });
}

export function lostAccess(error: unknown): boolean {
  return error instanceof RunnerApiError && (error.status === 401 || error.status === 403);
}

// ---------------------------------------------------------------------------------------------------------------
// The last days, newest first, the days without a check-in included.

export type DailyMetricsLoader = (
  input: { from: string; orgId: string; to: string },
  signal: AbortSignal,
) => Promise<DailyMetricsListResponse>;

export type CheckInListStatus = 'access-denied' | 'error' | 'loading' | 'ready';

export interface CheckInHistorySnapshot {
  days: HistoryDay[];
  message: string | null;
  status: CheckInListStatus;
}

export const loadingCheckInHistory: CheckInHistorySnapshot = { days: [], message: null, status: 'loading' };

export interface CheckInHistoryControllerOptions {
  load: DailyMetricsLoader;
  onChange: (snapshot: CheckInHistorySnapshot) => void;
  orgId: string;
  signal?: AbortSignal;
  // The person's "today" when the screen opened; the window ends on it.
  today: string;
}

export class CheckInHistoryController {
  readonly #load: DailyMetricsLoader;
  readonly #onChange: (snapshot: CheckInHistorySnapshot) => void;
  readonly #orgId: string;
  readonly #today: string;
  #disposed = false;
  #request: AbortController | null = null;
  #snapshot: CheckInHistorySnapshot = loadingCheckInHistory;
  #started = false;

  public constructor(options: CheckInHistoryControllerOptions) {
    this.#load = options.load;
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#today = options.today;
    followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): CheckInHistorySnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#loadWindow();
  }

  // A day was saved: load the window again and drop the answer to anything sent before.
  public refresh(): void {
    if (!this.#started || this.#disposed) return;
    this.#loadWindow();
  }

  public retry(): void {
    if (!this.#started || this.#disposed || this.#request !== null) return;
    if (this.#snapshot.status === 'error' || this.#snapshot.status === 'access-denied') this.#loadWindow();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#request?.abort();
    this.#request = null;
  }

  #emit(snapshot: CheckInHistorySnapshot): void {
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }

  #loadWindow(): void {
    this.#request?.abort();
    const controller = new AbortController();
    this.#request = controller;
    // The days already shown stay visible while the window reloads after a save.
    this.#emit(this.#snapshot.status === 'ready' ? this.#snapshot : loadingCheckInHistory);
    void this.#run(controller);
  }

  async #run(controller: AbortController): Promise<void> {
    const current = () => !this.#disposed && this.#request === controller && !controller.signal.aborted;
    let response: DailyMetricsListResponse;
    try {
      response = await this.#load({ ...historyRange(this.#today), orgId: this.#orgId }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#request = null;
      if (lostAccess(error)) {
        this.#emit({ days: [], message: 'You no longer have access to your check-ins in this organization.', status: 'access-denied' });
        return;
      }
      this.#emit({
        days: [],
        message:
          error instanceof RunnerApiError
            ? serverText(error)
            : 'Your recent check-ins could not be loaded. Check your connection and try again.',
        status: 'error',
      });
      return;
    }
    if (!current()) return;
    this.#request = null;
    this.#emit({ days: historyDays(this.#today, response.items), message: null, status: 'ready' });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The day shown in the form: its stored values, and saving it. A PUT replaces the whole day, so it is naturally
// idempotent: after an unknown outcome, saving again is always safe and never creates a second record.

export type DailyMetricsReader = (target: DailyMetricsTarget, signal: AbortSignal) => Promise<DailyMetricsView | null>;

export type DailyMetricsWriter = (
  target: DailyMetricsTarget,
  request: PutDailyMetricsRequest,
  csrf: CsrfCredentials,
  signal: AbortSignal,
) => Promise<{ created: boolean; view: DailyMetricsView }>;

// The server answers 204 whether or not the day still existed, so a repeat after an unknown outcome is always safe.
export type DailyMetricsRemover = (target: DailyMetricsTarget, csrf: CsrfCredentials, signal: AbortSignal) => Promise<void>;

export type CheckInSavePhase = 'failed' | 'idle' | 'pending' | 'saved';

export type CheckInDeletionPhase = 'failed' | 'idle' | 'pending';

export interface CheckInDaySnapshot {
  date: string;
  deletion: CheckInDeletionPhase;
  // "Check-in deleted." after a confirmed deletion, or why the last one failed.
  deletionMessage: string | null;
  // The day as stored, or null when nothing is recorded (or not loaded yet).
  existing: DailyMetricsView | null;
  load: CheckInListStatus;
  loadMessage: string | null;
  save: CheckInSavePhase;
  saveMessage: string | null;
  // An earlier save's outcome is unknown: it may already be stored.
  uncertain: boolean;
}

export function loadingCheckInDay(date: string): CheckInDaySnapshot {
  return {
    date,
    deletion: 'idle',
    deletionMessage: null,
    existing: null,
    load: 'loading',
    loadMessage: null,
    save: 'idle',
    saveMessage: null,
    uncertain: false,
  };
}

export interface CheckInDayControllerOptions {
  csrf: () => CsrfCredentials;
  date: string;
  onChange: (snapshot: CheckInDaySnapshot) => void;
  // Called once per confirmed deletion, after the snapshot that shows the day empty.
  onDeleted: (date: string) => void;
  // Called once each time a date's stored values arrive (null: nothing recorded), so the form can show them.
  onLoaded: (date: string, existing: DailyMetricsView | null) => void;
  // Called once per confirmed save, after the `saved` snapshot.
  onSaved: (view: DailyMetricsView, created: boolean) => void;
  orgId: string;
  read: DailyMetricsReader;
  remove: DailyMetricsRemover;
  signal?: AbortSignal;
  // The zone the person is in now: the server uses it to refuse a date after today, and stores it on a first write.
  timeZone: string;
  write: DailyMetricsWriter;
}

function definitiveSaveRefusal(error: unknown): string | null {
  if (!(error instanceof RunnerApiError)) return null;
  if (error.status === 401) return 'The check-in was not saved: sign in again, then save.';
  if (error.status === 403) return 'The check-in was not saved: you no longer have access to this organization.';
  if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
    return `The check-in was not saved: ${serverText(error)}`;
  }
  return null;
}

function unknownOutcomeText(error: unknown): string {
  const reason =
    error instanceof RunnerApiError
      ? serverText(error)
      : error instanceof DOMException && error.name === 'TimeoutError'
        ? 'the server did not answer in time.'
        : 'the connection failed.';
  return `The save was not confirmed: ${reason} Saving again is safe: the day is replaced, never duplicated.`;
}

function deletionFailureText(error: unknown): string {
  if (error instanceof RunnerApiError) {
    if (error.status === 401) return 'The check-in was not deleted: sign in again, then delete it.';
    if (error.status === 403) return 'The check-in was not deleted: you no longer have access to this organization.';
    if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
      return `The check-in was not deleted: ${serverText(error)}`;
    }
  }
  const reason =
    error instanceof RunnerApiError
      ? serverText(error)
      : error instanceof DOMException && error.name === 'TimeoutError'
        ? 'the server did not answer in time.'
        : 'the connection failed.';
  return `The deletion was not confirmed: ${reason} Deleting again is safe.`;
}

// One mutation at a time, and it belongs to the date it was sent for: while a save or a deletion is pending, the
// other is refused and so is another date.
export class CheckInDayController {
  readonly #options: CheckInDayControllerOptions;
  #deleteRequest: AbortController | null = null;
  #disposed = false;
  #loadRequest: AbortController | null = null;
  #saveRequest: AbortController | null = null;
  #snapshot: CheckInDaySnapshot;

  public constructor(options: CheckInDayControllerOptions) {
    this.#options = options;
    this.#snapshot = loadingCheckInDay(options.date);
    followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): CheckInDaySnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#disposed || this.#loadRequest !== null || this.#snapshot.load !== 'loading') return;
    this.#loadDate(this.#snapshot.date);
  }

  /**
   * Shows another date. Refused (false) while a save or a deletion is pending, so its answer always belongs to its date.
   */
  public select(date: string): boolean {
    if (this.#disposed || this.#mutating()) return false;
    if (date === this.#snapshot.date && this.#snapshot.load !== 'error' && this.#snapshot.load !== 'access-denied') return true;
    this.#loadDate(date);
    return true;
  }

  public retry(): void {
    if (this.#disposed || this.#mutating()) return;
    if (this.#snapshot.load === 'error' || this.#snapshot.load === 'access-denied') this.#loadDate(this.#snapshot.date);
  }

  public save(values: CheckInValues): void {
    if (this.#disposed || this.#mutating() || this.#snapshot.load !== 'ready') return;
    const date = this.#snapshot.date;
    const controller = new AbortController();
    this.#saveRequest = controller;
    this.#emit({ deletion: 'idle', deletionMessage: null, save: 'pending', saveMessage: null });
    void this.#runSave(controller, date, { ...values, timeZone: this.#options.timeZone });
  }

  /** Deletes the shown day. Only a day with a stored record can be deleted; the caller asks for confirmation first. */
  public deleteDay(): void {
    if (this.#disposed || this.#mutating() || this.#snapshot.load !== 'ready' || this.#snapshot.existing === null) return;
    const date = this.#snapshot.date;
    const controller = new AbortController();
    this.#deleteRequest = controller;
    this.#emit({ deletion: 'pending', deletionMessage: null, save: 'idle', saveMessage: null });
    void this.#runDelete(controller, date);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#loadRequest?.abort();
    this.#saveRequest?.abort();
    this.#deleteRequest?.abort();
    this.#loadRequest = null;
    this.#saveRequest = null;
    this.#deleteRequest = null;
  }

  #mutating(): boolean {
    return this.#saveRequest !== null || this.#deleteRequest !== null;
  }

  #emit(patch: Partial<CheckInDaySnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#options.onChange(this.#snapshot);
  }

  #loadDate(date: string): void {
    this.#loadRequest?.abort();
    const controller = new AbortController();
    this.#loadRequest = controller;
    this.#snapshot = loadingCheckInDay(date);
    this.#emit({});
    void this.#runLoad(controller, date);
  }

  async #runLoad(controller: AbortController, date: string): Promise<void> {
    const current = () => !this.#disposed && this.#loadRequest === controller && !controller.signal.aborted;
    let existing: DailyMetricsView | null;
    try {
      existing = await this.#options.read({ localDate: date, orgId: this.#options.orgId }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#loadRequest = null;
      this.#emit(
        lostAccess(error)
          ? { load: 'access-denied', loadMessage: 'You no longer have access to your check-ins in this organization.' }
          : {
              load: 'error',
              loadMessage:
                error instanceof RunnerApiError
                  ? serverText(error)
                  : 'This day could not be loaded. Check your connection and try again.',
            },
      );
      return;
    }
    if (!current()) return;
    this.#loadRequest = null;
    this.#emit({ existing, load: 'ready', loadMessage: null });
    this.#options.onLoaded(date, existing);
  }

  async #runSave(controller: AbortController, date: string, request: PutDailyMetricsRequest): Promise<void> {
    const current = () => !this.#disposed && this.#saveRequest === controller && !controller.signal.aborted;
    let result: { created: boolean; view: DailyMetricsView };
    try {
      result = await this.#options.write(
        { localDate: date, orgId: this.#options.orgId },
        request,
        this.#options.csrf(),
        controller.signal,
      );
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#saveRequest = null;
      const refusal = definitiveSaveRefusal(error);
      this.#emit(
        refusal === null
          ? { save: 'failed', saveMessage: unknownOutcomeText(error), uncertain: true }
          : { save: 'failed', saveMessage: refusal },
      );
      return;
    }
    if (!current()) return;
    this.#saveRequest = null;
    this.#emit({
      existing: result.view,
      save: 'saved',
      saveMessage: result.created ? 'Check-in saved.' : 'Check-in updated.',
      uncertain: false,
    });
    this.#options.onSaved(result.view, result.created);
  }

  async #runDelete(controller: AbortController, date: string): Promise<void> {
    const current = () => !this.#disposed && this.#deleteRequest === controller && !controller.signal.aborted;
    try {
      await this.#options.remove({ localDate: date, orgId: this.#options.orgId }, this.#options.csrf(), controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#deleteRequest = null;
      // The stored values stay shown: after a refusal they are still there, after an unknown outcome they may be.
      this.#emit({ deletion: 'failed', deletionMessage: deletionFailureText(error) });
      return;
    }
    if (!current()) return;
    this.#deleteRequest = null;
    this.#emit({ deletion: 'idle', deletionMessage: 'Check-in deleted.', existing: null, uncertain: false });
    this.#options.onDeleted(date);
  }
}
