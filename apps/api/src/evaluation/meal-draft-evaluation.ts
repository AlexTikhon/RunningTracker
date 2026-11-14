import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  MEAL_DRAFT_CLARIFICATION_REASONS,
  MEAL_DRAFT_UNSUPPORTED_REASONS,
  MEAL_NUTRITION_FIELDS,
  mealTypeSchema,
  type MealNutritionField,
} from '@running-tracker/contracts';
import { z } from 'zod';

import type { Clock } from '../clock.js';
import { LlmProviderError, type LlmProvider } from '../insights/llm-provider.js';
import { groundMealDraft, UngroundedOutputError, type GroundedProposal, type GroundingAudit } from '../meals/drafts/meal-draft-grounding.js';
import { buildMealDraftMessages, MEAL_DRAFT_PROMPT_VERSION, mealDraftPromptDigest } from '../meals/drafts/meal-draft-prompt.js';
import { mealDraftWireJsonSchema, mealDraftWireSchema } from '../meals/drafts/meal-draft-wire.js';

// The evaluation of "Draft from text" (ADR-0092; docs/runbooks/meal-drafts.md). Two FROZEN synthetic sets, development
// and held-out, English and Russian. A run makes at most one provider call per case, never retries, and goes through the
// same prompt, wire schema and grounding as the service, so what is measured is what a person would be shown. Extraction
// quality, incorrectly accepted fields, abstentions and latency are reported separately. A run with the fake provider
// verifies this harness and nothing else: it is never evidence about a model.

/** The most provider calls one evaluation run may make (the brief's budget for real-model evaluation). */
export const MEAL_DRAFT_EVALUATION_MAX_CALLS = 40;
/** Identical systemic failures in a row after which a run stops spending calls. */
export const MEAL_DRAFT_EVALUATION_FAILURE_STREAK = 3;

export const MEAL_DRAFT_EVALUATION_SETS = ['development', 'heldout'] as const;
export type MealDraftEvaluationSet = (typeof MEAL_DRAFT_EVALUATION_SETS)[number];

/**
 * The digests of the frozen sets (SHA-256 of their parsed, re-serialised JSON, so line endings do not matter). A set
 * whose content changed is refused: a new set is a new version with a new file.
 */
export const MEAL_DRAFT_DATASET_DIGESTS: Readonly<Record<MealDraftEvaluationSet, string>> = {
  development: '7081d147294698185b8ba87c3ef98f4770c51a9aa72e2ecf22ff98f0cf9e2951',
  heldout: 'be55bcaf7c6b1707818a1137eddc7f0d160bc077c5ede7842a3c952e04863b85',
};

const nutritionExpectation = z.number().finite().nonnegative().nullable();

const expectedSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    mealType: mealTypeSchema.nullable(),
    nutrition: z.strictObject({ carbohydrateG: nutritionExpectation, energyKcal: nutritionExpectation, fatG: nutritionExpectation, proteinG: nutritionExpectation }),
    outcome: z.literal('draft'),
    titleIncludes: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({ outcome: z.literal('clarify'), reason: z.enum(MEAL_DRAFT_CLARIFICATION_REASONS) }),
  z.strictObject({ outcome: z.literal('unsupported'), reason: z.enum(MEAL_DRAFT_UNSUPPORTED_REASONS) }),
]);

export const mealDraftEvaluationCaseSchema = z.strictObject({
  category: z.string().regex(/^[a-z][a-z-]{2,40}$/u),
  expected: expectedSchema,
  id: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/u),
  language: z.enum(['en', 'ru']),
  text: z.string().min(1).max(500),
});

export const mealDraftEvaluationDatasetSchema = z.strictObject({
  cases: z.array(mealDraftEvaluationCaseSchema).min(1).max(100),
  datasetVersion: z.string().regex(/^\d+$/u),
  description: z.string().min(1),
  set: z.enum(MEAL_DRAFT_EVALUATION_SETS),
});

