import type { RunView } from '@running-tracker/contracts';

import { readRun, RunnerApiError } from './runner-api.js';
import { isUnrecoverableRunCode, type RunnerEvent } from './runner-state.js';
import type { IndexedDbRunnerStorage, WriterLease } from './runner-storage.js';

// How long an unreachable server is left alone before the same read is asked again.
export const AUTHORITY_RETRY_MS = 5_000;

export interface AuthorityScope {
  orgId: string;
  runId: string;
  userId: string;
}

export interface AuthorityRefusal {
  code: string;
  message: string;
}

// What the page has right now, asked at the moment of use and never remembered. This is how a completion finds out
// that the run, the identity, the organization, the session or the writer is no longer the one it was started for.
export interface AuthorityHost {
  // The writer capability this tab holds, or null when it is read-only.
  lease: () => WriterLease | null;
  online: () => boolean;
  // The user, organization and run the page shows, or null when there is nothing to ask the server about.
  scope: () => AuthorityScope | null;
  // The lifetime of the session the page is using.
  signal: () => AbortSignal | null;
}

export type AuthorityCompletion =
  | { kind: 'confirmed'; persisted: boolean }
  | { kind: 'refused' }
  | { kind: 'unreachable' }
  // The read says nothing about the page any more, and nothing was reported or written for it:
  //  - not-requested: there was no scope, session or connection to ask with
  //  - session:       the server answered 401, which the session layer owns
  //  - superseded:    it was replaced, invalidated or cancelled
  //  - scope-changed: the run, organization or identity moved on
  //  - writer-changed: the writer capability it started with is not the one the tab holds now
  //  - not-saved:     the answer could not be stored for the current writer and run; it is not reported as confirmed
  | { kind: 'obsolete'; reason: 'not-requested' | 'not-saved' | 'scope-changed' | 'session' | 'superseded' | 'writer-changed' };

type Mode = 'confirm' | 'reconcile';

interface Flight {
  attempt: number;
  controller: AbortController;
  lease: WriterLease | null;
  mode: Mode;
  promise: Promise<AuthorityCompletion>;
  scope: AuthorityScope;
}

export interface RunAuthorityOptions {
  dispatch: (event: RunnerEvent) => void;
  host: AuthorityHost;
  read?: typeof readRun;
  storage: Pick<IndexedDbRunnerStorage, 'refreshActiveRun'>;
}

// A 4xx that is about the request, not the run: the next attempt may succeed.
const transientStatuses: ReadonlySet<number> = new Set([408, 425, 429]);
const notRequested: AuthorityCompletion = { kind: 'obsolete', reason: 'not-requested' };

function describe(error: unknown): string {
  if (error instanceof RunnerApiError) return `${error.message} (${error.code}).`;
  return error instanceof Error && error.message !== '' ? error.message : 'The server could not be reached.';
}

// The server answered, about the request or the run, that this cannot be used: a 4xx that is neither the session's
// (401) nor transient (408/425/429). Whether the person may then be offered the local discard is decided from the
// code (runner-state.ts). No answer at all (network, timeout, 5xx, an unreadable body) is never a refusal.
export function refusalOf(error: unknown): AuthorityRefusal | null {
  if (
    error instanceof RunnerApiError
    && error.status >= 400
    && error.status < 500
    && error.status !== 401
    && !transientStatuses.has(error.status)
  ) {
    return { code: error.code, message: describe(error) };
  }
  return null;
}

// A refusal that also means this identity cannot use this run, now or later (deleted, not found, membership gone):
// the answers that open the explicit local discard. The one test for reads, uploads and commands alike.
export function unrecoverableRefusalOf(error: unknown): AuthorityRefusal | null {
  const refusal = refusalOf(error);
  return refusal !== null && isUnrecoverableRunCode(refusal.code) ? refusal : null;
}

function sameScope(left: AuthorityScope | null, right: AuthorityScope): boolean {
  return left !== null && left.userId === right.userId && left.orgId === right.orgId && left.runId === right.runId;
}

