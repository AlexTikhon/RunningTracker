import {
  runSearchClarificationReasonSchema,
  runSearchUnsupportedReasonSchema,
} from '@running-tracker/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { evaluateAcceptance, formatAcceptance } from './run-search-evaluation-cli.js';
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
      cachedInputTokens: 0,
      callsWithReasoningDetail: 0,
      callsWithUsage: dataset.cases.length,
      inputTokens: 100 * dataset.cases.length,
      outputTokens: 10 * dataset.cases.length,
      reasoningTokens: 0,
    });
    expect(report.mismatches).toEqual([]);
    expect(report).toMatchObject({ aborted: null, partial: false });
    expect(report.executedIds).toEqual(dataset.cases.map((entry) => entry.id));
    expect(report.incorrectAcceptances).toEqual({
      ids: [],
      ofCases: dataset.cases.filter((entry) => entry.expected.outcome !== 'search').length,
      total: 0,
    });
  });

  it('sums reasoning and cached tokens only where a call reported them', async () => {
    const oracle = new OracleInterpreter();
    let count = 0;
    const interpreter: RunSearchInterpreter = {
      interpret: async (input) => {
        count += 1;
        const answer = await oracle.interpret(input);
        return count === 1
          ? { ...answer, usage: { cachedInputTokens: 40, inputTokens: 100, outputTokens: 70, reasoningTokens: 60 } }
          : { ...answer, usage: { cachedInputTokens: null, inputTokens: 100, outputTokens: 10, reasoningTokens: null } };
      },
      model: 'reasoner',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter, maxCases: 3 });
    expect(report.usage).toEqual({
      cachedInputTokens: 40,
      callsWithReasoningDetail: 1,
      callsWithUsage: 3,
      inputTokens: 300,
      outputTokens: 90,
      reasoningTokens: 60,
    });
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

  it('reports numerators and denominators per language, the Russian cases apart from the English ones', async () => {
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter: new OracleInterpreter() });
    for (const language of ['en', 'ru'] as const) {
      const entries = dataset.cases.filter((entry) => entry.language === language);
      const searches = entries.filter((entry) => entry.expected.outcome === 'search').length;
      expect(report.byLanguage[language], language).toEqual({
        cases: entries.length,
        exactFilters: { correct: searches, total: searches },
        failures: 0,
        outcome: { correct: entries.length, total: entries.length },
        reason: { correct: entries.length - searches, total: entries.length - searches },
      });
    }
    expect(report.counts.outcome).toEqual({ correct: dataset.cases.length, total: dataset.cases.length });
  });

  it('keeps a failed call in every denominator, so a model that answers nothing scores zero and not "n/a"', async () => {
    const interpreter: RunSearchInterpreter = {
      interpret: () => Promise.reject(new InterpreterFailure('refusal')),
      model: 'silent',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter });
    const searches = dataset.cases.filter((entry) => entry.expected.outcome === 'search').length;
    expect(report.counts).toEqual({
      exactFilters: { correct: 0, total: searches },
      outcome: { correct: 0, total: dataset.cases.length },
      reason: { correct: 0, total: dataset.cases.length - searches },
    });
    expect(report).toMatchObject({ exactFilterAccuracy: 0, outcomeAccuracy: 0, reasonAccuracy: 0 });
    expect(report.failures.byReason).toEqual({ refusal: dataset.cases.length });
    expect(report.byLanguage.ru!.failures).toBe(dataset.cases.filter((entry) => entry.language === 'ru').length);
    // A category whose search cases all failed shows 0 exact filters, not an absent figure.
    expect(report.byCategory['period-preset']).toMatchObject({ exactFilters: 0, outcomeCorrect: 0 });
    // A refusal is measured, never a reason to stop spending calls.
    expect(report.aborted).toBeNull();
    expect(report.executedCount).toBe(dataset.cases.length);
  });

  it('keeps a wrong outcome in exact-filter accuracy instead of dropping the case', async () => {
    const interpreter: RunSearchInterpreter = {
      interpret: (input) => {
        const found = dataset.cases.find((entry) => entry.text === input.text)!;
        const proposal = proposalFor(found);
        return Promise.resolve({
          proposal:
            found.expected.outcome === 'search'
              ? { ...proposal, clarificationReason: 'period_missing', distanceUnit: null, fromDate: null, maxDistance: null, minDistance: null, outcome: 'clarify', period: null, sort: null, toDate: null }
              : proposal,
          usage: null,
        });
      },
      model: 'over-cautious',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter });
    const searches = dataset.cases.filter((entry) => entry.expected.outcome === 'search').length;
    expect(report.counts.exactFilters).toEqual({ correct: 0, total: searches });
    expect(report.exactFilterAccuracy).toBe(0);
    expect(report.outcomeMatrix.search).toEqual({ clarify: searches, failure: 0, search: 0, unsupported: 0 });
    expect(report.incorrectAcceptances.total).toBe(0);
  });

  it('records a dropped unsupported condition as an incorrect acceptance, not as a lesser success', async () => {
    const interpreter: RunSearchInterpreter = {
      interpret: (input) => {
        const found = dataset.cases.find((entry) => entry.text === input.text)!;
        // Answers "this month's runs of at least 5 km, in Berlin" with the search and quietly forgets Berlin.
        const droppedLocation = found.id === 'en-supported-plus-location';
        return Promise.resolve({
          proposal: droppedLocation
            ? {
                clarificationReason: null,
                distanceUnit: 'km',
                fromDate: null,
                maxDistance: null,
                minDistance: '5',
                outcome: 'search',
                period: 'this-month',
                sort: null,
                toDate: null,
                unsupportedReason: null,
              }
            : proposalFor(found),
          usage: null,
        });
      },
      model: 'forgetful',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter });
    expect(report.incorrectAcceptances.ids).toEqual(['en-supported-plus-location']);
    expect(report.incorrectAcceptances.total).toBe(1);
    expect(report.outcomeMatrix.unsupported.search).toBe(1);
    expect(report.counts.outcome.correct).toBe(dataset.cases.length - 1);
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        actualOutcome: 'search',
        expectedOutcome: 'unsupported',
        expectedReason: 'location',
        id: 'en-supported-plus-location',
      }),
    ]);
  });

  it('runs exactly the cases asked for, in dataset order, and says the run is partial', async () => {
    const interpreter = new OracleInterpreter();
    const ids = ['ru-location', 'en-last-month-min-longest', 'en-strict-more-than'];
    const report = await runEvaluation({ caseIds: ids, clock: new StepClock(), dataset, interpreter });
    const expectedOrder = dataset.cases.map((entry) => entry.id).filter((id) => ids.includes(id));
    expect(interpreter.calls).toBe(3);
    expect(report.executedIds).toEqual(expectedOrder);
    expect(report).toMatchObject({ aborted: null, caseCount: dataset.cases.length, executedCount: 3, partial: true });
    expect(report.counts.outcome).toEqual({ correct: 3, total: 3 });
  });

  it('refuses an unknown case id before any call is made', async () => {
    const interpreter = new OracleInterpreter();
    await expect(
      runEvaluation({ caseIds: ['en-last-month-min-longest', 'no-such-case'], clock: new StepClock(), dataset, interpreter }),
    ).rejects.toThrow(/no-such-case/u);
    expect(interpreter.calls).toBe(0);
  });

  it('stops after three identical systemic failures in a row and does not spend the rest of the budget', async () => {
    let calls = 0;
    const interpreter: RunSearchInterpreter = {
      interpret: () => {
        calls += 1;
        return Promise.reject(new InterpreterFailure('provider_error'));
      },
      model: 'rejected-key',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter });
    expect(calls).toBe(3);
    expect(report.aborted).toEqual({ afterCases: 3, consecutive: 3, reason: 'provider_error' });
    expect(report).toMatchObject({ caseCount: dataset.cases.length, executedCount: 3, partial: true });
    expect(report.failures).toEqual({ byReason: { provider_error: 3 }, total: 3 });
  });

  it('does not stop for failures that differ, that are interrupted by an answer, or that are measurements', async () => {
    const oracle = new OracleInterpreter();
    const script: Array<string | null> = [
      'timeout', 'provider_error', 'timeout', // different reasons
      'provider_error', 'provider_error', null, // interrupted by a good answer
      'provider_error', 'provider_error', 'invalid_output', 'invalid_output', 'invalid_output', 'invalid_output', // measured
    ];
    let count = 0;
    const interpreter: RunSearchInterpreter = {
      interpret: (input) => {
        const step = script[count] ?? null;
        count += 1;
        return step === null ? oracle.interpret(input) : Promise.reject(new InterpreterFailure(step as 'timeout'));
      },
      model: 'uneven',
    };
    const report = await runEvaluation({ clock: new StepClock(), dataset, interpreter, maxCases: script.length });
    expect(report.aborted).toBeNull();
    expect(report.executedCount).toBe(script.length);
  });

  it('starts nothing new once it has stopped, even with calls in flight', async () => {
    let calls = 0;
    const interpreter: RunSearchInterpreter = {
      interpret: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new InterpreterFailure('timeout');
      },
      model: 'slow-and-broken',
    };
    const report = await runEvaluation({ clock: new StepClock(), concurrency: 4, dataset, interpreter });
    expect(report.aborted).toMatchObject({ reason: 'timeout' });
    // Three failed to reach the streak; at most the three other workers' calls were already in flight.
    expect(calls).toBeLessThanOrEqual(3 + 3);
    expect(report.executedCount).toBe(calls);
  });

});

