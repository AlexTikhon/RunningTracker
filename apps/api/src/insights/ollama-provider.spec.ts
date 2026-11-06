import { describe, expect, it } from 'vitest';

import { LlmProviderError } from './llm-provider.js';
import { OllamaProvider } from './ollama-provider.js';

const answer = { dataGaps: [], observations: [], suggestion: 'Rest.', summary: 'Fine.' };

const envelope = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    done: true,
    done_reason: 'stop',
    eval_count: 60,
    message: { content, role: 'assistant', thinking: 'never read' },
    prompt_eval_count: 900,
    ...extra,
  });

type Step = (init: RequestInit | undefined) => Promise<Response>;

function harness(steps: Step[], baseUrl = 'http://ollama:11434') {
  const requests: { body: Record<string, unknown>; init: RequestInit | undefined; url: string }[] = [];
  const provider = new OllamaProvider({
    baseUrl,
    fetch: (url, init) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      requests.push({ body: JSON.parse(init?.body as string) as Record<string, unknown>, init, url: href });
      const step = steps.shift();
      if (!step) throw new Error('unexpected extra request');
      return step(init);
    },
    maxResponseBytes: 4_096,
    model: 'qwen2.5:3b',
  });
  return { provider, requests };
}

const ok = (body: string): Step => () => Promise.resolve(new Response(body, { status: 200 }));
const status = (code: number): Step => () => Promise.resolve(new Response('error text that may echo the prompt', { status: code }));
const refused: Step = () => Promise.reject(new TypeError('fetch failed'));
const hang: Step = (init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

const call = (provider: OllamaProvider, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  provider.generateStructured({ system: 'S', user: 'U' }, { type: 'object' }, { maxOutputTokens: 321, timeoutMs: 50, ...options });

async function failure(promise: Promise<unknown>): Promise<{ attempts: number; reason: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmProviderError) return { attempts: error.attempts, reason: error.reason };
    throw error;
  }
  throw new Error('expected a failure');
}

describe('Ollama provider (ADR-0076)', () => {
  it('sends one non-streaming chat request to the configured base URL with the schema as format', async () => {
    const { provider, requests } = harness([ok(envelope(JSON.stringify(answer)))]);
    await expect(call(provider)).resolves.toEqual({ attempts: 1, value: answer });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://ollama:11434/api/chat');
    expect(requests[0]!.init?.redirect).toBe('manual');
    expect(requests[0]!.body).toEqual({
      format: { type: 'object' },
      messages: [
        { content: 'S', role: 'system' },
        { content: 'U', role: 'user' },
      ],
      model: 'qwen2.5:3b',
      options: { num_ctx: 4096, num_predict: 321, temperature: 0 },
      stream: false,
      think: false,
    });
  });

  it('retries a timeout, a refused connection, a 5xx or a 429 exactly once', async () => {
    for (const first of [hang, refused, status(503), status(500), status(429)]) {
      const { provider, requests } = harness([first, ok(envelope(JSON.stringify(answer)))]);
      await expect(call(provider)).resolves.toEqual({ attempts: 2, value: answer });
      expect(requests).toHaveLength(2);
    }
  });

  it('stops after the one retry and reports the reason of the last attempt', async () => {
    expect(await failure(call(harness([hang, hang]).provider))).toEqual({ attempts: 2, reason: 'timeout' });
    expect(await failure(call(harness([refused, refused]).provider))).toEqual({ attempts: 2, reason: 'unavailable' });
    expect(await failure(call(harness([status(502), status(502)]).provider))).toEqual({ attempts: 2, reason: 'provider_error' });
  });

  it('does not retry a 4xx, a redirect, content that is not JSON or an answer cut by the token limit', async () => {
    expect(await failure(call(harness([status(404)]).provider))).toEqual({ attempts: 1, reason: 'provider_error' });
    const redirect: Step = () => Promise.resolve(new Response(null, { headers: { location: 'https://example.com' }, status: 302 }));
    expect(await failure(call(harness([redirect]).provider))).toEqual({ attempts: 1, reason: 'provider_error' });
    expect(await failure(call(harness([ok(envelope('not json'))]).provider))).toEqual({ attempts: 1, reason: 'invalid_response' });
    expect(await failure(call(harness([ok(envelope('{"summary":', { done_reason: 'length' }))]).provider))).toEqual({
      attempts: 1,
      reason: 'incomplete',
    });
    expect(await failure(call(harness([ok(envelope('{}', { eval_count: 100, prompt_eval_count: 4_000 }))]).provider))).toEqual({
      attempts: 1,
      reason: 'incomplete',
    });
  });

  it('refuses an oversized response without retrying', async () => {
    const big: Step = () => Promise.resolve(new Response('x'.repeat(5_000), { status: 200 }));
    expect(await failure(call(harness([big]).provider))).toEqual({ attempts: 1, reason: 'oversized' });
  });

  it('retries a malformed envelope once', async () => {
    const { provider, requests } = harness([ok('{"unexpected":true}'), ok(envelope(JSON.stringify(answer)))]);
    await expect(call(provider)).resolves.toEqual({ attempts: 2, value: answer });
    expect(requests).toHaveLength(2);
  });

  it('stops at once when the caller cancels, and makes no request when already cancelled', async () => {
    const controller = new AbortController();
    const { provider, requests } = harness([hang, ok(envelope(JSON.stringify(answer)))]);
    const pending = call(provider, { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    expect(await failure(pending)).toEqual({ attempts: 1, reason: 'aborted' });
    expect(requests).toHaveLength(1);
    const cancelled = harness([]);
    expect(await failure(call(cancelled.provider, { signal: controller.signal }))).toEqual({ attempts: 0, reason: 'aborted' });
    expect(cancelled.requests).toHaveLength(0);
  });

  it('never puts provider error text into the error', async () => {
    const error = await call(harness([status(400)]).provider).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toMatch(/echo|prompt/u);
  });
});
