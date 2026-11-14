import {
  MEAL_DRAFT_ERROR_CODES,
  type MealDraftClarificationReason,
  type MealDraftProposalResponse,
  type MealDraftUnsupportedReason,
} from '@running-tracker/contracts';

import { followSession, isAbort } from './daily-checkin-controller.js';
import type { MealDraftErrorKind, MealDraftProposal } from './meal-draft.js';
import { RunnerApiError } from './runner-api.js';

// "Draft from text" (ADR-0092): one controller per organization and session. Each submission is one model run, never
// retried here. Whether an answer is still wanted is decided by a generation counter and by the scope it was asked for
// (the exact text and the form's date), never by the abort signal alone: an answer for text, a date, an organization or
// a session that is no longer current is dropped without effect, whatever the transport did with the cancelled request.

export interface MealDraftScope {
  localDate: string;
  text: string;
}

export type MealDraftLoader = (input: MealDraftScope & { orgId: string; timeZone: string }, signal: AbortSignal) => Promise<MealDraftProposalResponse>;

export type MealDraftSnapshot =
  | { status: 'idle' }
  | { scope: MealDraftScope; status: 'proposing' }
  | { proposal: MealDraftProposal; scope: MealDraftScope; status: 'proposal' }
  | { reason: MealDraftClarificationReason; scope: MealDraftScope; status: 'clarify' }
  | { reason: MealDraftUnsupportedReason; scope: MealDraftScope; status: 'unsupported' }
  | { status: 'unavailable' }
  | { kind: MealDraftErrorKind; retryAfterMs: number | null; status: 'error' };

export const idleMealDraft: MealDraftSnapshot = { status: 'idle' };

export interface MealDraftControllerOptions {
  load: MealDraftLoader;
  onChange: (snapshot: MealDraftSnapshot) => void;
  orgId: string;
  // The session's signal: ending or replacing the session silences this controller for good.
  signal?: AbortSignal;
  timeZone: string;
}

function toSnapshot(error: unknown): MealDraftSnapshot | null {
  if (!(error instanceof RunnerApiError)) {
    if (error instanceof DOMException && error.name === 'TimeoutError') return { kind: 'timeout', retryAfterMs: null, status: 'error' };
    // A refused answer (another date or zone, a broken body) is a failure; a dropped connection is a network problem.
    return { kind: error instanceof TypeError ? 'network' : 'failed', retryAfterMs: null, status: 'error' };
  }
  const failure = (kind: MealDraftErrorKind): MealDraftSnapshot => ({ kind, retryAfterMs: error.retryAfterMs, status: 'error' });
  switch (error.code) {
    case MEAL_DRAFT_ERROR_CODES.disabled:
      return { status: 'unavailable' };
    case MEAL_DRAFT_ERROR_CODES.rateLimited:
      return failure('rate_limited');
    case MEAL_DRAFT_ERROR_CODES.inProgress:
      return failure('in_progress');
    case MEAL_DRAFT_ERROR_CODES.busy:
    case MEAL_DRAFT_ERROR_CODES.budgetExhausted:
      return failure('busy');
    case MEAL_DRAFT_ERROR_CODES.timeout:
      return failure('timeout');
    default:
      break;
  }
  // The application announces an expired session and suspends it; nothing to say here.
  if (error.status === 401) return null;
  if (error.status === 403) return failure('access');
  return failure('failed');
}

export class MealDraftController {
  readonly #options: MealDraftControllerOptions;
  #disposed = false;
  #generation = 0;
  #request: AbortController | null = null;
  #snapshot: MealDraftSnapshot = idleMealDraft;
  #unavailable = false;
  #unfollowSession: () => void = () => undefined;

  public constructor(options: MealDraftControllerOptions) {
    this.#options = options;
    this.#unfollowSession = followSession(options.signal, () => this.dispose());
  }

  public get snapshot(): MealDraftSnapshot {
    return this.#snapshot;
  }

  public get pending(): boolean {
    return this.#request !== null;
  }

  /** Asks for a proposal for this exact text and date. Ignored while one is on its way, after "off", or once disposed. */
  public submit(text: string, localDate: string): boolean {
    if (this.#disposed || this.#unavailable || this.#request !== null) return false;
    const generation = (this.#generation += 1);
    const controller = new AbortController();
    const scope: MealDraftScope = { localDate, text };
    this.#request = controller;
    this.#emit({ scope, status: 'proposing' });
    void this.#run(generation, controller, scope);
    return true;
  }

  /**
   * The text, the date or the edit target changed, the person cancelled, or the proposal was applied: whatever is
   * pending or shown no longer applies. A pending request is abandoned and its answer will be dropped.
   */
  public invalidate(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#request?.abort();
    this.#request = null;
    if (this.#snapshot.status !== 'idle' && this.#snapshot.status !== 'unavailable') this.#emit(idleMealDraft);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unfollowSession();
    this.#generation += 1;
    this.#request?.abort();
    this.#request = null;
  }

  #emit(snapshot: MealDraftSnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onChange(snapshot);
  }

  #wanted(generation: number): boolean {
    return !this.#disposed && this.#generation === generation;
  }

  async #run(generation: number, controller: AbortController, scope: MealDraftScope): Promise<void> {
    let answer: MealDraftProposalResponse;
    try {
      answer = await this.#options.load({ ...scope, orgId: this.#options.orgId, timeZone: this.#options.timeZone }, controller.signal);
    } catch (error) {
      if (!this.#wanted(generation) || isAbort(error)) return;
      this.#request = null;
      const snapshot = toSnapshot(error);
      if (snapshot === null) {
        this.#emit(idleMealDraft);
        return;
      }
      if (snapshot.status === 'unavailable') this.#unavailable = true;
      this.#emit(snapshot);
      return;
    }
    if (!this.#wanted(generation)) return;
    this.#request = null;
    if (answer.localDate !== scope.localDate) {
      // Made for another date than the form's: applying it would move the entry. Never shown.
      this.#emit({ kind: 'failed', retryAfterMs: null, status: 'error' });
      return;
    }
    if (answer.outcome === 'draft') this.#emit({ proposal: answer, scope, status: 'proposal' });
    else if (answer.outcome === 'clarify') this.#emit({ reason: answer.reason, scope, status: 'clarify' });
    else this.#emit({ reason: answer.reason, scope, status: 'unsupported' });
  }
}
