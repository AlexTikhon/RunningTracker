import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../../clock.js';
import { ApiError } from '../../http/errors.js';
import { createApiMetrics } from '../../observability/api-metrics.js';
import { createLogger } from '../../observability/logger.js';
import {
  AdmissionRejectedError,
  InterpretationAdmission,
  type AdmissionRejection,
  type AdmissionTicket,
} from './interpretation-admission.js';
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

// Timers that only fire when a test says so: a deadline is an event here, never a wait.
class ManualTimerClock extends TestClock {
  readonly #timers = new Map<number, () => void>();
  #next = 1;

  public override clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.#timers.delete(handle as unknown as number);
  }

  public override setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const handle = this.#next;
    this.#next += 1;
    this.#timers.set(handle, callback);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }

  /** Fires every pending deadline. */
  public fireDeadlines(): void {
    const due = [...this.#timers.values()];
    this.#timers.clear();
    for (const callback of due) callback();
  }
}

interface HeldOperation {
  reject(error: Error): void;
  resolve(value?: InterpreterAnswer): void;
  readonly signal: AbortSignal;
  settled: boolean;
}

// One deferred promise per call. It ignores AbortSignal unless `cooperative`, and it counts the calls that started
// and have not settled: the number the admission limits are meant to bound, whatever the HTTP side did meanwhile.
class DeferredInterpreter implements RunSearchInterpreter {
  public readonly model = 'test-model';
  public cooperative = false;
  public maxOutstanding = 0;
  public readonly operations: HeldOperation[] = [];

  public get outstanding(): number {
    return this.operations.filter((operation) => !operation.settled).length;
  }

  public interpret(_input: InterpretationInput, options: InterpretCallOptions): Promise<InterpreterAnswer> {
    return new Promise<InterpreterAnswer>((resolve, reject) => {
      const operation: HeldOperation = {
        reject: (error) => {
          operation.settled = true;
          reject(error);
        },
        resolve: (value = { proposal: search, usage: { inputTokens: 700, outputTokens: 40 } }) => {
          operation.settled = true;
          resolve(value);
        },
        settled: false,
        signal: options.signal,
      };
      this.operations.push(operation);
      this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
      if (this.cooperative) {
        options.signal.addEventListener('abort', () => operation.reject(new InterpreterFailure('aborted')), {
          once: true,
        });
      }
    });
  }
}

// The real admission, plus a record of how each ticket was released and a probe that asks "would a request be
// admitted now?" without leaving a charge behind.
class RecordingAdmission extends InterpretationAdmission {
  public readonly tickets: Array<{ releases: Array<boolean | undefined> }> = [];

  public override admit(userId: string): AdmissionTicket {
    const ticket = super.admit(userId);
    const record = { releases: [] as Array<boolean | undefined> };
    this.tickets.push(record);
    return {
      release: (options) => {
        record.releases.push(options?.dispatched);
        ticket.release(options);
      },
    };
  }

  public probe(userId: string): 'admitted' | AdmissionRejection {
    try {
      super.admit(userId).release({ dispatched: false });
      return 'admitted';
    } catch (error) {
      if (error instanceof AdmissionRejectedError) {
        return error.reason;
      }
      throw error;
    }
  }
}

// Lets promise reactions and Node's unhandled-rejection check run; it measures nothing.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

