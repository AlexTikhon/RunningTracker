import { describe, expect, it } from 'vitest';

import { INTERPRETATION_INSTRUCTIONS } from './interpretation-prompt.js';
import { InterpreterFailure } from './interpretation-types.js';
import { OpenAiInterpreter } from './openai-interpreter.js';

const API_KEY = 'sk-test-synthetic-sentinel-key-7d41';
const input = { text: 'runs of at least 5 km last month, longest first', timeZone: 'Europe/Warsaw', today: '2026-10-15' };

const proposal = {
  clarificationReason: null,
  distanceUnit: 'km',
  fromDate: null,
  maxDistance: null,
  minDistance: '5',
  outcome: 'search',
  period: 'previous-month',
  sort: 'longest',
  toDate: null,
  unsupportedReason: null,
};

function completed(text: string, extra: Record<string, unknown> = {}) {
  return {
    created_at: 1_760_000_000,
    error: null,
    id: 'resp_synthetic',
    incomplete_details: null,
    model: 'gpt-4.1-mini',
    object: 'response',
    output: [
      {
        content: [{ annotations: [], text, type: 'output_text' }],
        id: 'msg_synthetic',
        role: 'assistant',
        status: 'completed',
        type: 'message',
      },
    ],
    status: 'completed',
    usage: {
      input_tokens: 812,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 61,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 873,
    },
    ...extra,
  };
}

interface Recorded {
  body: Record<string, unknown>;
  headers: Headers;
  method: string | undefined;
  url: string;
}

type Responder = (recorded: Recorded, signal: AbortSignal | undefined) => Promise<Response> | Response;

function transport(respond: Responder) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const recorded: Recorded = {
      body: JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>,
      headers: new Headers(init?.headers),
      method: init?.method,
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
    };
    calls.push(recorded);
    return respond(recorded, init?.signal ?? undefined);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

function create(respond: Responder, overrides: Partial<ConstructorParameters<typeof OpenAiInterpreter>[0]> = {}) {
  const { calls, fetchImpl } = transport(respond);
  const interpreter = new OpenAiInterpreter({
    apiKey: API_KEY,
    fetch: fetchImpl,
    maxOutputTokens: 800,
    maxResponseBytes: 32_768,
    model: 'gpt-4.1-mini',
    timeoutMs: 10_000,
    ...overrides,
  });
  return { calls, interpreter };
}

async function failureOf(promise: Promise<unknown>): Promise<InterpreterFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InterpreterFailure) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected an InterpreterFailure');
}

const signal = () => new AbortController().signal;

describe('OpenAI interpreter request', () => {
  it('makes one Responses API call with a strict JSON schema, no storage and nothing else', async () => {
    const { calls, interpreter } = create(() => json(completed(JSON.stringify(proposal))));
    await interpreter.interpret(input, { signal: signal() });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.url).toBe('https://api.openai.com/v1/responses');
    expect(call!.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(Object.keys(call!.body).sort()).toEqual(
      ['input', 'instructions', 'max_output_tokens', 'model', 'store', 'text'].sort(),
    );
    expect(call!.body).toMatchObject({
      instructions: INTERPRETATION_INSTRUCTIONS,
      max_output_tokens: 800,
      model: 'gpt-4.1-mini',
      store: false,
      text: { format: { name: 'run_search_interpretation', strict: true, type: 'json_schema' } },
    });
    expect(call!.body.input).toEqual([
      { content: expect.stringContaining('Europe/Warsaw') as string, role: 'developer' },
      { content: input.text, role: 'user' },
    ]);
  });

  it('sends no tools, no conversation state and no identifier', async () => {
    const { calls, interpreter } = create(() => json(completed(JSON.stringify(proposal))));
    await interpreter.interpret(input, { signal: signal() });
    const serialized = JSON.stringify(calls[0]!.body);
    for (const forbidden of ['tools', 'previous_response_id', 'conversation', 'user', 'safety_identifier', 'metadata', 'stream', 'background']) {
      expect(calls[0]!.body, forbidden).not.toHaveProperty(forbidden);
    }
    expect(serialized).not.toContain(API_KEY);
  });

  it('turns the response into a validated proposal with token usage', async () => {
    const { interpreter } = create(() => json(completed(JSON.stringify(proposal))));
    const answer = await interpreter.interpret(input, { signal: signal() });
    expect(answer.proposal).toEqual(proposal);
    expect(answer.usage).toEqual({ inputTokens: 812, outputTokens: 61 });
  });

  it('reports the configured model', () => {
    const { interpreter } = create(() => json({}));
    expect(interpreter.model).toBe('gpt-4.1-mini');
  });
});