// A call the test settles by hand, so the number of operations still alive is observable at every instant.
interface ControlledCall {
  reject: (reason: Error) => void;
  resolve: (answer: InterpreterAnswer) => void;
  settled: boolean;
  signal: AbortSignal | undefined;
  text: string;
}

class ControlledInterpreter implements RunSearchInterpreter {
  public readonly model = 'controlled';
  public readonly calls: ControlledCall[] = [];
  public active = 0;
  public peak = 0;
  /** When set, an operation rejects as soon as it is asked to cancel; otherwise it ignores the signal. */
  public cooperative = false;

  public interpret(input: InterpretationInput, options?: { signal?: AbortSignal }): Promise<InterpreterAnswer> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    return new Promise<InterpreterAnswer>((resolve, reject) => {
      const call: ControlledCall = {
        reject: (reason) => {
          if (!call.settled) {
            call.settled = true;
            this.active -= 1;
            reject(reason);
          }
        },
        resolve: (answer) => {
          if (!call.settled) {
            call.settled = true;
            this.active -= 1;
            resolve(answer);
          }
        },
        settled: false,
        signal: options?.signal,
        text: input.text,
      };
      this.calls.push(call);
      if (this.cooperative) {
        options?.signal?.addEventListener('abort', () => call.reject(new InterpreterFailure('timeout')));
      }
    });
  }
}