// A service whose only limit that can bind is the one under test: the per-person rate, the allowance and the
// tracked-person table are set far above anything a test does, so no other limiter can mask a leaked slot.
function setupHeld(
  options: { allowance?: number; interpreter?: RunSearchInterpreter; maxConcurrent?: number } = {},
) {
  const clock = new ManualTimerClock();
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    clock,
    write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const interpreter = new DeferredInterpreter();
  const admission = new RecordingAdmission({
    allowance: { perWindow: options.allowance ?? 1_000, windowMs: 86_400_000 },
    clock,
    maxConcurrent: options.maxConcurrent ?? 1,
    maxUsers: 1_000,
    userRate: { perWindow: 1_000, windowMs: 60_000 },
  });
  const metrics = createApiMetrics().interpretation;
  const outcomes = vi.spyOn(metrics.requests, 'inc');
  const service = new InterpretationService({
    admission,
    clock,
    interpreter: options.interpreter ?? interpreter,
    logger,
    metrics,
    timeoutMs: 10_000,
  });
  const requestLines = (): Array<Record<string, unknown>> =>
    lines.filter((line) => line.event === 'run_search.interpretation');
  return { admission, clock, interpreter, lines, outcomes, requestLines, service };
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

  // The deadline and cancellation end the REQUEST. They do not end the operation, so they must not free its place:
  // that is asserted in 'interpretation service: operation lifetime' below (ADR-0057, addendum).
  it('enforces its own deadline when the transport ignores cancellation', async () => {
    const { interpreter, service } = setup(hangsForever, { maxConcurrent: 1, timeoutMs: 30 });
    const started = Date.now();
    const failure = await failureOf(service.interpret(request()));
    expect(failure).toMatchObject({ code: 'INTERPRETATION_TIMEOUT', statusCode: 504 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(interpreter.calls[0]!.signal.aborted).toBe(true);
  });

  it('answers a client that went away even if the transport ignores the cancellation', async () => {
    const { service } = setup(hangsForever, { maxConcurrent: 1, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = failureOf(service.interpret(request({ signal: controller.signal })));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'INTERPRETATION_ABORTED' });
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

// The invariant (ADR-0057, addendum): an admission ticket stands for an admitted provider OPERATION. It is held until
// the underlying interpreter promise settles, not until the HTTP request ends. So, whatever requests did, the number
// of started-but-unsettled interpreter calls never exceeds maxConcurrent, and a person never has two.
describe('interpretation service: operation lifetime', () => {
  const THIRD = '33333333-3333-4333-8333-333333333333';

  it('answers at the deadline at once, while the unsettled operation keeps its slot', async () => {
    const { admission, clock, interpreter, service } = setupHeld();
    const pending = failureOf(service.interpret(request()));
    expect(interpreter.outstanding).toBe(1);

    clock.fireDeadlines();
    expect(await pending).toMatchObject({ code: 'INTERPRETATION_TIMEOUT', statusCode: 504 });

    expect(interpreter.operations[0]!.signal.aborted).toBe(true);
    expect(interpreter.outstanding).toBe(1);
    expect(admission.probe(OTHER)).toBe('busy');
    expect(admission.tickets[0]!.releases).toEqual([]);
  });

  it('answers a cancelled client at once, while the unsettled operation keeps its slot', async () => {
    const { admission, interpreter, service } = setupHeld();
    const controller = new AbortController();
    const pending = failureOf(service.interpret(request({ signal: controller.signal })));

    controller.abort();
    expect(await pending).toMatchObject({ code: 'INTERPRETATION_ABORTED', statusCode: 499 });

    expect(interpreter.outstanding).toBe(1);
    expect(admission.probe(OTHER)).toBe('busy');
    expect(admission.tickets[0]!.releases).toEqual([]);
  });

  it('refuses another person, without calling the provider, while global capacity is occupied', async () => {
    const { clock, interpreter, service } = setupHeld({ maxConcurrent: 1 });
    const first = failureOf(service.interpret(request({ userId: USER })));
    clock.fireDeadlines();
    await first;

    const second = await failureOf(service.interpret(request({ userId: OTHER })));
    expect(second).toMatchObject({ code: 'INTERPRETATION_BUSY', statusCode: 503 });
    expect(interpreter.operations).toHaveLength(1);
    expect(interpreter.maxOutstanding).toBe(1);
  });

  it('refuses the same person while their operation is unsettled, although global capacity is free', async () => {
    const { admission, clock, interpreter, service } = setupHeld({ maxConcurrent: 4 });
    const first = failureOf(service.interpret(request({ userId: USER })));
    clock.fireDeadlines();
    await first;

    // Capacity is not what stops this: another person is admitted. The person's own reservation is.
    expect(admission.probe(OTHER)).toBe('admitted');
    const again = await failureOf(service.interpret(request({ userId: USER })));
    expect(again).toMatchObject({ code: 'INTERPRETATION_IN_PROGRESS', statusCode: 429 });
    expect(interpreter.operations).toHaveLength(1);
  });

  it('releases capacity exactly once when the abandoned operation resolves late, and delivers nothing', async () => {
    const { admission, clock, interpreter, outcomes, requestLines, service } = setupHeld();
    const revalidate = vi.fn(() => Promise.resolve());
    const pending = failureOf(service.interpret(request({ revalidate })));
    clock.fireDeadlines();
    await pending;
    expect(admission.probe(OTHER)).toBe('busy');
    expect(requestLines()).toHaveLength(1);
    expect(outcomes).toHaveBeenCalledTimes(1);

    interpreter.operations[0]!.resolve();
    await flush();

    expect(interpreter.outstanding).toBe(0);
    expect(admission.probe(OTHER)).toBe('admitted');
    // Dispatched and charged once; released once, as a dispatched operation.
    expect(admission.tickets).toHaveLength(1);
    expect(admission.tickets[0]!.releases).toEqual([true]);
    expect(admission.allowanceInUse()).toBe(1);
    // The request is over: no access check, no second outcome in the log or the counters.
    expect(revalidate).not.toHaveBeenCalled();
    expect(requestLines()).toHaveLength(1);
    expect(requestLines()[0]).toMatchObject({ outcome: 'timeout' });
    expect(outcomes).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveBeenCalledWith({ outcome: 'timeout' });
  });

  it('releases capacity exactly once when the abandoned operation rejects late, without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { admission, clock, interpreter, outcomes, requestLines, service } = setupHeld();
      const pending = failureOf(service.interpret(request()));
      clock.fireDeadlines();
      await pending;
      expect(admission.probe(OTHER)).toBe('busy');

      interpreter.operations[0]!.reject(new Error(`provider body echoing ${SENTINEL_TEXT}`));
      await flush();
      await flush();

      expect(unhandled).toEqual([]);
      expect(interpreter.outstanding).toBe(0);
      expect(admission.probe(OTHER)).toBe('admitted');
      expect(admission.tickets[0]!.releases).toEqual([true]);
      expect(requestLines()).toHaveLength(1);
      expect(outcomes).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('releases capacity once an interpreter that honours cancellation settles', async () => {
    const { admission, clock, interpreter, service } = setupHeld();
    interpreter.cooperative = true;
    const pending = failureOf(service.interpret(request()));
    clock.fireDeadlines();
    expect(await pending).toMatchObject({ code: 'INTERPRETATION_TIMEOUT' });
    await flush();

    expect(interpreter.outstanding).toBe(0);
    expect(admission.probe(OTHER)).toBe('admitted');
    expect(admission.tickets[0]!.releases).toEqual([true]);
  });

  it('releases provider capacity before the access check when the operation completes normally', async () => {
    const { admission, interpreter, service } = setupHeld();
    const seenByRevalidate: Array<{ probe: string; releases: Array<boolean | undefined> }> = [];
    const pending = service.interpret(
      request({
        revalidate: () => {
          seenByRevalidate.push({
            probe: admission.probe(OTHER),
            releases: [...admission.tickets[0]!.releases],
          });
          return Promise.resolve();
        },
      }),
    );
    interpreter.operations[0]!.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'search' });

    expect(seenByRevalidate).toEqual([{ probe: 'admitted', releases: [true] }]);
    expect(admission.tickets[0]!.releases).toEqual([true]);
  });

  it('neither dispatches nor charges a request that was cancelled before admission', async () => {
    const { admission, interpreter, requestLines, service } = setupHeld({ allowance: 1 });
    const controller = new AbortController();
    controller.abort();

    expect(await failureOf(service.interpret(request({ signal: controller.signal })))).toMatchObject({
      code: 'INTERPRETATION_ABORTED',
    });

    expect(interpreter.operations).toHaveLength(0);
    expect(admission.tickets).toHaveLength(0);
    expect(admission.allowanceInUse()).toBe(0);
    expect(admission.probe(USER)).toBe('admitted');
    expect(requestLines()).toHaveLength(1);
  });

  it('cleans up a synchronous interpreter failure: slot freed once, charge kept, no operation left', async () => {
    const throwing = new ScriptedInterpreter(() => {
      throw new Error('synchronous failure');
    });
    const { admission, requestLines, service } = setupHeld({ allowance: 1, interpreter: throwing });

    const failure = await failureOf(service.interpret(request()));
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
    expect(throwing.calls).toHaveLength(1);
    // The interpreter was called, so the allowance is charged (as for any dispatched failure), and nothing is held.
    expect(admission.tickets).toHaveLength(1);
    expect(admission.tickets[0]!.releases).toEqual([true]);
    expect(admission.allowanceInUse()).toBe(1);
    expect(admission.probe(USER)).toBe('budget_exhausted');
    expect(requestLines()).toHaveLength(1);
    expect(requestLines()[0]).toMatchObject({ outcome: 'provider_error' });
  });

  it('keeps a dispatched operation\'s allowance charge when it is abandoned and then fails late', async () => {
    const { admission, clock, interpreter, service } = setupHeld({ allowance: 1 });
    const pending = failureOf(service.interpret(request()));
    clock.fireDeadlines();
    await pending;
    expect(interpreter.outstanding).toBe(1);
    interpreter.operations[0]!.reject(new InterpreterFailure('provider_error'));
    await flush();

    // The place is back, the charge is not.
    expect(interpreter.outstanding).toBe(0);
    expect(admission.allowanceInUse()).toBe(1);
    expect(admission.probe(OTHER)).toBe('budget_exhausted');
  });

  it('keeps a dispatched failure\'s allowance charge when the provider fails inside the request', async () => {
    const { admission, interpreter, service } = setupHeld({ allowance: 1 });
    const pending = failureOf(service.interpret(request()));
    interpreter.operations[0]!.reject(new InterpreterFailure('refusal'));
    expect(await pending).toMatchObject({ code: 'INTERPRETATION_FAILED' });

    expect(admission.tickets[0]!.releases).toEqual([true]);
    expect(admission.probe(OTHER)).toBe('budget_exhausted');
  });

  it('never has more unsettled operations than the configured concurrency, however often requests end', async () => {
    const { admission, clock, interpreter, service } = setupHeld({ maxConcurrent: 2 });
    const people = Array.from(
      { length: 12 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const codes: string[] = [];

    for (const [index, userId] of people.entries()) {
      const controller = new AbortController();
      const attempt = failureOf(service.interpret(request({ signal: controller.signal, userId })));
      if (index % 2 === 0) {
        clock.fireDeadlines();
      } else {
        controller.abort();
      }
      codes.push((await attempt).code);
    }

    expect(codes).toEqual([
      'INTERPRETATION_TIMEOUT',
      'INTERPRETATION_ABORTED',
      ...Array<string>(10).fill('INTERPRETATION_BUSY'),
    ]);
    expect(interpreter.operations).toHaveLength(2);
    expect(interpreter.maxOutstanding).toBeLessThanOrEqual(2);

    // The same person trying again and again does not get past their own unsettled operation either.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = await failureOf(service.interpret(request({ userId: people[0]! })));
      expect(again.code).toBe('INTERPRETATION_IN_PROGRESS');
    }
    expect(interpreter.maxOutstanding).toBeLessThanOrEqual(2);

    // Settling one operation frees exactly one place.
    interpreter.operations[0]!.resolve();
    await flush();
    expect(admission.probe(THIRD)).toBe('admitted');
    expect(admission.probe(THIRD)).toBe('admitted');
    const start = failureOf(service.interpret(request({ userId: THIRD })));
    expect(interpreter.outstanding).toBe(2);
    expect(await failureOf(service.interpret(request({ userId: OTHER })))).toMatchObject({
      code: 'INTERPRETATION_BUSY',
    });
    clock.fireDeadlines();
    await start;
    expect(interpreter.maxOutstanding).toBeLessThanOrEqual(2);
  });

  it('reports a late settlement once, with bounded fields and no text or provider body', async () => {
    const { clock, interpreter, lines, service } = setupHeld();
    const pending = failureOf(service.interpret(request({ text: `near ${SENTINEL_TEXT}` })));
    clock.fireDeadlines();
    await pending;
    interpreter.operations[0]!.reject(new Error(`provider body echoing ${SENTINEL_TEXT}`));
    await flush();

    const settled = lines.filter((line) => line.event === 'run_search.interpretation.operation_settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      model: 'test-model',
      reason: 'rejected',
      requestId: '99999999-9999-4999-8999-999999999999',
    });
    expect(typeof settled[0]!.durationMs).toBe('number');
    expect(JSON.stringify(lines)).not.toContain(SENTINEL_TEXT);
    expect(JSON.stringify(lines)).not.toContain(USER);
  });

  it('says nothing extra when the operation settles while its request is still waiting', async () => {
    const { interpreter, lines, service } = setupHeld();
    const pending = service.interpret(request());
    interpreter.operations[0]!.resolve();
    await pending;

    expect(lines.map((line) => line.event)).toEqual(['run_search.interpretation']);
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