describe('OpenAI interpreter retries', () => {
  it.each([
    ['a server error', () => json({ error: { message: 'boom' } }, 500)],
    ['a gateway error', () => json({ error: { message: 'boom' } }, 503)],
    ['a rate limit', () => json({ error: { message: 'slow down' } }, 429, { 'retry-after': '1' })],
    ['a request timeout status', () => json({ error: { message: 'slow' } }, 408)],
    ['a conflict', () => json({ error: { message: 'x' } }, 409)],
  ])('makes exactly one attempt after %s', async (_name, respond) => {
    const { calls, interpreter } = create(respond);
    await failureOf(interpreter.interpret(input, { signal: signal() }));
    expect(calls).toHaveLength(1);
  });

  it('makes exactly one attempt after a network error', async () => {
    const { calls, interpreter } = create(() => {
      throw new TypeError('fetch failed');
    });
    const failure = await failureOf(interpreter.interpret(input, { signal: signal() }));
    expect(failure.reason).toBe('provider_error');
    expect(calls).toHaveLength(1);
  });
});

describe('OpenAI interpreter failures', () => {
  it('classifies a refusal, even inside a completed response', async () => {
    const { interpreter } = create(() =>
      json(
        completed('', {
          output: [
            {
              content: [{ refusal: 'I cannot help with that.', type: 'refusal' }],
              id: 'msg',
              role: 'assistant',
              status: 'completed',
              type: 'message',
            },
          ],
        }),
      ),
    );
    const failure = await failureOf(interpreter.interpret(input, { signal: signal() }));
    expect(failure.reason).toBe('refusal');
    expect(failure.usage).toEqual({ inputTokens: 812, outputTokens: 61 });
  });

  it('classifies an incomplete response as incomplete and never parses its partial text', async () => {
    const { interpreter } = create(() =>
      json(completed('{"outcome":"sea', { incomplete_details: { reason: 'max_output_tokens' }, status: 'incomplete' })),
    );
    expect((await failureOf(interpreter.interpret(input, { signal: signal() }))).reason).toBe('incomplete');
  });

  it('classifies a content filter stop as incomplete', async () => {
    const { interpreter } = create(() =>
      json(completed('{}', { incomplete_details: { reason: 'content_filter' }, status: 'incomplete' })),
    );
    expect((await failureOf(interpreter.interpret(input, { signal: signal() }))).reason).toBe('incomplete');
  });

  it('classifies a failed response as a provider error', async () => {
    const { interpreter } = create(() =>
      json(completed('', { error: { code: 'server_error', message: 'internal details' }, output: [], status: 'failed' })),
    );
    expect((await failureOf(interpreter.interpret(input, { signal: signal() }))).reason).toBe('provider_error');
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['an object that breaks the schema', JSON.stringify({ ...proposal, outcome: 'answer' })],
    ['an object with an extra field', JSON.stringify({ ...proposal, sql: 'select 1' })],
    ['an object with a missing field', JSON.stringify({ outcome: 'search' })],
    ['an object that breaks the union rules', JSON.stringify({ ...proposal, period: null })],
    ['empty text', ''],
  ])('classifies %s as invalid output', async (_name, text) => {
    const { interpreter } = create(() => json(completed(text)));
    expect((await failureOf(interpreter.interpret(input, { signal: signal() }))).reason).toBe('invalid_output');
  });

  it('classifies a response without any message as invalid output', async () => {
    const { interpreter } = create(() => json(completed('', { output: [] })));
    expect((await failureOf(interpreter.interpret(input, { signal: signal() }))).reason).toBe('invalid_output');
  });

  it('classifies a malformed HTTP body as a provider error', async () => {
    const { interpreter } = create(() => new Response('<html>bad gateway</html>', { status: 200 }));
    const failure = await failureOf(interpreter.interpret(input, { signal: signal() }));
    expect(['provider_error', 'invalid_output']).toContain(failure.reason);
  });

  it('classifies a 429 as a provider rate limit and other statuses as provider errors', async () => {
    const limited = create(() => json({ error: { message: 'x' } }, 429));
    expect((await failureOf(limited.interpreter.interpret(input, { signal: signal() }))).reason).toBe(
      'provider_rate_limited',
    );
    for (const status of [400, 401, 403, 404, 500]) {
      const other = create(() => json({ error: { message: 'x' } }, status));
      expect((await failureOf(other.interpreter.interpret(input, { signal: signal() }))).reason, String(status)).toBe(
        'provider_error',
      );
    }
  });

  it('refuses a body that declares more than the response limit, without reading it', async () => {
    let read = false;
    const { interpreter } = create(
      () =>
        new Response(
          // highWaterMark 0: nothing is pulled until a consumer actually reads.
          new ReadableStream(
            {
              pull(controller) {
                read = true;
                controller.enqueue(new Uint8Array(10));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-length': '1000000', 'content-type': 'application/json' }, status: 200 },
        ),
      { maxResponseBytes: 4_096 },
    );
    expect((await failureOf(interpreter.interpret(input, { signal: signal() }))).reason).toBe('oversized');
    expect(read).toBe(false);
  });

  it('stops reading a body that grows past the limit without declaring it', async () => {
    let chunks = 0;
    const { interpreter } = create(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              chunks += 1;
              if (chunks > 1_000) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode('x'.repeat(1_024)));
            },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      { maxResponseBytes: 4_096 },
    );
    expect((await failureOf(interpreter.interpret(input, { signal: signal() }))).reason).toBe('oversized');
    expect(chunks).toBeLessThan(20);
  });

  it('never exposes the credential, the provider message or the response in a failure', async () => {
    const { interpreter } = create(() =>
      json({ error: { message: `Incorrect API key provided: ${API_KEY}`, type: 'invalid_request_error' } }, 401),
    );
    const failure = await failureOf(interpreter.interpret(input, { signal: signal() }));
    const rendered = `${failure.message} ${failure.stack ?? ''} ${JSON.stringify(failure)} ${String(failure.cause)}`;
    expect(rendered).not.toContain(API_KEY);
    expect(rendered).not.toContain('Incorrect API key');
  });
});

describe('OpenAI interpreter cancellation and deadline', () => {
  it('cancels the transport when the signal aborts', async () => {
    let seenSignal: AbortSignal | undefined;
    const { interpreter } = create(
      (_recorded, requestSignal) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = requestSignal;
          requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const controller = new AbortController();
    const pending = failureOf(interpreter.interpret(input, { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect((await pending).reason).toBe('aborted');
    expect(seenSignal?.aborted).toBe(true);
  });

  it('does not call the provider when the signal is already aborted', async () => {
    const { calls, interpreter } = create(() => json(completed(JSON.stringify(proposal))));
    const controller = new AbortController();
    controller.abort();
    expect((await failureOf(interpreter.interpret(input, { signal: controller.signal }))).reason).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('has its own time limit, so a transport that never answers cannot hang it', async () => {
    const { calls, interpreter } = create(
      (_recorded, requestSignal) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { timeoutMs: 50 },
    );
    const failure = await failureOf(interpreter.interpret(input, { signal: signal() }));
    expect(failure.reason).toBe('timeout');
    expect(calls).toHaveLength(1);
  });
});
