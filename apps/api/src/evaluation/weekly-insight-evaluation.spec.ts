import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../insights/fake-provider.js';
import { buildFacts } from '../insights/insight-facts.js';
import { canonicalJson } from '../insights/weekly-aggregate.js';
import { evaluateCase, evaluationCases, percentile, summarize, validationCases } from './weekly-insight-evaluation.js';

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

  it('keeps the validation set frozen, separate from the development set, and covering its situations', () => {
    const validation = validationCases();
    // Pinned before any candidate prompt was written. A change here invalidates the held-out result of the prompt
    // experiment (docs/reports/weekly-insights-prompt-experiment-2026-11-07.md): do not update this hash to tune.
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