// The same owner and epoch. The expiry moves with every renewal and is not part of the capability.
function sameLease(left: WriterLease | null, right: WriterLease | null): boolean {
  return left === null || right === null
    ? left === right
    : left.ownerId === right.ownerId && left.fencingToken === right.fencingToken;
}

const unsavedMessages = {
  'not-active': 'The answer was not saved because this run is no longer the active run on this device.',
  'writer-lost': 'The answer was not saved because this tab no longer owns recording.',
} as const;

// Owns what the page asks the server about its run, and what is allowed to happen when the answer comes back.
//
// One authority read is in flight at most. Asking again for the same scope, writer epoch and purpose returns the
// read already running; asking for anything else replaces it. A replaced, invalidated or cancelled read is aborted,
// but the abort is only cleanup: when the answer eventually arrives, whether anything may be reported or written is
// decided here, from the page's present scope and writer, before any durable work. The durable write then repeats
// the writer and active-run check inside its own IndexedDB transaction (IndexedDbRunnerStorage.refreshActiveRun),
// because the page can change between this check and that write.
//
// Reads are numbered by this object, never reused, so the reducer can tell the answer to the read it is waiting for
// from any other. A tab that is not the writer shows an eligible answer and never stores it.
export class RunAuthority {
  readonly #dispatch: (event: RunnerEvent) => void;
  readonly #host: AuthorityHost;
  readonly #read: typeof readRun;
  readonly #storage: Pick<IndexedDbRunnerStorage, 'refreshActiveRun'>;
  #attempt = 0;
  #flight: Flight | null = null;

  public constructor(options: RunAuthorityOptions) {
    this.#dispatch = options.dispatch;
    this.#host = options.host;
    this.#read = options.read ?? readRun;
    this.#storage = options.storage;
  }

  // Reads in flight that can still report: 0 or 1.
  public get inFlight(): number {
    return this.#flight === null ? 0 : 1;
  }

  // 'confirm' (the default) is the ordinary read, announced to the reducer as a numbered attempt. 'reconcile' is the
  // background read after the server rejected an upload: it merges the answer, or reports a refusal, and says
  // nothing when the server cannot be reached.
  public request(options: { reconcile?: boolean } = {}): Promise<AuthorityCompletion> {
    const mode: Mode = options.reconcile === true ? 'reconcile' : 'confirm';
    const scope = this.#host.scope();
    const session = this.#host.signal();
    if (scope === null || session === null || session.aborted || !this.#host.online()) return Promise.resolve(notRequested);
    const lease = this.#host.lease();

    // A reconciliation asks what an ordinary confirmation of the same scope is already asking, so it joins it: replacing
    // that read would leave the attempt the reducer is waiting for unanswered.
    const running = this.#flight;
    const sameKind = running?.mode === mode || (mode === 'reconcile' && running?.mode === 'confirm');
    if (running !== null && sameKind && sameScope(scope, running.scope) && sameLease(lease, running.lease) && this.#isCurrent(running)) {
      return running.promise;
    }
    this.invalidate();

    const controller = new AbortController();
    const cancel = () => controller.abort();
    session.addEventListener('abort', cancel, { once: true });
    const flight: Flight = {
      attempt: mode === 'confirm' ? this.#nextAttempt() : 0,
      controller,
      lease,
      mode,
      promise: Promise.resolve(notRequested),
      scope,
    };
    this.#flight = flight;
    if (mode === 'confirm') this.#dispatch({ attempt: flight.attempt, type: 'authority-requested' });
    flight.promise = this.#run(flight).finally(() => {
      session.removeEventListener('abort', cancel);
      if (this.#flight === flight) this.#flight = null;
    });
    return flight.promise;
  }

  // The page's scope or writer changed on purpose (a run cleared, started or discarded, an identity or organization
  // left, the page closed): whatever is in flight no longer says anything and must not report or write.
  public invalidate(): void {
    const running = this.#flight;
    this.#flight = null;
    running?.controller.abort();
  }

