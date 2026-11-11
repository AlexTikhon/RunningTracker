import type {
  ActivityHistoryDay,
  ActivityHistoryItem,
  ActivityHistoryResponse,
  ActivityHistorySource,
  ActivityType,
} from '@running-tracker/contracts';

import { followSession } from './daily-checkin-controller.js';
import { RunnerApiError, type ActivityHistoryInput } from './runner-api.js';

// The unified activity history (ADR-0087), one page at a time. A controller belongs to one organization, one set of
// filters (source, type and the local day of ADR-0088) and one session: changing any of them means a new controller, and
// disposing the old one (or ending its session) aborts its request and silences it, so a late answer for other filters,
// another day, another organization or an ended session can never be shown. Only one request is in flight at a time, the
// cursor sent is only ever the one the server returned for these filters, and an item repeated across pages is dropped.

/** A local calendar date and the IANA zone it is read in; the server lists what started in that date there. */
export interface HistoryDay {
  localDate: string;
  timeZone: string;
}

export interface ActivityHistoryFilters {
  day: HistoryDay | null;
  source: ActivityHistorySource | null;
  type: ActivityType | null;
}

export const noHistoryFilters: ActivityHistoryFilters = { day: null, source: null, type: null };

export const historyFilterKey = (filters: ActivityHistoryFilters) =>
  `${filters.source ?? '*'}|${filters.type ?? '*'}|${filters.day === null ? '*' : `${filters.day.localDate}@${filters.day.timeZone}`}`;

/** Whether the server's echo of the applied day is the day these filters asked for. */
function sameDay(requested: HistoryDay | null, applied: ActivityHistoryDay | null): boolean {
  if (requested === null || applied === null) return requested === null && applied === null;
  return requested.localDate === applied.localDate && requested.timeZone === applied.timeZone;
}

export const historyItemKey = (item: ActivityHistoryItem) =>
  item.source === 'recorded_run' ? `run:${item.runId}` : `activity:${item.activityId}`;

export type ActivityHistoryLoader = (input: ActivityHistoryInput, signal: AbortSignal) => Promise<ActivityHistoryResponse>;

export type ActivityHistoryStatus = 'access-denied' | 'error' | 'loading' | 'ready';

export interface ActivityHistorySnapshot {
  // The day the server applied, with its UTC interval (23 or 25 hours around a daylight saving change); null for every
  // date or before the first answer.
  appliedDay: ActivityHistoryDay | null;
  filters: ActivityHistoryFilters;
  hasMore: boolean;
  items: ActivityHistoryItem[];
  loadingMore: boolean;
  // Why the first page could not be shown (error, lost access); null otherwise.
  message: string | null;
  // Why the next page could not be added; the pages already shown stay.
  moreMessage: string | null;
  // The server no longer accepts the cursor: only starting over is meaningful.
  outdated: boolean;
  status: ActivityHistoryStatus;
}

export function loadingActivityHistory(filters: ActivityHistoryFilters): ActivityHistorySnapshot {
  return {
    appliedDay: null,
    filters,
    hasMore: false,
    items: [],
    loadingMore: false,
    message: null,
    moreMessage: null,
    outdated: false,
    status: 'loading',
  };
}

export interface ActivityHistoryControllerOptions {
  filters: ActivityHistoryFilters;
  load: ActivityHistoryLoader;
  onChange: (snapshot: ActivityHistorySnapshot) => void;
  orgId: string;
  // The session's lifetime: when it ends, the controller is disposed.
  signal?: AbortSignal;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function serverText(error: RunnerApiError): string {
  const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
}

export class ActivityHistoryController {
  readonly #filters: ActivityHistoryFilters;
  readonly #load: ActivityHistoryLoader;
  readonly #onChange: (snapshot: ActivityHistorySnapshot) => void;
  readonly #orgId: string;
  #cursor: string | null = null;
  #disposed = false;
  #request: AbortController | null = null;
  #snapshot: ActivityHistorySnapshot;
  #started = false;
  #unfollowSession: () => void = () => undefined;

