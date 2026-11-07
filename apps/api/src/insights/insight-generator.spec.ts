import { describe, expect, it } from 'vitest';

import { FakeProvider, type FakeProviderMode } from './fake-provider.js';
import { generateWeeklyInsight, MIN_ATTEMPT_MS, type GenerationBudget } from './insight-generator.js';
import { LlmProviderError, type LlmCallOptions, type LlmProvider, type LlmStructuredResult } from './llm-provider.js';
import { aggregateWeek, resolveWeekWindow, type CheckInRecord } from './weekly-aggregate.js';

const WEEK = '2026-11-02';

function weekOf(values: Partial<CheckInRecord>[]) {
  const records: CheckInRecord[] = values.map((value, index) => ({
    localDate: `2026-11-0${2 + index}`,
    mood: null,
    sleepMinutes: null,
    sleepQuality: null,
    soreness: null,
    timeZone: 'Europe/Warsaw',
    weightKg: null,
    ...value,
  }));
  const window = resolveWeekWindow({ checkIns: records, requestTimeZone: 'Europe/Warsaw', weekStart: WEEK });
  return aggregateWeek({ activities: [], checkIns: records, gpsRuns: [], todayLocalDate: '2026-11-20', window });
}

const normal = weekOf([
  { mood: 4, sleepMinutes: 420, weightKg: 72.4 },
  { mood: 3, sleepMinutes: 480 },
  { mood: 4, sleepMinutes: 410, weightKg: 71.8 },
]);
const extreme = weekOf([{ sleepMinutes: 450, soreness: 9 }, { sleepMinutes: 400, soreness: 3 }]);

const budget: GenerationBudget = { attemptTimeoutMs: 5_000, maxAttempts: 3, totalBudgetMs: 60_000 };
const settings = (override: Partial<GenerationBudget> = {}, now: () => number = () => 0) => ({
  budget: { ...budget, ...override },
  maxOutputTokens: 800,
  now,
});

/** Answers from a script, one entry per call; records each call's deadline. */
class ScriptedProvider implements LlmProvider {
  public readonly model = 'scripted';
  public readonly timeouts: number[] = [];
  public constructor(private readonly script: ((options: LlmCallOptions) => Promise<LlmStructuredResult>)[]) {}
  public generateStructured(_input: unknown, _schema: unknown, options: LlmCallOptions): Promise<LlmStructuredResult> {
    this.timeouts.push(options.timeoutMs);
    const next = this.script.shift();
    if (!next) throw new Error('The script has no more answers');
    return next(options);
  }
}
const fail = (reason: ConstructorParameters<typeof LlmProviderError>[0], retryable: boolean) => () =>
  Promise.reject(new LlmProviderError(reason, retryable));
const grounded = new FakeProvider();
const valid = async (options: LlmCallOptions) => grounded.generateStructured(lastPrompt, {}, options);
let lastPrompt = { system: '', user: '' };

