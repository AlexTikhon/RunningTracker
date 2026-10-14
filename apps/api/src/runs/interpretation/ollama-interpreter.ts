import { z } from 'zod';

import { boundedFetch, causedByOversizedResponse } from './bounded-fetch.js';
import {
  buildInterpretationMessages,
  OLLAMA_INTERPRETATION_INSTRUCTIONS,
} from './interpretation-prompt.js';
import { providerProposalSchema } from './interpretation-schema.js';
import {
  ollamaOutputJsonSchema,
  ollamaWireSchema,
  proposalFromOllamaWire,
} from './ollama-output-schema.js';
import {
  InterpreterFailure,
  type InterpretationInput,
  type InterpretCallOptions,
  type InterpreterAnswer,
  type InterpreterUsage,
  type RunSearchInterpreter,
} from './interpretation-types.js';

// The destination is a constant, not a setting: this adapter talks to the Ollama on this machine and to nothing else.
// Nothing from a request, a configuration file or the environment can change it, and redirects are refused, so a
// misconfigured or hostile local service cannot send it somewhere else (ADR-0057). It is for local development and
// test only; the configuration refuses it in production.
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_CHAT_URL = `${OLLAMA_BASE_URL}/api/chat`;
const OLLAMA_VERSION_URL = `${OLLAMA_BASE_URL}/api/version`;

/**
 * The generation settings, fixed and reported with every evaluation. `numCtx` is explicit because Ollama silently
 * truncates a prompt that does not fit its context window, and the instructions are at the start of the prompt:
 * 4096 is its default, written down so that it cannot change under the adapter. Temperature 0 is what the structured
 * output documentation recommends for deterministic completions; `think: false` turns reasoning off for the models
 * that can (Qwen3), so that the answer is the final content and a thinking trace is never produced.
 */
export const OLLAMA_GENERATION = { numCtx: 4_096, temperature: 0, think: false } as const;

export interface OllamaInterpreterOptions {
  /** Replaces the global fetch. Tests use it so that no test can reach a network or a running server. */
  fetch?: typeof fetch;
  /** Becomes `num_predict`: the most tokens one answer may have, thinking included. */
  maxOutputTokens: number;
  maxResponseBytes: number;
  model: string;
  /** The adapter's own limit on its transport work. The caller's deadline is the authority. */
  timeoutMs: number;
}

const count = z.number().int().nonnegative().nullish();

// Only what is relied on is required; Ollama adds fields (timings, `created_at`, `model`, `thinking`) over time.
// `message.thinking` is deliberately not declared: it is never read, returned or logged.
const envelopeSchema = z.looseObject({
  done: z.boolean(),
  done_reason: z.string().nullish(),
  eval_count: count,
  message: z.looseObject({
    content: z.string(),
    role: z.literal('assistant'),
    tool_calls: z.array(z.unknown()).nullish(),
  }),
  prompt_eval_cached_count: count,
  prompt_eval_count: count,
});

type Envelope = z.infer<typeof envelopeSchema>;

function usageOf(envelope: Envelope): InterpreterUsage | null {
  const inputTokens = envelope.prompt_eval_count ?? null;
  const outputTokens = envelope.eval_count ?? null;
  const cachedInputTokens = envelope.prompt_eval_cached_count ?? null;
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) {
    return null;
  }
  // Ollama does not report reasoning tokens separately: not reported, never zero.
  return { cachedInputTokens, inputTokens, outputTokens, reasoningTokens: null };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// Provider error text is never kept: it can echo parts of the request, and nothing in it is needed to act.
function classify(error: unknown, state: { callerAborted: boolean; timedOut: boolean }): InterpreterFailure {
  if (error instanceof InterpreterFailure) {
    return error;
  }
  if (causedByOversizedResponse(error)) {
    return new InterpreterFailure('oversized');
  }
  if (state.callerAborted) {
    return new InterpreterFailure('aborted');
  }
  if (state.timedOut) {
    return new InterpreterFailure('timeout');
  }
  if (isAbortError(error)) {
    return new InterpreterFailure('aborted');
  }
  return new InterpreterFailure('provider_error');
}

/**
 * A local model served by Ollama's native chat API: one non-streaming request with the existing JSON Schema as
 * `format`, nothing stored by this adapter, no tools, no retries.
 *
 * Lifetime (ADR-0057, addendum): the promise this returns is the operation, and the service holds admission capacity
 * until it settles. So this adapter never settles while its own transport work (the request, or the reading of its
 * body) is still outstanding: cancellation is passed to the transport through the fetch signal and the call ends when
 * the transport does. It does not race the signal.
 */
export class OllamaInterpreter implements RunSearchInterpreter {
  public readonly model: string;
  readonly #fetch: typeof fetch;
  readonly #maxOutputTokens: number;
  readonly #timeoutMs: number;

  public constructor(options: OllamaInterpreterOptions) {
    this.model = options.model;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#timeoutMs = options.timeoutMs;
    // The size limit is enforced while the body is read: a body is never buffered whole before it is checked.
    this.#fetch = boundedFetch(options.fetch ?? globalThis.fetch.bind(globalThis), options.maxResponseBytes);
  }

