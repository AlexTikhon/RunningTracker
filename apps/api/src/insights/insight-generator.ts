import {
  weeklyInsightModelOutputSchema,
  weeklyInsightOutputSchema,
  type WeeklyInsightFact,
  type WeeklyInsightModelOutput,
  type WeeklyInsightOutput,
} from '@running-tracker/contracts';

import { checkGrounding, type GroundingViolation } from './grounding.js';
import { buildFacts, dataGapsOf } from './insight-facts.js';
import { buildWeeklyInsightPrompt, weeklyInsightOutputJsonSchema } from './insight-prompt.js';
import { LlmProviderError, type LlmFailureReason, type LlmProvider } from './llm-provider.js';
import { approvedSuggestionFor, checkSafety, type SafetyViolation } from './safety.js';
import type { WeeklyAggregate } from './weekly-aggregate.js';

// One weekly insight generation (ADR-0076).
//
// Budget: ONE budget for the whole generation, owned here. Providers make exactly one attempt per call.
//   - at most `maxAttempts` provider calls in total (default 3), whatever failed;
//   - at most ONE regeneration after an answer that is not the schema (not JSON, cut off, or failing the Zod schema);
//     a second such answer ends the generation (generation_failed, schema_invalid);
//   - a retryable transport failure (timeout, connection refused, 429/5xx) may use the remaining attempts;
//   - a non-retryable failure (4xx, oversized answer, redirect) ends the generation at once;
//   - every attempt's deadline is min(attemptTimeoutMs, time left of totalBudgetMs); no attempt starts with less than
//     MIN_ATTEMPT_MS left (generation_failed, budget_exhausted).
// So the worst case is bounded by totalBudgetMs, and the attempt counts are reported with the outcome.
//
// Validation of a schema-valid answer: claim grounding and prose rules (grounding.ts), then the heuristic safety screen
// (safety.ts). Any violation discards the answer; both are reported, and safety wins the status. A failed check is
// never retried: generating until the checks happen to pass would make them a filter on luck.
//
// A ready answer is assembled by code: each claim is replaced by its fact (with the code-rendered text), the data gaps
// come from the aggregate, and in a week with extreme values the suggestion is the approved one selected by code.

export const MIN_ATTEMPT_MS = 1_000;
export const MAX_SCHEMA_REGENERATIONS = 1;

/** Shown in an ordinary week when the model wrote no suggestion. */
export const FALLBACK_SUGGESTION = {
  id: 'keep_checking_in',
  text: "Keep checking in each day so next week's summary has more to describe.",
} as const;

export interface GenerationBudget {
  attemptTimeoutMs: number;
  maxAttempts: number;
  totalBudgetMs: number;
}

export interface GenerationSettings {
  budget: GenerationBudget;
  maxOutputTokens: number;
  /** Monotonic milliseconds. */
  now: () => number;
  signal?: AbortSignal;
}

export interface GenerationStats {
  /** Provider calls made (each one HTTP request for Ollama). */
  attempts: number;
  durationMs: number;
  /** In a week with extreme values: the model wrote a suggestion anyway, and it was dropped unseen. */
  modelSuggestionDropped: boolean;
  /** Answers that were not the schema. */
  schemaFailures: number;
  /** Retryable transport failures. */
  transportFailures: number;
}

export type GenerationFailureReason = LlmFailureReason | 'budget_exhausted' | 'schema_invalid';

export type GenerationOutcome =
  | { output: WeeklyInsightOutput; stats: GenerationStats; status: 'ready' }
  | { reason: GenerationFailureReason; stats: GenerationStats; status: 'generation_failed' }
  | { grounding: GroundingViolation[]; modelOutput: WeeklyInsightModelOutput; stats: GenerationStats; status: 'failed_grounding' }
  | {
      grounding: GroundingViolation[];
      modelOutput: WeeklyInsightModelOutput;
      safety: SafetyViolation[];
      stats: GenerationStats;
      status: 'failed_safety';
    };

/** Reasons that mean "the model answered, but not with the schema": they use the one regeneration. */
const schemaLike: ReadonlySet<LlmFailureReason> = new Set(['incomplete', 'invalid_response']);

