import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from '../../clock.js';
import { createLogger } from '../../observability/logger.js';
import { InterpretationAdmission } from './interpretation-admission.js';
import { INTERPRETATION_INSTRUCTIONS } from './interpretation-prompt.js';
import { providerOutputJsonSchema, type ProviderProposal } from './interpretation-schema.js';
import { InterpretationService } from './interpretation-service.js';
import { InterpreterFailure, type InterpretationInput } from './interpretation-types.js';
import {
  OLLAMA_CHAT_URL,
  OLLAMA_GENERATION,
  OllamaInterpreter,
  readOllamaVersion,
  type OllamaInterpreterOptions,
} from './ollama-interpreter.js';

const SENTINEL_TEXT = 'SENTINEL-PRIVATE-ADDRESS-4f8c';
const SENTINEL_THOUGHT = 'SENTINEL-THINKING-TRACE-77d1';
const MAX_BYTES = 8_192;

const input: InterpretationInput = {
  text: `runs of at least 5 km last month, longest first ${SENTINEL_TEXT}`,
  timeZone: 'Europe/Warsaw',
  today: '2026-10-15',
};

const search: ProviderProposal = {
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

const clarify: ProviderProposal = {
  ...search,
  clarificationReason: 'distance_boundary_strict',
  distanceUnit: null,
  minDistance: null,
  outcome: 'clarify',
  period: null,
  sort: null,
};

const unsupported: ProviderProposal = {
  ...clarify,
  clarificationReason: null,
  outcome: 'unsupported',
  unsupportedReason: 'location',
};

// What Ollama's /api/chat answers with stream:false, in the fields this adapter relies on.
function envelope(overrides: Record<string, unknown> = {}, content: unknown = search): Record<string, unknown> {
  return {
    created_at: '2026-10-15T12:00:00.000Z',
    done: true,
    done_reason: 'stop',
    eval_count: 41,
    eval_duration: 900_000_000,
    load_duration: 1_000_000,
    message: { content: typeof content === 'string' ? content : JSON.stringify(content), role: 'assistant' },
    model: 'qwen3:8b',
    prompt_eval_count: 1_300,
    prompt_eval_duration: 400_000_000,
    total_duration: 2_000_000_000,
    ...overrides,
  };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
    ...init,
  });

type Transport = (url: string, init: RequestInit) => Promise<Response>;

function recording(handler: Transport) {
  const calls: Array<{ init: RequestInit; url: string }> = [];
  const transport = ((url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ init: init ?? {}, url: target });
    return handler(target, init ?? {});
  }) as typeof fetch;
  return { calls, transport };
}

function adapter(handler: Transport, overrides: Partial<OllamaInterpreterOptions> = {}) {
  const { calls, transport } = recording(handler);
  const interpreter = new OllamaInterpreter({
    fetch: transport,
    maxOutputTokens: 800,
    maxResponseBytes: MAX_BYTES,
    model: 'qwen3:8b',
    timeoutMs: 10_000,
    ...overrides,
  });
  return { calls, interpreter };
}

