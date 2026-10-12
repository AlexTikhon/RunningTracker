import type { RunSearchInterpretationResponse } from '@running-tracker/contracts';

import type { Clock } from '../clock.js';
import { normalizeProposal, ProposalRejectedError } from '../runs/interpretation/interpretation-normalizer.js';
import { INTERPRETATION_PROMPT_VERSION } from '../runs/interpretation/interpretation-prompt.js';
import {
  InterpreterFailure,
  type InterpreterAnswer,
  type RunSearchInterpreter,
} from '../runs/interpretation/interpretation-types.js';
import { localDateOf } from '../runs/run-search-period.js';
import type { EvaluationCase, EvaluationDataset } from './run-search-evaluation-dataset.js';
import { FILTER_FIELDS, scoreCase, type FilterField } from './run-search-scoring.js';

export const EVALUATION_MAX_CONCURRENCY = 4;
export const EVALUATION_DEFAULT_CALL_TIMEOUT_MS = 12_000;
/** Identical systemic failures in a row after which a run stops spending calls: 3 is evidence, not noise. */
export const EVALUATION_SYSTEMIC_FAILURE_STREAK = 3;

// Failures that say the configuration, the credential, the model's availability, the transport or the output budget
// does not work, and will not work for the next case either. A refusal or an answer the contract rejects is what the
// model did with one request: that is measured, so it never stops a run.
const SYSTEMIC_FAILURES: ReadonlySet<string> = new Set([
  'incomplete',
  'oversized',
  'provider_error',
  'provider_rate_limited',
  'timeout',
]);

export interface EvaluationOptions {
  /** Hard deadline for one call, response included. */
  callTimeoutMs?: number;
  /** Run exactly these cases, in dataset order. An id the dataset does not have is an error before any call. */
  caseIds?: readonly string[];
  clock: Pick<Clock, 'monotonicNow'>;
  concurrency?: number;
  dataset: EvaluationDataset;
  interpreter: RunSearchInterpreter;
  /** Run only the first N of the selected cases: the call budget of one evaluation. */
  maxCases?: number;
  onCase?: (progress: { done: number; id: string; total: number }) => void;
  /** Stop starting cases after this many identical systemic failures in a row. */
  stopAfterSystemicFailures?: number;
}

export interface Mismatch {
  actualOutcome: string;
  actualReason: string | null;
  expectedOutcome: string;
  expectedReason: string | null;
  fieldErrors: FilterField[];
  id: string;
}

export interface Tally {
  correct: number;
  total: number;
}

export type ExpectedOutcome = 'clarify' | 'search' | 'unsupported';
export type ActualOutcome = ExpectedOutcome | 'failure';

export interface GroupResult {
  cases: number;
  exactFilters: Tally;
  failures: number;
  outcome: Tally;
  reason: Tally;
}

export interface EvaluationReport {
  /** Set when the run stopped itself after identical systemic failures; the report is then partial. */
  aborted: { afterCases: number; consecutive: number; reason: string } | null;
  byCategory: Record<string, { cases: number; exactFilters: number | null; outcomeCorrect: number }>;
  byLanguage: Record<string, GroupResult>;
  caseCount: number;
  /** The same numbers as the three accuracies, with their denominators. A failed call is in every denominator. */
  counts: { exactFilters: Tally; outcome: Tally; reason: Tally };
  datasetVersion: string;
  /** Cases a call was started for. Each is exactly one dispatch: there are no retries. */
  executedCount: number;
  executedIds: string[];
  exactFilterAccuracy: number | null;
  failures: { byReason: Record<string, number>; total: number };
  fieldErrors: Record<FilterField, number>;
  /**
   * Requests that needed a clarification or are unsupported but were answered as a search: the product would have
   * run a query that is not what the person asked. `ofCases` is how many such requests were executed.
   */
  incorrectAcceptances: { ids: string[]; ofCases: number; total: number };
  latencyMs: { max: number; mean: number; p50: number; p95: number };
  mismatches: Mismatch[];
  model: string;
  outcomeAccuracy: number;
  /** Expected outcome (rows) against what happened (columns); a failed call is its own column. */
  outcomeMatrix: Record<ExpectedOutcome, Record<ActualOutcome, number>>;
  /** True unless every case of the dataset was executed. */
  partial: boolean;
  promptVersion: string;
  reasonAccuracy: number | null;
  usage: {
    cachedInputTokens: number;
    callsWithReasoningDetail: number;
    callsWithUsage: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
}

interface CaseResult {
  answer: RunSearchInterpretationResponse | null;
  durationMs: number;
  failure: string | null;
  testCase: EvaluationCase;
  usage: InterpreterAnswer['usage'];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function emptyGroup(): GroupResult {
  return {
    cases: 0,
    exactFilters: { correct: 0, total: 0 },
    failures: 0,
    outcome: { correct: 0, total: 0 },
    reason: { correct: 0, total: 0 },
  };
}

// The cases to run: the ids asked for (checked against the dataset before anything is dispatched), or all of them,
// in dataset order either way, then capped by maxCases.
export function selectEvaluationCases(
  dataset: EvaluationDataset,
  caseIds: readonly string[] | undefined,
  maxCases: number | undefined,
): EvaluationCase[] {
  let selected = dataset.cases;
  if (caseIds !== undefined) {
    const wanted = new Set(caseIds);
    const known = new Set(dataset.cases.map((entry) => entry.id));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`The dataset has no case with the id ${unknown.map((id) => id.slice(0, 60)).join(', ')}`);
    }
    selected = dataset.cases.filter((entry) => wanted.has(entry.id));
  }
  return selected.slice(0, maxCases ?? selected.length);
}

