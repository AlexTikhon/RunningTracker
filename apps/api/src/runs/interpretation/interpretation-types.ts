import type { RunSearchInterpretationFailureReason } from '@running-tracker/contracts';

import type { ProviderProposal } from './interpretation-schema.js';

/** Everything the interpreter is given: the person's words and two facts the server derived. */
export interface InterpretationInput {
  text: string;
  /** The person's validated IANA zone. */
  timeZone: string;
  /** The server clock's date in `timeZone`, YYYY-MM-DD. */
  today: string;
}

export interface InterpreterUsage {
  /** Input tokens served from the provider's prompt cache; they are part of `inputTokens`. */
  cachedInputTokens?: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tokens spent on hidden reasoning; they are part of `outputTokens` and count against `max_output_tokens`. */
  reasoningTokens?: number | null;
}

export interface InterpreterAnswer {
  proposal: ProviderProposal;
  usage: InterpreterUsage | null;
}

export interface InterpretCallOptions {
  /**
   * Aborted when the request is cancelled or its deadline passes, and again once the request is over. It is a
   * cancellation REQUEST, not proof of termination: a transport may ignore it, and the service keeps the
   * operation's places until the returned promise settles whatever the signal did.
   */
  signal: AbortSignal;
}

/**
 * One request in, one answer out. Implementations make at most one provider call and never retry.
 *
 * Lifetime contract. The promise returned by `interpret` IS the operation: the service holds one global
 * concurrency place and the person's single in-flight reservation until that promise resolves or rejects, and for no
 * shorter time, however the HTTP request ends. An implementation must therefore:
 *
 * - settle its promise (resolve or reject) once the underlying work has finished or has been given up on, and not
 *   settle it early while work it started may still be running, because the places are released on settlement;
 * - treat `signal` as a request to stop, and settle promptly when it aborts; ignoring it is allowed but then the
 *   places stay taken until the promise settles on its own, so bound the call with its own transport timeout;
 * - never throw synchronously for an operational failure (return a rejected promise), though a synchronous throw is
 *   handled as a failed, already-settled operation;
 * - carry no provider text in a rejection that is not an `InterpreterFailure`; the service only treats it as a
 *   failure and never logs or returns its message.
 *
 * A promise that never settles keeps its places for good (until the process restarts): that is intentional,
 * fail-closed behaviour, and manual search is unaffected. What the service can know is bounded by this promise: it
 * does not know whether a remote provider stopped computing, only that the local call settled.
 */
export interface RunSearchInterpreter {
  interpret(input: InterpretationInput, options: InterpretCallOptions): Promise<InterpreterAnswer>;
  /** The configured model, for operational metadata. */
  readonly model: string;
}

export type InterpreterFailureReason = RunSearchInterpretationFailureReason | 'aborted' | 'timeout';

/** An interpreter could not produce an answer. Carries a bounded reason and never the provider's text. */
export class InterpreterFailure extends Error {
  public constructor(
    public readonly reason: InterpreterFailureReason,
    public readonly usage: InterpreterUsage | null = null,
  ) {
    super(`Interpretation failed: ${reason}`);
    this.name = 'InterpreterFailure';
  }
}
