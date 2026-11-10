import {
  MEAL_ALREADY_SAVED,
  mealAlreadySavedDetailsSchema,
  type CreateMealRequest,
  type MealListResponse,
  type MealView,
  type UpdateMealRequest,
} from '@running-tracker/contracts';

import { followSession, isAbort, lostAccess, serverText } from './daily-checkin-controller.js';
import { sameMealDetails, type MealDetails } from './meal-log.js';
import { RunnerApiError, type CsrfCredentials, type MealTarget } from './runner-api.js';

// Framework-free controllers of the Meal log (ADR-0083). Each belongs to one organization and one session: a change of
// person, organization or session means new controllers, and disposing an old one (or ending its session) aborts its
// request and silences it, so a late answer can never reach the new scope. Within a controller only the latest request
// may change what is shown: an answer for a date that is no longer selected is dropped.

function failureReason(error: unknown): string {
  if (error instanceof RunnerApiError) return serverText(error);
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'the server did not answer in time.';
  return 'the connection failed.';
}

/** A refusal before anything was written (a 4xx other than "try later"), as a sentence; null when the outcome is unknown. */
function definitiveRefusal(error: unknown, what: string): string | null {
  if (!(error instanceof RunnerApiError)) return null;
  if (error.status === 401) return `${what}: sign in again, then save.`;
  if (error.status === 403) return `${what}: you no longer have access to this organization.`;
  if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) return `${what}: ${serverText(error)}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// One date's entries, in the order they were logged, a page at a time.

export type MealLoader = (input: { cursor: string | null; localDate: string; orgId: string }, signal: AbortSignal) => Promise<MealListResponse>;

export type MealListStatus = 'access-denied' | 'error' | 'loading' | 'ready';

export interface MealListSnapshot {
  hasMore: boolean;
  items: MealView[];
  loadingMore: boolean;
  localDate: string;
  // Why the first page could not be shown (error, lost access); null otherwise.
  message: string | null;
  // Why the next page could not be added; the pages already shown stay.
  moreMessage: string | null;
  // The server no longer accepts the cursor: only starting over is meaningful.
  outdated: boolean;
  status: MealListStatus;
}

export function loadingMealList(localDate: string): MealListSnapshot {
  return { hasMore: false, items: [], loadingMore: false, localDate, message: null, moreMessage: null, outdated: false, status: 'loading' };
}

export interface MealListControllerOptions {
  load: MealLoader;
  localDate: string;
  onChange: (snapshot: MealListSnapshot) => void;
  orgId: string;
  signal?: AbortSignal;
}

export class MealListController {
  readonly #load: MealLoader;
  readonly #onChange: (snapshot: MealListSnapshot) => void;
  readonly #orgId: string;
  #cursor: string | null = null;
  #disposed = false;
  #unfollowSession: () => void = () => undefined;
  #request: AbortController | null = null;
  #snapshot: MealListSnapshot;
  #started = false;

  public constructor(options: MealListControllerOptions) {
    this.#load = options.load;
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#snapshot = loadingMealList(options.localDate);
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): MealListSnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#loadFirstPage(this.#snapshot.localDate);
  }

  /** Shows another date: the previous date's entries disappear at once and its request is abandoned. */
  public select(localDate: string): void {
    if (!this.#started || this.#disposed || localDate === this.#snapshot.localDate) return;
    this.#loadFirstPage(localDate);
  }

  public loadMore(): void {
    const s = this.#snapshot;
    if (!this.#started || this.#disposed || this.#request !== null || s.status !== 'ready' || s.outdated || this.#cursor === null) return;
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ loadingMore: true, moreMessage: null });
    void this.#run(controller, s.localDate, this.#cursor, 'next');
  }

  // A failed first page, lost access or an outdated cursor start over; a failed next page asks again.
  public retry(): void {
    const s = this.#snapshot;
    if (!this.#started || this.#disposed || this.#request !== null) return;
    if (s.outdated || s.status === 'error' || s.status === 'access-denied') this.#loadFirstPage(s.localDate);
    else if (s.moreMessage !== null) this.loadMore();
  }

  /** The date's entries changed (a save or a deletion): start over from page one and drop any earlier answer. */
  public refresh(): void {
    if (!this.#started || this.#disposed) return;
    this.#loadFirstPage(this.#snapshot.localDate);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#request?.abort();
    this.#request = null;
  }

  #emit(patch: Partial<MealListSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#onChange(this.#snapshot);
  }

  #loadFirstPage(localDate: string): void {
    this.#request?.abort();
    this.#cursor = null;
    const controller = new AbortController();
    this.#request = controller;
    // After a save on the same date the entries already shown stay visible while page one reloads.
    const keep = this.#snapshot.status === 'ready' && this.#snapshot.localDate === localDate;
    this.#snapshot = keep ? { ...this.#snapshot, loadingMore: false, moreMessage: null } : loadingMealList(localDate);
    this.#emit({});
    void this.#run(controller, localDate, null, 'first');
  }

  #current(controller: AbortController, localDate: string): boolean {
    return !this.#disposed && this.#request === controller && !controller.signal.aborted && this.#snapshot.localDate === localDate;
  }

  async #run(controller: AbortController, localDate: string, cursor: string | null, kind: 'first' | 'next'): Promise<void> {
    let response: MealListResponse;
    try {
      response = await this.#load({ cursor, localDate, orgId: this.#orgId }, controller.signal);
    } catch (error) {
      if (!this.#current(controller, localDate) || isAbort(error)) return;
      this.#request = null;
      this.#fail(error, kind, localDate);
      return;
    }
    if (!this.#current(controller, localDate)) return;
    this.#request = null;
    this.#cursor = response.nextCursor;
    const known = new Set(this.#snapshot.items.map((item) => item.mealId));
    this.#emit({
      hasMore: response.nextCursor !== null,
      items: kind === 'first' ? response.items : [...this.#snapshot.items, ...response.items.filter((item) => !known.has(item.mealId))],
      loadingMore: false,
      message: null,
      moreMessage: null,
      outdated: false,
      status: 'ready',
    });
  }

  #fail(error: unknown, kind: 'first' | 'next', localDate: string): void {
    if (lostAccess(error)) {
      this.#cursor = null;
      this.#snapshot = loadingMealList(localDate);
      this.#emit({ message: 'You no longer have access to your meal log in this organization.', status: 'access-denied' });
      return;
    }
    if (kind === 'first') {
      this.#snapshot = loadingMealList(localDate);
      this.#emit({
        message: error instanceof RunnerApiError ? serverText(error) : 'Your meal log could not be loaded. Check your connection and try again.',
        status: 'error',
      });
      return;
    }
    if (error instanceof RunnerApiError && error.code === 'INVALID_CURSOR') {
      this.#emit({ loadingMore: false, moreMessage: 'This list is out of date. Refresh to see your current entries.', outdated: true });
      return;
    }
    this.#emit({
      loadingMore: false,
      moreMessage: error instanceof RunnerApiError ? serverText(error) : 'More entries could not be loaded. Check your connection and try again.',
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Logging a new entry. One idempotency key per form session (ADR-0073 pattern), kept across retries and edits of the
// form until a confirmed save or an explicit new entry: if an earlier attempt of this session did go through, the server
// returns that entry (same request) or 409 MEAL_ALREADY_SAVED (changed request), and never stores a second entry.

export type MealCreator = (orgId: string, request: CreateMealRequest, csrf: CsrfCredentials, signal: AbortSignal) => Promise<{ created: boolean; view: MealView }>;

export type MealSavePhase = 'already-saved' | 'failed' | 'idle' | 'pending' | 'saved';

export interface MealSaveSnapshot {
  message: string | null;
  phase: MealSavePhase;
  // An earlier attempt's outcome is unknown: it may already be saved.
  uncertain: boolean;
}

export const idleMealSave: MealSaveSnapshot = { message: null, phase: 'idle', uncertain: false };

export interface MealCreateControllerOptions {
  create: MealCreator;
  // Read when the request is sent, so a refreshed token needs no new controller.
  csrf: () => CsrfCredentials;
  // A fresh idempotency key for a new form session.
  newKey: () => string;
  // Called once when the server says this form session already saved an entry with other details.
  onAlreadySaved: (mealId: string | null) => void;
  onChange: (snapshot: MealSaveSnapshot) => void;
  // Called once per confirmed save, after the `saved` snapshot.
  onSaved: (view: MealView, created: boolean) => void;
  orgId: string;
  signal?: AbortSignal;
  // The zone the person is in now: the server uses it to refuse a date after today, and stores it on the entry.
  timeZone: string;
}

interface CreateAttempt {
  details: MealDetails;
  localDate: string;
}

function alreadySavedId(error: unknown): { mealId: string | null } | null {
  if (!(error instanceof RunnerApiError) || error.status !== 409 || error.code !== MEAL_ALREADY_SAVED) return null;
  const details = mealAlreadySavedDetailsSchema.safeParse(error.details);
  return { mealId: details.success ? details.data.mealId : null };
}

export class MealCreateController {
  readonly #options: MealCreateControllerOptions;
  #disposed = false;
  #unfollowSession: () => void = () => undefined;
  // The form session's idempotency key.
  #formKey: string;
  #request: AbortController | null = null;
  // The attempt whose outcome is unknown, kept to recognise an exact retry.
  #retained: CreateAttempt | null = null;
  #snapshot: MealSaveSnapshot = idleMealSave;

  public constructor(options: MealCreateControllerOptions) {
    this.#options = options;
    this.#formKey = options.newKey();
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): MealSaveSnapshot {
    return this.#snapshot;
  }

  public get pending(): boolean {
    return this.#request !== null;
  }

  /** Whether saving these details now repeats the uncertain earlier attempt rather than sending changed details. */
  public wouldReuse(localDate: string, details: MealDetails): boolean {
    return this.#retained !== null && this.#retained.localDate === localDate && sameMealDetails(this.#retained.details, details);
  }

  /** Sends the entry unless a request is on its way or this form session already saved one. Returns whether it was sent. */
  public submit(localDate: string, details: MealDetails): boolean {
    if (this.#disposed || this.#request !== null || this.#snapshot.phase === 'already-saved') return false;
    this.#retained = { details, localDate };
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ message: null, phase: 'pending', uncertain: false });
    const request: CreateMealRequest = { ...details, idempotencyKey: this.#formKey, localDate, timeZone: this.#options.timeZone };
    void this.#options.create(this.#options.orgId, request, this.#options.csrf(), controller.signal).then(
      ({ created, view }) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        this.#retained = null;
        // The form session produced its entry; the next entry is a new form session with a new key.
        this.#formKey = this.#options.newKey();
        this.#emit({ message: 'Entry saved.', phase: 'saved', uncertain: false });
        this.#options.onSaved(view, created);
      },
      (error: unknown) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        const saved = alreadySavedId(error);
        if (saved !== null) {
          this.#retained = null;
          this.#emit({ message: 'Your earlier save went through, so these changed details were not saved. The saved entry is in the list.', phase: 'already-saved', uncertain: false });
          this.#options.onAlreadySaved(saved.mealId);
          return;
        }
        const refusal = definitiveRefusal(error, 'The entry was not saved');
        if (refusal !== null) {
          // Nothing was stored under the key, so the form session (and its key) simply continues.
          this.#retained = null;
          this.#emit({ message: refusal, phase: 'failed', uncertain: false });
          return;
        }
        this.#emit({
          message: `The save was not confirmed: ${failureReason(error)} The entry may already be saved. Saving again is safe and will not create a duplicate.`,
          phase: 'failed',
          uncertain: true,
        });
      },
    );
    return true;
  }

  /** Starts a new form session: a new key, nothing retained, idle. Ignored while a request is on its way. */
  public startNew(): void {
    if (this.#disposed || this.#request !== null) return;
    this.#retained = null;
    this.#formKey = this.#options.newKey();
    this.#emit(idleMealSave);
  }

  /** Clears a confirmation or a failure message without starting a new form session (the key is kept). */
  public acknowledge(): void {
    if (this.#disposed || this.#request !== null || this.#snapshot.phase === 'already-saved' || this.#snapshot.uncertain) return;
    this.#emit(idleMealSave);
  }

  // Aborting does not undo a POST the server already received; it only stops this controller from reporting it.
  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#request?.abort();
    this.#request = null;
  }

  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#request === controller;
  }

  #emit(snapshot: MealSaveSnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onChange(snapshot);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Editing one entry. A PUT replaces the editable fields, so it is naturally idempotent: after an unknown outcome,
// saving again is always safe.

export type MealUpdater = (target: MealTarget, request: UpdateMealRequest, csrf: CsrfCredentials, signal: AbortSignal) => Promise<MealView>;

export interface MealEditControllerOptions extends MealTarget {
  csrf: () => CsrfCredentials;
  onChange: (snapshot: MealSaveSnapshot) => void;
  onSaved: (view: MealView) => void;
  signal?: AbortSignal;
  update: MealUpdater;
}

export class MealEditController {
  readonly #options: MealEditControllerOptions;
  #disposed = false;
  #unfollowSession: () => void = () => undefined;
  #request: AbortController | null = null;
  #snapshot: MealSaveSnapshot = idleMealSave;

  public constructor(options: MealEditControllerOptions) {
    this.#options = options;
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): MealSaveSnapshot {
    return this.#snapshot;
  }

  public submit(details: MealDetails): boolean {
    if (this.#disposed || this.#request !== null) return false;
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ message: null, phase: 'pending', uncertain: false });
    const target = { mealId: this.#options.mealId, orgId: this.#options.orgId };
    void this.#options.update(target, details, this.#options.csrf(), controller.signal).then(
      (view) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        this.#emit({ message: 'Changes saved.', phase: 'saved', uncertain: false });
        this.#options.onSaved(view);
      },
      (error: unknown) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        if (error instanceof RunnerApiError && error.status === 404) {
          this.#emit({ message: 'The changes were not saved: this entry no longer exists. It may have been deleted elsewhere.', phase: 'failed', uncertain: false });
          return;
        }
        const refusal = definitiveRefusal(error, 'The changes were not saved');
        this.#emit(
          refusal !== null
            ? { message: refusal, phase: 'failed', uncertain: false }
            : { message: `The changes were not confirmed: ${failureReason(error)} Saving again is safe.`, phase: 'failed', uncertain: true },
        );
      },
    );
    return true;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#request?.abort();
    this.#request = null;
  }

  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#request === controller;
  }

  #emit(snapshot: MealSaveSnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onChange(snapshot);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Deleting one entry after an explicit confirmation. The server answers 204 whether or not the entry still existed,
// so a repeat after an unknown outcome is always safe.

export type MealRemover = (target: MealTarget, csrf: CsrfCredentials, signal: AbortSignal) => Promise<void>;

export type MealDeletionPhase = 'confirming' | 'failed' | 'pending' | 'unavailable';

export interface MealDeletionSnapshot {
  message: string | null;
  phase: MealDeletionPhase;
}

export const confirmingMealDeletion: MealDeletionSnapshot = { message: null, phase: 'confirming' };

export interface MealDeletionControllerOptions extends MealTarget {
  csrf: () => CsrfCredentials;
  onChange: (snapshot: MealDeletionSnapshot) => void;
  onDeleted: () => void;
  remove: MealRemover;
  signal?: AbortSignal;
}

export class MealDeletionController {
  readonly #options: MealDeletionControllerOptions;
  #disposed = false;
  #unfollowSession: () => void = () => undefined;
  #request: AbortController | null = null;
  #snapshot: MealDeletionSnapshot = confirmingMealDeletion;

  public constructor(options: MealDeletionControllerOptions) {
    this.#options = options;
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): MealDeletionSnapshot {
    return this.#snapshot;
  }

  public confirm(): void {
    const { phase } = this.#snapshot;
    if (this.#disposed || this.#request !== null || (phase !== 'confirming' && phase !== 'failed')) return;
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ message: null, phase: 'pending' });
    void this.#options.remove({ mealId: this.#options.mealId, orgId: this.#options.orgId }, this.#options.csrf(), controller.signal).then(
      () => {
        if (!this.#current(controller)) return;
        this.#request = null;
        this.#options.onDeleted();
      },
      (error: unknown) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        if (lostAccess(error)) {
          this.#emit({ message: 'You no longer have access to this organization, so this entry cannot be deleted.', phase: 'unavailable' });
          return;
        }
        const refusal = error instanceof RunnerApiError && error.status >= 400 && error.status < 500 ? `The entry was not deleted: ${serverText(error)}` : null;
        this.#emit({ message: refusal ?? `The deletion was not confirmed: ${failureReason(error)} Trying again is safe.`, phase: 'failed' });
      },
    );
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#request?.abort();
    this.#request = null;
  }

  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#request === controller;
  }

  #emit(snapshot: MealDeletionSnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onChange(snapshot);
  }
}