export type MealDraftEvaluationCase = z.infer<typeof mealDraftEvaluationCaseSchema>;
export type MealDraftEvaluationDataset = z.infer<typeof mealDraftEvaluationDatasetSchema>;

export function mealDraftDatasetDigest(dataset: MealDraftEvaluationDataset): string {
  return createHash('sha256').update(JSON.stringify(dataset), 'utf8').digest('hex');
}

const datasetUrl = (set: MealDraftEvaluationSet) => new URL(`../../evaluation/meal-draft.${set}.v1.json`, import.meta.url);

/** Reads a frozen set and refuses it if its content is not the pinned one (or `digests` says otherwise, for tests). */
export function loadMealDraftDataset(
  set: MealDraftEvaluationSet,
  digests: Readonly<Record<MealDraftEvaluationSet, string>> = MEAL_DRAFT_DATASET_DIGESTS,
): { dataset: MealDraftEvaluationDataset; digest: string } {
  const dataset = mealDraftEvaluationDatasetSchema.parse(JSON.parse(readFileSync(datasetUrl(set), 'utf8')));
  if (dataset.set !== set) throw new Error(`The ${set} file holds the ${dataset.set} set`);
  const digest = mealDraftDatasetDigest(dataset);
  if (digest !== digests[set]) throw new Error(`The ${set} set is not the frozen one (digest ${digest.slice(0, 12)}…)`);
  const ids = new Set(dataset.cases.map((entry) => entry.id));
  if (ids.size !== dataset.cases.length) throw new Error(`The ${set} set has duplicate case ids`);
  return { dataset, digest };
}

// ---------------------------------------------------------------------------------------------------------------
// Running.

export type CaseFailure = 'incomplete' | 'invalid_output' | 'oversized' | 'provider_error' | 'provider_unavailable' | 'timeout' | 'ungrounded_output';

export interface MealDraftCaseResult {
  audit: GroundingAudit | null;
  case: MealDraftEvaluationCase;
  durationMs: number;
  failure: CaseFailure | null;
  proposal: GroundedProposal | null;
}

const SYSTEMIC: ReadonlySet<CaseFailure> = new Set(['incomplete', 'oversized', 'provider_error', 'provider_unavailable', 'timeout']);

function failureOf(error: unknown): CaseFailure {
  if (error instanceof UngroundedOutputError) return 'ungrounded_output';
  if (!(error instanceof LlmProviderError)) return 'provider_error';
  switch (error.reason) {
    case 'timeout':
    case 'aborted':
      return 'timeout';
    case 'incomplete':
      return 'incomplete';
    case 'invalid_response':
      return 'invalid_output';
    case 'oversized':
      return 'oversized';
    case 'unavailable':
      return 'provider_unavailable';
    case 'provider_error':
      return 'provider_error';
  }
}

export interface MealDraftEvaluationOptions {
  cases: readonly MealDraftEvaluationCase[];
  clock: Pick<Clock, 'monotonicNow'>;
  /** At most this many calls; never more than MEAL_DRAFT_EVALUATION_MAX_CALLS. */
  maxCalls: number;
  maxOutputTokens: number;
  onCase?: (progress: { done: number; id: string; total: number }) => void;
  provider: LlmProvider;
  timeoutMs: number;
}

export interface MealDraftEvaluationRun {
  calls: number;
  results: MealDraftCaseResult[];
  stopped: { afterCases: number; reason: CaseFailure } | null;
}