/** The answer the person sees, built by code around the model's prose. Exported for tests. */
export function assembleOutput(
  modelOutput: WeeklyInsightModelOutput,
  aggregate: WeeklyAggregate,
  facts: readonly WeeklyInsightFact[],
): WeeklyInsightOutput {
  const catalogue = new Map(facts.map((entry) => [entry.id, entry]));
  const approved = approvedSuggestionFor(aggregate);
  const suggestion = approved
    ? { id: approved.id, source: 'approved' as const, text: approved.text }
    : modelOutput.suggestion === null
      ? { id: FALLBACK_SUGGESTION.id, source: 'approved' as const, text: FALLBACK_SUGGESTION.text }
      : { id: null, source: 'model' as const, text: modelOutput.suggestion };
  return weeklyInsightOutputSchema.parse({
    dataGaps: dataGapsOf(aggregate),
    observations: modelOutput.observations.map((observation) => ({
      facts: observation.claims.map((claim) => {
        const target = catalogue.get(claim.factId);
        if (!target) throw new Error('assembleOutput was given an ungrounded claim');
        return target;
      }),
      text: observation.text,
    })),
    suggestion,
    summary: modelOutput.summary,
  });
}

/** Validates a schema-valid model answer and, when it passes, assembles the stored output. Exported for evaluation. */
export function validateModelOutput(
  modelOutput: WeeklyInsightModelOutput,
  aggregate: WeeklyAggregate,
  facts: readonly WeeklyInsightFact[] = buildFacts(aggregate),
):
  | { output: WeeklyInsightOutput; status: 'ready' }
  | { grounding: GroundingViolation[]; status: 'failed_grounding' }
  | { grounding: GroundingViolation[]; safety: SafetyViolation[]; status: 'failed_safety' } {
  const grounding = checkGrounding(modelOutput, facts);
  const safety = checkSafety(modelOutput, aggregate);
  if (safety.length > 0) return { grounding, safety, status: 'failed_safety' };
  if (grounding.length > 0) return { grounding, status: 'failed_grounding' };
  return { output: assembleOutput(modelOutput, aggregate, facts), status: 'ready' };
}

export async function generateWeeklyInsight(
  aggregate: WeeklyAggregate,
  provider: LlmProvider,
  settings: GenerationSettings,
): Promise<GenerationOutcome> {
  const facts = buildFacts(aggregate);
  const prompt = buildWeeklyInsightPrompt(aggregate, facts);
  const schema = weeklyInsightOutputJsonSchema(facts);
  const { budget } = settings;
  const started = settings.now();
  const deadline = started + budget.totalBudgetMs;
  const stats: GenerationStats = { attempts: 0, durationMs: 0, modelSuggestionDropped: false, schemaFailures: 0, transportFailures: 0 };
  const finish = <Outcome extends GenerationOutcome>(outcome: Outcome): Outcome => {
    stats.durationMs = Math.max(0, Math.round(settings.now() - started));
    return outcome;
  };

  let modelOutput: WeeklyInsightModelOutput | undefined;
  let lastReason: GenerationFailureReason = 'budget_exhausted';
  while (modelOutput === undefined) {
    if (stats.attempts >= budget.maxAttempts) return finish({ reason: lastReason, stats, status: 'generation_failed' });
    const remaining = deadline - settings.now();
    if (remaining < MIN_ATTEMPT_MS) return finish({ reason: 'budget_exhausted', stats, status: 'generation_failed' });
    stats.attempts += 1;
    try {
      const result = await provider.generateStructured(prompt, schema, {
        maxOutputTokens: settings.maxOutputTokens,
        ...(settings.signal ? { signal: settings.signal } : {}),
        timeoutMs: Math.min(budget.attemptTimeoutMs, Math.floor(remaining)),
      });
      const parsed = weeklyInsightModelOutputSchema.safeParse(result.value);
      if (parsed.success) {
        modelOutput = parsed.data;
        break;
      }
      stats.schemaFailures += 1;
      lastReason = 'schema_invalid';
    } catch (error) {
      const failure = error instanceof LlmProviderError ? error : new LlmProviderError('provider_error', false);
      if (failure.reason === 'aborted' || settings.signal?.aborted) {
        return finish({ reason: 'aborted', stats, status: 'generation_failed' });
      }
      if (schemaLike.has(failure.reason)) {
        stats.schemaFailures += 1;
        lastReason = 'schema_invalid';
      } else if (failure.retryable) {
        stats.transportFailures += 1;
        lastReason = failure.reason;
        continue;
      } else {
        return finish({ reason: failure.reason, stats, status: 'generation_failed' });
      }
    }
    if (stats.schemaFailures > MAX_SCHEMA_REGENERATIONS) {
      return finish({ reason: 'schema_invalid', stats, status: 'generation_failed' });
    }
  }

  stats.modelSuggestionDropped = approvedSuggestionFor(aggregate) !== undefined && modelOutput.suggestion !== null;
  const validated = validateModelOutput(modelOutput, aggregate, facts);
  if (validated.status === 'ready') return finish({ output: validated.output, stats, status: 'ready' });
  return finish({ ...validated, modelOutput, stats });
}
