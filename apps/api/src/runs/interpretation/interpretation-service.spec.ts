import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../../clock.js';
import { ApiError } from '../../http/errors.js';
import { createLogger } from '../../observability/logger.js';
import { InterpretationAdmission } from './interpretation-admission.js';
import { InterpretationService, type InterpretationRequest } from './interpretation-service.js';
import type { ProviderProposal } from './interpretation-schema.js';
import {
  InterpreterFailure,
  type InterpretationInput,
  type InterpretCallOptions,
  type InterpreterAnswer,
  type RunSearchInterpreter,
} from './interpretation-types.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SENTINEL_TEXT = 'SENTINEL-PRIVATE-ADDRESS-4f8c';

class TestClock implements Clock {
  public nowMs = Date.parse('2026-10-15T12:00:00.000Z');

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return this.nowMs;
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.nowMs);
  }
}

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

type Behaviour = (input: InterpretationInput, options: InterpretCallOptions) => Promise<InterpreterAnswer>;

class ScriptedInterpreter implements RunSearchInterpreter {
  public readonly model = 'test-model';
  public calls: Array<{ input: InterpretationInput; signal: AbortSignal }> = [];

  public constructor(private readonly behaviour: Behaviour) {}

  public interpret(input: InterpretationInput, options: InterpretCallOptions): Promise<InterpreterAnswer> {
    this.calls.push({ input, signal: options.signal });
    return this.behaviour(input, options);
  }
}

const answer = (proposal: ProviderProposal = search): Behaviour => () =>
  Promise.resolve({ proposal, usage: { inputTokens: 700, outputTokens: 40 } });

// Ignores cancellation completely, like a transport that does not honour AbortSignal.
const hangsForever: Behaviour = () => new Promise(() => undefined);

function setup(
  behaviour: Behaviour,
  options: { allowance?: number; timeoutMs?: number; maxConcurrent?: number } = {},
) {
  const clock = new TestClock();
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    clock,
    write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const interpreter = new ScriptedInterpreter(behaviour);
  const admission = new InterpretationAdmission({
    allowance: { perWindow: options.allowance ?? 100, windowMs: 86_400_000 },
    clock,
    maxConcurrent: options.maxConcurrent ?? 4,
    maxUsers: 100,
    userRate: { perWindow: 50, windowMs: 60_000 },
  });
  const service = new InterpretationService({
    admission,
    clock,
    interpreter,
    logger,
    timeoutMs: options.timeoutMs ?? 40,
  });
  return { admission, clock, interpreter, lines, service };
}

