import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../insights/fake-provider.js';
import { evaluateCase, evaluationCases, percentile, summarize } from './weekly-insight-evaluation.js';

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

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});
