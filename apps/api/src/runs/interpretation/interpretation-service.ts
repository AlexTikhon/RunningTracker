import type { RunSearchInterpretationResponse } from '@running-tracker/contracts';

import type { Clock } from '../../clock.js';
import { ApiError } from '../../http/errors.js';
import type { ApiMetrics } from '../../observability/api-metrics.js';
import type { Logger } from '../../observability/logger.js';
import { localDateOf } from '../run-search-period.js';
import {
  AdmissionRejectedError,
  type AdmissionRejection,
  type AdmissionTicket,
  type InterpretationAdmission,
} from './interpretation-admission.js';
import { normalizeProposal, ProposalRejectedError } from './interpretation-normalizer.js';
import {
  InterpreterFailure,
  type InterpretationInput,
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
 *
 * Two lifetimes, kept apart. The REQUEST ends at the deadline or when the client leaves, and is answered then. The
 * OPERATION (the interpreter's promise) ends when that promise settles, and only then are its admission places
 * released. So after a timeout the call may still be running and still counts against `maxConcurrent` and against
 * the person's one in-flight reservation: outstanding provider calls stay bounded by the configured limits, and an
 * interpreter that never settles keeps its place until the process restarts (fail-closed; manual search is not
 * involved). A late result is dropped: it is not normalized, not revalidated and not counted as another outcome.
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

      // The ticket now belongs to the operation, not to this request: #run hands it to the interpreter call and it
      // is released when that call settles, which on a normal answer is before the line below continues. The
      // request may end sooner (deadline, client gone) and does not release anything.
      let answer: InterpreterAnswer;
      try {
        answer = await this.#run(request, ticket);
      } catch (error) {
        if (error instanceof InterpreterFailure) {
          outcome = error.reason;
          usage = error.usage;
        }
        throw error;
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

  /**
   * Starts the one interpreter call and waits for it, for as long as the REQUEST may wait. Two lifetimes meet here
   * and are kept apart:
   *
   * - the request's ends at the deadline or when the client leaves: the promise returned rejects then, at once;
   * - the operation's ends when the interpreter's own promise settles, and only then is `ticket` released.
   *
   * An interpreter that ignores the abort signal and never settles therefore keeps its place for good. That is the
   * intended fail-closed behaviour (ADR-0057, addendum): a place is never given back on a timer while the call
   * that holds it may still be running, because that would allow more unsettled calls than the limits say.
   */
  async #run(request: InterpretationRequest, ticket: AdmissionTicket): Promise<InterpreterAnswer> {
    const { clock, interpreter, logger, timeoutMs } = this.#options;
    const controller = new AbortController();

    // Nothing has reached the interpreter yet, so a failure to build its input is refunded.
    let input: InterpretationInput;
    try {
      input = {
        text: request.text.trim(),
        timeZone: request.timeZone,
        today: localDateOf(clock.utcNow().getTime(), request.timeZone),
      };
    } catch (error) {
      ticket.release({ dispatched: false });
      throw error;
    }

    const dispatchedAt = clock.monotonicNow();
    let call: Promise<InterpreterAnswer>;
    try {
      call = Promise.resolve(interpreter.interpret(input, { signal: controller.signal }));
    } catch (error) {
      // The interpreter was called, so the allowance stays charged; no promise exists, so nothing is outstanding.
      ticket.release({ dispatched: true });
      throw error;
    }

    // The operation: the interpreter's promise, with the ticket's release attached to ITS settlement. This is the
    // only place a dispatched ticket is released, which is what makes "released exactly once" and "released before
    // any later step of the request" true.
    let requestEnded = false;
    const reportLateSettlement = (reason: 'fulfilled' | 'rejected'): void => {
      if (!requestEnded) {
        return;
      }
      // The request was answered already and has its own outcome; this only tells an operator that the place is
      // back. Bounded fields, no text, no identifiers, no provider body.
      logger.info('run_search.interpretation.operation_settled', {
        durationMs: Math.max(0, Math.round(clock.monotonicNow() - dispatchedAt)),
        model: interpreter.model,
        reason,
        requestId: request.requestId,
      });
    };
    const operation = call.then(
      (answer) => {
        ticket.release({ dispatched: true });
        reportLateSettlement('fulfilled');
        return answer;
      },
      (error: unknown) => {
        ticket.release({ dispatched: true });
        reportLateSettlement('rejected');
        throw error;
      },
    );
    // If the request stops waiting, a later failure of the operation is not an error of anything: it must not
    // become an unhandled rejection.
    operation.catch(() => undefined);

    // One promise that rejects when the deadline passes or the client leaves. It is raced against the operation,
    // so the request ends on time even when the transport never reacts to the abort signal.
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
      return await Promise.race([operation, interrupted]);
    } finally {
      // From here on the request is over, whether or not the operation is: a late settlement delivers nothing.
      requestEnded = true;
      if (timer !== undefined) {
        clock.clearTimeout(timer);
      }
      if (onClientAbort !== undefined) {
        request.signal.removeEventListener('abort', onClientAbort);
      }
      // A cancellation request, not a termination: an interpreter may ignore it, and then its place stays taken.
      controller.abort();
    }
  }
}