function request(overrides: Partial<InterpretationRequest> = {}): InterpretationRequest {
  return {
    requestId: '99999999-9999-4999-8999-999999999999',
    revalidate: () => Promise.resolve(),
    signal: new AbortController().signal,
    text: 'runs of at least 5 km last month, longest first',
    timeZone: 'Europe/Warsaw',
    userId: USER,
    ...overrides,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected an ApiError');
}

describe('interpretation service: answers', () => {
  it('returns the normalized proposal and gives the interpreter only text, zone and local date', async () => {
    const { interpreter, service } = setup(answer());
    const result = await service.interpret(request());

    expect(result).toEqual({
      filters: {
        distanceUnit: 'km',
        maxDistance: null,
        minDistance: '5',
        period: { kind: 'preset', preset: 'previous-month' },
        sort: 'longest',
        timeZone: 'Europe/Warsaw',
      },
      outcome: 'search',
    });
    expect(interpreter.calls).toHaveLength(1);
    expect(interpreter.calls[0]!.input).toEqual({
      text: 'runs of at least 5 km last month, longest first',
      timeZone: 'Europe/Warsaw',
      today: '2026-10-15',
    });
  });

  it('derives the local date in the person\'s zone from the server clock', async () => {
    const { clock, interpreter, service } = setup(answer());
    clock.nowMs = Date.parse('2026-10-31T23:30:00.000Z');
    await service.interpret(request());
    // 23:30 UTC is already the 1st of November in Warsaw.
    expect(interpreter.calls[0]!.input.today).toBe('2026-11-01');
  });

  it('passes a clarification and an unsupported answer through as reason codes only', async () => {
    const clarify: ProviderProposal = {
      ...search,
      clarificationReason: 'distance_boundary_strict',
      distanceUnit: null,
      minDistance: null,
      outcome: 'clarify',
      period: null,
      sort: null,
    };
    expect(await setup(answer(clarify)).service.interpret(request())).toEqual({
      outcome: 'clarify',
      reason: 'distance_boundary_strict',
    });
    const unsupported: ProviderProposal = { ...clarify, clarificationReason: null, outcome: 'unsupported', unsupportedReason: 'location' };
    expect(await setup(answer(unsupported)).service.interpret(request())).toEqual({
      outcome: 'unsupported',
      reason: 'location',
    });
  });

  it('treats a well-formed answer that is not a valid search as a failure, not as an answer', async () => {
    const { service } = setup(answer({ ...search, maxDistance: '2' }));
    const failure = await failureOf(service.interpret(request()));
    expect(failure).toMatchObject({ code: 'INTERPRETATION_FAILED', details: { reason: 'invalid_output' }, statusCode: 502 });
  });
});

describe('interpretation service: failures', () => {
  it.each([
    ['refusal', 'refusal'],
    ['incomplete', 'incomplete'],
    ['invalid_output', 'invalid_output'],
    ['oversized', 'oversized'],
    ['provider_error', 'provider_error'],
    ['provider_rate_limited', 'provider_rate_limited'],
  ] as const)('reports a provider %s as INTERPRETATION_FAILED, never as an unsupported answer', async (reason, expected) => {
    const { interpreter, service } = setup(() => Promise.reject(new InterpreterFailure(reason)));
    const failure = await failureOf(service.interpret(request()));
    expect(failure).toMatchObject({ code: 'INTERPRETATION_FAILED', details: { reason: expected }, statusCode: 502 });
    expect(interpreter.calls).toHaveLength(1);
  });

  it('enforces its own deadline when the transport ignores cancellation, and frees the place', async () => {
    const { admission, interpreter, service } = setup(hangsForever, { maxConcurrent: 1, timeoutMs: 30 });
    const started = Date.now();
    const failure = await failureOf(service.interpret(request()));
    expect(failure).toMatchObject({ code: 'INTERPRETATION_TIMEOUT', statusCode: 504 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(interpreter.calls[0]!.signal.aborted).toBe(true);
    // The concurrency place is back although the provider call never settled.
    expect(() => admission.admit(OTHER)).not.toThrow();
  });

  it('answers a client that went away and frees the place even if the transport ignores it', async () => {
    const { admission, service } = setup(hangsForever, { maxConcurrent: 1, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = failureOf(service.interpret(request({ signal: controller.signal })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'INTERPRETATION_ABORTED' });
    expect(() => admission.admit(OTHER)).not.toThrow();
  });

  it('does not charge or dispatch a request that was already cancelled', async () => {
    const { admission, interpreter, service } = setup(answer(), { allowance: 1 });
    const controller = new AbortController();
    controller.abort();
    await failureOf(service.interpret(request({ signal: controller.signal })));
    expect(interpreter.calls).toHaveLength(0);
    expect(admission.allowanceInUse()).toBe(0);
  });

  it('does not deliver a proposal when access was lost while the provider worked', async () => {
    const revoked = new ApiError(403, 'ORG_ACCESS_DENIED', 'The current identity cannot access this organization');
    const { service } = setup(answer());
    const failure = await failureOf(service.interpret(request({ revalidate: () => Promise.reject(revoked) })));
    expect(failure).toBe(revoked);
  });

  it('revalidates after the provider answered and not before', async () => {
    const order: string[] = [];
    const { service } = setup(async (input, options) => {
      order.push('provider');
      return answer()(input, options);
    });
    await service.interpret(
      request({
        revalidate: () => {
          order.push('revalidate');
          return Promise.resolve();
        },
      }),
    );
    expect(order).toEqual(['provider', 'revalidate']);
  });

  it('releases the place before revalidating, so a slow access check never holds provider capacity', async () => {
    const { admission, service } = setup(answer(), { maxConcurrent: 1 });
    let admittedDuringRevalidate = false;
    await service.interpret(
      request({
        revalidate: () => {
          try {
            admission.admit(OTHER).release({ dispatched: false });
            admittedDuringRevalidate = true;
          } catch {
            admittedDuringRevalidate = false;
          }
          return Promise.resolve();
        },
      }),
    );
    expect(admittedDuringRevalidate).toBe(true);
  });
});

describe('interpretation service: admission', () => {
  it('refuses without contacting the provider and carries when to retry', async () => {
    const { interpreter, service } = setup(hangsForever, { timeoutMs: 5_000 });
    const first = service.interpret(request());
    first.catch(() => undefined);
    const failure = await failureOf(service.interpret(request()));
    expect(failure).toMatchObject({ code: 'INTERPRETATION_IN_PROGRESS', statusCode: 429 });
    expect(interpreter.calls).toHaveLength(1);
  });

  it('maps every refusal to its own code and status', async () => {
    const rate = setup(answer());
    // 50 per minute allowed in this setup: use a tighter service instead.
    const tight = new InterpretationAdmission({
      allowance: { perWindow: 100, windowMs: 86_400_000 },
      clock: rate.clock,
      maxConcurrent: 4,
      maxUsers: 10,
      userRate: { perWindow: 1, windowMs: 60_000 },
    });
    const service = new InterpretationService({
      admission: tight,
      clock: rate.clock,
      interpreter: rate.interpreter,
      logger: createLogger({ clock: rate.clock, write: () => undefined }),
      timeoutMs: 100,
    });
    await service.interpret(request());
    const limited = await failureOf(service.interpret(request()));
    expect(limited).toMatchObject({ code: 'INTERPRETATION_RATE_LIMITED', statusCode: 429 });
    expect(limited.details).toMatchObject({ retryAfterSeconds: 60 });

    const busy = setup(hangsForever, { maxConcurrent: 1, timeoutMs: 5_000 });
    busy.service.interpret(request()).catch(() => undefined);
    expect(await failureOf(busy.service.interpret(request({ userId: OTHER })))).toMatchObject({
      code: 'INTERPRETATION_BUSY',
      statusCode: 503,
    });

    const spent = setup(answer(), { allowance: 1 });
    await spent.service.interpret(request());
    expect(await failureOf(spent.service.interpret(request({ userId: OTHER })))).toMatchObject({
      code: 'INTERPRETATION_BUDGET_EXHAUSTED',
      statusCode: 503,
    });
  });

  it('keeps the charge when the provider failed: a failure after dispatch still spends allowance', async () => {
    const { service } = setup(() => Promise.reject(new InterpreterFailure('provider_error')), { allowance: 1 });
    await failureOf(service.interpret(request()));
    expect(await failureOf(service.interpret(request({ userId: OTHER })))).toMatchObject({
      code: 'INTERPRETATION_BUDGET_EXHAUSTED',
    });
  });
});

describe('interpretation service: operational logging', () => {
  it('logs outcome, duration, model, usage and request id, and never the text or an answer', async () => {
    const { lines, service } = setup(answer());
    await service.interpret(request({ text: `runs last month near ${SENTINEL_TEXT}` }));

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      event: 'run_search.interpretation',
      inputTokens: 700,
      model: 'test-model',
      outcome: 'search',
      outputTokens: 40,
      requestId: '99999999-9999-4999-8999-999999999999',
    });
    expect(typeof line!.durationMs).toBe('number');
    const text = JSON.stringify(lines);
    expect(text).not.toContain(SENTINEL_TEXT);
    expect(text).not.toContain(USER);
    expect(text).not.toContain('previous-month');
  });

  it('logs a failure with a bounded outcome and no provider text', async () => {
    const { lines, service } = setup(() => Promise.reject(new InterpreterFailure('refusal', { inputTokens: 9, outputTokens: 3 })));
    await failureOf(service.interpret(request({ text: SENTINEL_TEXT })));
    expect(lines[0]).toMatchObject({ inputTokens: 9, outcome: 'refusal', outputTokens: 3 });
    expect(JSON.stringify(lines)).not.toContain(SENTINEL_TEXT);
  });

  it('logs a refused admission as such', async () => {
    const { lines, service } = setup(answer(), { allowance: 1 });
    await service.interpret(request());
    await failureOf(service.interpret(request({ userId: OTHER })));
    expect(lines.at(-1)).toMatchObject({ outcome: 'rejected_budget_exhausted' });
  });

  it('never throws because of logging', async () => {
    const { service } = setup(answer());
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(service.interpret(request())).resolves.toMatchObject({ outcome: 'search' });
  });
});
