import type { RunSearchInterpretationResponse } from '@running-tracker/contracts';

import type { Clock } from '../../clock.js';
import { ApiError } from '../../http/errors.js';
import type { ApiMetrics } from '../../observability/api-metrics.js';
import type { Logger } from '../../observability/logger.js';
import { localDateOf } from '../run-search-period.js';
import {
  AdmissionRejectedError,
  type AdmissionRejection,
  type InterpretationAdmission,
} from './interpretation-admission.js';
import { normalizeProposal, ProposalRejectedError } from './interpretation-normalizer.js';
import {
  InterpreterFailure,
  type InterpreterAnswer,
  type InterpreterUsage,
  type RunSearchInterpreter,
} from './interpretation-types.js';

export interface InterpretationServiceOptions {
  admission: InterpretationAdmission;
  clock: Clock;
  interpreter: RunSearchInterpreter;
  logger: Logger;
  metrics?: ApiMetrics['interpretation'];
  /** Hard deadline for the whole provider call, response body included. */
  timeoutMs: number;
}

export interface InterpretationRequest {
  requestId: string;
  /**
   * Called after the provider answered and before anything is returned: it must throw the existing authorization
   * error if the session or the membership is gone. It runs after the provider's place was released and holds no
   * database connection while the provider works.
   */
  revalidate: () => Promise<void>;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
  text: string;
  timeZone: string;
  userId: string;
}

// Bounded vocabulary of what happened to a request: the only thing about its content that is ever logged or
// counted, and never the text, the answer or the person.
export type InterpretationOutcome =
  | 'access_lost'
  | 'aborted'
  | 'clarify'
  | 'incomplete'
  | 'invalid_output'
  | 'oversized'
  | 'provider_error'
  | 'provider_rate_limited'
  | 'refusal'
  | 'rejected_budget_exhausted'
  | 'rejected_busy'
  | 'rejected_in_progress'
  | 'rejected_rate_limited'
  | 'search'
  | 'timeout'
  | 'unsupported';

const rejectionStatus: Record<AdmissionRejection, { code: string; message: string; status: number }> = {
  budget_exhausted: {
    code: 'INTERPRETATION_BUDGET_EXHAUSTED',
    message: 'The interpretation allowance of this server is used up for now',
    status: 503,
  },
  busy: {
    code: 'INTERPRETATION_BUSY',
    message: 'The interpreter is busy; try again shortly',
    status: 503,
  },
  in_progress: {
    code: 'INTERPRETATION_IN_PROGRESS',
    message: 'An earlier interpretation of yours is still running',
    status: 429,
  },
  rate_limited: {
    code: 'INTERPRETATION_RATE_LIMITED',
    message: 'Too many interpretation requests; try again shortly',
    status: 429,
  },
};

function toError(error: unknown): ApiError {
  if (error instanceof AdmissionRejectedError) {
    const mapped = rejectionStatus[error.reason];
    return new ApiError(
      mapped.status,
      mapped.code,
      mapped.message,
      error.retryAfterMs === null
        ? undefined
        : { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) },
    );
  }
  if (error instanceof InterpreterFailure) {
    if (error.reason === 'timeout') {
      return new ApiError(504, 'INTERPRETATION_TIMEOUT', 'The interpreter did not answer in time');
    }
    if (error.reason === 'aborted') {
      return new ApiError(499, 'INTERPRETATION_ABORTED', 'The interpretation was cancelled');
    }
    return new ApiError(502, 'INTERPRETATION_FAILED', 'The interpreter could not produce an answer', {
      reason: error.reason,
    });
  }
  if (error instanceof ProposalRejectedError) {
    return new ApiError(502, 'INTERPRETATION_FAILED', 'The interpreter could not produce an answer', {
      reason: 'invalid_output',
    });
  }
  return error instanceof ApiError
    ? error
    : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred');
}

/**
 * One interpretation: admission, one provider call under a hard deadline, normalization against the search
 * contract, and a last access check before the answer leaves. It owns no HTTP and no database: the route has
 * already verified access, and `revalidate` is how it asks again.
 */
export class InterpretationService {
  readonly #options: InterpretationServiceOptions;

  public constructor(options: InterpretationServiceOptions) {
    this.#options = options;
  }

