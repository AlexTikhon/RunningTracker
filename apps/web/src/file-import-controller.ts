import {
  ACTIVITY_ALREADY_SAVED,
  activityAlreadySavedDetailsSchema,
  type ActivityType,
  type ActivityView,
} from '@running-tracker/contracts';
import { followSession } from './daily-checkin-controller.js';
import { RunnerApiError, type ActivityTarget, type CsrfCredentials } from './runner-api.js';

// The file import of the Activity tab, framework-free like the other Activity controllers, shared by the GPX (ADR-0086)
// and TCX (ADR-0091) imports: a format only supplies its limits, error codes and wording, so retries, unknown outcomes,
// duplicates and disposal behave identically for both. One controller per organization and session: a change of person,
// organization or session disposes it, which aborts its request and silences every later answer.
//
// The import identity is the selected file, one idempotency key (ADR-0073) and the activity id of the attempt. It is
// created when a file is selected and kept until a confirmed outcome or until the person chooses another file or starts
// over. After an unknown outcome (5xx, timeout, network) "Import again" sends the same file, key, id and type; the server
// answers the stored activity if the first attempt went through, and never stores a second one. A changed type after an
// unknown outcome keeps the key and takes a new id, so the server can say the earlier attempt already saved it.
//
// The server parses the file and computes every number, on preview and again on confirmation; this controller never
// sends a total, a time or a source.

/** A contract schema of error details that name an activity (the format's "already imported" details). */
export interface ActivityIdDetailsSchema {
  safeParse(value: unknown): { data: { activityId: string }; success: true } | { success: false };
}

/** What distinguishes one import format from another; everything else is shared. */
export interface FileImportFormat {
  /** 409 code: the same file (by the format's fingerprint) is already one of the person's activities. */
  readonly alreadyImportedCode: string;
  readonly alreadyImportedDetailsSchema: ActivityIdDetailsSchema;
  readonly alreadyImportedMessage: string;
  readonly maxBytes: number;
  /** The status message after a confirmed import. */
  readonly savedMessage: string;
  /** 413 code: the body is larger than the format's limit. */
  readonly tooLargeCode: string;
  /** 422 code: the file is outside the format's supported subset. */
  readonly unsupportedCode: string;
}

export type FilePreviewer<Preview> = (input: { orgId: string }, file: Blob, csrf: CsrfCredentials, signal: AbortSignal) => Promise<Preview>;

export type FileConfirmer = (
  target: ActivityTarget,
  choice: { idempotencyKey: string; type: ActivityType },
  file: Blob,
  csrf: CsrfCredentials,
  signal: AbortSignal,
) => Promise<{ activity: ActivityView; created: boolean }>;

export type FileImportPhase =
  | 'access-denied'
  | 'already-imported'
  | 'already-saved'
  | 'idle'
  | 'invalid'
  | 'preview'
  | 'preview-failed'
  | 'previewing'
  | 'save-failed'
  | 'saved'
  | 'saving';

export interface FileImportSnapshot<Preview> {
  /** With `already-imported` or `already-saved`: the existing activity the server named (null when it named none). */
  existingActivityId: string | null;
  fileName: string | null;
  message: string | null;
  phase: FileImportPhase;
  /** The server's preview of the selected file; kept while confirming and after a failed confirmation. */
  preview: Preview | null;
  /** With `saved`: the stored activity. */
  saved: ActivityView | null;
  /** An earlier confirmation's outcome is unknown: it may already be saved. */
  uncertain: boolean;
}

export const idleFileImport: FileImportSnapshot<never> = {
  existingActivityId: null,
  fileName: null,
  message: null,
  phase: 'idle',
  preview: null,
  saved: null,
  uncertain: false,
};

export interface FileImportControllerOptions<Preview> {
  confirm: FileConfirmer;
  csrf: () => CsrfCredentials;
  newId: () => string;
  newKey: () => string;
  onChange: (snapshot: FileImportSnapshot<Preview>) => void;
  /** Called once per confirmed import (also a confirmed replay), after the `saved` snapshot. */
  onSaved: (activity: ActivityView, created: boolean) => void;
  orgId: string;
  preview: FilePreviewer<Preview>;
  /** The session's lifetime: when it ends, the controller is disposed. */
  signal?: AbortSignal;
}