  public constructor(options: ActivityHistoryControllerOptions) {
    const { day, source, type } = options.filters;
    this.#filters = { day: day === null ? null : { localDate: day.localDate, timeZone: day.timeZone }, source, type };
    this.#load = options.load;
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#snapshot = loadingActivityHistory(this.#filters);
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): ActivityHistorySnapshot {
    return this.#snapshot;
  }

  public start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#loadFirstPage();
  }

  public loadMore(): void {
    const s = this.#snapshot;
    if (!this.#started || this.#disposed || this.#request !== null || s.status !== 'ready' || s.outdated || this.#cursor === null) {
      return;
    }
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ loadingMore: true, moreMessage: null });
    void this.#run(controller, this.#cursor, 'next');
  }

  // A failed first page, lost access or an outdated cursor start over; a failed next page asks again.
  public retry(): void {
    const s = this.#snapshot;
    if (!this.#started || this.#disposed || this.#request !== null) return;
    if (s.outdated || s.status === 'error' || s.status === 'access-denied') {
      this.#loadFirstPage();
    } else if (s.moreMessage !== null) {
      this.loadMore();
    }
  }

  // The history is known to be out of date (an activity was saved, imported or deleted): start over from page one and
  // drop the answer to anything sent before, so it cannot bring back what the server has since changed.
  public refresh(): void {
    if (!this.#started || this.#disposed) return;
    this.#loadFirstPage();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#request?.abort();
    this.#request = null;
  }

  #emit(patch: Partial<ActivityHistorySnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#onChange(this.#snapshot);
  }

  #loadFirstPage(): void {
    this.#request?.abort();
    this.#cursor = null;
    const controller = new AbortController();
    this.#request = controller;
    this.#snapshot = loadingActivityHistory(this.#filters);
    this.#emit({});
    void this.#run(controller, null, 'first');
  }

  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#request === controller && !controller.signal.aborted;
  }

  async #run(controller: AbortController, cursor: string | null, kind: 'first' | 'next'): Promise<void> {
    let response: ActivityHistoryResponse;
    try {
      response = await this.#load({ cursor, orgId: this.#orgId, ...this.#filters }, controller.signal);
    } catch (error) {
      if (!this.#current(controller) || isAbort(error)) return;
      this.#request = null;
      this.#fail(error, kind);
      return;
    }
    if (!this.#current(controller)) return;
    this.#request = null;
    // The server echoes the filters it applied. An answer for other filters or another day is not this list's, whatever
    // caused it.
    if (
      response.applied.source !== this.#filters.source ||
      response.applied.type !== this.#filters.type ||
      !sameDay(this.#filters.day, response.applied.day)
    ) {
      this.#fail(new Error('The history answer belongs to other filters'), kind);
      return;
    }
    this.#cursor = response.nextCursor;
    const known = new Set(this.#snapshot.items.map(historyItemKey));
    const added = response.items.filter((item) => !known.has(historyItemKey(item)));
    this.#emit({
      appliedDay: response.applied.day,
      hasMore: response.nextCursor !== null,
      items: kind === 'first' ? response.items : [...this.#snapshot.items, ...added],
      loadingMore: false,
      message: null,
      moreMessage: null,
      outdated: false,
      status: 'ready',
    });
  }

  #fail(error: unknown, kind: 'first' | 'next'): void {
    if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
      this.#cursor = null;
      this.#snapshot = loadingActivityHistory(this.#filters);
      this.#emit({ message: 'You no longer have access to your activity history in this organization.', status: 'access-denied' });
      return;
    }
    if (kind === 'first') {
      this.#emit({
        message:
          error instanceof RunnerApiError
            ? serverText(error)
            : 'Your activity history could not be loaded. Check your connection and try again.',
        status: 'error',
      });
      return;
    }
    if (error instanceof RunnerApiError && error.code === 'INVALID_CURSOR') {
      this.#emit({
        loadingMore: false,
        moreMessage: 'This history is out of date. Refresh to see your current activities.',
        outdated: true,
      });
      return;
    }
    this.#emit({
      loadingMore: false,
      moreMessage:
        error instanceof RunnerApiError
          ? serverText(error)
          : 'More of your history could not be loaded. Check your connection and try again.',
    });
  }
}
