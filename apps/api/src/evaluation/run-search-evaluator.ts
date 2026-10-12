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

export interface EvaluationOptions {
  /** Hard deadline for one call, response included. */
  callTimeoutMs?: number;
  clock: Pick<Clock, 'monotonicNow'>;
  concurrency?: number;
  dataset: EvaluationDataset;
  interpreter: RunSearchInterpreter;
  /** Run only the first N cases: the call budget of one evaluation. */
  maxCases?: number;
  onCase?: (progress: { done: number; id: string; total: number }) => void;
}

export interface Mismatch {
  actualOutcome: string;
  actualReason: string | null;
  expectedOutcome: string;
  expectedReason: string | null;
  fieldErrors: FilterField[];
  id: string;
}

export interface EvaluationReport {
  byCategory: Record<string, { cases: number; exactFilters: number | null; outcomeCorrect: number }>;
  caseCount: number;
  datasetVersion: string;
  executedCount: number;
  exactFilterAccuracy: number | null;
  failures: { byReason: Record<string, number>; total: number };
  fieldErrors: Record<FilterField, number>;
  latencyMs: { max: number; mean: number; p50: number; p95: number };
  mismatches: Mismatch[];
  model: string;
  outcomeAccuracy: number;
  promptVersion: string;
  reasonAccuracy: number | null;
  usage: { callsWithUsage: number; inputTokens: number; outputTokens: number };
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
 */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationReport> {
  const { dataset, interpreter } = options;
  const concurrency = Math.min(Math.max(options.concurrency ?? 1, 1), EVALUATION_MAX_CONCURRENCY);
  const cases = dataset.cases.slice(0, options.maxCases ?? dataset.cases.length);
  const results: CaseResult[] = new Array<CaseResult>(cases.length);
  const callOptions = {
    callTimeoutMs: options.callTimeoutMs ?? EVALUATION_DEFAULT_CALL_TIMEOUT_MS,
    clock: options.clock,
    interpreter,
  };

  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= cases.length) {
        return;
      }
      const testCase = cases[index]!;
      results[index] = await evaluateOne(testCase, callOptions, dataset);
      done += 1;
      options.onCase?.({ done, id: testCase.id, total: cases.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));

  const context = { now: new Date(dataset.now), timeZone: dataset.timeZone };
  const fieldErrors = Object.fromEntries(FILTER_FIELDS.map((field) => [field, 0])) as Record<FilterField, number>;
  const failuresByReason: Record<string, number> = {};
  const byCategory: EvaluationReport['byCategory'] = {};
  const mismatches: Mismatch[] = [];
  let outcomeCorrect = 0;
  let reasonCases = 0;
  let reasonCorrect = 0;
  let searchCases = 0;
  let exactFilters = 0;
  const usage = { callsWithUsage: 0, inputTokens: 0, outputTokens: 0 };

  for (const result of results) {
    const { testCase } = result;
    const category = (byCategory[testCase.category] ??= { cases: 0, exactFilters: null, outcomeCorrect: 0 });
    category.cases += 1;

    if (result.usage !== null && result.usage !== undefined) {
      usage.callsWithUsage += 1;
      usage.inputTokens += result.usage.inputTokens ?? 0;
      usage.outputTokens += result.usage.outputTokens ?? 0;
    }

    const expectsSearch = testCase.expected.outcome === 'search';
    const expectsReason = !expectsSearch;
    searchCases += expectsSearch ? 1 : 0;
    reasonCases += expectsReason ? 1 : 0;

    if (result.answer === null) {
      failuresByReason[result.failure ?? 'provider_error'] =
        (failuresByReason[result.failure ?? 'provider_error'] ?? 0) + 1;
      mismatches.push({
        actualOutcome: `failure:${result.failure ?? 'provider_error'}`,
        actualReason: null,
        expectedOutcome: testCase.expected.outcome,
        expectedReason: testCase.expected.outcome === 'search' ? null : testCase.expected.reason,
        fieldErrors: [],
        id: testCase.id,
      });
      continue;
    }

    const score = scoreCase(testCase.expected, result.answer, context);
    if (score.outcomeCorrect) {
      outcomeCorrect += 1;
      category.outcomeCorrect += 1;
    }
    if (expectsReason && score.reasonCorrect === true) {
      reasonCorrect += 1;
    }
    if (expectsSearch && score.filtersExact === true) {
      exactFilters += 1;
      category.exactFilters = (category.exactFilters ?? 0) + 1;
    } else if (expectsSearch) {
      category.exactFilters ??= 0;
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
        expectedReason: testCase.expected.outcome === 'search' ? null : testCase.expected.reason,
        fieldErrors: score.fieldErrors,
        id: testCase.id,
      });
    }
  }

  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    byCategory,
    caseCount: dataset.cases.length,
    datasetVersion: dataset.datasetVersion,
    exactFilterAccuracy: ratio(exactFilters, searchCases),
    executedCount: results.length,
    failures: {
      byReason: failuresByReason,
      total: Object.values(failuresByReason).reduce((sum, value) => sum + value, 0),
    },
    fieldErrors,
    latencyMs: {
      max: durations.at(-1) ?? 0,
      mean: durations.length === 0 ? 0 : total / durations.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    mismatches,
    model: interpreter.model,
    outcomeAccuracy: results.length === 0 ? 0 : outcomeCorrect / results.length,
    promptVersion: INTERPRETATION_PROMPT_VERSION,
    reasonAccuracy: ratio(reasonCorrect, reasonCases),
    usage,
  };
}