interface ImportIdentity {
  /** The id of the attempt whose outcome is unknown, with its type; null before the first confirmation. */
  attempt: { activityId: string; type: ActivityType } | null;
  readonly file: Blob;
  readonly key: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function serverText(error: RunnerApiError): string {
  const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
}

function namedActivity(error: RunnerApiError, schema: ActivityIdDetailsSchema): string | null {
  const parsed = schema.safeParse(error.details);
  return parsed.success ? parsed.data.activityId : null;
}

function unknownOutcome(error: unknown): string {
  const reason = error instanceof RunnerApiError
    ? serverText(error)
    : error instanceof DOMException && error.name === 'TimeoutError'
      ? 'the server did not answer in time.'
      : 'the connection failed.';
  return `The import was not confirmed: ${reason} It may already be saved. Importing again is safe and will not create a duplicate.`;
}

export class FileImportController<Preview> {
  readonly #confirm: FileConfirmer;
  readonly #csrf: () => CsrfCredentials;
  readonly #format: FileImportFormat;
  readonly #newId: () => string;
  readonly #newKey: () => string;
  readonly #onChange: (snapshot: FileImportSnapshot<Preview>) => void;
  readonly #onSaved: (activity: ActivityView, created: boolean) => void;
  readonly #orgId: string;
  readonly #preview: FilePreviewer<Preview>;
  #disposed = false;
  #identity: ImportIdentity | null = null;
  #request: AbortController | null = null;
  #snapshot: FileImportSnapshot<Preview> = idleFileImport;
  #unfollowSession: () => void = () => undefined;

  public constructor(format: FileImportFormat, options: FileImportControllerOptions<Preview>) {
    this.#format = format;
    this.#confirm = options.confirm;
    this.#csrf = options.csrf;
    this.#newId = options.newId;
    this.#newKey = options.newKey;
    this.#onChange = options.onChange;
    this.#onSaved = options.onSaved;
    this.#orgId = options.orgId;
    this.#preview = options.preview;
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): FileImportSnapshot<Preview> {
    return this.#snapshot;
  }

  get #maxMegabytes(): number {
    return this.#format.maxBytes / (1024 * 1024);
  }

  /** Why a file cannot be imported at all, from the server's definitive answer; null for anything else. */
  #unsupportedText(error: unknown): string | null {
    if (!(error instanceof RunnerApiError)) return null;
    if (error.code === this.#format.tooLargeCode || error.status === 413) {
      return `This file is larger than ${this.#maxMegabytes} MB, so it cannot be imported.`;
    }
    if (error.code === this.#format.unsupportedCode) return `This file cannot be imported: ${serverText(error)}`;
    return null;
  }

