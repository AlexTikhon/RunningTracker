import type {
  RunSearchClarificationReason,
  RunSearchInterpretationResponse,
  RunSearchProposedFilters,
  RunSearchUnsupportedReason,
} from '@running-tracker/contracts';

import { RunnerApiError } from './runner-api.js';
import type { InterpretationErrorKind } from './run-search-interpretation.js';

export interface InterpretationRequestInput {
  orgId: string;
  text: string;
  timeZone: string;
}

export type InterpretationLoader = (
  input: InterpretationRequestInput,
  signal: AbortSignal,
) => Promise<RunSearchInterpretationResponse>;

export type InterpretationSnapshot =
  | { status: 'idle' }
  | { status: 'interpreting' }
  // The editable draft was replaced by a proposal that still needs to be reviewed and applied.
  | { status: 'proposal' }
  | { reason: RunSearchClarificationReason; status: 'clarify' }
  | { reason: RunSearchUnsupportedReason; status: 'unsupported' }
  | { kind: 'disabled'; status: 'unavailable' }
  | { kind: Exclude<InterpretationErrorKind, 'disabled'>; retryAfterMs: number | null; status: 'error' };

export interface InterpretationControllerOptions {
  load: InterpretationLoader;
  onChange: (snapshot: InterpretationSnapshot) => void;
  /** Called, at most once per interpretation, only with a proposal that is still current. */
  onProposal: (filters: RunSearchProposedFilters) => void;
  orgId: string;
  timeZone: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toSnapshot(error: unknown): InterpretationSnapshot {
  if (error instanceof RunnerApiError) {
    const error_ = (kind: Exclude<InterpretationErrorKind, 'disabled'>): InterpretationSnapshot => ({
      kind,
      retryAfterMs: error.retryAfterMs,
      status: 'error',
    });
    switch (error.code) {
      case 'INTERPRETATION_DISABLED':
        return { kind: 'disabled', status: 'unavailable' };
      case 'INTERPRETATION_RATE_LIMITED':
        return error_('rate_limited');
      case 'INTERPRETATION_IN_PROGRESS':
        return error_('in_progress');
      case 'INTERPRETATION_BUSY':
      case 'INTERPRETATION_BUDGET_EXHAUSTED':
        return error_('busy');
      case 'INTERPRETATION_TIMEOUT':
        return error_('timeout');
      case 'INTERPRETATION_FAILED':
        return error_('failed');
      default:
        break;
    }
    if (error.status === 401) {
      // The application announces this and suspends the session; nothing to say here.
      return { status: 'idle' };
    }
    if (error.status === 403) {
      return error_('access');
    }
    return error_('failed');
  }
  return { kind: 'network', retryAfterMs: null, status: 'error' };
}

/**
 * One "describe it in words" box for one organization. Each submission is one billable request, never retried by
 * this class. A generation counter, not the abort signal, decides whether an answer is still wanted: whatever the
 * transport does with a cancelled request, an answer for text, a draft or a scope that is no longer current is
 * dropped without effect.
 */
export class RunSearchInterpretationController {
  readonly #options: InterpretationControllerOptions;
  #disposed = false;
  #generation = 0;
  #request: AbortController | null = null;
  #snapshot: InterpretationSnapshot = { status: 'idle' };
  #unavailable = false;

  public constructor(options: InterpretationControllerOptions) {
    this.#options = options;
  }

  public get snapshot(): InterpretationSnapshot {
    return this.#snapshot;
  }

  public submit(text: string): void {
    if (this.#disposed || this.#unavailable || this.#request !== null) {
      return;
    }
    const generation = (this.#generation += 1);
    const controller = new AbortController();
    this.#request = controller;
    this.#emit({ status: 'interpreting' });
    void this.#run(generation, controller, text);
  }

  /** The text or the draft changed, or the filters were applied: whatever is pending or shown no longer applies. */
  public invalidate(): void {
    if (this.#disposed) {
      return;
    }
    this.#generation += 1;
    this.#request?.abort();
    this.#request = null;
    if (this.#snapshot.status !== 'idle' && this.#snapshot.status !== 'unavailable') {
      this.#emit({ status: 'idle' });
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#request?.abort();
    this.#request = null;
  }

  #emit(snapshot: InterpretationSnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onChange(snapshot);
  }

  async #run(generation: number, controller: AbortController, text: string): Promise<void> {
    let answer: RunSearchInterpretationResponse;
    try {
      answer = await this.#options.load(
        { orgId: this.#options.orgId, text, timeZone: this.#options.timeZone },
        controller.signal,
      );
    } catch (error) {
      if (!this.#wanted(generation) || isAbort(error)) {
        return;
      }
      this.#request = null;
      const snapshot = toSnapshot(error);
      if (snapshot.status === 'unavailable') {
        this.#unavailable = true;
      }
      this.#emit(snapshot);
      return;
    }
    if (!this.#wanted(generation)) {
      return;
    }
    this.#request = null;

    if (answer.outcome === 'search') {
      if (answer.filters.timeZone !== this.#options.timeZone) {
        // The answer was made for a zone this form is not in; applying it would silently move the dates.
        this.#emit({ kind: 'failed', retryAfterMs: null, status: 'error' });
        return;
      }
      this.#options.onProposal(answer.filters);
      this.#emit({ status: 'proposal' });
    } else if (answer.outcome === 'clarify') {
      this.#emit({ reason: answer.reason, status: 'clarify' });
    } else {
      this.#emit({ reason: answer.reason, status: 'unsupported' });
    }
  }

  #wanted(generation: number): boolean {
    return !this.#disposed && this.#generation === generation;
  }
}
