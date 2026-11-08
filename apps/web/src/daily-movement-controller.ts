import type { DailyMovementListResponse, DailyMovementView, PutDailyMovementRequest } from '@running-tracker/contracts';

import { followSession, isAbort, lostAccess, serverText } from './daily-checkin-controller.js';
import { movementHistoryDays, movementHistoryRange, type MovementHistoryDay, type MovementValues } from './daily-movement.js';
import { RunnerApiError, type CsrfCredentials, type DailyMovementTarget } from './runner-api.js';

// Framework-free controllers for the Movement section of the Check-in tab (ADR-0078), with the rules of the check-in
// controllers (ADR-0074, ADR-0075). Each belongs to one organization and one session: a change of person,
// organization or session means new controllers, and disposing an old one (or ending its session) aborts its request
// and silences it, so a late answer can never reach the new scope. Within one controller only the latest request of a
// kind may change what is shown: an answer for a date that is no longer selected is dropped.

export type MovementListStatus = 'access-denied' | 'error' | 'loading' | 'ready';

const accessDeniedText = 'You no longer have access to your movement in this organization.';

// ---------------------------------------------------------------------------------------------------------------
// The last 14 days, newest first, the days without a record included.

export type DailyMovementLoader = (
  input: { from: string; orgId: string; to: string },
  signal: AbortSignal,
) => Promise<DailyMovementListResponse>;

export interface MovementHistorySnapshot {
  days: MovementHistoryDay[];
  message: string | null;
  status: MovementListStatus;
}

export const loadingMovementHistory: MovementHistorySnapshot = { days: [], message: null, status: 'loading' };

export interface MovementHistoryControllerOptions {
  load: DailyMovementLoader;
  onChange: (snapshot: MovementHistorySnapshot) => void;
  orgId: string;
  signal?: AbortSignal;
  // The person's "today" when the screen opened; the window ends on it.
  today: string;
}

export class MovementHistoryController {
  readonly #options: MovementHistoryControllerOptions;
  #disposed = false;
  #request: AbortController | null = null;
  #snapshot: MovementHistorySnapshot = loadingMovementHistory;
  #started = false;

  public constructor(options: MovementHistoryControllerOptions) {
    this.#options = options;
    followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): MovementHistorySnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#loadWindow();
  }

  // A day was saved or deleted: load the window again and drop the answer to anything sent before.
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

  #emit(snapshot: MovementHistorySnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onChange(snapshot);
  }

  #loadWindow(): void {
    this.#request?.abort();
    const controller = new AbortController();
    this.#request = controller;
    // The days already shown stay visible while the window reloads after a save.
    this.#emit(this.#snapshot.status === 'ready' ? this.#snapshot : loadingMovementHistory);
    void this.#run(controller);
  }

  async #run(controller: AbortController): Promise<void> {
    const current = () => !this.#disposed && this.#request === controller && !controller.signal.aborted;
    const { orgId, today } = this.#options;
    let response: DailyMovementListResponse;
    try {
      response = await this.#options.load({ ...movementHistoryRange(today), orgId }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#request = null;
      if (lostAccess(error)) {
        this.#emit({ days: [], message: accessDeniedText, status: 'access-denied' });
        return;
      }
      this.#emit({
        days: [],
        message:
          error instanceof RunnerApiError
            ? serverText(error)
            : 'Your recent movement could not be loaded. Check your connection and try again.',
        status: 'error',
      });
      return;
    }
    if (!current()) return;
    this.#request = null;
    this.#emit({ days: movementHistoryDays(today, response.items), message: null, status: 'ready' });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The day shown in the form: its stored values, saving and deleting it. A PUT replaces the whole day, so it is
// naturally idempotent: after an unknown outcome, saving again is always safe and never creates a second record.

export type DailyMovementReader = (target: DailyMovementTarget, signal: AbortSignal) => Promise<DailyMovementView | null>;

export type DailyMovementWriter = (
  target: DailyMovementTarget,
  request: PutDailyMovementRequest,
  csrf: CsrfCredentials,
  signal: AbortSignal,
) => Promise<{ created: boolean; view: DailyMovementView }>;

// The server answers 204 whether or not the day still existed, so a repeat after an unknown outcome is always safe.
export type DailyMovementRemover = (target: DailyMovementTarget, csrf: CsrfCredentials, signal: AbortSignal) => Promise<void>;

export type MovementSavePhase = 'failed' | 'idle' | 'pending' | 'saved';

export type MovementDeletionPhase = 'failed' | 'idle' | 'pending';

export interface MovementDaySnapshot {
  date: string;
  deletion: MovementDeletionPhase;
  // "Movement deleted." after a confirmed deletion, or why the last one failed.
  deletionMessage: string | null;
  // The day as stored, or null when nothing is recorded (or not loaded yet).
  existing: DailyMovementView | null;
  load: MovementListStatus;
  loadMessage: string | null;
  save: MovementSavePhase;
  saveMessage: string | null;
  // An earlier save's outcome is unknown: it may already be stored.
  uncertain: boolean;
}