  /**
   * A newly selected file: a new import identity, and a preview request. Refused while a confirmation is on its way (its
   * outcome must be reported first). A preview of an earlier file is aborted and its answer dropped.
   */
  public select(file: File): boolean {
    if (this.#disposed || this.#snapshot.phase === 'saving') return false;
    this.#request?.abort();
    this.#request = null;
    const base = { ...idleFileImport, fileName: file.name };
    if (file.size === 0) {
      this.#identity = null;
      this.#emit({ ...base, message: 'This file is empty, so it cannot be imported.', phase: 'invalid' });
      return true;
    }
    if (file.size > this.#format.maxBytes) {
      // Refused here without sending it; the server would refuse it too.
      this.#identity = null;
      this.#emit({ ...base, message: `This file is larger than ${this.#maxMegabytes} MB, so it cannot be imported.`, phase: 'invalid' });
      return true;
    }
    this.#identity = { attempt: null, file, key: this.#newKey() };
    this.#emit({ ...base, phase: 'previewing' });
    this.#requestPreview();
    return true;
  }

  /** Asks for the preview of the selected file again after a transient failure. */
  public retryPreview(): void {
    if (this.#disposed || this.#request !== null || this.#identity === null || this.#snapshot.phase !== 'preview-failed') return;
    this.#emit({ ...this.#snapshot, message: null, phase: 'previewing' });
    this.#requestPreview();
  }

  /** Whether confirming `type` now repeats the attempt whose outcome is unknown. */
  public wouldRepeat(type: ActivityType): boolean {
    return this.#identity?.attempt?.type === type;
  }

  /** Confirms the previewed file as an activity of `type`. Returns whether a request was sent. */
  public confirm(type: ActivityType): boolean {
    const phase = this.#snapshot.phase;
    const identity = this.#identity;
    if (this.#disposed || this.#request !== null || identity === null || (phase !== 'preview' && phase !== 'save-failed')) return false;
    const attempt = identity.attempt?.type === type ? identity.attempt : { activityId: this.#newId(), type };
    identity.attempt = attempt;
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ ...this.#snapshot, message: null, phase: 'saving', uncertain: false });
    void this.#confirm(
      { activityId: attempt.activityId, orgId: this.#orgId },
      { idempotencyKey: identity.key, type },
      identity.file,
      this.#csrf(),
      controller.signal,
    ).then(
      ({ activity, created }) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        // The import produced its activity; the identity is used up.
        this.#identity = null;
        this.#emit({ ...idleFileImport, fileName: this.#snapshot.fileName, message: this.#format.savedMessage, phase: 'saved', saved: activity });
        this.#onSaved(activity, created);
      },
      (error: unknown) => {
        if (!this.#current(controller)) return;
        this.#request = null;
        this.#failConfirmation(error);
      },
    );
    return true;
  }

  /** Back to choosing a file: the identity is dropped. Ignored while a confirmation is on its way. */
  public reset(): void {
    if (this.#disposed || this.#snapshot.phase === 'saving') return;
    this.#request?.abort();
    this.#request = null;
    this.#identity = null;
    this.#emit(idleFileImport);
  }

  // Aborting does not undo a confirmation the server already received; it only stops this controller from reporting it.
  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#request?.abort();
    this.#request = null;
  }

  #requestPreview(): void {
    const identity = this.#identity;
    if (identity === null) return;
    const controller = new AbortController();
    this.#request = controller;
    void this.#preview({ orgId: this.#orgId }, identity.file, this.#csrf(), controller.signal).then(
      (preview) => {
        if (!this.#current(controller) || this.#identity !== identity) return;
        this.#request = null;
        this.#emit({ ...this.#snapshot, message: null, phase: 'preview', preview });
      },
      (error: unknown) => {
        if (!this.#current(controller) || this.#identity !== identity || isAbort(error)) return;
        this.#request = null;
        if (error instanceof RunnerApiError && (error.status === 401 || error.status === 403)) {
          this.#identity = null;
          this.#emit({ ...this.#snapshot, message: 'You no longer have access to this organization, so nothing can be imported.', phase: 'access-denied' });
          return;
        }
        const unsupported = this.#unsupportedText(error);
        if (unsupported !== null) {
          this.#identity = null;
          this.#emit({ ...this.#snapshot, message: unsupported, phase: 'invalid' });
          return;
        }
        const reason = error instanceof RunnerApiError ? serverText(error) : 'Check your connection and try again.';
        this.#emit({ ...this.#snapshot, message: `The file could not be checked. ${reason}`, phase: 'preview-failed' });
      },
    );
  }

  #failConfirmation(error: unknown): void {
    const identity = this.#identity;
    const definitive = (message: string, patch: Partial<FileImportSnapshot<Preview>> = {}) => {
      this.#emit({ ...this.#snapshot, message, phase: 'save-failed', uncertain: false, ...patch });
    };
    if (error instanceof RunnerApiError) {
      if (error.code === this.#format.alreadyImportedCode && error.status === 409) {
        this.#identity = null;
        this.#emit({
          ...this.#snapshot,
          existingActivityId: namedActivity(error, this.#format.alreadyImportedDetailsSchema),
          message: this.#format.alreadyImportedMessage,
          phase: 'already-imported',
          uncertain: false,
        });
        return;
      }
      if (error.code === ACTIVITY_ALREADY_SAVED && error.status === 409) {
        this.#identity = null;
        this.#emit({
          ...this.#snapshot,
          existingActivityId: namedActivity(error, activityAlreadySavedDetailsSchema),
          message: 'Your earlier import of this file went through with another type, so the new type was not saved.',
          phase: 'already-saved',
          uncertain: false,
        });
        return;
      }
      if (error.status === 401 || error.status === 403) {
        this.#identity = null;
        this.#emit({ ...this.#snapshot, message: 'The activity was not imported: you no longer have access to this organization.', phase: 'access-denied', uncertain: false });
        return;
      }
      if (error.code === 'ACTIVITY_CONFLICT' || error.code === 'ACTIVITY_NOT_FOUND') {
        // The id is taken; the next confirmation takes a new one under the same key.
        if (identity !== null) identity.attempt = null;
        definitive('The activity was not imported because its identifier was already used. Import again to retry.');
        return;
      }
      const unsupported = this.#unsupportedText(error);
      if (unsupported !== null) {
        this.#identity = null;
        this.#emit({ ...this.#snapshot, message: unsupported, phase: 'invalid', preview: null, uncertain: false });
        return;
      }
      if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
        if (identity !== null) identity.attempt = null;
        definitive(`The activity was not imported: ${serverText(error)}`);
        return;
      }
    }
    // 5xx, timeout, network, an aborted transport: the server may have stored it. Keep the identity for an exact retry.
    this.#emit({ ...this.#snapshot, message: unknownOutcome(error), phase: 'save-failed', uncertain: true });
  }

  #current(controller: AbortController): boolean {
    return !this.#disposed && this.#request === controller && !controller.signal.aborted;
  }

  #emit(snapshot: FileImportSnapshot<Preview>): void {
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }
}
