import {
  ACTIVITY_ALREADY_SAVED,
  activityAlreadySavedDetailsSchema,
  type ActivityView,
  type CreateActivityRequest,
} from '@running-tracker/contracts';

import { sameActivityRequest, type ActivityDetails } from './activity-form.js';
import { followSession } from './daily-checkin-controller.js';
import { RunnerApiError, type ActivityTarget, type CsrfCredentials } from './runner-api.js';

// Framework-free controllers for the Activity tab (ADR-0072). Each belongs to one organization and one session: a
// change of person, organization or session means new controllers, and disposing an old one (or ending its session)
// aborts its request and silences it, so a late answer can never reach the new scope.

function reference(error: RunnerApiError): string {
  return error.requestId === null ? '' : ` Reference ${error.requestId}.`;
}

function serverText(error: RunnerApiError): string {
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference(error)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Saving one activity. Two layers make it idempotent:
//   - the client id is bound to one payload: after an unknown outcome the same details are sent again under the same
//     id (idempotent on the server); changed details get a new id;
//   - one idempotency key per form session (ADR-0073), kept across edits until a confirmed save or an explicit new
//     form: if an earlier attempt of this session did go through, the server returns that activity (same details) or
//     409 ACTIVITY_ALREADY_SAVED (changed details), and never stores a second activity.

export type ActivityCreator = (
  target: ActivityTarget,
  request: Required<CreateActivityRequest>,
  csrf: CsrfCredentials,
  signal: AbortSignal,
) => Promise<{ activity: ActivityView; created: boolean }>;

export type ActivitySubmissionPhase = 'already-saved' | 'failed' | 'idle' | 'pending' | 'saved';

export interface ActivitySubmissionSnapshot {
  message: string | null;
  phase: ActivitySubmissionPhase;
  // With `already-saved`: the activity this form session saved earlier, when the server named it.
  savedActivityId: string | null;
  // An earlier attempt's outcome is unknown: it may already be saved.
  uncertain: boolean;
}

export const idleSubmission: ActivitySubmissionSnapshot = {
  message: null,
  phase: 'idle',
  savedActivityId: null,
  uncertain: false,
};

export interface ActivitySubmissionControllerOptions {
  create: ActivityCreator;
  // Read when the request is sent, so a refreshed token needs no new controller.
  csrf: () => CsrfCredentials;
  newId: () => string;
  // A fresh idempotency key for a new form session.
  newKey: () => string;
  // Called once when the server says this form session already saved an activity with other details.
  onAlreadySaved: (activityId: string | null) => void;
  onChange: (snapshot: ActivitySubmissionSnapshot) => void;
  // Called once per confirmed save, after the `saved` snapshot.
  onSaved: (activity: ActivityView, created: boolean) => void;
  orgId: string;
  signal?: AbortSignal;
}

interface Attempt {
  activityId: string;
  details: ActivityDetails;
}

function definitiveSaveRefusal(error: unknown): string | null {
  if (!(error instanceof RunnerApiError)) return null;
  if (error.status === 401) return 'The activity was not saved: sign in again, then save.';
  if (error.status === 403) return 'The activity was not saved: you no longer have access to this organization.';
  // The id is taken: by a different payload of this person's (409) or by someone else's activity (404).
  if (error.code === 'ACTIVITY_CONFLICT' || error.code === 'ACTIVITY_NOT_FOUND') {
    return 'The activity was not saved because its identifier was already used. Save again to retry.';
  }
  // Any other 4xx is a refusal before anything was written, except those that say "try later".
  if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
    return `The activity was not saved: ${serverText(error)}`;
  }
  return null;
}

function unknownOutcomeText(error: unknown): string {
  const reason = error instanceof RunnerApiError
    ? serverText(error)
    : error instanceof DOMException && error.name === 'TimeoutError'
      ? 'the server did not answer in time.'
      : 'the connection failed.';
  return `The save was not confirmed: ${reason} The activity may already be saved. Saving the same details again is safe and will not create a duplicate.`;
}

function alreadySavedId(error: unknown): { activityId: string | null } | null {
  if (!(error instanceof RunnerApiError) || error.status !== 409 || error.code !== ACTIVITY_ALREADY_SAVED) return null;
  const details = activityAlreadySavedDetailsSchema.safeParse(error.details);
  return { activityId: details.success ? details.data.activityId : null };
}

export class ActivitySubmissionController {
  readonly #create: ActivityCreator;
  readonly #csrf: () => CsrfCredentials;
  readonly #newId: () => string;
  readonly #newKey: () => string;
  readonly #onAlreadySaved: (activityId: string | null) => void;
  readonly #onChange: (snapshot: ActivitySubmissionSnapshot) => void;
  readonly #onSaved: (activity: ActivityView, created: boolean) => void;
  readonly #orgId: string;
  // The form session's idempotency key.
  #formKey: string;
  // The attempt whose outcome is unknown, kept for an exact retry.
  #retained: Attempt | null = null;
  #disposed = false;
  #unfollowSession: () => void = () => undefined;
  #request: AbortController | null = null;
  #snapshot: ActivitySubmissionSnapshot = idleSubmission;

  public constructor(options: ActivitySubmissionControllerOptions) {
    this.#create = options.create;
    this.#csrf = options.csrf;
    this.#newId = options.newId;
    this.#newKey = options.newKey;
    this.#onAlreadySaved = options.onAlreadySaved;
    this.#onChange = options.onChange;
    this.#onSaved = options.onSaved;
    this.#orgId = options.orgId;
    this.#formKey = options.newKey();
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): ActivitySubmissionSnapshot {
    return this.#snapshot;
  }

