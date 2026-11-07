// The language model seen by the weekly insight (ADR-0076): one call that takes instructions and data and returns one
// JSON value that the model was asked to shape like `schema`. It does not validate the value: the caller parses it with
// the contract's Zod schema, so every provider's answers go through the same check.
//
// One call is ONE attempt: providers never retry. The generator owns the whole budget (attempts and total time), so a
// transport retry and a schema regeneration can never multiply each other.
//
// Only local providers exist: Ollama over HTTP on this machine or a private network, and a deterministic fake for
// tests. There is deliberately no adapter for an external API.

export interface LlmStructuredInput {
  system: string;
  user: string;
}

/** A JSON Schema object, passed to the provider's structured-output feature as it is. */
export type LlmJsonSchema = Readonly<Record<string, unknown>>;

export interface LlmCallOptions {
  /** Becomes the provider's output token limit. */
  maxOutputTokens: number;
  /** Cancels the call when aborted, for example at shutdown. */
  signal?: AbortSignal;
  /** Deadline of this attempt. */
  timeoutMs: number;
}

export interface LlmStructuredResult {
  /** The parsed JSON value the model answered. Unvalidated. */
  value: unknown;
}

export type LlmFailureReason =
  | 'aborted'
  | 'incomplete'
  | 'invalid_response'
  | 'oversized'
  | 'provider_error'
  | 'timeout'
  | 'unavailable';

/** An attempt that produced no JSON value. Carries a reason code and never provider text, which could echo the request. */
export class LlmProviderError extends Error {
  public constructor(
    public readonly reason: LlmFailureReason,
    /** Whether another attempt could plausibly succeed (a timeout, a 5xx, a dropped connection). */
    public readonly retryable: boolean,
  ) {
    super(`The language model call failed: ${reason}`);
    this.name = 'LlmProviderError';
  }
}

export interface LlmProvider {
  /** The model name recorded with every stored insight. */
  readonly model: string;
  generateStructured(input: LlmStructuredInput, schema: LlmJsonSchema, options: LlmCallOptions): Promise<LlmStructuredResult>;
}
