import type { RunShareListResponse } from '@running-tracker/contracts';

import { RunnerApiError, type CsrfCredentials, type LiveTrackScope, type RunShareTarget } from './runner-api.js';

// What one person can see of the run, exactly as the server stores it. `none` means there is no share row;
// `neither` is a row with both flags off, which grants nothing.
export type ShareAccess = 'both' | 'history' | 'live' | 'neither' | 'none';

export interface ShareRow {
  access: ShareAccess;
  // A coach the server listed for the organization, or someone else who holds a share (granted through the API, or
  // a coach no longer active).
  kind: 'coach' | 'member';
  userId: string;
}

export type ShareChange = 'grant' | 'revoke';

export interface RunSharingSnapshot {
  // Why the shares could not be read (status `error`), or why the last change was not confirmed (status `ready`).
  message: string | null;
  pending: { change: ShareChange; userId: string } | null;
  rows: ShareRow[];
  status: 'error' | 'loading' | 'ready';
  truncated: boolean;
}

export interface RunSharingApi {
  grant: (target: RunShareTarget, csrf: CsrfCredentials, signal: AbortSignal) => Promise<unknown>;
  loadCoaches: (orgId: string, signal: AbortSignal) => Promise<string[]>;
  loadShares: (scope: LiveTrackScope, signal: AbortSignal) => Promise<RunShareListResponse>;
  revoke: (target: RunShareTarget, csrf: CsrfCredentials, signal: AbortSignal) => Promise<void>;
}

export interface RunSharingControllerOptions extends LiveTrackScope {
  api: RunSharingApi;
  csrf: CsrfCredentials;
  onChange: (snapshot: RunSharingSnapshot) => void;
}

function accessOf(share: { canReadHistory: boolean; canReadLive: boolean } | undefined): ShareAccess {
  if (share === undefined) return 'none';
  if (share.canReadLive && share.canReadHistory) return 'both';
  if (share.canReadLive) return 'live';
  if (share.canReadHistory) return 'history';
  return 'neither';
}

// Coaches first, in the server's order, then every other grantee in the server's order, so no share is hidden.
export function shareRows(coaches: readonly string[], shares: RunShareListResponse['items']): ShareRow[] {
  const byUser = new Map(shares.map((share) => [share.userId, share]));
  const coachSet = new Set(coaches);
  return [
    ...coaches.map((userId): ShareRow => ({ access: accessOf(byUser.get(userId)), kind: 'coach', userId })),
    ...shares
      .filter((share) => !coachSet.has(share.userId))
      .map((share): ShareRow => ({ access: accessOf(share), kind: 'member', userId: share.userId })),
  ];
}

const accessLabels: Record<ShareAccess, string> = {
  both: 'Live and history',
  history: 'History only',
  live: 'Live only',
  neither: 'No access',
  none: 'Not shared',
};

export function accessLabel(access: ShareAccess): string {
  return accessLabels[access];
}

// No name is stored for anyone, so a person is their role and the end of their identifier.
export function personLabel(row: ShareRow): string {
  return `${row.kind === 'coach' ? 'Coach' : 'Member'} …${row.userId.slice(-8)}`;
}

// Share always means live and history. Anything short of that can be completed (coaches only, since only they are
// offered to the owner) or removed.
export function rowActions(row: ShareRow): ShareChange[] {
  if (row.access === 'none') return row.kind === 'coach' ? ['grant'] : [];
  if (row.access === 'both' || row.kind === 'member') return ['revoke'];
  return ['grant', 'revoke'];
}

function describeFailure(error: unknown): string {
  if (error instanceof RunnerApiError) {
    const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
    return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'The server did not answer in time.';
  }
  return 'Check your connection and try again.';
}

const initialSnapshot: RunSharingSnapshot = {
  message: null,
  pending: null,
  rows: [],
  status: 'loading',
  truncated: false,
};