  /** Whether saving these details now would repeat the uncertain earlier attempt rather than send new details. */
  public wouldReuse(details: ActivityDetails): boolean {
    return this.#retained !== null && sameActivityRequest(this.#retained.details, details);
  }

  /**
   * Sends the details unless a request is on its way or this form session already saved its activity. Returns whether
   * it was sent.
   */
  public submit(details: ActivityDetails): boolean {
    if (this.#disposed || this.#request !== null || this.#snapshot.phase === 'already-saved') return false;
    const attempt: Attempt = this.wouldReuse(details) ? this.#retained! : { activityId: this.#newId(), details };
    this.#retained = attempt;
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ message: null, phase: 'pending', savedActivityId: null, uncertain: false });
    const request = { ...attempt.details, idempotencyKey: this.#formKey };
    void this.#create({ activityId: attempt.activityId, orgId: this.#orgId }, request, this.#csrf(), controller.signal).then(
      ({ activity, created }) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        this.#retained = null;
        // The form session produced its activity; the next one starts with a new key.
        this.#formKey = this.#newKey();
        this.#emit({ message: 'Activity saved.', phase: 'saved', savedActivityId: null, uncertain: false });
        this.#onSaved(activity, created);
      },
      (error: unknown) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        const saved = alreadySavedId(error);
        if (saved !== null) {
          this.#retained = null;
          this.#emit({
            message: 'Your earlier save went through, so these changed details were not saved.',
            phase: 'already-saved',
            savedActivityId: saved.activityId,
            uncertain: false,
          });
          this.#onAlreadySaved(saved.activityId);
          return;
        }
        const refusal = definitiveSaveRefusal(error);
        if (refusal !== null) {
          this.#retained = null;
          this.#emit({ message: refusal, phase: 'failed', savedActivityId: null, uncertain: false });
        } else {
          this.#emit({ message: unknownOutcomeText(error), phase: 'failed', savedActivityId: null, uncertain: true });
        }
      },
    );
    return true;
  }

  /** Starts a new form session: a new key, nothing retained, idle. Ignored while a request is on its way. */
  public startNew(): void {
    if (this.#disposed || this.#request !== null) return;
    this.#retained = null;
    this.#formKey = this.#newKey();
    this.#emit(idleSubmission);
  }

  // Aborting does not undo a PUT the server already received; it only stops this controller from reporting it.
  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#request?.abort();
    this.#request = null;
  }

  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#request === controller;
  }

  #emit(snapshot: ActivitySubmissionSnapshot): void {
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Deleting one activity after an explicit confirmation. The server answers 204 whether or not the row still existed
// (no tombstone, ADR-0072), so a repeat is always safe.

export type ActivityDeletionPhase = 'confirming' | 'deleted' | 'failed' | 'pending' | 'unavailable';

export interface ActivityDeletionSnapshot {
  message: string | null;
  phase: ActivityDeletionPhase;
}

export const confirmingActivityDeletion: ActivityDeletionSnapshot = { message: null, phase: 'confirming' };

export interface ActivityDeletionControllerOptions extends ActivityTarget {
  csrf: () => CsrfCredentials;
  deleteActivity: (target: ActivityTarget, csrf: CsrfCredentials, signal: AbortSignal) => Promise<void>;
  onChange: (snapshot: ActivityDeletionSnapshot) => void;
  onDeleted: () => void;
  signal?: AbortSignal;
}

function deletionFailureText(error: unknown): string {
  if (error instanceof RunnerApiError && error.status >= 400 && error.status < 500) {
    return `The activity was not deleted: ${serverText(error)}`;
  }
  const reason = error instanceof RunnerApiError
    ? serverText(error)
    : error instanceof DOMException && error.name === 'TimeoutError'
      ? 'the server did not answer in time.'
      : 'the connection failed.';
  return `The deletion was not confirmed: ${reason} Trying again is safe.`;
}

export class ActivityDeletionController {
  readonly #csrf: () => CsrfCredentials;
  readonly #deleteActivity: ActivityDeletionControllerOptions['deleteActivity'];
  readonly #onChange: (snapshot: ActivityDeletionSnapshot) => void;
  readonly #onDeleted: () => void;
  readonly #target: ActivityTarget;
  #disposed = false;
  #unfollowSession: () => void = () => undefined;
  #request: AbortController | null = null;
  #snapshot: ActivityDeletionSnapshot = confirmingActivityDeletion;

  public constructor(options: ActivityDeletionControllerOptions) {
    this.#csrf = options.csrf;
    this.#deleteActivity = options.deleteActivity;
    this.#onChange = options.onChange;
    this.#onDeleted = options.onDeleted;
    this.#target = { activityId: options.activityId, orgId: options.orgId };
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): ActivityDeletionSnapshot {
    return this.#snapshot;
  }

  public confirm(): void {
    const { phase } = this.#snapshot;
    if (this.#disposed || this.#request !== null || (phase !== 'confirming' && phase !== 'failed')) return;
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ message: null, phase: 'pending' });
    void this.#deleteActivity(this.#target, this.#csrf(), controller.signal).then(
      () => {
        if (!this.#current(controller)) return;
        this.#request = null;
        this.#emit({ message: null, phase: 'deleted' });
        this.#onDeleted();
      },
      (error: unknown) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
          this.#emit({
            message: 'You no longer have access to this organization, so this activity cannot be deleted.',
            phase: 'unavailable',
          });
          return;
        }
        this.#emit({ message: deletionFailureText(error), phase: 'failed' });
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

  #emit(snapshot: ActivityDeletionSnapshot): void {
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }
}
