import { MEAL_DRAFT_ERROR_CODES, type MealDraftFailureReason } from '@running-tracker/contracts';

import type { Clock } from '../../clock.js';
import { ApiError } from '../../http/errors.js';
import { LlmProviderError, type LlmProvider, type LlmStructuredInput, type LlmStructuredResult } from '../../insights/llm-provider.js';
import type { ApiMetrics } from '../../observability/api-metrics.js';
import type { Logger } from '../../observability/logger.js';
import {
  AdmissionRejectedError,
  type AdmissionRejection,
  type AdmissionTicket,
  type InterpretationAdmission,
} from '../../runs/interpretation/interpretation-admission.js';
import { groundMealDraft, UngroundedOutputError, type GroundedProposal, type GroundingAudit } from './meal-draft-grounding.js';
import { buildMealDraftMessages } from './meal-draft-prompt.js';
import { mealDraftWireJsonSchema, mealDraftWireSchema } from './meal-draft-wire.js';

// One meal draft proposal (ADR-0092): admission, one model call under a hard deadline, the wire schema, grounding in the
// person's text, and a last access check before the answer leaves. It owns no HTTP and no database: the route has checked
// access and the date rules, and `revalidate` is how it asks again.
//
// The two lifetimes of ADR-0057 (addendum), unchanged: the REQUEST ends at the deadline or when the client leaves and is
// answered then; the OPERATION (the provider's promise) ends when that promise settles, and only then are its admission
// places released. A call still running after a timeout keeps its global place and the person's one in-flight
// reservation, so outstanding model calls stay within the configured limits; a call that never settles keeps them until
// the process restarts (fail-closed: the manual meal form is not involved). A late answer is dropped unread.

export interface MealDraftServiceOptions {
  admission: InterpretationAdmission;
  clock: Clock;
  logger: Logger;
  maxOutputTokens: number;
  metrics?: ApiMetrics['mealDrafts'];
  provider: LlmProvider;
  /** Hard deadline for the whole provider call, response body included. */
  timeoutMs: number;
}

export interface MealDraftRequest {
  requestId: string;
  /**
   * Called after the answer was grounded and before anything is returned: it must throw the existing authorization
   * error if the session or the membership is gone. It holds no connection while the model works.
   */
  revalidate: () => Promise<void>;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
  /** The person's text, already checked against the request contract. */
  text: string;
  userId: string;
}

/** The only thing about a request that is ever logged or counted: never the text, the answer, a prompt or the person. */
export type MealDraftOutcome =
  | 'aborted'
  | 'access_lost'
  | 'clarify'
  | 'draft'
  | 'incomplete'
  | 'invalid_output'
  | 'oversized'
  | 'provider_error'
  | 'provider_unavailable'
  | 'rejected_budget_exhausted'
  | 'rejected_busy'
  | 'rejected_in_progress'
  | 'rejected_rate_limited'
  | 'timeout'
  | 'ungrounded_output'
  | 'unsupported';

/** The request ended before the operation could answer it. Internal. */
class RequestInterrupted extends Error {
  public constructor(public readonly reason: 'aborted' | 'timeout') {
    super(`The meal draft request ended: ${reason}`);
    this.name = 'RequestInterrupted';
  }
}

class ServiceFailure extends Error {
  public constructor(public readonly reason: MealDraftFailureReason) {
    super(`The meal draft failed: ${reason}`);
    this.name = 'ServiceFailure';
  }
}

const rejection: Record<AdmissionRejection, { code: string; message: string; status: number }> = {
  budget_exhausted: {
    code: MEAL_DRAFT_ERROR_CODES.budgetExhausted,
    message: 'The meal draft allowance of this server is used up for now',
    status: 503,
  },
  busy: { code: MEAL_DRAFT_ERROR_CODES.busy, message: 'The local model is busy; try again shortly', status: 503 },
  in_progress: { code: MEAL_DRAFT_ERROR_CODES.inProgress, message: 'An earlier draft of yours is still running', status: 429 },
  rate_limited: { code: MEAL_DRAFT_ERROR_CODES.rateLimited, message: 'Too many draft requests; try again shortly', status: 429 },
};

function providerFailure(error: unknown): MealDraftOutcome {
  if (!(error instanceof LlmProviderError)) return 'provider_error';
  switch (error.reason) {
    case 'aborted':
      return 'aborted';
    case 'timeout':
      return 'timeout';
    case 'incomplete':
      return 'incomplete';
    case 'invalid_response':
      return 'invalid_output';
    case 'oversized':
      return 'oversized';
    case 'unavailable':
      return 'provider_unavailable';
    case 'provider_error':
      return 'provider_error';
  }
}

function toError(outcome: MealDraftOutcome, error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AdmissionRejectedError) {
    const mapped = rejection[error.reason];
    return new ApiError(
      mapped.status,
      mapped.code,
      mapped.message,
      error.retryAfterMs === null ? undefined : { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) },
    );
  }
  if (outcome === 'timeout') return new ApiError(504, MEAL_DRAFT_ERROR_CODES.timeout, 'The local model did not answer in time');
  if (outcome === 'aborted') return new ApiError(499, MEAL_DRAFT_ERROR_CODES.aborted, 'The draft request was cancelled');
  const reason: MealDraftFailureReason =
    error instanceof ServiceFailure
      ? error.reason
      : (['incomplete', 'invalid_output', 'oversized', 'provider_unavailable', 'ungrounded_output'] as const).find((value) => value === outcome) ??
        'provider_error';
  return new ApiError(502, MEAL_DRAFT_ERROR_CODES.failed, 'No draft could be made from this text', { reason });
}