  public isCurrentScope(scope: AuthorityScope): boolean {
    return sameScope(this.#host.scope(), scope);
  }

  // A definitive refusal that did not come from a read (an upload, a command). It is accepted only for the scope the
  // page has now; it ends the read in flight, whose older answer could otherwise still persist or confirm.
  public refuse(scope: AuthorityScope, refusal: AuthorityRefusal): boolean {
    if (!this.isCurrentScope(scope)) return false;
    this.invalidate();
    this.#dispatch({ code: refusal.code, message: refusal.message, runId: scope.runId, type: 'authority-refused' });
    return true;
  }

  #nextAttempt(): number {
    this.#attempt += 1;
    return this.#attempt;
  }

  #isCurrent(flight: Flight): boolean {
    return this.#flight === flight
      && !flight.controller.signal.aborted
      && sameScope(this.#host.scope(), flight.scope)
      && sameLease(this.#host.lease(), flight.lease);
  }

  #whyObsolete(flight: Flight): AuthorityCompletion {
    if (this.#flight !== flight || flight.controller.signal.aborted) return { kind: 'obsolete', reason: 'superseded' };
    if (!sameScope(this.#host.scope(), flight.scope)) return { kind: 'obsolete', reason: 'scope-changed' };
    return { kind: 'obsolete', reason: 'writer-changed' };
  }

  async #run(flight: Flight): Promise<AuthorityCompletion> {
    const { lease, scope } = flight;
    let answer: RunView;
    try {
      answer = await this.#read(scope.orgId, scope.runId, flight.controller.signal);
    } catch (error) {
      return this.#isCurrent(flight) ? this.#failed(flight, error) : this.#whyObsolete(flight);
    }
    // Before any durable work: an answer for a scope or a writer that has changed is dropped here.
    if (!this.#isCurrent(flight)) return this.#whyObsolete(flight);
    if (answer.runId !== scope.runId) {
      return this.#failed(flight, new Error('The server answered with a different run than the one asked for.'));
    }

    if (lease !== null) {
      let unsaved: string | null = null;
      try {
        const written = await this.#storage.refreshActiveRun(scope, answer, lease);
        if (written.outcome === 'obsolete') unsaved = unsavedMessages[written.reason];
      } catch (error) {
        return this.#isCurrent(flight) ? this.#failed(flight, error) : this.#whyObsolete(flight);
      }
      if (!this.#isCurrent(flight)) return this.#whyObsolete(flight);
      if (unsaved !== null) {
        // Not a confirmation: the write that was meant to go with it did not happen.
        if (flight.mode === 'confirm') {
          this.#dispatch({ attempt: flight.attempt, kind: 'unreachable', message: unsaved, type: 'authority-unconfirmed' });
        }
        return { kind: 'obsolete', reason: 'not-saved' };
      }
    }

    this.#dispatch(flight.mode === 'confirm'
      ? { attempt: flight.attempt, run: answer, type: 'authority-confirmed' }
      : { run: answer, type: 'run-reconciled' });
    return { kind: 'confirmed', persisted: lease !== null };
  }

  #failed(flight: Flight, error: unknown): AuthorityCompletion {
    // 401: the session layer suspends everything on its own; there is nothing to report about the run.
    if (error instanceof RunnerApiError && error.status === 401) return { kind: 'obsolete', reason: 'session' };
    const refusal = refusalOf(error);
    if (flight.mode === 'reconcile') {
      if (refusal === null) return { kind: 'unreachable' };
      this.#dispatch({ code: refusal.code, message: refusal.message, runId: flight.scope.runId, type: 'authority-refused' });
      return { kind: 'refused' };
    }
    if (refusal !== null) {
      this.#dispatch({ attempt: flight.attempt, code: refusal.code, kind: 'refused', message: refusal.message, type: 'authority-unconfirmed' });
      return { kind: 'refused' };
    }
    this.#dispatch({ attempt: flight.attempt, kind: 'unreachable', message: describe(error), type: 'authority-unconfirmed' });
    return { kind: 'unreachable' };
  }
}
