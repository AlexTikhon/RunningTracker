import { describe, expect, it } from 'vitest';

import type { Clock } from '../../clock.js';
import { ApiError } from '../../http/errors.js';
import { LlmProviderError, type LlmCallOptions, type LlmJsonSchema, type LlmProvider, type LlmStructuredInput, type LlmStructuredResult } from '../../insights/llm-provider.js';
import { createApiMetrics } from '../../observability/api-metrics.js';
import { createLogger } from '../../observability/logger.js';
import { InterpretationAdmission } from '../../runs/interpretation/interpretation-admission.js';
import { fakeMealDraftAnswer } from './fake-meal-draft-provider.js';
import { MEAL_DRAFT_INSTRUCTIONS } from './meal-draft-prompt.js';
import { MealDraftService, type MealDraftRequest } from './meal-draft-service.js';
import { mealDraftWireJsonSchema } from './meal-draft-wire.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
// A recognisable private string: it must never appear in a log line or a metric.
const SENTINEL = 'Dinner: SENTINEL-QXZ stew, total 650 kcal, protein 40 g';

// Timers that only fire when a test says so: a deadline is an event here, never a wait.
class ManualClock implements Clock {
  public nowMs = Date.parse('2026-11-14T12:00:00.000Z');
  readonly #timers = new Map<number, () => void>();
  #next = 1;

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.#timers.delete(handle as unknown as number);
  }

  public monotonicNow(): number {
    return this.nowMs;
  }

  public setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const handle = this.#next;
    this.#next += 1;
    this.#timers.set(handle, callback);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }

  public utcNow(): Date {
    return new Date(this.nowMs);
  }

  public fireDeadlines(): void {
    const due = [...this.#timers.values()];
    this.#timers.clear();
    for (const callback of due) callback();
  }
}

interface Held {
  input: LlmStructuredInput;
  options: LlmCallOptions;
  reject(error: Error): void;
  resolve(value: unknown): void;
  schema: LlmJsonSchema;
}

/** A provider whose calls stay open until the test settles them, and which ignores cancellation unless told. */
class HeldProvider implements LlmProvider {
  public readonly model = 'test-model';
  public readonly calls: Held[] = [];

  public generateStructured(input: LlmStructuredInput, schema: LlmJsonSchema, options: LlmCallOptions): Promise<LlmStructuredResult> {
    return new Promise((resolve, reject) => {
      this.calls.push({ input, options, reject, resolve: (value) => resolve({ value }), schema });
    });
  }
}

function setup(options: { maxConcurrent?: number; perMinute?: number } = {}) {
  const clock = new ManualClock();
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ clock, write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const provider = new HeldProvider();
  const admission = new InterpretationAdmission({
    allowance: { perWindow: 100, windowMs: 86_400_000 },
    clock,
    maxConcurrent: options.maxConcurrent ?? 2,
    maxUsers: 100,
    userRate: { perWindow: options.perMinute ?? 30, windowMs: 60_000 },
  });
  const metrics = createApiMetrics().mealDrafts;
  const service = new MealDraftService({ admission, clock, logger, maxOutputTokens: 600, metrics, provider, timeoutMs: 45_000 });
  return { admission, clock, lines, metrics, provider, service };
}