/**
 * Sharing for one run, in one organization, for one session. A change of any of them means a new controller, and
 * disposing the old one aborts its request and silences it, so a late answer can never reach the new scope. One
 * request is open at a time. After every change, confirmed or not, the share list is read again: a change that
 * timed out may still have happened, and the panel shows what the server says rather than a guess. Nothing here is
 * stored or retried on its own; sharing is not part of the runner's durable request queue.
 */
export class RunSharingController {
  readonly #api: RunSharingApi;
  readonly #csrf: CsrfCredentials;
  readonly #onChange: (snapshot: RunSharingSnapshot) => void;
  readonly #scope: LiveTrackScope;
  #coaches: string[] = [];
  #disposed = false;
  #request: AbortController | null = null;
  #snapshot: RunSharingSnapshot = initialSnapshot;
  #started = false;

  public constructor(options: RunSharingControllerOptions) {
    this.#api = options.api;
    this.#csrf = options.csrf;
    this.#onChange = options.onChange;
    this.#scope = { orgId: options.orgId, runId: options.runId };
  }

  public start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#load();
  }

  public retry(): void {
    if (!this.#started || this.#disposed || this.#request !== null || this.#snapshot.status !== 'error') return;
    this.#load();
  }

  public grant(userId: string): void {
    this.#change('grant', userId);
  }

  public revoke(userId: string): void {
    this.#change('revoke', userId);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#request?.abort();
    this.#request = null;
  }

  #emit(snapshot: RunSharingSnapshot): void {
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }

  #open(): AbortController {
    const request = new AbortController();
    this.#request = request;
    return request;
  }

  // Whether an answer to `request` may still change what is shown.
  #current(request: AbortController): boolean {
    return !this.#disposed && this.#request === request;
  }

  #load(): void {
    const request = this.#open();
    this.#emit({ ...initialSnapshot });
    void Promise.all([
      this.#api.loadCoaches(this.#scope.orgId, request.signal),
      this.#api.loadShares(this.#scope, request.signal),
    ]).then(
      ([coaches, shares]) => {
        if (!this.#current(request)) return;
        this.#request = null;
        this.#coaches = coaches;
        this.#emit({
          message: null,
          pending: null,
          rows: shareRows(coaches, shares.items),
          status: 'ready',
          truncated: shares.truncated,
        });
      },
      (error: unknown) => {
        if (!this.#current(request)) return;
        this.#request = null;
        this.#fail(error);
      },
    );
  }

  #fail(error: unknown): void {
    this.#emit({
      message: `The current sharing could not be read: ${describeFailure(error)}`,
      pending: null,
      rows: [],
      status: 'error',
      truncated: false,
    });
  }

  #change(change: ShareChange, userId: string): void {
    if (this.#disposed || this.#request !== null || this.#snapshot.status !== 'ready') return;
    const row = this.#snapshot.rows.find((candidate) => candidate.userId === userId);
    if (row === undefined || !rowActions(row).includes(change)) return;

    const request = this.#open();
    this.#emit({ ...this.#snapshot, message: null, pending: { change, userId } });
    const target: RunShareTarget = { ...this.#scope, userId };
    const sent = change === 'grant'
      ? this.#api.grant(target, this.#csrf, request.signal)
      : this.#api.revoke(target, this.#csrf, request.signal);
    void sent.then(
      () => this.#reload(request, null),
      (error: unknown) => {
        const verb = change === 'grant' ? 'Sharing' : 'Revoking';
        this.#reload(request, `${verb} was not confirmed: ${describeFailure(error)}`);
      },
    );
  }

  // Reads the shares again under the same request, so a dispose in between silences it as well.
  #reload(request: AbortController, message: string | null): void {
    if (!this.#current(request)) return;
    void this.#api.loadShares(this.#scope, request.signal).then(
      (shares) => {
        if (!this.#current(request)) return;
        this.#request = null;
        this.#emit({
          message,
          pending: null,
          rows: shareRows(this.#coaches, shares.items),
          status: 'ready',
          truncated: shares.truncated,
        });
      },
      (error: unknown) => {
        if (!this.#current(request)) return;
        this.#request = null;
        this.#fail(error);
      },
    );
  }
}