const answers = (body: unknown = envelope()): Transport => () => Promise.resolve(json(body));

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

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(new DOMException('The operation was aborted', 'AbortError'));
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('ollama interpreter: the request', () => {
  it('sends one non-streaming chat request to the fixed loopback address with the existing schema and words', async () => {
    const { calls, interpreter } = adapter(answers());
    await interpreter.interpret(input, { signal: new AbortController().signal });

    expect(calls).toHaveLength(1);
    expect(OLLAMA_CHAT_URL).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]!.init.method).toBe('POST');
    // A redirect is a refusal, never something to follow to another host.
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['format', 'messages', 'model', 'options', 'stream', 'think']);
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, think: false });
    // The exact schema the OpenAI adapter sends, not a copy of it.
    expect(body.format).toEqual(JSON.parse(JSON.stringify(providerOutputJsonSchema)));
    expect(body.options).toEqual({ num_ctx: 4_096, num_predict: 800, temperature: 0 });
    expect(OLLAMA_GENERATION).toEqual({ numCtx: 4_096, temperature: 0, think: false });
  });

  it('maps the instructions and calendar facts to one system message and the text, byte for byte, to the user', async () => {
    const { calls, interpreter } = adapter(answers());
    await interpreter.interpret(input, { signal: new AbortController().signal });

    const { messages } = JSON.parse(calls[0]!.init.body as string) as {
      messages: Array<{ content: string; role: string }>;
    };
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]!.content.startsWith(INTERPRETATION_INSTRUCTIONS)).toBe(true);
    expect(messages[0]!.content).toContain('Time zone: Europe/Warsaw');
    expect(messages[0]!.content).toContain('2026-10-15');
    expect(messages[1]!.content).toBe(input.text);
    // The person's words are data: never interpolated into the instructions.
    expect(messages[0]!.content).not.toContain(SENTINEL_TEXT);
  });

  it('offers no tools, no images, no keep-alive override and no credential or identity', async () => {
    const { calls, interpreter } = adapter(answers());
    await interpreter.interpret(input, { signal: new AbortController().signal });
    const sent = `${JSON.stringify(calls[0]!.init.headers)}${calls[0]!.init.body as string}`;
    for (const forbidden of ['tools', 'tool_calls', 'images', 'keep_alive', 'authorization', 'cookie', 'userId', 'orgId']) {
      expect(sent.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it('bounds generation by the configured output limit', async () => {
    const { calls, interpreter } = adapter(answers(), { maxOutputTokens: 300 });
    await interpreter.interpret(input, { signal: new AbortController().signal });
    const body = JSON.parse(calls[0]!.init.body as string) as { options: Record<string, number> };
    expect(body.options.num_predict).toBe(300);
  });
});

describe('ollama interpreter: answers', () => {
  it.each([
    ['search', search],
    ['clarify', clarify],
    ['unsupported', unsupported],
  ])('returns a valid %s proposal', async (_name, proposal) => {
    const { interpreter } = adapter(answers(envelope({}, proposal)));
    const result = await interpreter.interpret(input, { signal: new AbortController().signal });
    expect(result.proposal).toEqual(proposal);
  });

  it('maps the usage Ollama reports and leaves what it does not report null', async () => {
    const full = adapter(answers(envelope({ prompt_eval_cached_count: 1_000 })));
    expect((await full.interpreter.interpret(input, { signal: new AbortController().signal })).usage).toEqual({
      cachedInputTokens: 1_000,
      inputTokens: 1_300,
      outputTokens: 41,
      reasoningTokens: null,
    });

    const partial = adapter(answers(envelope({ eval_count: undefined })));
    expect((await partial.interpreter.interpret(input, { signal: new AbortController().signal })).usage).toEqual({
      cachedInputTokens: null,
      inputTokens: 1_300,
      outputTokens: null,
      reasoningTokens: null,
    });

    const none = adapter(answers(envelope({ eval_count: undefined, prompt_eval_count: undefined })));
    expect((await none.interpreter.interpret(input, { signal: new AbortController().signal })).usage).toBeNull();
  });

  it('never exposes the thinking trace, and takes the answer from the final content only', async () => {
    const withTrace = adapter(
      answers({
        ...envelope(),
        message: { content: JSON.stringify(search), role: 'assistant', thinking: SENTINEL_THOUGHT },
      }),
    );
    const result = await withTrace.interpreter.interpret(input, { signal: new AbortController().signal });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_THOUGHT);

    // A valid answer that only appears in the trace is not an answer.
    const traceOnly = adapter(
      answers({
        ...envelope(),
        message: { content: '', role: 'assistant', thinking: JSON.stringify(search) },
      }),
    );
    const failure = await failureOf(traceOnly.interpreter.interpret(input, { signal: new AbortController().signal }));
    expect(failure.reason).toBe('invalid_output');
    expect(JSON.stringify(failure)).not.toContain('previous-month');
  });
});

describe('ollama interpreter: output that cannot be used is a provider failure', () => {
  const run = (handler: Transport) =>
    adapter(handler).interpreter.interpret(input, { signal: new AbortController().signal });

  it.each([
    ['content that is not JSON', envelope({}, 'Sure! Here are your filters')],
    ['content cut in the middle of the object', envelope({}, '{"outcome":"search","period":"previous-mon')],
    ['content with a code fence around the object', envelope({}, `\`\`\`json\n${JSON.stringify(search)}\n\`\`\``)],
    ['empty content', envelope({}, '')],
    ['an array instead of the object', envelope({}, [search])],
    ['an extra field', envelope({}, { ...search, timeZone: 'UTC' })],
    ['a value outside the enumeration', envelope({}, { ...search, sort: 'oldest' })],
    ['a search without a period', envelope({}, { ...search, period: null })],
    ['a clarification that proposes filters', envelope({}, { ...clarify, sort: 'longest' })],
  ])('maps %s to invalid_output, not to an unsupported answer', async (_name, body) => {
    const failure = await failureOf(run(answers(body)));
    expect(failure).toBeInstanceOf(InterpreterFailure);
    expect(failure.reason).toBe('invalid_output');
  });

  it.each([
    ['a body that is not JSON', '<html>proxy error</html>'],
    ['a JSON array', '[]'],
    ['an envelope without a message', JSON.stringify({ done: true, done_reason: 'stop' })],
    ['an envelope with the wrong role', JSON.stringify(envelope({ message: { content: '{}', role: 'user' } }))],
    ['a message without content', JSON.stringify(envelope({ message: { role: 'assistant' } }))],
    ['a done flag that is not a boolean', JSON.stringify(envelope({ done: 'yes' }))],
    ['a token count that is not a number', JSON.stringify(envelope({ eval_count: 'many' }))],
    ['no completion reason', JSON.stringify(envelope({ done_reason: undefined }))],
    ['a tool call nobody asked for', JSON.stringify(envelope({ message: { content: JSON.stringify(search), role: 'assistant', tool_calls: [{ function: { name: 'x' } }] } }))],
  ])('maps %s to invalid_output', async (_name, body) => {
    const failure = await failureOf(run(() => Promise.resolve(json(body))));
    expect(failure.reason).toBe('invalid_output');
  });

  it('maps output cut by the generation limit to incomplete and keeps the reported usage', async () => {
    const failure = await failureOf(
      run(answers(envelope({ done_reason: 'length' }, '{"outcome":"search","period":"previous-mon'))),
    );
    expect(failure.reason).toBe('incomplete');
    expect(failure.usage).toEqual({
      cachedInputTokens: null,
      inputTokens: 1_300,
      outputTokens: 41,
      reasoningTokens: null,
    });
  });

  it('maps an unfinished response and an unknown completion reason to failures', async () => {
    expect((await failureOf(run(answers(envelope({ done: false })))))?.reason).toBe('incomplete');
    expect((await failureOf(run(answers(envelope({ done_reason: 'unload' })))))?.reason).toBe('provider_error');
  });

  it('treats a prompt that filled the context window as incomplete: the instructions may have been cut', async () => {
    const failure = await failureOf(
      run(answers(envelope({ eval_count: 20, prompt_eval_count: OLLAMA_GENERATION.numCtx }))),
    );
    expect(failure.reason).toBe('incomplete');
  });

  it('never puts provider text in a failure', async () => {
    const failure = await failureOf(run(answers(envelope({}, `not json ${SENTINEL_TEXT}`))));
    expect(JSON.stringify([failure.message, failure.reason, failure.usage])).not.toContain(SENTINEL_TEXT);
  });
});

describe('ollama interpreter: transport failures', () => {
  const run = (handler: Transport, signal = new AbortController().signal) => {
    const built = adapter(handler);
    return { ...built, result: built.interpreter.interpret(input, { signal }) };
  };

  it('maps a refused connection to provider_error after exactly one attempt', async () => {
    const { calls, result } = run(() => Promise.reject(new TypeError('fetch failed')));
    expect((await failureOf(result)).reason).toBe('provider_error');
    expect(calls).toHaveLength(1);
  });

  it.each([
    [404, 'provider_error'],
    [500, 'provider_error'],
    [400, 'provider_error'],
    [429, 'provider_rate_limited'],
    [503, 'provider_rate_limited'],
  ])('maps HTTP %i to %s without reading the body', async (status, reason) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        controller.enqueue(bytes(`{"error":"model echo ${SENTINEL_TEXT}"}`));
      },
    });
    const { calls, result } = run(() => Promise.resolve(new Response(body, { status })));
    const failure = await failureOf(result);
    expect(failure.reason).toBe(reason);
    expect(JSON.stringify(failure)).not.toContain(SENTINEL_TEXT);
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each([301, 302, 307, 308])(
    'refuses a %i redirect instead of following it, and makes no second request',
    async (status) => {
      const { calls, result } = run(() =>
        Promise.resolve(
          new Response(null, { headers: { location: 'https://api.openai.com/v1/responses' }, status }),
        ),
      );
      const failure = await failureOf(result);
      expect(failure.reason).toBe('provider_error');
      expect(calls).toHaveLength(1);
      expect(calls.map((call) => call.url)).toEqual([OLLAMA_CHAT_URL]);
    },
  );

  it('never falls back to another provider after a failure', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network must not be used'));
    const { result } = run(() => Promise.reject(new TypeError('fetch failed')));
    await failureOf(result);
    expect(outbound).not.toHaveBeenCalled();
    outbound.mockRestore();
  });
});