describe('weekly insight generation budget', () => {
  it('generates, validates and assembles a ready insight in one attempt', async () => {
    const outcome = await generateWeeklyInsight(normal, new FakeProvider(), settings());
    expect(outcome.status).toBe('ready');
    expect(outcome.stats).toMatchObject({ attempts: 1, schemaFailures: 0, transportFailures: 0 });
    if (outcome.status !== 'ready') return;
    expect(outcome.output.observations.flatMap((observation) => observation.facts.map((fact) => fact.text))).toContain(
      'Average sleep: 437 min',
    );
    expect(outcome.output.suggestion.source).toBe('model');
    expect(outcome.output.dataGaps.map((gap) => gap.code)).toEqual(['missing_check_in_days', 'no_activities']);
  });

  it('regenerates once after an answer that is not the schema, and fails on the second one', async () => {
    const regenerated = new FakeProvider({ mode: 'invalid_then_grounded' });
    expect((await generateWeeklyInsight(normal, regenerated, settings())).status).toBe('ready');
    expect(regenerated.calls).toHaveLength(2);
    for (const mode of ['invalid_schema', 'not_json'] as FakeProviderMode[]) {
      const provider = new FakeProvider({ mode });
      const outcome = await generateWeeklyInsight(normal, provider, settings());
      expect(outcome).toMatchObject({ reason: 'schema_invalid', stats: { attempts: 2, schemaFailures: 2 }, status: 'generation_failed' });
    }
  });

  it('caps every failure kind together at maxAttempts: retries never multiply', async () => {
    const provider = new FakeProvider({ mode: 'timeout' });
    const outcome = await generateWeeklyInsight(normal, provider, settings());
    expect(outcome).toMatchObject({ reason: 'timeout', stats: { attempts: 3, transportFailures: 3 }, status: 'generation_failed' });
    expect(provider.calls).toHaveLength(3);
    // One schema failure, then transport failures: still three calls in total, not 2 x 2.
    const mixed = new ScriptedProvider([
      () => Promise.resolve({ value: { summary: 42 } }),
      fail('unavailable', true),
      fail('timeout', true),
    ]);
    expect(await generateWeeklyInsight(normal, mixed, settings())).toMatchObject({
      stats: { attempts: 3, schemaFailures: 1, transportFailures: 2 },
      status: 'generation_failed',
    });
  });

  it('stops at once on a failure that another attempt cannot fix', async () => {
    for (const reason of ['provider_error', 'oversized'] as const) {
      const provider = new ScriptedProvider([fail(reason, false)]);
      expect(await generateWeeklyInsight(normal, provider, settings())).toMatchObject({ reason, stats: { attempts: 1 }, status: 'generation_failed' });
    }
  });

  it('gives each attempt at most what is left of the total budget, and starts none with less than the minimum', async () => {
    let clock = 0;
    const provider = new ScriptedProvider([
      () => {
        clock += 7_000;
        return Promise.reject(new LlmProviderError('timeout', true));
      },
      () => {
        clock += 2_500;
        return Promise.reject(new LlmProviderError('timeout', true));
      },
    ]);
    const outcome = await generateWeeklyInsight(normal, provider, settings({ attemptTimeoutMs: 8_000, totalBudgetMs: 10_000 }, () => clock));
    expect(provider.timeouts).toEqual([8_000, 3_000]);
    expect(outcome).toMatchObject({ reason: 'budget_exhausted', stats: { attempts: 2 }, status: 'generation_failed' });
    expect(10_000 - clock).toBeLessThan(MIN_ATTEMPT_MS);
  });

  it('reports a cancellation as aborted without further attempts', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await generateWeeklyInsight(normal, new FakeProvider(), { ...settings(), signal: controller.signal });
    expect(outcome).toMatchObject({ reason: 'aborted', stats: { attempts: 1 }, status: 'generation_failed' });
  });
});

describe('weekly insight generation checks', () => {
  const statusFor = async (mode: FakeProviderMode, aggregate = normal) =>
    (await generateWeeklyInsight(aggregate, new FakeProvider({ mode }), settings())).status;

  it('discards claim and prose grounding failures without retrying', async () => {
    for (const mode of ['number_in_prose', 'unrelated_value', 'wrong_unit', 'reversed_direction', 'swapped_min_max', 'unknown_fact'] as const) {
      const provider = new FakeProvider({ mode });
      const outcome = await generateWeeklyInsight(normal, provider, settings());
      expect([mode, outcome.status]).toEqual([mode, 'failed_grounding']);
      expect(provider.calls).toHaveLength(1);
    }
    expect(await statusFor('missing_as_zero', weekOf([{ mood: 3 }]))).toBe('failed_grounding');
  });

  it('discards unsafe prose as failed_safety, which wins over grounding', async () => {
    expect(await statusFor('diagnosis')).toBe('failed_safety');
    expect(await statusFor('unsafe_medication')).toBe('failed_safety');
    expect(await statusFor('unsafe_ignore_pain', extreme)).toBe('failed_safety');
  });

  it('in an extreme week drops the model\'s suggestion unseen and uses the approved one', async () => {
    const outcome = await generateWeeklyInsight(extreme, new FakeProvider({ mode: 'extreme_model_suggestion' }), settings());
    expect(outcome.status).toBe('ready');
    expect(outcome.stats.modelSuggestionDropped).toBe(true);
    if (outcome.status !== 'ready') return;
    expect(outcome.output.suggestion).toMatchObject({ id: 'rest_and_recovery', source: 'approved' });
    expect(JSON.stringify(outcome.output)).not.toContain('interval');
  });

  it('uses the approved fallback when the model writes no suggestion in an ordinary week', async () => {
    const provider = new ScriptedProvider([
      () => Promise.resolve({ value: { observations: [], suggestion: null, summary: 'A calm week.' } }),
    ]);
    const outcome = await generateWeeklyInsight(normal, provider, settings());
    expect(outcome.status === 'ready' && outcome.output.suggestion).toMatchObject({ id: 'keep_checking_in', source: 'approved' });
  });

  it('records the prompt as the fake reads it back (the facts are in the prompt)', async () => {
    const provider = new FakeProvider();
    await generateWeeklyInsight(normal, provider, settings());
    lastPrompt = provider.calls[0]!;
    const replayed = new ScriptedProvider([valid]);
    expect((await generateWeeklyInsight(normal, replayed, settings())).status).toBe('ready');
  });
});