function answerFor(text: string): InterpreterAnswer {
  return { proposal: proposalFor(dataset.cases.find((entry) => entry.text === text)!), usage: null };
}

describe('evaluator operation lifetime', () => {
  const CALL_TIMEOUT_MS = 20;
  const DRAIN_MS = 50;
  const clock = { monotonicNow: () => Date.now() };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.useRealTimers();
  });

  function start(
    interpreter: RunSearchInterpreter,
    overrides: Partial<Parameters<typeof runEvaluation>[0]> = {},
  ): { finished: () => boolean; report: Promise<Awaited<ReturnType<typeof runEvaluation>>> } {
    let isFinished = false;
    const report = runEvaluation({
      callTimeoutMs: CALL_TIMEOUT_MS,
      cancellationDrainMs: DRAIN_MS,
      clock,
      dataset,
      interpreter,
      maxCases: 3,
      ...overrides,
    }).finally(() => {
      isFinished = true;
    });
    return { finished: () => isFinished, report };
  }

  it('keeps the only slot of concurrency 1 occupied by an operation that ignores cancellation', async () => {
    const interpreter = new ControlledInterpreter();
    const { report } = start(interpreter);

    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + DRAIN_MS);
    const result = await report;

    expect(interpreter.calls).toHaveLength(1);
    expect(interpreter.active).toBe(1);
    expect(interpreter.peak).toBe(1);
    expect(result.executedIds).toEqual([dataset.cases[0]!.id]);
    expect(result.failures.byReason).toEqual({ timeout: 1 });
    expect(result.unsettled).toEqual({ caseIds: [dataset.cases[0]!.id], count: 1 });
    expect(result.partial).toBe(true);
  });

  it('never has more unsettled operations than the concurrency of 2, and stops when both are stuck', async () => {
    const interpreter = new ControlledInterpreter();
    const { report } = start(interpreter, { concurrency: 2, maxCases: 6 });

    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + DRAIN_MS);
    const result = await report;

    expect(interpreter.calls).toHaveLength(2);
    expect(interpreter.active).toBe(2);
    expect(interpreter.peak).toBe(2);
    expect(result.unsettled.count).toBe(2);
    expect(result.unsettled.caseIds).toEqual([dataset.cases[0]!.id, dataset.cases[1]!.id]);
    expect(result.executedCount).toBe(2);
  });

  it('keeps the slot at the deadline, requests cancellation, and goes on only once the operation has settled', async () => {
    const interpreter = new ControlledInterpreter();
    const { report } = start(interpreter);
    await vi.advanceTimersByTimeAsync(0);
    expect(interpreter.calls).toHaveLength(1);
    expect(interpreter.calls[0]!.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    // The case has timed out and cancellation was asked for, but the operation is alive: no new call.
    expect(interpreter.calls[0]!.signal?.aborted).toBe(true);
    expect(interpreter.calls).toHaveLength(1);
    expect(interpreter.active).toBe(1);

    await vi.advanceTimersByTimeAsync(DRAIN_MS - 1);
    expect(interpreter.calls).toHaveLength(1);

    interpreter.calls[0]!.reject(new InterpreterFailure('timeout'));
    await vi.advanceTimersByTimeAsync(0);
    expect(interpreter.calls).toHaveLength(2);
    expect(interpreter.active).toBe(1);

    interpreter.calls[1]!.resolve(answerFor(interpreter.calls[1]!.text));
    await vi.advanceTimersByTimeAsync(0);
    expect(interpreter.calls).toHaveLength(3);
    interpreter.calls[2]!.resolve(answerFor(interpreter.calls[2]!.text));

    const result = await report;
    expect(interpreter.peak).toBe(1);
    expect(interpreter.active).toBe(0);
    expect(result.unsettled).toEqual({ caseIds: [], count: 0 });
    expect(result.executedCount).toBe(3);
    expect(result.failures.byReason).toEqual({ timeout: 1 });
    expect(result.counts.outcome).toEqual({ correct: 2, total: 3 });
    // The measured latency of the case is its deadline, not the deadline plus the time spent draining.
    expect(result.latencyMs.max).toBe(CALL_TIMEOUT_MS);
  });

  it('lets cooperative cancellation through to the next cases without waiting for the drain interval', async () => {
    const interpreter = new ControlledInterpreter();
    interpreter.cooperative = true;
    const { report } = start(interpreter);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    expect(interpreter.calls).toHaveLength(2);
    interpreter.calls[1]!.resolve(answerFor(interpreter.calls[1]!.text));
    await vi.advanceTimersByTimeAsync(0);
    interpreter.calls[2]!.resolve(answerFor(interpreter.calls[2]!.text));

    const result = await report;
    expect(interpreter.peak).toBe(1);
    expect(result.unsettled.count).toBe(0);
    expect(result.executedCount).toBe(3);
    expect(result.failures.byReason).toEqual({ timeout: 1 });
  });

  it('returns within the deadline plus the drain interval when cancellation is ignored', async () => {
    const interpreter = new ControlledInterpreter();
    const { finished, report } = start(interpreter);

    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + DRAIN_MS - 1);
    expect(finished()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(finished()).toBe(true);
    await report;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is not changed by an operation that succeeds or fails after the report was returned', async () => {
    const interpreter = new ControlledInterpreter();
    const { report } = start(interpreter, { concurrency: 2, maxCases: 4 });
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + DRAIN_MS);
    const result = await report;
    const before = structuredClone(result);

    interpreter.calls[0]!.resolve(answerFor(interpreter.calls[0]!.text));
    interpreter.calls[1]!.reject(new InterpreterFailure('refusal'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(result).toEqual(before);
    expect(interpreter.calls).toHaveLength(2);
    expect(unhandled).toEqual([]);
    expect(result.failures).toEqual({ byReason: { timeout: 2 }, total: 2 });
  });

  it('counts a synchronous throw and an immediate rejection once each, and frees the slot at once', async () => {
    let active = 0;
    let peak = 0;
    let count = 0;
    const interpreter: RunSearchInterpreter = {
      interpret: (input) => {
        count += 1;
        active += 1;
        peak = Math.max(peak, active);
        try {
          if (count === 1) {
            throw new Error('boom');
          }
          return count === 2
            ? Promise.reject(new InterpreterFailure('refusal'))
            : Promise.resolve(answerFor(input.text));
        } finally {
          active -= 1;
        }
      },
      model: 'immediate',
    };
    const { report } = start(interpreter);
    const result = await report;

    expect(count).toBe(3);
    expect(peak).toBe(1);
    expect(result.executedIds).toEqual(dataset.cases.slice(0, 3).map((entry) => entry.id));
    expect(result.failures).toEqual({ byReason: { provider_error: 1, refusal: 1 }, total: 2 });
    expect(result.counts.outcome).toEqual({ correct: 1, total: 3 });
    expect(result.unsettled).toEqual({ caseIds: [], count: 0 });
    expect(unhandled).toEqual([]);
  });

  it('stops waiting for a call that never answers, counts it as a timeout, and does not start another', async () => {
    const interpreter: RunSearchInterpreter = {
      interpret: () => new Promise(() => undefined),
      model: 'hang',
    };
    const { report } = start(interpreter, { maxCases: 2 });
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + DRAIN_MS);
    const result = await report;
    expect(result.failures.byReason).toEqual({ timeout: 1 });
    expect(result.executedCount).toBe(1);
    expect(result.unsettled.count).toBe(1);
  });

  it('does not accept a run with an operation that outlived its cancellation, even for a one-case selection', async () => {
    const interpreter = new ControlledInterpreter();
    const { report } = start(interpreter, { maxCases: 1 });
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + DRAIN_MS);
    const result = await report;
    const selected = [dataset.cases[0]!.id];

    const acceptance = evaluateAcceptance(result, selected);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toMatch(/unsettled/iu);
    expect(acceptance.failures.join('\n')).toContain(selected[0]);
  });
});