// One provider call, never retried, under its own deadline: a call that never answers is a timeout of this case.
async function evaluateOne(
  testCase: EvaluationCase,
  options: Required<Pick<EvaluationOptions, 'callTimeoutMs' | 'clock' | 'interpreter'>>,
  dataset: EvaluationDataset,
): Promise<CaseResult> {
  const { callTimeoutMs, clock, interpreter } = options;
  const startedAt = clock.monotonicNow();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new InterpreterFailure('timeout'));
      controller.abort();
    }, callTimeoutMs);
  });
  deadline.catch(() => undefined);

  let usage: InterpreterAnswer['usage'] = null;
  try {
    const call = interpreter.interpret(
      {
        text: testCase.text,
        timeZone: dataset.timeZone,
        today: localDateOf(Date.parse(dataset.now), dataset.timeZone),
      },
      { signal: controller.signal },
    );
    call.catch(() => undefined);
    const answer = await Promise.race([call, deadline]);
    usage = answer.usage;
    const normalized = normalizeProposal(answer.proposal, {
      now: new Date(dataset.now),
      timeZone: dataset.timeZone,
    });
    return {
      answer: normalized,
      durationMs: clock.monotonicNow() - startedAt,
      failure: null,
      testCase,
      usage,
    };
  } catch (error) {
    const failure =
      error instanceof InterpreterFailure
        ? error.reason
        : error instanceof ProposalRejectedError
          ? 'invalid_output'
          : 'provider_error';
    return {
      answer: null,
      durationMs: clock.monotonicNow() - startedAt,
      failure,
      testCase,
      usage: error instanceof InterpreterFailure ? error.usage : usage,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    controller.abort();
  }
}

