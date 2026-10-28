import { RunnerApiError, type CsrfCredentials, type LiveTrackScope } from './runner-api.js';

// `confirming`: asked, nothing sent. `pending`: one DELETE is on its way. `failed`: it was refused or its outcome is
// unknown, and the same request may be sent again. `unavailable`: the server will not delete this run for this person
// (404 or lost membership), so asking again cannot help. `deleted`: the server confirmed it.
export type RunDeletionPhase = 'confirming' | 'deleted' | 'failed' | 'pending' | 'unavailable';

export interface RunDeletionSnapshot {
  // Why the last attempt did not delete the run (`failed`, `unavailable`); null otherwise.
  message: string | null;
  phase: RunDeletionPhase;
}

export type RunDeleter = (scope: LiveTrackScope, csrf: CsrfCredentials, signal: AbortSignal) => Promise<void>;

export interface RunDeletionControllerOptions extends LiveTrackScope {
  // Read when the request is sent, so a refreshed token needs no new controller.
  csrf: () => CsrfCredentials;
  deleteRun: RunDeleter;
  onChange: (snapshot: RunDeletionSnapshot) => void;
  // Called once, after the server confirmed the deletion and after the `deleted` snapshot.
  onDeleted: () => void;
}

export const confirmingDeletion: RunDeletionSnapshot = { message: null, phase: 'confirming' };

function reference(error: RunnerApiError): string {
  return error.requestId === null ? '' : ` Reference ${error.requestId}.`;
}

function serverText(error: RunnerApiError): string {
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference(error)}`;
}

// The server answered and the run is not deletable by this person at all. A 404 reads the same for a run that is not
// theirs and one that never existed, and this text keeps it that way.
function unavailableText(error: unknown): string | null {
  if (!(error instanceof RunnerApiError)) return null;
  if (error.status === 404 && error.code === 'RUN_NOT_FOUND') {
    return 'This run is not available to you, so it cannot be deleted. Search again to refresh the list.';
  }
  if (error.status === 403 && error.code === 'ORG_ACCESS_DENIED') {
    return 'You no longer have access to this organization, so this run cannot be deleted.';
  }
  return null;
}

function failureText(error: unknown): string {
  // A 4xx answer is a refusal before anything was changed. Anything else (a 5xx, a lost connection, a deadline, an
  // answer that could not be read) says nothing about whether the server deleted the run before it failed.
  if (error instanceof RunnerApiError && error.status >= 400 && error.status < 500) {
    return `The run was not deleted: ${serverText(error)}`;
  }
  const reason = error instanceof RunnerApiError
    ? serverText(error)
    : error instanceof DOMException && error.name === 'TimeoutError'
      ? 'The server did not answer in time.'
      : 'The connection failed.';
  return `The deletion was not confirmed: ${reason} The run may already be deleted. Trying again is safe.`;
}

/**
 * Deleting one finished run, in one organization, for one person and session. A change of any of them means a new
 * controller, and disposing the old one aborts its request and silences it, so a late answer can never reach the new
 * scope. Creating it sends nothing: only `confirm()` does, at most one request at a time. A failed attempt sends the
 * same DELETE for the same run ID again, which the server treats as idempotent. Nothing is stored or retried on its
 * own; the runner's active run, writer lease and upload queue are not involved.
 */
export class RunDeletionController {
  readonly #csrf: () => CsrfCredentials;
  readonly #deleteRun: RunDeleter;
  readonly #onChange: (snapshot: RunDeletionSnapshot) => void;
  readonly #onDeleted: () => void;
  readonly #scope: LiveTrackScope;
  #disposed = false;
  #request: AbortController | null = null;
  #snapshot: RunDeletionSnapshot = confirmingDeletion;

  public constructor(options: RunDeletionControllerOptions) {
    this.#csrf = options.csrf;
    this.#deleteRun = options.deleteRun;
    this.#onChange = options.onChange;
    this.#onDeleted = options.onDeleted;
    this.#scope = { orgId: options.orgId, runId: options.runId };
  }

  public get snapshot(): RunDeletionSnapshot {
    return this.#snapshot;
  }

  public confirm(): void {
    const { phase } = this.#snapshot;
    if (this.#disposed || this.#request !== null || (phase !== 'confirming' && phase !== 'failed')) return;
    const request = new AbortController();
    this.#request = request;
    this.#emit({ message: null, phase: 'pending' });
    void this.#deleteRun(this.#scope, this.#csrf(), request.signal).then(
      () => {
        if (!this.#current(request)) return;
        this.#request = null;
        this.#emit({ message: null, phase: 'deleted' });
        this.#onDeleted();
      },
      (error: unknown) => {
        if (!this.#current(request)) return;
        this.#request = null;
        const unavailable = unavailableText(error);
        this.#emit(
          unavailable === null
            ? { message: failureText(error), phase: 'failed' }
            : { message: unavailable, phase: 'unavailable' },
        );
      },
    );
  }

  // Aborting does not undo a DELETE the server already received; it only stops this controller from reporting it.
  public dispose(): void {
    this.#disposed = true;
    this.#request?.abort();
    this.#request = null;
  }

  #current(request: AbortController): boolean {
    return !this.#disposed && this.#request === request;
  }

  #emit(snapshot: RunDeletionSnapshot): void {
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }
}