function fieldCounts(audit: GroundingAudit | null): Record<string, number> {
  const counts = { abstainedFields: 0, notStatedFields: 0, proposedFields: 0, withheldFields: 0 };
  for (const disposition of Object.values(audit?.fields ?? {})) {
    if (disposition === 'proposed') counts.proposedFields += 1;
    else if (disposition === 'not_stated') counts.notStatedFields += 1;
    else if (disposition === 'model_abstained') counts.abstainedFields += 1;
    else counts.withheldFields += 1;
  }
  return counts;
}

export class MealDraftService {
  readonly #options: MealDraftServiceOptions;

  public constructor(options: MealDraftServiceOptions) {
    this.#options = options;
  }

  public get model(): string {
    return this.#options.provider.model;
  }

  public async propose(request: MealDraftRequest): Promise<GroundedProposal> {
    const { admission, clock, logger, metrics, provider } = this.#options;
    const startedAt = clock.monotonicNow();
    let outcome: MealDraftOutcome = 'provider_error';
    let audit: GroundingAudit | null = null;

    try {
      if (request.signal.aborted) {
        outcome = 'aborted';
        throw new RequestInterrupted('aborted');
      }

      let ticket: AdmissionTicket;
      try {
        ticket = admission.admit(request.userId);
      } catch (error) {
        if (error instanceof AdmissionRejectedError) outcome = `rejected_${error.reason}`;
        throw error;
      }

      let answer: LlmStructuredResult;
      try {
        answer = await this.#run(request, ticket);
      } catch (error) {
        outcome = error instanceof RequestInterrupted ? error.reason : providerFailure(error);
        throw error;
      }

      const wire = mealDraftWireSchema.safeParse(answer.value);
      if (!wire.success) {
        outcome = 'invalid_output';
        throw new ServiceFailure('invalid_output');
      }

      let grounded;
      try {
        grounded = groundMealDraft(request.text.trim(), wire.data);
      } catch (error) {
        if (error instanceof UngroundedOutputError) {
          outcome = 'ungrounded_output';
          throw new ServiceFailure('ungrounded_output');
        }
        throw error;
      }
      audit = grounded.audit;

      try {
        await request.revalidate();
      } catch (error) {
        outcome = 'access_lost';
        throw error;
      }
      outcome = grounded.proposal.outcome;
      return grounded.proposal;
    } catch (error) {
      throw toError(outcome, error);
    } finally {
      const durationMs = Math.max(0, Math.round(clock.monotonicNow() - startedAt));
      const answered = outcome === 'draft' || outcome === 'clarify' || outcome === 'unsupported';
      const counts = fieldCounts(audit);
      const fields = {
        durationMs,
        model: provider.model,
        outcome,
        requestId: request.requestId,
        ...(audit?.fields ? counts : {}),
        ...(audit?.multipleMealsOverride ? { multipleMealsOverride: true } : {}),
      };
      if (answered) logger.info('meal_draft.proposal', fields);
      else logger.warn('meal_draft.proposal', fields);
      metrics?.requests.inc({ outcome });
      metrics?.durationSeconds.observe({ outcome }, durationMs / 1_000);
      if (audit?.fields && answered) {
        for (const disposition of Object.values(audit.fields)) metrics?.fields.inc({ disposition });
      }
    }
  }

  /**
   * Starts the one provider call and waits for it for as long as the REQUEST may. The ticket is released only when the
   * provider's own promise settles, never on a timer and never when the request gives up.
   */
  async #run(request: MealDraftRequest, ticket: AdmissionTicket): Promise<LlmStructuredResult> {
    const { clock, logger, maxOutputTokens, provider, timeoutMs } = this.#options;
    const controller = new AbortController();

    // Nothing has reached the provider yet, so a failure to build its input is refunded.
    let input: LlmStructuredInput;
    try {
      input = buildMealDraftMessages(request.text);
    } catch (error) {
      ticket.release({ dispatched: false });
      throw error;
    }

    const dispatchedAt = clock.monotonicNow();
    let call: Promise<LlmStructuredResult>;
    try {
      call = Promise.resolve(
        provider.generateStructured(input, mealDraftWireJsonSchema, { maxOutputTokens, signal: controller.signal, timeoutMs }),
      );
    } catch (error) {
      // Called, so the allowance stays charged; no promise exists, so nothing is outstanding.
      ticket.release({ dispatched: true });
      throw error;
    }

    let requestEnded = false;
    const settled = (reason: 'fulfilled' | 'rejected'): void => {
      ticket.release({ dispatched: true });
      if (requestEnded) {
        logger.info('meal_draft.operation_settled', {
          durationMs: Math.max(0, Math.round(clock.monotonicNow() - dispatchedAt)),
          model: provider.model,
          reason,
          requestId: request.requestId,
        });
      }
    };
    const operation = call.then(
      (answer) => {
        settled('fulfilled');
        return answer;
      },
      (error: unknown) => {
        settled('rejected');
        throw error;
      },
    );
    operation.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClientAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = clock.setTimeout(() => {
        reject(new RequestInterrupted('timeout'));
        controller.abort();
      }, timeoutMs);
      onClientAbort = () => {
        reject(new RequestInterrupted('aborted'));
        controller.abort();
      };
      request.signal.addEventListener('abort', onClientAbort, { once: true });
    });
    interrupted.catch(() => undefined);

    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      requestEnded = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      if (onClientAbort !== undefined) request.signal.removeEventListener('abort', onClientAbort);
      // A cancellation request, not a termination: a provider may ignore it, and then its place stays taken.
      controller.abort();
    }
  }
}
