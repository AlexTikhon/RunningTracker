import type { RunSearchItem, RunSearchResponse } from '@running-tracker/contracts';

import { RunnerApiError } from './runner-api.js';
import { toSearchParams, type RunSearchFilters } from './run-search.js';

export interface RunSearchRequest {
  orgId: string;
  params: Record<string, string>;
}

export type RunSearchLoader = (
  input: RunSearchRequest,
  signal: AbortSignal,
) => Promise<RunSearchResponse>;

export type RunSearchStatus = 'access-denied' | 'error' | 'loading' | 'ready';

export interface RunSearchSnapshot {
  hasMore: boolean;
  items: RunSearchItem[];
  loadingMore: boolean;
  // Why the first page could not be shown (error, lost access); null otherwise.
  message: string | null;
  // Why the next page could not be added; the pages already shown stay.
  moreMessage: string | null;
  // The server no longer accepts the cursor (the period moved on, for instance): only a new search is meaningful.
  outdated: boolean;
  pendingSummaryCount: number;
  // The period as the server resolved it; null until the first answer.
  resolved: { fromDate: string; toDate: string } | null;
  status: RunSearchStatus;
}

export interface RunSearchControllerOptions {
  filters: RunSearchFilters;
  load: RunSearchLoader;
  onChange: (snapshot: RunSearchSnapshot) => void;
  orgId: string;
}

const initialSnapshot: RunSearchSnapshot = {
  hasMore: false,
  items: [],
  loadingMore: false,
  message: null,
  moreMessage: null,
  outdated: false,
  pendingSummaryCount: 0,
  resolved: null,
  status: 'loading',
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describeFailure(error: unknown): string {
  if (error instanceof RunnerApiError) {
    const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
    return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
  }
  return 'The search could not be completed. Check your connection and try again.';
}

/**
 * One search: one organization, one set of applied filters. Changing either means a new controller, and disposing the
 * old one aborts its request and silences it, so a late answer can never be mixed into the new results. Pages are
 * requested one at a time with the cursor the server returned for the page before.
 */
export class RunSearchController {
  readonly #filters: RunSearchFilters;
  readonly #load: RunSearchLoader;
  readonly #onChange: (snapshot: RunSearchSnapshot) => void;
  readonly #orgId: string;
  #cursor: string | null = null;
  #disposed = false;
  #request: AbortController | null = null;
  #snapshot: RunSearchSnapshot = initialSnapshot;
  #started = false;

  public constructor(options: RunSearchControllerOptions) {
    this.#filters = options.filters;
    this.#load = options.load;
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
  }

  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#loadFirstPage();
  }

  public loadMore(): void {
    const s = this.#snapshot;
    if (
      !this.#started ||
      this.#disposed ||
      this.#request !== null ||
      s.status !== 'ready' ||
      s.outdated ||
      this.#cursor === null
    ) {
      return;
    }
    this.#loadNextPage(this.#cursor);
  }

  // Failed first page, lost access or an outdated cursor start over from page one; a failed next page asks again.
  public retry(): void {
    const s = this.#snapshot;
    if (!this.#started || this.#disposed || this.#request !== null) {
      return;
    }
    if (s.outdated || s.status === 'error' || s.status === 'access-denied') {
      this.#loadFirstPage();
    } else if (s.moreMessage !== null) {
      this.loadMore();
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#request?.abort();
    this.#request = null;
  }

  #emit(patch: Partial<RunSearchSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#onChange(this.#snapshot);
  }

  #loadFirstPage(): void {
    this.#request?.abort();
    this.#cursor = null;
    const controller = new AbortController();
    this.#request = controller;
    this.#snapshot = initialSnapshot;
    this.#emit({});
    void this.#run(controller, undefined, 'first');
  }

  #loadNextPage(cursor: string): void {
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ loadingMore: true, moreMessage: null });
    void this.#run(controller, cursor, 'next');
  }

  async #run(controller: AbortController, cursor: string | undefined, kind: 'first' | 'next'): Promise<void> {
    let response: RunSearchResponse;
    try {
      response = await this.#load(
        { orgId: this.#orgId, params: toSearchParams(this.#filters, cursor) },
        controller.signal,
      );
    } catch (error) {
      if (!this.#current(controller) || isAbort(error)) {
        return;
      }
      this.#request = null;
      this.#fail(error, kind);
      return;
    }
    if (!this.#current(controller)) {
      return;
    }
    this.#request = null;
    const known = new Set(this.#snapshot.items.map((entry) => entry.runId));
    const added = response.items.filter((entry) => !known.has(entry.runId));
    this.#cursor = response.nextCursor;
    this.#emit({
      hasMore: response.nextCursor !== null,
      items: kind === 'first' ? response.items : [...this.#snapshot.items, ...added],
      loadingMore: false,
      message: null,
      moreMessage: null,
      outdated: false,
      pendingSummaryCount: response.pendingSummaryCount,
      resolved: { fromDate: response.applied.fromDate, toDate: response.applied.toDate },
      status: 'ready',
    });
  }

  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#request === controller && !controller.signal.aborted;
  }

  #fail(error: unknown, kind: 'first' | 'next'): void {
    if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
      this.#cursor = null;
      this.#snapshot = initialSnapshot;
      this.#emit({
        message: 'You no longer have access to your runs in this organization.',
        status: 'access-denied',
      });
      return;
    }
    if (kind === 'first') {
      this.#emit({ message: describeFailure(error), status: 'error' });
      return;
    }
    if (error instanceof RunnerApiError && error.code === 'INVALID_CURSOR') {
      this.#emit({
        loadingMore: false,
        moreMessage: 'These results are out of date. Search again to see the current list.',
        outdated: true,
      });
      return;
    }
    this.#emit({ loadingMore: false, moreMessage: describeFailure(error) });
  }
}