/**
 * Runs the dataset through an interpreter and the production normalization, and scores meaning rather than wording.
 * The same function is used with the deterministic doubles in tests and with the real adapter in the opt-in live
 * run, so a number from a live run can only come from the real model.
 *
 * Every executed case counts in every denominator it belongs to, a failed call included: a case the model could not
 * answer is not a case it answered correctly. A run that did not cover the dataset says so (`partial`, `aborted`).
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationReport> {
  const { dataset, interpreter } = options;
  const concurrency = Math.min(Math.max(options.concurrency ?? 1, 1), EVALUATION_MAX_CONCURRENCY);
  const cases = selectEvaluationCases(dataset, options.caseIds, options.maxCases);
  const results: Array<CaseResult | undefined> = new Array<CaseResult | undefined>(cases.length).fill(undefined);
  const callOptions = {
    callTimeoutMs: options.callTimeoutMs ?? EVALUATION_DEFAULT_CALL_TIMEOUT_MS,
    clock: options.clock,
    interpreter,
  };
  const streakLimit = options.stopAfterSystemicFailures ?? EVALUATION_SYSTEMIC_FAILURE_STREAK;

  let next = 0;
  let done = 0;
  let streakReason: string | null = null;
  let streak = 0;
  let aborted: EvaluationReport['aborted'] = null;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= cases.length) {
        return;
      }
      next += 1;
      const testCase = cases[index]!;
      const result = await evaluateOne(testCase, callOptions, dataset);
      results[index] = result;
      done += 1;
      options.onCase?.({ done, id: testCase.id, total: cases.length });

      // Results arrive in completion order; a streak is a run of identical systemic failures in that order.
      if (result.failure !== null && SYSTEMIC_FAILURES.has(result.failure)) {
        streak = result.failure === streakReason ? streak + 1 : 1;
        streakReason = result.failure;
      } else {
        streak = 0;
        streakReason = null;
      }
      if (aborted === null && streakReason !== null && streak >= streakLimit) {
        // Cases already in flight finish; nothing new is started.
        aborted = { afterCases: done, consecutive: streak, reason: streakReason };
        next = cases.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));

  const executed = results.filter((entry): entry is CaseResult => entry !== undefined);
  const context = { now: new Date(dataset.now), timeZone: dataset.timeZone };
  const fieldErrors = Object.fromEntries(FILTER_FIELDS.map((field) => [field, 0])) as Record<FilterField, number>;
  const failuresByReason: Record<string, number> = {};
  const byCategory: EvaluationReport['byCategory'] = {};
  const byLanguage: Record<string, GroupResult> = {};
  const mismatches: Mismatch[] = [];
  const outcomeMatrix = Object.fromEntries(
    (['search', 'clarify', 'unsupported'] as const).map((expected) => [
      expected,
      { clarify: 0, failure: 0, search: 0, unsupported: 0 },
    ]),
  ) as EvaluationReport['outcomeMatrix'];
  const acceptedIds: string[] = [];
  let nonSearchCases = 0;
  const outcome: Tally = { correct: 0, total: 0 };
  const reason: Tally = { correct: 0, total: 0 };
  const exactFilters: Tally = { correct: 0, total: 0 };
  const usage = {
    cachedInputTokens: 0,
    callsWithReasoningDetail: 0,
    callsWithUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };

  for (const result of executed) {
    const { testCase } = result;
    const category = (byCategory[testCase.category] ??= { cases: 0, exactFilters: null, outcomeCorrect: 0 });
    const language = (byLanguage[testCase.language] ??= emptyGroup());
    category.cases += 1;
    language.cases += 1;

    if (result.usage !== null && result.usage !== undefined) {
      usage.callsWithUsage += 1;
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
      usage.cachedInputTokens += result.usage.cachedInputTokens ?? 0;
      if (result.usage.reasoningTokens !== null && result.usage.reasoningTokens !== undefined) {
        usage.callsWithReasoningDetail += 1;
        usage.reasoningTokens += result.usage.reasoningTokens;
      }
    }

    const expectsSearch = testCase.expected.outcome === 'search';
    const expectsReason = !expectsSearch;
    const expectedReason = testCase.expected.outcome === 'search' ? null : testCase.expected.reason;
    nonSearchCases += expectsReason ? 1 : 0;

    // Denominators are filled before the answer is looked at, so a failed or wrong answer can only lower a ratio.
    outcome.total += 1;
    language.outcome.total += 1;
    if (expectsReason) {
      reason.total += 1;
      language.reason.total += 1;
    }
    if (expectsSearch) {
      exactFilters.total += 1;
      language.exactFilters.total += 1;
      category.exactFilters ??= 0;
    }

    if (result.answer === null) {
      const failure = result.failure ?? 'provider_error';
      failuresByReason[failure] = (failuresByReason[failure] ?? 0) + 1;
      language.failures += 1;
      outcomeMatrix[testCase.expected.outcome].failure += 1;
      mismatches.push({
        actualOutcome: `failure:${failure}`,
        actualReason: null,
        expectedOutcome: testCase.expected.outcome,
        expectedReason,
        fieldErrors: [],
        id: testCase.id,
      });
      continue;
    }

    const score = scoreCase(testCase.expected, result.answer, context);
    outcomeMatrix[testCase.expected.outcome][score.actualOutcome] += 1;
    if (expectsReason && score.actualOutcome === 'search') {
      acceptedIds.push(testCase.id);
    }
    if (score.outcomeCorrect) {
      outcome.correct += 1;
      language.outcome.correct += 1;
      category.outcomeCorrect += 1;
    }
    if (expectsReason && score.reasonCorrect === true) {
      reason.correct += 1;
      language.reason.correct += 1;
    }
    if (expectsSearch && score.filtersExact === true) {
      exactFilters.correct += 1;
      language.exactFilters.correct += 1;
      category.exactFilters = (category.exactFilters ?? 0) + 1;
    }
    for (const field of score.fieldErrors) {
      fieldErrors[field] += 1;
    }
    const exact = score.outcomeCorrect && (expectsSearch ? score.filtersExact === true : score.reasonCorrect === true);
    if (!exact) {
      mismatches.push({
        actualOutcome: score.actualOutcome,
        actualReason: score.actualReason,
        expectedOutcome: testCase.expected.outcome,
        expectedReason,
        fieldErrors: score.fieldErrors,
        id: testCase.id,
      });
    }
  }

  const durations = executed.map((result) => result.durationMs).sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    aborted,
    byCategory,
    byLanguage,
    caseCount: dataset.cases.length,
    counts: { exactFilters, outcome, reason },
    datasetVersion: dataset.datasetVersion,
    exactFilterAccuracy: ratio(exactFilters.correct, exactFilters.total),
    executedCount: executed.length,
    executedIds: executed.map((result) => result.testCase.id),
    failures: {
      byReason: failuresByReason,
      total: Object.values(failuresByReason).reduce((sum, value) => sum + value, 0),
    },
    fieldErrors,
    incorrectAcceptances: { ids: acceptedIds, ofCases: nonSearchCases, total: acceptedIds.length },
    latencyMs: {
      max: durations.at(-1) ?? 0,
      mean: durations.length === 0 ? 0 : total / durations.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    mismatches,
    model: interpreter.model,
    outcomeAccuracy: executed.length === 0 ? 0 : outcome.correct / executed.length,
    outcomeMatrix,
    partial: executed.length < dataset.cases.length,
    promptVersion: INTERPRETATION_PROMPT_VERSION,
    reasonAccuracy: ratio(reason.correct, reason.total),
    usage,
  };
}
