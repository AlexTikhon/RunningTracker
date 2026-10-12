import OpenAI, {
  APIConnectionTimeoutError,
  APIUserAbortError,
  RateLimitError,
} from 'openai';
import type { Response as OpenAiResponse } from 'openai/resources/responses/responses';

import { boundedFetch, ResponseTooLargeError } from './bounded-fetch.js';
import {
  buildInterpretationMessages,
  INTERPRETATION_INSTRUCTIONS,
} from './interpretation-prompt.js';
import {
  INTERPRETATION_SCHEMA_NAME,
  providerOutputJsonSchema,
  providerProposalSchema,
} from './interpretation-schema.js';
import {
  InterpreterFailure,
  type InterpretationInput,
  type InterpretCallOptions,
  type InterpreterAnswer,
  type InterpreterUsage,
  type RunSearchInterpreter,
} from './interpretation-types.js';

export interface OpenAiInterpreterOptions {
  apiKey: string;
  /** Replaces the global fetch. Tests use it so that no test can reach the network. */
  fetch?: typeof fetch;
  maxOutputTokens: number;
  maxResponseBytes: number;
  model: string;
  /** The adapter's own limit, headers and body included. The caller's deadline is the authority. */
  timeoutMs: number;
}

// The SDK would otherwise read the base URL, organization, project, admin key, webhook secret and log level from the
// process environment (OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID, OPENAI_ADMIN_KEY, OPENAI_WEBHOOK_SECRET,
// OPENAI_LOG). This adapter talks to one fixed endpoint with one credential and logs nothing, whatever the
// environment of the process says. OPENAI_CUSTOM_HEADERS is the one the SDK still reads and options cannot switch
// off; it is operator-controlled configuration of the server, like the credential.
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

function usageOf(response: OpenAiResponse): InterpreterUsage | null {
  const { usage } = response;
  if (usage === undefined || usage === null) {
    return null;
  }
  return {
    inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
    outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
  };
}

// The SDK may wrap a failure that happened while reading the body; look a few levels down the cause chain.
function causedByOversizedResponse(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof ResponseTooLargeError) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

// Provider error text is never kept: it can echo parts of the request, and nothing in it is needed to act.
function classifyFailure(error: unknown): InterpreterFailure {
  if (error instanceof InterpreterFailure) {
    return error;
  }
  if (causedByOversizedResponse(error)) {
    return new InterpreterFailure('oversized');
  }
  if (error instanceof APIUserAbortError) {
    return new InterpreterFailure('aborted');
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new InterpreterFailure('timeout');
  }
  if (error instanceof RateLimitError) {
    return new InterpreterFailure('provider_rate_limited');
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new InterpreterFailure('aborted');
  }
  return new InterpreterFailure('provider_error');
}

/**
 * The real adapter: one Responses API call with a strict JSON schema, nothing stored, no tools, no retries.
 * Everything the model returns is checked again locally; a refusal, an incomplete or malformed answer is a failure,
 * never an application outcome.
 */
export class OpenAiInterpreter implements RunSearchInterpreter {
  public readonly model: string;
  readonly #client: OpenAI;
  readonly #maxOutputTokens: number;
  readonly #timeoutMs: number;

  public constructor(options: OpenAiInterpreterOptions) {
    this.model = options.model;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#timeoutMs = options.timeoutMs;
    this.#client = new OpenAI({
      adminAPIKey: null,
      apiKey: options.apiKey,
      baseURL: OPENAI_BASE_URL,
      fetch: boundedFetch(options.fetch ?? globalThis.fetch.bind(globalThis), options.maxResponseBytes),
      logLevel: 'off',
      // One accepted submission is at most one provider dispatch: the SDK's automatic retries are off.
      maxRetries: 0,
      organization: null,
      project: null,
      timeout: options.timeoutMs,
      webhookSecret: null,
    });
  }

  public async interpret(
    input: InterpretationInput,
    options: InterpretCallOptions,
  ): Promise<InterpreterAnswer> {
    if (options.signal.aborted) {
      throw new InterpreterFailure('aborted');
    }

    let response: OpenAiResponse;
    try {
      response = await this.#client.responses.create(
        {
          input: buildInterpretationMessages(input),
          instructions: INTERPRETATION_INSTRUCTIONS,
          max_output_tokens: this.#maxOutputTokens,
          model: this.model,
          // Disabling storage is a request not to retain the response; it is not a zero-data-retention claim.
          store: false,
          text: {
            format: {
              name: INTERPRETATION_SCHEMA_NAME,
              schema: providerOutputJsonSchema,
              strict: true,
              type: 'json_schema',
            },
          },
        },
        { maxRetries: 0, signal: options.signal, timeout: this.#timeoutMs },
      );
    } catch (error) {
      throw classifyFailure(error);
    }
    return this.#answerOf(response);
  }

  #answerOf(response: OpenAiResponse): InterpreterAnswer {
    const usage = usageOf(response);

    if (response.status === 'incomplete') {
      throw new InterpreterFailure('incomplete', usage);
    }
    if (response.status === 'failed' || response.status === 'cancelled' || response.error) {
      throw new InterpreterFailure('provider_error', usage);
    }

    const texts: string[] = [];
    for (const item of response.output ?? []) {
      if (item.type !== 'message') {
        // Any other item (a tool call, reasoning) is not something this request can produce or accept.
        continue;
      }
      for (const part of item.content) {
        if (part.type === 'refusal') {
          throw new InterpreterFailure('refusal', usage);
        }
        if (part.type === 'output_text') {
          texts.push(part.text);
        }
      }
    }
    if (texts.length !== 1 || texts[0]!.trim() === '') {
      throw new InterpreterFailure('invalid_output', usage);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(texts[0]!);
    } catch {
      throw new InterpreterFailure('invalid_output', usage);
    }
    const proposal = providerProposalSchema.safeParse(parsed);
    if (!proposal.success) {
      throw new InterpreterFailure('invalid_output', usage);
    }
    return { proposal: proposal.data, usage };
  }
}