  public async interpret(
    input: InterpretationInput,
    options: InterpretCallOptions,
  ): Promise<InterpreterAnswer> {
    if (options.signal.aborted) {
      throw new InterpreterFailure('aborted');
    }

    // One signal for the transport: the caller's cancellation, or this adapter's own deadline.
    const controller = new AbortController();
    let timedOut = false;
    const forward = (): void => controller.abort();
    options.signal.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    try {
      return await this.#exchange(input, controller.signal, options.signal);
    } catch (error) {
      throw classify(error, { callerAborted: options.signal.aborted, timedOut });
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', forward);
    }
  }

  async #exchange(
    input: InterpretationInput,
    transportSignal: AbortSignal,
    caller: AbortSignal,
  ): Promise<InterpreterAnswer> {
    const response = await this.#fetch(OLLAMA_CHAT_URL, {
      body: JSON.stringify(this.#payload(input)),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      // A redirect is refused below, never followed: nothing may take this request to another host.
      redirect: 'manual',
      signal: transportSignal,
    });

    const discard = async (): Promise<void> => {
      await response.body?.cancel().catch(() => undefined);
    };

    // The transport answered after the caller had stopped waiting (it ignored the cancellation): nothing is read.
    if (caller.aborted) {
      await discard();
      throw new InterpreterFailure('aborted');
    }
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      await discard();
      throw new InterpreterFailure('provider_error');
    }
    if (!response.ok) {
      // The body of an error can echo the request; it is not read.
      await discard();
      throw new InterpreterFailure(
        response.status === 429 || response.status === 503 ? 'provider_rate_limited' : 'provider_error',
      );
    }

    const text = await response.text();
    if (caller.aborted) {
      throw new InterpreterFailure('aborted');
    }
    return this.#answerOf(text);
  }

  // Ollama's own words, translated to the two roles its chat API takes: the instructions and the server's calendar
  // facts form the one system message, and the person's text is the user message, byte for byte.
  #payload(input: InterpretationInput): Record<string, unknown> {
    const messages = buildInterpretationMessages(input);
    const system = [
      OLLAMA_INTERPRETATION_INSTRUCTIONS,
      ...messages.filter((message) => message.role === 'developer').map((message) => message.content),
    ].join('\n\n');
    return {
      // The outcome-dependent wire schema, sent as `format`; it is not interpolated into the prompt.
      format: ollamaOutputJsonSchema,
      messages: [
        { content: system, role: 'system' },
        ...messages
          .filter((message) => message.role === 'user')
          .map((message) => ({ content: message.content, role: 'user' })),
      ],
      model: this.model,
      options: {
        num_ctx: OLLAMA_GENERATION.numCtx,
        num_predict: this.#maxOutputTokens,
        temperature: OLLAMA_GENERATION.temperature,
      },
      stream: false,
      think: OLLAMA_GENERATION.think,
    };
  }

  #answerOf(text: string): InterpreterAnswer {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new InterpreterFailure('invalid_output');
    }
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new InterpreterFailure('invalid_output');
    }
    const envelope = parsed.data;
    const usage = usageOf(envelope);

    if (!envelope.done) {
      throw new InterpreterFailure('incomplete', usage);
    }
    const reason = envelope.done_reason ?? null;
    if (reason === null) {
      throw new InterpreterFailure('invalid_output', usage);
    }
    if (reason === 'length') {
      // Cut by `num_predict`: whatever text there is, it is not the answer.
      throw new InterpreterFailure('incomplete', usage);
    }
    if (reason !== 'stop') {
      throw new InterpreterFailure('provider_error', usage);
    }
    if ((envelope.message.tool_calls?.length ?? 0) > 0) {
      // No tool is offered, so none can be an answer.
      throw new InterpreterFailure('invalid_output', usage);
    }
    // A prompt that filled the window may have been cut from the front, which is where the instructions are.
    if (
      usage?.inputTokens != null &&
      usage.outputTokens != null &&
      usage.inputTokens + usage.outputTokens >= OLLAMA_GENERATION.numCtx
    ) {
      throw new InterpreterFailure('incomplete', usage);
    }

    // Only the final content is the answer; the thinking trace (if any) is neither read nor returned.
    const content = envelope.message.content;
    if (content.trim() === '') {
      throw new InterpreterFailure('invalid_output', usage);
    }
    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(content);
    } catch {
      throw new InterpreterFailure('invalid_output', usage);
    }
    // Wire shape first, then the mapping into the domain's ProviderProposal, then the canonical check: the same
    // `providerProposalSchema` the OpenAI adapter's answers go through, and normalisation after it.
    const wire = ollamaWireSchema.safeParse(parsedContent);
    if (!wire.success) {
      throw new InterpreterFailure('invalid_output', usage);
    }
    const proposal = providerProposalSchema.safeParse(proposalFromOllamaWire(wire.data));
    if (!proposal.success) {
      throw new InterpreterFailure('invalid_output', usage);
    }
    return { proposal: proposal.data, usage };
  }
}

const versionSchema = z.looseObject({ version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/u) });

/**
 * The version of the local Ollama runtime, for an evaluation report. One GET to the same fixed address, no
 * redirects, a tiny bounded body. The message names the address only: whatever answered is not repeated.
 */
export async function readOllamaVersion(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const unavailable = (): Error => new Error('Ollama did not answer at 127.0.0.1:11434');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const guarded = boundedFetch(options.fetch ?? globalThis.fetch.bind(globalThis), 4_096);
    const response = await guarded(OLLAMA_VERSION_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const parsed = versionSchema.safeParse(JSON.parse(await response.text()));
    if (!parsed.success) {
      throw unavailable();
    }
    return parsed.data.version;
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
}