describe('semantic acceptance of a run', () => {
  const idsOf = (count: number): string[] => dataset.cases.slice(0, count).map((entry) => entry.id);
  const run = (interpreter: RunSearchInterpreter, options: Partial<Parameters<typeof runEvaluation>[0]> = {}) =>
    runEvaluation({ clock: new StepClock(), dataset, interpreter, ...options });
  // Answers every case exactly, except where `override` returns something else.
  function answering(
    override: (found: EvaluationCase, proposal: ProviderProposal) => ProviderProposal | InterpreterFailure | null,
  ): RunSearchInterpreter {
    return {
      interpret: (input) => {
        const found = dataset.cases.find((entry) => entry.text === input.text)!;
        const proposal = proposalFor(found);
        const changed = override(found, proposal);
        if (changed instanceof InterpreterFailure) {
          return Promise.reject(changed);
        }
        return Promise.resolve({ proposal: changed ?? proposal, usage: null });
      },
      model: 'acceptance-double',
    };
  }
  const firstCaseWhere = (outcome: 'clarify' | 'search' | 'unsupported'): EvaluationCase =>
    dataset.cases.find((entry) => entry.expected.outcome === outcome)!;

  it('passes a complete selection of exact answers, and says what a pass is about', async () => {
    const report = await run(new OracleInterpreter());
    const acceptance = evaluateAcceptance(report, dataset.cases.map((entry) => entry.id));

    expect(acceptance).toMatchObject({ failures: [], passed: true, scope: 'selected-synthetic-cases' });
    expect(acceptance.selectedIds).toEqual(dataset.cases.map((entry) => entry.id));
    expect(acceptance.statement).toMatch(/selected synthetic cases/iu);
    expect(acceptance.statement).toMatch(/not .*(general model quality|production)/iu);
    expect(formatAcceptance(acceptance)).toContain('ACCEPTANCE PASSED');
  });

  it('passes a complete subset although the report is partial relative to the whole dataset', async () => {
    const selected = idsOf(5);
    const report = await run(new OracleInterpreter(), { caseIds: selected });

    expect(report.partial).toBe(true);
    expect(report.executedCount).toBe(5);
    expect(evaluateAcceptance(report, selected)).toMatchObject({ failures: [], passed: true, selectedIds: selected });
  });

  it('fails a wrong outcome', async () => {
    const target = firstCaseWhere('search');
    const report = await run(
      answering((found, proposal) =>
        found.id === target.id
          ? { ...proposal, clarificationReason: 'period_missing', outcome: 'clarify', period: null }
          : proposal,
      ),
      { caseIds: [target.id] },
    );
    const acceptance = evaluateAcceptance(report, [target.id]);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toContain(target.id);
    expect(formatAcceptance(acceptance)).toContain('ACCEPTANCE FAILED');
  });

  it('fails a right outcome with the wrong reason', async () => {
    const target = firstCaseWhere('clarify');
    const wrong = target.expected.outcome === 'clarify' && target.expected.reason === 'period_missing' ? 'period_ambiguous' : 'period_missing';
    const report = await run(
      answering((found, proposal) => (found.id === target.id ? { ...proposal, clarificationReason: wrong } : proposal)),
      { caseIds: [target.id] },
    );
    expect(report.counts.outcome).toEqual({ correct: 1, total: 1 });
    const acceptance = evaluateAcceptance(report, [target.id]);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toContain(target.id);
  });

  it('fails a right outcome with a wrong filter', async () => {
    const target = firstCaseWhere('search');
    const report = await run(
      answering((found, proposal) => (found.id === target.id ? { ...proposal, sort: proposal.sort === 'shortest' ? 'longest' : 'shortest' } : proposal)),
      { caseIds: [target.id] },
    );
    expect(report.counts.outcome).toEqual({ correct: 1, total: 1 });
    const acceptance = evaluateAcceptance(report, [target.id]);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toMatch(/sort/u);
  });

  it('fails a dropped unsupported condition, en-location, as a search nobody asked for', async () => {
    const report = await run(
      answering((found) =>
        found.id === 'en-location'
          ? {
              clarificationReason: null,
              distanceUnit: 'km',
              fromDate: null,
              maxDistance: null,
              minDistance: '5',
              outcome: 'search',
              period: 'this-month',
              sort: null,
              toDate: null,
              unsupportedReason: null,
            }
          : null,
      ),
      { caseIds: ['en-location'] },
    );
    expect(report.incorrectAcceptances.ids).toEqual(['en-location']);
    const acceptance = evaluateAcceptance(report, ['en-location']);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toMatch(/en-location/u);
    expect(acceptance.failures.join('\n')).toMatch(/search/u);
  });

  it('fails a provider failure such as a timeout', async () => {
    const selected = idsOf(2);
    const report = await run(answering(() => new InterpreterFailure('timeout')), { caseIds: selected });
    const acceptance = evaluateAcceptance(report, selected);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toMatch(/timeout/u);
  });

  it('fails a run that stopped early, naming why it stopped', async () => {
    const selected = idsOf(10);
    const report = await run(answering(() => new InterpreterFailure('provider_error')), { caseIds: selected });
    expect(report.aborted).not.toBeNull();
    const acceptance = evaluateAcceptance(report, selected);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toMatch(/stopped early/iu);
    expect(acceptance.failures.join('\n')).toMatch(/provider_error/u);
  });

  it('fails when a selected case was not executed, and when a case that was not selected was', async () => {
    const report = await run(new OracleInterpreter(), { caseIds: idsOf(3) });
    const missing = evaluateAcceptance(report, idsOf(5));
    expect(missing.passed).toBe(false);
    expect(missing.failures.join('\n')).toMatch(/not executed/iu);
    expect(missing.failures.join('\n')).toContain(idsOf(5)[4]);

    const unexpected = evaluateAcceptance(report, idsOf(2));
    expect(unexpected.passed).toBe(false);
    expect(unexpected.failures.join('\n')).toMatch(/not selected/iu);
  });

  it('fails a case that the report says was executed twice', async () => {
    const selected = idsOf(3);
    const report = await run(new OracleInterpreter(), { caseIds: selected });
    const duplicated = { ...report, executedCount: 4, executedIds: [...report.executedIds, selected[0]!] };
    const acceptance = evaluateAcceptance(duplicated, selected);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.join('\n')).toMatch(/more than once|twice/iu);
  });

  it('refuses to accept an empty selection', async () => {
    const report = await run(new OracleInterpreter(), { caseIds: idsOf(1) });
    expect(evaluateAcceptance(report, []).passed).toBe(false);
  });

  it('does not mutate the report and keeps its list of reasons short and bounded', async () => {
    const report = await run(answering(() => new InterpreterFailure('refusal')));
    const before = structuredClone(report);
    const acceptance = evaluateAcceptance(report, dataset.cases.map((entry) => entry.id));
    expect(report).toEqual(before);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.length).toBeGreaterThan(0);
    expect(acceptance.failures.length).toBeLessThanOrEqual(10);
    for (const failure of acceptance.failures) {
      expect(failure.length).toBeLessThanOrEqual(300);
    }
    // The failing cases are named, but only a handful of them, so a whole-dataset failure stays readable.
    expect(JSON.stringify(acceptance).length).toBeLessThan(4_000);
  });
});
