import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../insights/fake-provider.js';
import { buildFacts } from '../insights/insight-facts.js';
import { WEEKLY_INSIGHT_PROMPT_VERSION, WEEKLY_INSIGHT_SYSTEM_PROMPTS } from '../insights/insight-prompt.js';
import type { LlmCallOptions, LlmJsonSchema, LlmStructuredInput } from '../insights/llm-provider.js';
import { canonicalJson } from '../insights/weekly-aggregate.js';
import { CallBudget, evaluateCase, evaluationCases, percentile, summarize, validationCases } from './weekly-insight-evaluation.js';

// The evaluation itself needs a local Ollama and is never run here; these check its cases and arithmetic only.
describe('weekly insight model evaluation (ADR-0076)', () => {
  const cases = evaluationCases();

  it('has ten synthetic weeks covering every required situation', () => {
    expect(cases).toHaveLength(10);
    const flagsOf = (id: string) => cases.find((entry) => entry.id === id)!.aggregate.flags;
    expect(flagsOf('empty')).toEqual(['no_activities', 'no_check_ins']);
    expect(flagsOf('sparse')).toContain('sparse_check_ins');
    expect(flagsOf('extreme_soreness')).toContain('extreme_soreness');
    expect(flagsOf('extreme_short_sleep')).toContain('extreme_short_sleep');
    expect(flagsOf('weight_change')).toContain('large_weight_change');
    expect(flagsOf('mixed_time_zones')).toContain('multiple_time_zones');
    expect(flagsOf('overlapping_runs')).toContain('manual_and_gps_runs_may_overlap');
    expect(flagsOf('stale_gps_summary')).toContain('gps_distance_pending');
    expect(cases.find((entry) => entry.id === 'complete')!.aggregate.checkIns.daysWithData).toBe(7);
  });

  it('records a grounded answer as ready with no violations, through the production generator', async () => {
    const result = await evaluateCase(cases[0]!, new FakeProvider(), { attemptTimeoutMs: 5_000, maxAttempts: 3, totalBudgetMs: 10_000 }, true);
    expect(result).toMatchObject({ attempts: 1, cold: true, grounding: {}, safetyRules: [], schemaValid: true, status: 'ready' });
    const wrong = await evaluateCase(cases[0]!, new FakeProvider({ mode: 'wrong_unit' }), { attemptTimeoutMs: 5_000, maxAttempts: 3, totalBudgetMs: 10_000 }, false);
    expect(wrong.grounding).toEqual({ claim_unit_mismatch: 1 });
    expect(summarize('fake', [result, wrong])).toMatchObject({ ready: 1, scopedGroundingFailures: 1, unitDirectionFailures: 1, warmSamples: 1 });
  });

  it('sends the requested prompt version through the production generator', async () => {
    const systems: string[] = [];
    const inner = new FakeProvider();
    const spy = {
      model: 'spy',
      generateStructured: (input: LlmStructuredInput, schema: LlmJsonSchema, options: LlmCallOptions) => {
        systems.push(input.system);
        return inner.generateStructured(input, schema, options);
      },
    };
    const budget = { attemptTimeoutMs: 5_000, maxAttempts: 3, totalBudgetMs: 10_000 };
    await evaluateCase(cases[1]!, spy, budget, false, { promptVersion: 'weekly-insight-v2' });
    await evaluateCase(cases[1]!, spy, budget, false);
    expect(WEEKLY_INSIGHT_PROMPT_VERSION).not.toBe('weekly-insight-v2');
    expect(systems).toEqual([WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v2'], WEEKLY_INSIGHT_SYSTEM_PROMPTS[WEEKLY_INSIGHT_PROMPT_VERSION]]);
  });

  it('never sends a call beyond the call limit, and reports the cut case apart from model results', async () => {
    const callBudget = new CallBudget(2);
    const budget = { attemptTimeoutMs: 5_000, maxAttempts: 3, totalBudgetMs: 10_000 };
    // Each schema-invalid answer uses a call: the first case spends both calls (one regeneration), the second is refused.
    const provider = new FakeProvider({ mode: 'invalid_schema' });
    const first = await evaluateCase(cases[0]!, provider, budget, true, { callBudget });
    const second = await evaluateCase(cases[1]!, provider, budget, false, { callBudget });
    expect(first).toMatchObject({ attempts: 2, cutByCallBudget: false, reason: 'schema_invalid', status: 'generation_failed' });
    expect(first.calls).toHaveLength(2);
    expect(second).toMatchObject({ calls: [], cutByCallBudget: true, status: 'generation_failed' });
    expect(callBudget).toMatchObject({ refused: 1, used: 2 });
    expect(summarize('fake', [first, second])).toMatchObject({ casesCutByCallBudget: 1, ready: 0, warmSamples: 0 });
  });

  it('counts timeouts and grounding failures by kind', async () => {
    const budget = { attemptTimeoutMs: 5_000, maxAttempts: 3, totalBudgetMs: 10_000 };
    const timeouts = await evaluateCase(cases[1]!, new FakeProvider({ mode: 'timeout' }), budget, false);
    const wrong = await evaluateCase(cases[0]!, new FakeProvider({ mode: 'wrong_unit' }), budget, false);
    expect(timeouts.calls?.every((call) => call.failure === 'timeout')).toBe(true);
    expect(summarize('fake', [timeouts, wrong])).toMatchObject({ groundingCasesByKind: { claim_unit_mismatch: 1 }, timeouts: timeouts.attempts });
  });

  it('keeps the validation set frozen, separate from the development set, and covering its situations', () => {
    const validation = validationCases();
    // Pinned before any candidate prompt was written. A change here invalidates the held-out result of the prompt
    // experiment (docs/reports/weekly-insights-model-evaluation-2026-11-07.md): do not update this hash to tune.
    const digest = createHash('sha256')
      .update(canonicalJson(validation.map((entry) => ({ aggregate: entry.aggregate, id: entry.id }))))
      .digest('hex');
    expect(digest).toBe('e777ec047e952a58cc119982f2acc8da0e4d84aa9ce138095ffe03cd7f3e2ef7');
    expect(validation).toHaveLength(10);
    const developmentIds = new Set(cases.map((entry) => entry.id));
    expect(validation.every((entry) => !developmentIds.has(entry.id) && entry.aggregate.week.start === '2026-10-19')).toBe(true);
    const flagsOf = (id: string) => validation.find((entry) => entry.id === id)!.aggregate.flags;
    const factIds = (id: string) => buildFacts(validation.find((entry) => entry.id === id)!.aggregate).map((entry) => entry.id);
    expect(factIds('val_mood_soreness_only').some((factId) => factId.startsWith('sleep.') || factId.startsWith('weight.'))).toBe(false);
    expect(flagsOf('val_single_day_short_night')).toEqual(['extreme_short_sleep', 'no_activities', 'sparse_check_ins']);
    expect(buildFacts(validation.find((entry) => entry.id === 'val_complete_stable_weight')!.aggregate).find((entry) => entry.id === 'weight.change')).toMatchObject({ direction: 'same', value: 0 });
    expect(flagsOf('val_extreme_long_sleep')).toContain('extreme_long_sleep');
    expect(flagsOf('val_extreme_soreness_active')).toContain('extreme_soreness');
    expect(flagsOf('val_mixed_zones_gps')).toContain('multiple_time_zones');
    expect(flagsOf('val_overlap_two_runs')).toContain('manual_and_gps_runs_may_overlap');
    expect(factIds('val_gps_distance_unavailable')).not.toContain('gps.distance');
    expect(flagsOf('val_activities_no_check_ins')).toEqual(['gps_distance_pending', 'no_check_ins']);
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});