describe('ollama interpreter: response size', () => {
  const run = (handler: Transport) =>
    adapter(handler).interpreter.interpret(input, { signal: new AbortController().signal });

  it('refuses a declared length over the limit before reading a byte', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulled += 1;
        controller.enqueue(bytes('x'));
      },
    });
    const failure = await failureOf(
      run(() => Promise.resolve(new Response(body, { headers: { 'content-length': String(MAX_BYTES + 1) } }))),
    );
    expect(failure.reason).toBe('oversized');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('cuts a body that grows past the limit while it is being read', async () => {
    let pulled = 0;
    const chunk = bytes('x'.repeat(1_024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 10_000) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const failure = await failureOf(run(() => Promise.resolve(new Response(body))));
    expect(failure.reason).toBe('oversized');
    // Nowhere near the whole (unbounded) body was buffered.
    expect(pulled).toBeLessThan(40);
  });
});

describe('ollama interpreter: cancellation and lifetime', () => {
  it('does not call the transport for a request that is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, interpreter } = adapter(answers());
    const failure = await failureOf(interpreter.interpret(input, { signal: controller.signal }));
    expect(failure.reason).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('passes cancellation to the transport and settles as aborted while waiting for headers', async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const { interpreter } = adapter((_url, init) => {
      transportSignal = init.signal ?? undefined;
      return abortedBy(init.signal!);
    });
    const pending = failureOf(interpreter.interpret(input, { signal: controller.signal }));
    await flush();
    expect(transportSignal?.aborted).toBe(false);

    controller.abort();
    expect((await pending).reason).toBe('aborted');
    expect(transportSignal?.aborted).toBe(true);
  });

  it('passes cancellation through the body read and settles as aborted', async () => {
    const controller = new AbortController();
    const { interpreter } = adapter((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(bytes('{"done":'));
          init.signal!.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const pending = failureOf(interpreter.interpret(input, { signal: controller.signal }));
    await flush();
    controller.abort();
    expect((await pending).reason).toBe('aborted');
  });

  it('applies its own deadline to the transport and reports a timeout', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const built = adapter(
      (_url, init) => {
        transportSignal = init.signal ?? undefined;
        return abortedBy(init.signal!);
      },
      { timeoutMs: 5_000 },
    );
    const pending = failureOf(built.interpreter.interpret(input, { signal: new AbortController().signal }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(transportSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).reason).toBe('timeout');
    expect(transportSignal?.aborted).toBe(true);
  });

  it('does not settle while a transport that ignores cancellation is still working, then reports aborted', async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void;
    const { interpreter } = adapter(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const pending = interpreter.interpret(input, { signal: controller.signal }).then(
      () => {
        settled = true;
        return 'answer';
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await flush();
    controller.abort();
    await flush();
    await flush();
    // Its own transport work is outstanding, so it has not settled for the caller either.
    expect(settled).toBe(false);

    release(json(envelope()));
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(InterpreterFailure);
    expect((outcome as InterpreterFailure).reason).toBe('aborted');
  });

  it('keeps the service holding admission capacity while an uncooperative local call is pending', async () => {
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const clock: Clock = {
      clearTimeout: (handle) => {
        timers.delete(handle as unknown as number);
      },
      monotonicNow: () => 1_000,
      setTimeout: (callback) => {
        timers.set(nextTimer, callback);
        nextTimer += 1;
        return (nextTimer - 1) as unknown as ReturnType<typeof setTimeout>;
      },
      utcNow: () => new Date('2026-10-15T12:00:00.000Z'),
    };
    const admission = new InterpretationAdmission({
      allowance: { perWindow: 1_000, windowMs: 86_400_000 },
      clock,
      maxConcurrent: 1,
      maxUsers: 100,
      userRate: { perWindow: 1_000, windowMs: 60_000 },
    });

    let started = 0;
    let release!: (response: Response) => void;
    const { interpreter } = adapter(
      () => {
        started += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
      // The adapter's own limit is irrelevant here: the service's deadline is the authority.
      { timeoutMs: 60_000 },
    );
    const service = new InterpretationService({
      admission,
      clock,
      interpreter,
      logger: createLogger({ clock, write: () => undefined }),
      timeoutMs: 10_000,
    });
    const request = (userId: string) => ({
      requestId: '99999999-9999-4999-8999-999999999999',
      revalidate: () => Promise.resolve(),
      signal: new AbortController().signal,
      text: 'runs last month',
      timeZone: 'Europe/Warsaw',
      userId,
    });
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';

    const pending = service.interpret(request(first)).catch((error: unknown) => error);
    await flush();
    expect(started).toBe(1);

    // The request's deadline passes: it is answered, but the local call has not settled.
    for (const fire of [...timers.values()]) fire();
    expect(await pending).toMatchObject({ code: 'INTERPRETATION_TIMEOUT', statusCode: 504 });

    const refused = await service.interpret(request(second)).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'INTERPRETATION_BUSY', statusCode: 503 });
    expect(started).toBe(1);

    // When the local call finally settles, capacity returns, exactly once.
    release(json(envelope()));
    await flush();
    await flush();
    const again = service.interpret(request(second)).catch((error: unknown) => error);
    await flush();
    // Admitted and dispatched: the place was given back, once, by the settlement of the first local call.
    expect(started).toBe(2);
    for (const fire of [...timers.values()]) fire();
    expect(await again).toMatchObject({ code: 'INTERPRETATION_TIMEOUT' });
    // Tidy up the second, deliberately uncooperative, call so that no timer or promise outlives the test.
    release(json(envelope()));
    await flush();
  });
});

describe('ollama runtime version', () => {
  it('reads the version from the fixed local address without following redirects', async () => {
    const { calls, transport } = recording(() => Promise.resolve(json({ version: '0.35.1' })));
    await expect(readOllamaVersion({ fetch: transport })).resolves.toBe('0.35.1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/version');
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('fails with a message that names the address only', async () => {
    const unreachable = recording(() => Promise.reject(new TypeError('fetch failed')));
    await expect(readOllamaVersion({ fetch: unreachable.transport })).rejects.toThrow(
      'Ollama did not answer at 127.0.0.1:11434',
    );
    const odd = recording(() => Promise.resolve(json({ version: `0.1 ${SENTINEL_TEXT}` })));
    await expect(readOllamaVersion({ fetch: odd.transport })).rejects.toThrow('Ollama did not answer');
  });
});