function request(overrides: Partial<MealDraftRequest> = {}): MealDraftRequest {
  return {
    requestId: 'req-1',
    revalidate: () => Promise.resolve(),
    signal: new AbortController().signal,
    text: SENTINEL,
    userId: USER,
    ...overrides,
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected a rejection');
}

describe('MealDraftService: one call, grounded', () => {
  it('sends only the fixed instructions, the wire schema and the text, and returns a grounded draft', async () => {
    const { lines, provider, service } = setup();
    const pending = service.propose(request());
    await settleMicrotasks();
    expect(provider.calls).toHaveLength(1);
    const [call] = provider.calls;
    expect(call!.input).toEqual({ system: MEAL_DRAFT_INSTRUCTIONS, user: SENTINEL });
    expect(call!.schema).toBe(mealDraftWireJsonSchema);
    expect(call!.options).toMatchObject({ maxOutputTokens: 600, timeoutMs: 45_000 });
    call!.resolve(fakeMealDraftAnswer(SENTINEL));
    await expect(pending).resolves.toMatchObject({
      nutrition: { energyKcal: { status: 'proposed', value: 650 }, proteinG: { status: 'proposed', value: 40 } },
      outcome: 'draft',
      title: 'SENTINEL-QXZ stew',
    });
    expect(lines).toEqual([
      expect.objectContaining({ event: 'meal_draft.proposal', notStatedFields: 2, outcome: 'draft', proposedFields: 2, withheldFields: 0 }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('fails an answer the wire schema refuses, and an ungrounded title, without returning anything from it', async () => {
    const { lines, provider, service } = setup();
    const invalid = service.propose(request());
    await settleMicrotasks();
    provider.calls[0]!.resolve({ outcome: 'draft', title: 'stew' });
    const invalidError = await rejection(invalid);
    expect([invalidError.statusCode, invalidError.code, invalidError.details]).toEqual([502, 'MEAL_DRAFT_FAILED', { reason: 'invalid_output' }]);

    const ungrounded = service.propose(request({ text: 'Two eggs and toast' }));
    await settleMicrotasks();
    provider.calls[1]!.resolve(fakeMealDraftAnswer('Two eggs and toast [ungrounded]'));
    const ungroundedError = await rejection(ungrounded);
    expect(ungroundedError.details).toEqual({ reason: 'ungrounded_output' });
    expect(lines.map((line) => line.outcome)).toEqual(['invalid_output', 'ungrounded_output']);
  });

  it('maps provider failures to bounded reasons and codes', async () => {
    const { provider, service } = setup();
    const cases: Array<[LlmProviderError, number, string, unknown]> = [
      [new LlmProviderError('unavailable', true), 502, 'MEAL_DRAFT_FAILED', { reason: 'provider_unavailable' }],
      [new LlmProviderError('incomplete', false), 502, 'MEAL_DRAFT_FAILED', { reason: 'incomplete' }],
      [new LlmProviderError('oversized', false), 502, 'MEAL_DRAFT_FAILED', { reason: 'oversized' }],
      [new LlmProviderError('timeout', true), 504, 'MEAL_DRAFT_TIMEOUT', undefined],
    ];
    for (const [index, [failure, status, code, details]] of cases.entries()) {
      const pending = service.propose(request());
      await settleMicrotasks();
      provider.calls[index]!.reject(failure);
      const error = await rejection(pending);
      expect([error.statusCode, error.code, error.details]).toEqual([status, code, details]);
    }
  });
});

describe('MealDraftService: admission and the operation lifetime', () => {
  it('keeps the person\'s place after the request timed out, until the provider\'s promise settles', async () => {
    const { admission, clock, lines, provider, service } = setup();
    const first = service.propose(request());
    await settleMicrotasks();
    clock.fireDeadlines();
    const timedOut = await rejection(first);
    expect([timedOut.statusCode, timedOut.code]).toEqual([504, 'MEAL_DRAFT_TIMEOUT']);
    // The provider was asked to stop, but has not settled: the reservation is still held.
    expect(provider.calls[0]!.options.signal?.aborted).toBe(true);
    const meanwhile = await rejection(service.propose(request()));
    expect([meanwhile.statusCode, meanwhile.code]).toEqual([429, 'MEAL_DRAFT_IN_PROGRESS']);
    expect(provider.calls).toHaveLength(1);

    // The late answer settles the operation: the place comes back, and the answer itself is dropped unread.
    provider.calls[0]!.resolve(fakeMealDraftAnswer(SENTINEL));
    await settleMicrotasks();
    expect(lines.some((line) => line.event === 'meal_draft.operation_settled' && line.reason === 'fulfilled')).toBe(true);
    const again = service.propose(request());
    await settleMicrotasks();
    expect(provider.calls).toHaveLength(2);
    provider.calls[1]!.resolve(fakeMealDraftAnswer(SENTINEL));
    await expect(again).resolves.toMatchObject({ outcome: 'draft' });
    expect(admission.allowanceInUse()).toBe(2);
  });

  it('keeps the global place of a cancelled request until its provider call settles', async () => {
    const { provider, service } = setup({ maxConcurrent: 1 });
    const client = new AbortController();
    const first = service.propose(request({ signal: client.signal }));
    await settleMicrotasks();
    client.abort();
    const aborted = await rejection(first);
    expect([aborted.statusCode, aborted.code]).toEqual([499, 'MEAL_DRAFT_ABORTED']);

    // Someone else is refused while the abandoned call still runs: concurrency stays bounded.
    const busy = await rejection(service.propose(request({ userId: OTHER })));
    expect([busy.statusCode, busy.code]).toEqual([503, 'MEAL_DRAFT_BUSY']);

    provider.calls[0]!.reject(new LlmProviderError('aborted', false));
    await settleMicrotasks();
    const next = service.propose(request({ userId: OTHER }));
    await settleMicrotasks();
    expect(provider.calls).toHaveLength(2);
    provider.calls[1]!.resolve(fakeMealDraftAnswer(SENTINEL));
    await expect(next).resolves.toMatchObject({ outcome: 'draft' });
  });

  it('refuses a request whose client is already gone without calling the provider', async () => {
    const { provider, service } = setup();
    const client = new AbortController();
    client.abort();
    const error = await rejection(service.propose(request({ signal: client.signal })));
    expect(error.code).toBe('MEAL_DRAFT_ABORTED');
    expect(provider.calls).toHaveLength(0);
  });

  it('rate-limits per person with a Retry-After hint', async () => {
    const { provider, service } = setup({ perMinute: 1 });
    const first = service.propose(request());
    await settleMicrotasks();
    provider.calls[0]!.resolve(fakeMealDraftAnswer(SENTINEL));
    await first;
    const limited = await rejection(service.propose(request()));
    expect([limited.statusCode, limited.code]).toEqual([429, 'MEAL_DRAFT_RATE_LIMITED']);
    expect(limited.details).toEqual({ retryAfterSeconds: 60 });
  });
});

describe('MealDraftService: access is checked again before the answer leaves', () => {
  it('returns nothing when access was lost while the model worked', async () => {
    const { lines, provider, service } = setup();
    const pending = service.propose(
      request({ revalidate: () => Promise.reject(new ApiError(403, 'ORGANIZATION_ACCESS_DENIED', 'gone')) }),
    );
    await settleMicrotasks();
    provider.calls[0]!.resolve(fakeMealDraftAnswer(SENTINEL));
    const error = await rejection(pending);
    expect([error.statusCode, error.code]).toEqual([403, 'ORGANIZATION_ACCESS_DENIED']);
    expect(lines.at(-1)).toMatchObject({ outcome: 'access_lost' });
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('does not revalidate, or count as an answer, a result that arrives after the request ended', async () => {
    const { clock, lines, provider, service } = setup();
    let revalidated = 0;
    const pending = service.propose(request({ revalidate: () => Promise.resolve(void (revalidated += 1)) }));
    await settleMicrotasks();
    clock.fireDeadlines();
    await rejection(pending);
    provider.calls[0]!.resolve(fakeMealDraftAnswer(SENTINEL));
    await settleMicrotasks();
    expect(revalidated).toBe(0);
    expect(lines.filter((line) => line.event === 'meal_draft.proposal').map((line) => line.outcome)).toEqual(['timeout']);
  });
});