/** One call per case, in order, one at a time, no retries. Stops after three identical systemic failures in a row. */
export async function runMealDraftEvaluation(options: MealDraftEvaluationOptions): Promise<MealDraftEvaluationRun> {
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > MEAL_DRAFT_EVALUATION_MAX_CALLS) {
    throw new RangeError(`maxCalls must be 1..${MEAL_DRAFT_EVALUATION_MAX_CALLS}`);
  }
  const selected = options.cases.slice(0, options.maxCalls);
  const results: MealDraftCaseResult[] = [];
  let streak: { count: number; reason: CaseFailure | null } = { count: 0, reason: null };
  let calls = 0;
  for (const entry of selected) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAt = options.clock.monotonicNow();
    let result: MealDraftCaseResult;
    try {
      calls += 1;
      const answer = await options.provider.generateStructured(buildMealDraftMessages(entry.text), mealDraftWireJsonSchema, {
        maxOutputTokens: options.maxOutputTokens,
        signal: controller.signal,
        timeoutMs: options.timeoutMs,
      });
      const durationMs = Math.round(options.clock.monotonicNow() - startedAt);
      const wire = mealDraftWireSchema.safeParse(answer.value);
      if (!wire.success) {
        result = { audit: null, case: entry, durationMs, failure: 'invalid_output', proposal: null };
      } else {
        try {
          const grounded = groundMealDraft(entry.text.trim(), wire.data);
          result = { audit: grounded.audit, case: entry, durationMs, failure: null, proposal: grounded.proposal };
        } catch (error) {
          result = { audit: null, case: entry, durationMs, failure: failureOf(error), proposal: null };
        }
      }
    } catch (error) {
      result = { audit: null, case: entry, durationMs: Math.round(options.clock.monotonicNow() - startedAt), failure: failureOf(error), proposal: null };
    } finally {
      clearTimeout(timer);
    }
    results.push(result);
    options.onCase?.({ done: results.length, id: entry.id, total: selected.length });
    if (result.failure !== null && SYSTEMIC.has(result.failure)) {
      streak = streak.reason === result.failure ? { count: streak.count + 1, reason: result.failure } : { count: 1, reason: result.failure };
      if (streak.count >= MEAL_DRAFT_EVALUATION_FAILURE_STREAK) {
        return { calls, results, stopped: { afterCases: results.length, reason: result.failure } };
      }
    } else {
      streak = { count: 0, reason: null };
    }
  }
  return { calls, results, stopped: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring.

export interface Tally {
  correct: number;
  total: number;
}

/** Field-level counts over every executed case and every nutrition field. */
export interface FieldCounts {
  /** A value was proposed and it equals the expected value. */
  correctAccepted: number;
  /** Nothing was proposed and nothing was expected. */
  correctNull: number;
  /** Expected values (the recall denominator). */
  expectedValues: number;
  /** A value was proposed although none, or another, was expected: the safety metric. */
  incorrectAccepted: number;
  /** An expected value was not proposed because the model abstained or said it was not stated. */
  missedByModel: number;
  /** An expected value was not proposed because the outcome was not a draft (a clarification, a refusal or a failure). */
  missedByOutcome: number;
  /** An expected value was not proposed because the grounding withheld the model's claim. */
  missedByServer: number;
  /** The model claimed a value that was not expected and the grounding withheld it: a wrong field the server stopped. */
  stoppedByServer: number;
}

export interface MealDraftScore {
  extraction: { precision: number | null; recall: number | null };
  failures: { byReason: Record<string, number>; total: number };
  fields: FieldCounts;
  incorrectAccepted: Array<{ actual: number; expected: number | null; field: MealNutritionField; id: string }>;
  latencyMs: { max: number; mean: number; p50: number; p95: number } | null;
  mealType: Tally;
  multipleMealsOverrides: number;
  outcome: Tally;
  reason: Tally;
  title: Tally;
}

const emptyFields = (): FieldCounts => ({
  correctAccepted: 0,
  correctNull: 0,
  expectedValues: 0,
  incorrectAccepted: 0,
  missedByModel: 0,
  missedByOutcome: 0,
  missedByServer: 0,
  stoppedByServer: 0,
});

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Math.round((numerator / denominator) * 1_000) / 1_000);

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function scoreMealDraftResults(results: readonly MealDraftCaseResult[]): MealDraftScore {
  const fields = emptyFields();
  const incorrectAccepted: MealDraftScore['incorrectAccepted'] = [];
  const outcome: Tally = { correct: 0, total: 0 };
  const reason: Tally = { correct: 0, total: 0 };
  const title: Tally = { correct: 0, total: 0 };
  const mealType: Tally = { correct: 0, total: 0 };
  const failures: Record<string, number> = {};
  let multipleMealsOverrides = 0;

  for (const result of results) {
    const { expected } = result.case;
    const proposal = result.proposal;
    const actualOutcome = proposal?.outcome ?? 'failure';
    if (result.failure !== null) failures[result.failure] = (failures[result.failure] ?? 0) + 1;
    if (result.audit?.multipleMealsOverride) multipleMealsOverrides += 1;
    outcome.total += 1;
    if (actualOutcome === expected.outcome) outcome.correct += 1;

    if (expected.outcome !== 'draft') {
      reason.total += 1;
      if (proposal !== null && proposal.outcome === expected.outcome && proposal.reason === expected.reason) reason.correct += 1;
    }

    for (const field of MEAL_NUTRITION_FIELDS) {
      const wanted = expected.outcome === 'draft' ? expected.nutrition[field] : null;
      const shown = proposal?.outcome === 'draft' ? proposal.nutrition[field] : null;
      const value = shown?.status === 'proposed' ? shown.value : null;
      const disposition = proposal?.outcome === 'draft' ? result.audit?.fields?.[field] : undefined;
      if (wanted !== null) fields.expectedValues += 1;
      if (value !== null) {
        if (value === wanted) fields.correctAccepted += 1;
        else {
          fields.incorrectAccepted += 1;
          incorrectAccepted.push({ actual: value, expected: wanted, field, id: result.case.id });
        }
        continue;
      }
      if (wanted === null) {
        fields.correctNull += 1;
        if (disposition === 'server_withheld') fields.stoppedByServer += 1;
      } else if (proposal?.outcome !== 'draft') fields.missedByOutcome += 1;
      else if (disposition === 'server_withheld') fields.missedByServer += 1;
      else fields.missedByModel += 1;
    }

    if (expected.outcome === 'draft' && proposal?.outcome === 'draft') {
      title.total += 1;
      const lower = proposal.title.toLocaleLowerCase('ru');
      if (expected.titleIncludes.every((word) => lower.includes(word.toLocaleLowerCase('ru')))) title.correct += 1;
      mealType.total += 1;
      const actualType = proposal.mealType.status === 'proposed' ? proposal.mealType.value : null;
      if (actualType === expected.mealType) mealType.correct += 1;
    }
  }

  const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
  return {
    extraction: {
      precision: ratio(fields.correctAccepted, fields.correctAccepted + fields.incorrectAccepted),
      recall: ratio(fields.correctAccepted, fields.expectedValues),
    },
    failures: { byReason: failures, total: Object.values(failures).reduce((sum, count) => sum + count, 0) },
    fields,
    incorrectAccepted,
    latencyMs:
      durations.length === 0
        ? null
        : {
            max: durations.at(-1)!,
            mean: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
            p50: percentile(durations, 0.5),
            p95: percentile(durations, 0.95),
          },
    mealType,
    multipleMealsOverrides,
    outcome,
    reason,
    title,
  };
}