export function loadingMovementDay(date: string): MovementDaySnapshot {
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

export interface MovementDayControllerOptions {
  csrf: () => CsrfCredentials;
  date: string;
  onChange: (snapshot: MovementDaySnapshot) => void;
  // Called once per confirmed deletion, after the snapshot that shows the day empty.
  onDeleted: (date: string) => void;
  // Called once each time the selected date's stored values arrive (null: nothing recorded), so the form can show them.
  onLoaded: (date: string, existing: DailyMovementView | null) => void;
  // Called once per confirmed save, after the `saved` snapshot.
  onSaved: (view: DailyMovementView, created: boolean) => void;
  orgId: string;
  read: DailyMovementReader;
  remove: DailyMovementRemover;
  signal?: AbortSignal;
  // The zone the person is in now: the server uses it to refuse a date after today, and stores it on a first write.
  timeZone: string;
  write: DailyMovementWriter;
}

function refusal(error: unknown, action: 'deleted' | 'saved'): string | null {
  if (!(error instanceof RunnerApiError)) return null;
  const verb = action === 'saved' ? 'save' : 'delete it';
  if (error.status === 401) return `The movement was not ${action}: sign in again, then ${verb}.`;
  if (error.status === 403) return `The movement was not ${action}: you no longer have access to this organization.`;
  if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
    return `The movement was not ${action}: ${serverText(error)}`;
  }
  return null;
}

function unknownReason(error: unknown): string {
  return error instanceof RunnerApiError
    ? serverText(error)
    : error instanceof DOMException && error.name === 'TimeoutError'
      ? 'the server did not answer in time.'
      : 'the connection failed.';
}

// One mutation at a time, and it belongs to the date it was sent for: while a save or a deletion is pending, the
// other is refused and so is another date.
export class MovementDayController {
  readonly #options: MovementDayControllerOptions;
  #deleteRequest: AbortController | null = null;
  #disposed = false;
  #loadRequest: AbortController | null = null;
  #saveRequest: AbortController | null = null;
  #snapshot: MovementDaySnapshot;

  public constructor(options: MovementDayControllerOptions) {
    this.#options = options;
    this.#snapshot = loadingMovementDay(options.date);
    followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): MovementDaySnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#disposed || this.#loadRequest !== null || this.#snapshot.load !== 'loading') return;
    this.#loadDate(this.#snapshot.date);
  }

  /** Shows another date. Refused (false) while a save or a deletion is pending, so its answer belongs to its date. */
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

  public save(values: MovementValues): void {
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

  #emit(patch: Partial<MovementDaySnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#options.onChange(this.#snapshot);
  }

  #loadDate(date: string): void {
    this.#loadRequest?.abort();
    const controller = new AbortController();
    this.#loadRequest = controller;
    // The previous date's values are cleared at once: they must never be shown, or saved, under the new date.
    this.#snapshot = loadingMovementDay(date);
    this.#emit({});
    void this.#runLoad(controller, date);
  }

  async #runLoad(controller: AbortController, date: string): Promise<void> {
    const current = () =>
      !this.#disposed && this.#loadRequest === controller && !controller.signal.aborted && this.#snapshot.date === date;
    let existing: DailyMovementView | null;
    try {
      existing = await this.#options.read({ localDate: date, orgId: this.#options.orgId }, controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#loadRequest = null;
      this.#emit(
        lostAccess(error)
          ? { load: 'access-denied', loadMessage: accessDeniedText }
          : {
              load: 'error',
              loadMessage:
                error instanceof RunnerApiError
                  ? serverText(error)
                  : "This day's movement could not be loaded. Check your connection and try again.",
            },
      );
      return;
    }
    if (!current()) return;
    this.#loadRequest = null;
    this.#emit({ existing, load: 'ready', loadMessage: null });
    this.#options.onLoaded(date, existing);
  }

  async #runSave(controller: AbortController, date: string, request: PutDailyMovementRequest): Promise<void> {
    const current = () => !this.#disposed && this.#saveRequest === controller && !controller.signal.aborted;
    let result: { created: boolean; view: DailyMovementView };
    try {
      result = await this.#options.write({ localDate: date, orgId: this.#options.orgId }, request, this.#options.csrf(), controller.signal);
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.#saveRequest = null;
      const refused = refusal(error, 'saved');
      this.#emit(
        refused === null
          ? {
              save: 'failed',
              saveMessage: `The save was not confirmed: ${unknownReason(error)} Saving again is safe: the day is replaced, never duplicated.`,
              uncertain: true,
            }
          : { save: 'failed', saveMessage: refused },
      );
      return;
    }
    if (!current()) return;
    this.#saveRequest = null;
    this.#emit({
      existing: result.view,
      save: 'saved',
      saveMessage: result.created ? 'Movement saved.' : 'Movement updated.',
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
      this.#emit({
        deletion: 'failed',
        deletionMessage: refusal(error, 'deleted') ?? `The deletion was not confirmed: ${unknownReason(error)} Deleting again is safe.`,
      });
      return;
    }
    if (!current()) return;
    this.#deleteRequest = null;
    this.#emit({ deletion: 'idle', deletionMessage: 'Movement deleted.', existing: null, uncertain: false });
    this.#options.onDeleted(date);
  }
}
