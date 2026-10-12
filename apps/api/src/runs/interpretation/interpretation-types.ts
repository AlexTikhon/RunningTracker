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
  /** Aborted when the request is cancelled or its deadline passes. A transport may still ignore it. */
  signal: AbortSignal;
}

/** One request in, one answer out. Implementations make at most one provider call and never retry. */
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