  public async interpret(request: InterpretationRequest): Promise<RunSearchInterpretationResponse> {
    const { admission, clock, interpreter, logger, metrics } = this.#options;
    const startedAt = clock.monotonicNow();
    let outcome: InterpretationOutcome = 'provider_error';
    let usage: InterpreterUsage | null = null;

    try {
      if (request.signal.aborted) {
        outcome = 'aborted';
        throw new InterpreterFailure('aborted');
      }

      let ticket;
      try {
        ticket = admission.admit(request.userId);
      } catch (error) {
        if (error instanceof AdmissionRejectedError) {
          outcome = `rejected_${error.reason}`;
        }
        throw error;
      }

      let answer: InterpreterAnswer;
      let dispatched = false;
      try {
        answer = await this.#dispatch(request, () => {
          dispatched = true;
        });
      } catch (error) {
        if (error instanceof InterpreterFailure) {
          outcome = error.reason;
          usage = error.usage;
        }
        throw error;
      } finally {
        // The place is given back as soon as the provider is done with, or given up on, and before any further
        // work. A provider that ignores cancellation can still be running; it is bounded by its own limits.
        ticket.release({ dispatched });
      }
      usage = answer.usage;

      let result: RunSearchInterpretationResponse;
      try {
        result = normalizeProposal(answer.proposal, {
          now: clock.utcNow(),
          timeZone: request.timeZone,
        });
      } catch (error) {
        outcome = 'invalid_output';
        throw error;
      }

      try {
        await request.revalidate();
      } catch (error) {
        outcome = 'access_lost';
        throw error;
      }
      outcome = result.outcome;
      return result;
    } catch (error) {
      throw toError(error);
    } finally {
      const durationMs = Math.max(0, Math.round(clock.monotonicNow() - startedAt));
      const failed = !['clarify', 'search', 'unsupported'].includes(outcome);
      const fields = {
        durationMs,
        model: interpreter.model,
        outcome,
        requestId: request.requestId,
        ...(usage?.inputTokens == null ? {} : { inputTokens: usage.inputTokens }),
        ...(usage?.outputTokens == null ? {} : { outputTokens: usage.outputTokens }),
      };
      if (failed) {
        logger.warn('run_search.interpretation', fields);
      } else {
        logger.info('run_search.interpretation', fields);
      }
      metrics?.requests.inc({ outcome });
      metrics?.durationSeconds.observe({ outcome }, durationMs / 1_000);
      if (usage?.inputTokens != null) metrics?.tokens.inc({ direction: 'input' }, usage.inputTokens);
      if (usage?.outputTokens != null) metrics?.tokens.inc({ direction: 'output' }, usage.outputTokens);
    }
  }

  async #dispatch(request: InterpretationRequest, onDispatch: () => void): Promise<InterpreterAnswer> {
    const { clock, interpreter, timeoutMs } = this.#options;
    const controller = new AbortController();

    // One promise that rejects when the deadline passes or the client leaves. It is raced against the provider
    // call, so the request ends on time even when the transport never reacts to the abort signal.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClientAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = clock.setTimeout(() => {
        reject(new InterpreterFailure('timeout'));
        controller.abort();
      }, timeoutMs);
      onClientAbort = () => {
        reject(new InterpreterFailure('aborted'));
        controller.abort();
      };
      request.signal.addEventListener('abort', onClientAbort, { once: true });
    });
    // Rejecting after the race has settled must not become an unhandled rejection.
    interrupted.catch(() => undefined);

    try {
      onDispatch();
      const call = interpreter.interpret(
        {
          text: request.text.trim(),
          timeZone: request.timeZone,
          today: localDateOf(clock.utcNow().getTime(), request.timeZone),
        },
        { signal: controller.signal },
      );
      // Same reason: a call that loses the race and fails later is not an error of this request.
      call.catch(() => undefined);
      return await Promise.race([call, interrupted]);
    } finally {
      if (timer !== undefined) {
        clock.clearTimeout(timer);
      }
      if (onClientAbort !== undefined) {
        request.signal.removeEventListener('abort', onClientAbort);
      }
      // Whatever ended the race, nothing should keep working for a request that is over.
      controller.abort();
    }
  }
}
