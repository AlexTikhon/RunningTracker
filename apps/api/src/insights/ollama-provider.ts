import { z } from 'zod';

import { boundedFetch, causedByOversizedResponse } from '../runs/interpretation/bounded-fetch.js';
import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmFailureReason,
  type LlmJsonSchema,
  type LlmProvider,
  type LlmStructuredInput,
  type LlmStructuredResult,
} from './llm-provider.js';

// Ollama's native chat API, for the weekly insight (ADR-0076). Unlike the run-search interpreter (ADR-0057), whose
// destination is fixed to loopback, the base URL is configurable so that the API can reach an Ollama service on the
// compose network; the configuration only accepts loopback, private-network or single-label destinations, never a public
// host name or address. Redirects are refused, so nothing can move the request elsewhere. A private-network destination
// is NOT the same as "this machine": the prompt (computed numbers, no notes, coordinates or identifiers) travels to
// whatever host answers on that address, in clear text unless the URL is https (ADR-0076, network boundary).

/** Fixed generation settings. `num_ctx` is explicit because Ollama silently cuts a prompt that does not fit. */
export const OLLAMA_INSIGHT_GENERATION = { numCtx: 4_096, temperature: 0, think: false } as const;

export interface OllamaProviderOptions {
  baseUrl: string;
  /** Replaces the global fetch; tests use it so that nothing can reach a network. */
  fetch?: typeof fetch;
  maxResponseBytes: number;
  model: string;
}

const count = z.number().int().nonnegative().nullish();

// Only what is relied on is required; Ollama adds fields over time. `message.thinking` is never read.
const envelopeSchema = z.looseObject({
  done: z.boolean(),
  done_reason: z.string().nullish(),
  eval_count: count,
  message: z.looseObject({ content: z.string(), role: z.literal('assistant') }),
  prompt_eval_count: count,
});

class AttemptFailure extends Error {
  public constructor(
    public readonly reason: LlmFailureReason,
    public readonly retry: boolean,
  ) {
    super(reason);
  }
}

/** One non-streaming chat request with the JSON schema as `format`; one attempt per call, never a retry. */
export class OllamaProvider implements LlmProvider {
  public readonly model: string;
  readonly #chatUrl: string;
  readonly #fetch: typeof fetch;

  public constructor(options: OllamaProviderOptions) {
    this.model = options.model;
    this.#chatUrl = new URL('/api/chat', options.baseUrl).toString();
    this.#fetch = boundedFetch(options.fetch ?? globalThis.fetch.bind(globalThis), options.maxResponseBytes);
  }

  public async generateStructured(
    input: LlmStructuredInput,
    schema: LlmJsonSchema,
    options: LlmCallOptions,
  ): Promise<LlmStructuredResult> {
    const body = JSON.stringify({
      format: schema,
      messages: [
        { content: input.system, role: 'system' },
        { content: input.user, role: 'user' },
      ],
      model: this.model,
      options: {
        num_ctx: OLLAMA_INSIGHT_GENERATION.numCtx,
        num_predict: options.maxOutputTokens,
        temperature: OLLAMA_INSIGHT_GENERATION.temperature,
      },
      stream: false,
      think: OLLAMA_INSIGHT_GENERATION.think,
    });

    // One attempt. Whether to try again, and with how much of the budget left, is the generator's decision.
    if (options.signal?.aborted) throw new LlmProviderError('aborted', false);
    try {
      return { value: await this.#attempt(body, options) };
    } catch (error) {
      const failure = error instanceof AttemptFailure ? error : new AttemptFailure('provider_error', true);
      if (options.signal?.aborted) throw new LlmProviderError('aborted', false);
      throw new LlmProviderError(failure.reason, failure.retry);
    }
  }

  async #attempt(body: string, options: LlmCallOptions): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const forward = (): void => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#chatUrl, {
          body,
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        throw this.#transportFailure(error, timedOut, options.signal);
      }
      const discard = async (): Promise<void> => {
        await response.body?.cancel().catch(() => undefined);
      };
      if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
        await discard();
        throw new AttemptFailure('provider_error', false);
      }
      if (!response.ok) {
        // The body of an error can echo the request; it is not read. 429 and 5xx are transient; 4xx (an unknown
        // model, a malformed request) will not get better by asking again.
        await discard();
        throw new AttemptFailure('provider_error', response.status === 429 || response.status >= 500);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw this.#transportFailure(error, timedOut, options.signal);
      }
      return this.#valueOf(text);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forward);
    }
  }

  #transportFailure(error: unknown, timedOut: boolean, signal: AbortSignal | undefined): AttemptFailure {
    if (causedByOversizedResponse(error)) return new AttemptFailure('oversized', false);
    if (signal?.aborted) return new AttemptFailure('aborted', false);
    if (timedOut) return new AttemptFailure('timeout', true);
    return new AttemptFailure('unavailable', true);
  }

  #valueOf(text: string): unknown {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AttemptFailure('provider_error', true);
    }
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) throw new AttemptFailure('provider_error', true);
    const envelope = parsed.data;
    if (!envelope.done || envelope.done_reason === 'length') throw new AttemptFailure('incomplete', false);
    if (envelope.done_reason !== 'stop') throw new AttemptFailure('provider_error', false);
    const used = (envelope.prompt_eval_count ?? 0) + (envelope.eval_count ?? 0);
    if (envelope.prompt_eval_count != null && used >= OLLAMA_INSIGHT_GENERATION.numCtx) {
      // The window was full, so the prompt may have been cut from the front, where the instructions are.
      throw new AttemptFailure('incomplete', false);
    }
    try {
      return JSON.parse(envelope.message.content) as unknown;
    } catch {
      // Not JSON at all: for the caller this is an answer that does not fit the schema.
      throw new AttemptFailure('invalid_response', false);
    }
  }
}