export interface MealDraftEvaluationReport {
  byLanguage: Record<'en' | 'ru', MealDraftScore>;
  calls: number;
  caseCount: number;
  cases: Array<{
    category: string;
    durationMs: number;
    expectedOutcome: string;
    failure: CaseFailure | null;
    id: string;
    language: string;
    proposal: GroundedProposal | null;
  }>;
  datasetDigest: string;
  datasetVersion: string;
  executedCount: number;
  generation: Record<string, unknown>;
  /** "fake" runs verify the harness only; they are never model-quality evidence. */
  kind: 'fake-harness-verification' | 'real-model';
  model: string;
  partial: boolean;
  promptDigest: string;
  promptVersion: string;
  provider: string;
  runtimeVersion: string | null;
  score: MealDraftScore;
  set: MealDraftEvaluationSet;
  stopped: MealDraftEvaluationRun['stopped'];
  timeoutMs: number;
}

export function buildMealDraftReport(input: {
  dataset: MealDraftEvaluationDataset;
  digest: string;
  generation: Record<string, unknown>;
  model: string;
  provider: 'fake' | 'ollama';
  run: MealDraftEvaluationRun;
  runtimeVersion: string | null;
  timeoutMs: number;
}): MealDraftEvaluationReport {
  const { dataset, run } = input;
  return {
    byLanguage: {
      en: scoreMealDraftResults(run.results.filter((result) => result.case.language === 'en')),
      ru: scoreMealDraftResults(run.results.filter((result) => result.case.language === 'ru')),
    },
    calls: run.calls,
    caseCount: dataset.cases.length,
    cases: run.results.map((result) => ({
      category: result.case.category,
      durationMs: result.durationMs,
      expectedOutcome: result.case.expected.outcome,
      failure: result.failure,
      id: result.case.id,
      language: result.case.language,
      proposal: result.proposal,
    })),
    datasetDigest: input.digest,
    datasetVersion: dataset.datasetVersion,
    executedCount: run.results.length,
    generation: input.generation,
    kind: input.provider === 'fake' ? 'fake-harness-verification' : 'real-model',
    model: input.model,
    partial: run.results.length < dataset.cases.length || run.stopped !== null,
    promptDigest: mealDraftPromptDigest(),
    promptVersion: MEAL_DRAFT_PROMPT_VERSION,
    provider: input.provider,
    runtimeVersion: input.runtimeVersion,
    score: scoreMealDraftResults(run.results),
    set: dataset.set,
    stopped: run.stopped,
    timeoutMs: input.timeoutMs,
  };
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const tally = (value: Tally) => `${value.correct}/${value.total}`;

/** A short, human-readable summary. Bounded content: ids and numbers, never a model's words. */
export function formatMealDraftReport(report: MealDraftEvaluationReport): string {
  const { score } = report;
  const lines = [
    report.kind === 'fake-harness-verification'
      ? 'FAKE PROVIDER: harness verification only. This is NOT evidence about any model.'
      : `Real model: ${report.provider} ${report.model} (runtime ${report.runtimeVersion ?? 'unknown'})`,
    `Set: ${report.set} v${report.datasetVersion} (${report.executedCount}/${report.caseCount} cases, ${report.calls} calls)${report.partial ? ' PARTIAL' : ''}`,
    `Prompt: ${report.promptVersion} (${report.promptDigest.slice(0, 12)}…); deadline ${report.timeoutMs} ms`,
    `Outcome: ${tally(score.outcome)}; reason: ${tally(score.reason)}; title: ${tally(score.title)}; meal type: ${tally(score.mealType)}`,
    `Fields: ${score.fields.correctAccepted} correct, ${score.fields.incorrectAccepted} INCORRECTLY ACCEPTED, of ${score.fields.expectedValues} expected values`,
    `Extraction: precision ${pct(score.extraction.precision)}, recall ${pct(score.extraction.recall)}`,
    `Abstentions: ${score.fields.missedByModel} by the model, ${score.fields.missedByServer} withheld by grounding, ${score.fields.missedByOutcome} by a non-draft outcome; ${score.fields.stoppedByServer} wrong claims stopped by grounding`,
    `Failures: ${score.failures.total} ${JSON.stringify(score.failures.byReason)}`,
    score.latencyMs === null
      ? 'Latency: n/a'
      : `Latency (ms): mean ${score.latencyMs.mean}, p50 ${score.latencyMs.p50}, p95 ${score.latencyMs.p95}, max ${score.latencyMs.max}`,
  ];
  if (report.stopped !== null) lines.push(`Stopped after ${report.stopped.afterCases} cases: ${report.stopped.reason} three times in a row`);
  for (const wrong of score.incorrectAccepted) lines.push(`  incorrect: ${wrong.id} ${wrong.field} proposed ${wrong.actual}, expected ${wrong.expected ?? 'nothing'}`);
  return lines.join('\n');
}
