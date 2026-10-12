import {
  runSearchClarificationReasonSchema,
  runSearchUnsupportedReasonSchema,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { normalizeProposal } from '../runs/interpretation/interpretation-normalizer.js';
import { INTERPRETATION_PROMPT_VERSION } from '../runs/interpretation/interpretation-prompt.js';
import type { ProviderProposal } from '../runs/interpretation/interpretation-schema.js';
import {
  InterpreterFailure,
  type InterpretationInput,
  type InterpreterAnswer,
  type RunSearchInterpreter,
} from '../runs/interpretation/interpretation-types.js';
import {
  loadEvaluationDataset,
  type EvaluationCase,
} from './run-search-evaluation-dataset.js';
import { runEvaluation } from './run-search-evaluator.js';
import { scoreCase } from './run-search-scoring.js';

const dataset = loadEvaluationDataset();
const context = { now: new Date(dataset.now), timeZone: dataset.timeZone };

function proposalFor(testCase: EvaluationCase): ProviderProposal {
  const { expected } = testCase;
  const empty: ProviderProposal = {
    clarificationReason: null,
    distanceUnit: null,
    fromDate: null,
    maxDistance: null,
    minDistance: null,
    outcome: 'search',
    period: null,
    sort: null,
    toDate: null,
    unsupportedReason: null,
  };
  if (expected.outcome === 'clarify') {
    return { ...empty, clarificationReason: expected.reason, outcome: 'clarify' };
  }
  if (expected.outcome === 'unsupported') {
    return { ...empty, outcome: 'unsupported', unsupportedReason: expected.reason };
  }
  return {
    ...empty,
    distanceUnit: expected.distanceUnit,
    fromDate: expected.period.kind === 'dates' ? expected.period.fromDate : null,
    maxDistance: expected.maxDistance,
    minDistance: expected.minDistance,
    period: expected.period.kind === 'dates' ? 'dates' : expected.period.preset,
    sort: expected.sort,
    toDate: expected.period.kind === 'dates' ? expected.period.toDate : null,
  };
}

// An interpreter that knows the answers: the evaluator must score it perfectly, and every expectation in the
// dataset must be something the real pipeline would accept.
class OracleInterpreter implements RunSearchInterpreter {
  public readonly model = 'oracle';
  public calls = 0;
  readonly #byText = new Map(dataset.cases.map((entry) => [entry.text, entry]));

  public interpret(input: InterpretationInput): Promise<InterpreterAnswer> {
    this.calls += 1;
    const found = this.#byText.get(input.text);
    if (!found) {
      throw new Error('unknown text');
    }
    return Promise.resolve({ proposal: proposalFor(found), usage: { inputTokens: 100, outputTokens: 10 } });
  }
}

class StepClock {
  public now = 0;

  public monotonicNow(): number {
    this.now += 10;
    return this.now;
  }
}

describe('evaluation dataset', () => {
  it('is versioned and has at least forty cases in English and Russian', () => {
    expect(dataset.datasetVersion).toBe('1');
    expect(dataset.cases.length).toBeGreaterThanOrEqual(40);
    const languages = new Set(dataset.cases.map((entry) => entry.language));
    expect(languages).toEqual(new Set(['en', 'ru']));
    expect(dataset.cases.filter((entry) => entry.language === 'ru').length).toBeGreaterThanOrEqual(10);
  });

  it('has unique ids and unique texts', () => {
    expect(new Set(dataset.cases.map((entry) => entry.id)).size).toBe(dataset.cases.length);
    expect(new Set(dataset.cases.map((entry) => entry.text)).size).toBe(dataset.cases.length);
  });

  it('covers every kind of request the feature must handle', () => {
    const categories = new Set(dataset.cases.map((entry) => entry.category));
    for (const category of [
      'period-preset',
      'period-dates',
      'distance',
      'sort',
      'missing-information',
      'ambiguity',
      'contradiction',
      'negation',
      'strict-operator',
      'unsupported-feature',
      'prompt-injection',
    ]) {
      expect(categories, category).toContain(category);
    }
    expect(new Set(dataset.cases.map((entry) => entry.expected.outcome))).toEqual(
      new Set(['search', 'clarify', 'unsupported']),
    );
  });

  it('expects every clarification reason and every unsupported reason at least once', () => {
    const clarify = new Set(
      dataset.cases.flatMap((entry) => (entry.expected.outcome === 'clarify' ? [entry.expected.reason] : [])),
    );
    const unsupported = new Set(
      dataset.cases.flatMap((entry) => (entry.expected.outcome === 'unsupported' ? [entry.expected.reason] : [])),
    );
    expect([...clarify].sort()).toEqual([...runSearchClarificationReasonSchema.options].sort());
    expect([...unsupported].sort()).toEqual([...runSearchUnsupportedReasonSchema.options].sort());
  });

  it('has each of the three sort orders, miles and kilometres, and both period kinds', () => {
    const searches = dataset.cases.flatMap((entry) => (entry.expected.outcome === 'search' ? [entry.expected] : []));
    expect(new Set(searches.map((entry) => entry.sort ?? 'unspecified'))).toEqual(
      new Set(['newest', 'longest', 'shortest', 'unspecified']),
    );
    expect(new Set(searches.map((entry) => entry.distanceUnit))).toEqual(new Set(['km', 'mi', null]));
    expect(new Set(searches.map((entry) => entry.period.kind))).toEqual(new Set(['preset', 'dates']));
  });

  it('has expectations the real pipeline accepts, so a perfect interpreter can score fully', () => {
    for (const entry of dataset.cases) {
      expect(() => normalizeProposal(proposalFor(entry), context), entry.id).not.toThrow();
    }
  });
});

describe('semantic scoring', () => {
  const expectedSearch = {
    distanceUnit: 'km' as const,
    maxDistance: null,
    minDistance: '5',
    outcome: 'search' as const,
    period: { kind: 'preset' as const, preset: 'this-month' as const },
    sort: null,
  };
  const actual = (overrides: Record<string, unknown> = {}) => ({
    filters: {
      distanceUnit: 'km' as const,
      maxDistance: null,
      minDistance: '5',
      period: { kind: 'preset' as const, preset: 'this-month' as const },
      sort: 'newest' as const,
      timeZone: 'Europe/Warsaw',
      ...overrides,
    },
    outcome: 'search' as const,
  });

  it('treats an unspecified sort and the server default as the same meaning', () => {
    expect(scoreCase(expectedSearch, actual(), context)).toMatchObject({ filtersExact: true, outcomeCorrect: true });
  });

  it('treats a preset and the explicit dates it resolves to as the same period', () => {
    const explicit = actual({ period: { fromDate: '2026-10-01', kind: 'dates', toDate: '2026-10-31' } });
    expect(scoreCase(expectedSearch, explicit, context).filtersExact).toBe(true);
    const off = actual({ period: { fromDate: '2026-10-01', kind: 'dates', toDate: '2026-10-30' } });
    expect(scoreCase(expectedSearch, off, context)).toMatchObject({ fieldErrors: ['period'], filtersExact: false });
  });

  it('compares distances by meaning and reports the field that differs', () => {
    expect(scoreCase(expectedSearch, actual({ minDistance: '5.000' }), context).filtersExact).toBe(true);
    expect(scoreCase(expectedSearch, actual({ minDistance: '6' }), context).fieldErrors).toEqual(['minDistance']);
    expect(scoreCase(expectedSearch, actual({ maxDistance: '9' }), context).fieldErrors).toEqual(['maxDistance']);
    // The same number in another unit is a different distance, not a formatting difference.
    expect(
      scoreCase(expectedSearch, actual({ distanceUnit: 'mi' }), context).fieldErrors,
    ).toEqual(['minDistance']);
  });

  it('reports every wrong field, and a wrong sort', () => {
    const score = scoreCase(
      expectedSearch,
      actual({ maxDistance: '8', minDistance: '4', sort: 'longest' }),
      context,
    );
    expect(score.fieldErrors).toEqual(['minDistance', 'maxDistance', 'sort']);
  });

  it('scores a clarification by outcome and by reason separately', () => {
    const expected = { outcome: 'clarify' as const, reason: 'period_missing' as const };
    expect(scoreCase(expected, { outcome: 'clarify', reason: 'period_missing' }, context)).toMatchObject({
      outcomeCorrect: true,
      reasonCorrect: true,
    });
    expect(scoreCase(expected, { outcome: 'clarify', reason: 'period_ambiguous' }, context)).toMatchObject({
      outcomeCorrect: true,
      reasonCorrect: false,
    });
    expect(scoreCase(expected, { outcome: 'unsupported', reason: 'location' }, context)).toMatchObject({
      outcomeCorrect: false,
      reasonCorrect: false,
    });
  });

  it('counts a search where a clarification was expected as a wrong outcome', () => {
    const expected = { outcome: 'clarify' as const, reason: 'distance_boundary_strict' as const };
    expect(scoreCase(expected, actual(), context)).toMatchObject({ outcomeCorrect: false, reasonCorrect: false });
  });
});

describe('evaluator', () => {
  it('scores a perfect interpreter fully, with one call per case and the usage summed', async () => {
    const interpreter = new OracleInterpreter();
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter });

    expect(interpreter.calls).toBe(dataset.cases.length);
    expect(report).toMatchObject({
      caseCount: dataset.cases.length,
      datasetVersion: '1',
      exactFilterAccuracy: 1,
      executedCount: dataset.cases.length,
      model: 'oracle',
      outcomeAccuracy: 1,
      promptVersion: INTERPRETATION_PROMPT_VERSION,
      reasonAccuracy: 1,
    });
    expect(report.failures).toEqual({ byReason: {}, total: 0 });
    expect(report.fieldErrors).toEqual({ maxDistance: 0, minDistance: 0, period: 0, sort: 0 });
    expect(report.usage).toEqual({
      callsWithUsage: dataset.cases.length,
      inputTokens: 100 * dataset.cases.length,
      outputTokens: 10 * dataset.cases.length,
    });
    expect(report.mismatches).toEqual([]);
  });

  it('measures latency per call', async () => {
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter: new OracleInterpreter() });
    expect(report.latencyMs).toEqual({ max: 10, mean: 10, p50: 10, p95: 10 });
  });

  it('never makes more calls than the cap, and keeps the order of the dataset', async () => {
    const interpreter = new OracleInterpreter();
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter, maxCases: 7 });
    expect(interpreter.calls).toBe(7);
    expect(report.executedCount).toBe(7);
    expect(report.caseCount).toBe(dataset.cases.length);
  });

  it('runs at most the requested number of calls at the same time', async () => {
    let active = 0;
    let peak = 0;
    const interpreter: RunSearchInterpreter = {
      interpret: async (input) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const found = dataset.cases.find((entry) => entry.text === input.text)!;
        return { proposal: proposalFor(found), usage: null };
      },
      model: 'timed',
    };
    await runEvaluation({ clock: new StepClock(), concurrency: 3, dataset, interpreter, maxCases: 12 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('counts a failure as a wrong answer with its reason, and goes on', async () => {
    const oracle = new OracleInterpreter();
    let count = 0;
    const interpreter: RunSearchInterpreter = {
      interpret: (input) => {
        count += 1;
        if (count === 1) return Promise.reject(new InterpreterFailure('refusal'));
        if (count === 2) return Promise.reject(new InterpreterFailure('timeout'));
        return oracle.interpret(input);
      },
      model: 'flaky',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter, maxCases: 5 });
    expect(report.failures).toEqual({ byReason: { refusal: 1, timeout: 1 }, total: 2 });
    expect(report.executedCount).toBe(5);
    expect(report.outcomeAccuracy).toBeCloseTo(3 / 5);
  });

  it('turns a well-formed but invalid answer into an invalid_output failure', async () => {
    const interpreter: RunSearchInterpreter = {
      interpret: () =>
        Promise.resolve({
          proposal: {
            clarificationReason: null,
            distanceUnit: 'km',
            fromDate: null,
            maxDistance: '2',
            minDistance: '9',
            outcome: 'search',
            period: 'this-month',
            sort: null,
            toDate: null,
            unsupportedReason: null,
          },
          usage: null,
        }),
      model: 'invalid',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter, maxCases: 3 });
    expect(report.failures.byReason).toEqual({ invalid_output: 3 });
  });

  it('records which cases were wrong and how, without any model text', async () => {
    const interpreter: RunSearchInterpreter = {
      interpret: (input) => {
        const found = dataset.cases.find((entry) => entry.text === input.text)!;
        const proposal = proposalFor(found);
        return Promise.resolve({
          proposal: found.expected.outcome === 'search' ? { ...proposal, sort: 'shortest' } : proposal,
          usage: null,
        });
      },
      model: 'sorter',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter });
    expect(report.exactFilterAccuracy).toBeLessThan(1);
    expect(report.fieldErrors.sort).toBeGreaterThan(0);
    expect(report.fieldErrors.period).toBe(0);
    expect(report.mismatches[0]).toEqual(
      expect.objectContaining({ actualOutcome: 'search', fieldErrors: ['sort'] }),
    );
    expect(Object.keys(report.mismatches[0]!).sort()).toEqual(
      ['actualOutcome', 'actualReason', 'expectedOutcome', 'expectedReason', 'fieldErrors', 'id'].sort(),
    );
  });

  it('breaks accuracy down by category', async () => {
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter: new OracleInterpreter() });
    expect(report.byCategory['prompt-injection']).toMatchObject({ cases: 6, outcomeCorrect: 6 });
    expect(Object.values(report.byCategory).reduce((sum, entry) => sum + entry.cases, 0)).toBe(
      dataset.cases.length,
    );
  });

  it('stops waiting for a call that never answers, and counts it as a timeout', async () => {
    const interpreter: RunSearchInterpreter = {
      interpret: () => new Promise(() => undefined),
      model: 'hang',
    };
    const report = await runEvaluation({
      callTimeoutMs: 20,
      clock: new StepClock(),
      dataset,
      interpreter,
      maxCases: 2,
    });
    expect(report.failures.byReason).toEqual({ timeout: 2 });
  });
});
