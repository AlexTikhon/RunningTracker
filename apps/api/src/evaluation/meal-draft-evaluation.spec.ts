import { describe, expect, it } from 'vitest';

import { LlmProviderError, type LlmProvider } from '../insights/llm-provider.js';
import { FakeMealDraftProvider } from '../meals/drafts/fake-meal-draft-provider.js';
import {
  buildMealDraftReport,
  formatMealDraftReport,
  loadMealDraftDataset,
  MEAL_DRAFT_DATASET_DIGESTS,
  runMealDraftEvaluation,
  scoreMealDraftResults,
  type MealDraftCaseResult,
  type MealDraftEvaluationCase,
} from './meal-draft-evaluation.js';

const clock = { monotonicNow: () => performance.now() };

describe('meal draft evaluation sets (frozen)', () => {
  it('loads both sets only with their pinned digests, with English and Russian cases and no shared text', () => {
    const development = loadMealDraftDataset('development');
    const heldout = loadMealDraftDataset('heldout');
    expect(development.digest).toBe(MEAL_DRAFT_DATASET_DIGESTS.development);
    expect(heldout.digest).toBe(MEAL_DRAFT_DATASET_DIGESTS.heldout);
    for (const { dataset } of [development, heldout]) {
      expect(dataset.cases.filter((entry) => entry.language === 'en').length).toBeGreaterThanOrEqual(8);
      expect(dataset.cases.filter((entry) => entry.language === 'ru').length).toBeGreaterThanOrEqual(8);
    }
    const texts = new Set(development.dataset.cases.map((entry) => entry.text));
    expect(heldout.dataset.cases.some((entry) => texts.has(entry.text))).toBe(false);
    expect(() => loadMealDraftDataset('heldout', { ...MEAL_DRAFT_DATASET_DIGESTS, heldout: '0'.repeat(64) })).toThrow(/not the frozen one/u);
  });
});

describe('meal draft evaluation scoring', () => {
  const draftCase = (nutrition: Partial<Record<'carbohydrateG' | 'energyKcal' | 'fatG' | 'proteinG', number | null>>): MealDraftEvaluationCase => ({
    category: 'grounded',
    expected: {
      mealType: null,
      nutrition: { carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null, ...nutrition },
      outcome: 'draft',
      titleIncludes: ['soup'],
    },
    id: 'case-a',
    language: 'en',
    text: 'Soup',
  });
  const notStated = { status: 'not_stated' } as const;

  it('separates correct, incorrectly accepted, abstained and stopped fields', () => {
    const results: MealDraftCaseResult[] = [
      {
        audit: { fields: { carbohydrateG: 'server_withheld', energyKcal: 'proposed', fatG: 'model_abstained', proteinG: 'proposed' }, multipleMealsOverride: false },
        case: draftCase({ energyKcal: 300, fatG: 5, proteinG: 10 }),
        durationMs: 100,
        failure: null,
        proposal: {
          mealType: notStated,
          nutrition: {
            carbohydrateG: { reason: 'per_portion', status: 'withheld' },
            energyKcal: { excerpt: '300 kcal', status: 'proposed', value: 300 },
            fatG: { reason: 'ambiguous', status: 'withheld' },
            proteinG: { excerpt: 'protein 12 g', status: 'proposed', value: 12 },
          },
          outcome: 'draft',
          title: 'Soup',
        },
      },
      { audit: null, case: { ...draftCase({ energyKcal: 200 }), id: 'case-b' }, durationMs: 300, failure: 'timeout', proposal: null },
    ];
    const score = scoreMealDraftResults(results);
    expect(score.fields).toEqual({
      correctAccepted: 1,
      correctNull: 4,
      expectedValues: 4,
      incorrectAccepted: 1,
      missedByModel: 1,
      missedByOutcome: 1,
      missedByServer: 0,
      stoppedByServer: 1,
    });
    expect(score.incorrectAccepted).toEqual([{ actual: 12, expected: 10, field: 'proteinG', id: 'case-a' }]);
    expect(score.extraction).toEqual({ precision: 0.5, recall: 0.25 });
    expect(score.outcome).toEqual({ correct: 1, total: 2 });
    expect(score.failures).toEqual({ byReason: { timeout: 1 }, total: 1 });
    expect(score.latencyMs).toEqual({ max: 300, mean: 200, p50: 100, p95: 300 });
  });
});

describe('meal draft evaluation runner', () => {
  it('makes one call per case, never more than allowed, and stops after three identical systemic failures', async () => {
    const { dataset } = loadMealDraftDataset('development');
    let calls = 0;
    const failing: LlmProvider = {
      generateStructured: () => {
        calls += 1;
        return Promise.reject(new LlmProviderError('unavailable', true));
      },
      model: 'test',
    };
    const run = await runMealDraftEvaluation({ cases: dataset.cases, clock, maxCalls: 20, maxOutputTokens: 600, provider: failing, timeoutMs: 1_000 });
    expect(calls).toBe(3);
    expect(run.stopped).toEqual({ afterCases: 3, reason: 'provider_unavailable' });
    await expect(runMealDraftEvaluation({ cases: dataset.cases, clock, maxCalls: 41, maxOutputTokens: 600, provider: failing, timeoutMs: 1_000 })).rejects.toThrow(/maxCalls/u);
  });

  // Harness verification with the deterministic fake. It proves that the runner, the grounding and the scoring work
  // together; it is NOT evidence about any model (the fake copies numbers naively and the grounding withholds the rest).
  it.each(['development', 'heldout'] as const)('runs the %s set end to end with the fake provider, labelled as such', async (set) => {
    const { dataset, digest } = loadMealDraftDataset(set);
    const run = await runMealDraftEvaluation({ cases: dataset.cases, clock, maxCalls: 20, maxOutputTokens: 600, provider: new FakeMealDraftProvider(), timeoutMs: 5_000 });
    const report = buildMealDraftReport({ dataset, digest, generation: {}, model: 'fake', provider: 'fake', run, runtimeVersion: null, timeoutMs: 5_000 });
    expect(report.kind).toBe('fake-harness-verification');
    expect(report.executedCount).toBe(20);
    expect(report.calls).toBe(20);
    expect(report.partial).toBe(false);
    // The fake proposes every number it sees next to a unit; the grounding keeps all the wrong ones out.
    expect(report.score.fields.incorrectAccepted).toBe(0);
    expect(report.score.fields.stoppedByServer).toBeGreaterThan(0);
    expect(formatMealDraftReport(report)).toContain('FAKE PROVIDER: harness verification only. This is NOT evidence about any model.');
  });
});
