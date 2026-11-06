import { weeklyInsightOutputSchema, type WeeklyInsightOutput } from '@running-tracker/contracts';

import { checkGrounding, type GroundingViolation } from './grounding.js';
import { buildWeeklyInsightPrompt, WEEKLY_INSIGHT_OUTPUT_JSON_SCHEMA } from './insight-prompt.js';
import { LlmProviderError, type LlmFailureReason, type LlmProvider } from './llm-provider.js';
import { checkSafety, type SafetyViolation } from './safety.js';
import type { WeeklyAggregate } from './weekly-aggregate.js';

// One weekly insight generation (ADR-0076):
//   1. ask the model; an answer that is not the contract's schema (or not JSON at all, or cut off) is asked for once
//      more, and a second such answer is `generation_failed`;
//   2. a provider failure (no answer after the provider's own single retry, or a cancellation) is `generation_failed`
//      at once: asking again would only repeat the provider's retry;
//   3. a schema-valid answer is checked for grounding and safety; any violation discards it. When both checks fail the
//      status is `failed_safety`, the more serious of the two. A failed check is never retried: generating until the
//      checks happen to pass would make them a filter on luck rather than a guarantee.

export const MAX_GENERATION_ATTEMPTS = 2;

export interface GenerationSettings {
  maxOutputTokens: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

interface Common {
  /** Model answers requested (1 or 2), not counting the provider's internal transport retry. */
  generations: number;
}

export type GenerationOutcome =
  | (Common & { output: WeeklyInsightOutput; status: 'ready' })
  | (Common & { reason: LlmFailureReason | 'schema_invalid'; status: 'generation_failed' })
  | (Common & { grounding: GroundingViolation[]; status: 'failed_grounding' })
  | (Common & { grounding: GroundingViolation[]; safety: SafetyViolation[]; status: 'failed_safety' });

/** Reasons that mean "the model answered, but not with the schema": worth one regeneration. */
const schemaLike: ReadonlySet<LlmFailureReason> = new Set(['incomplete', 'invalid_response']);

export async function generateWeeklyInsight(
  aggregate: WeeklyAggregate,
  provider: LlmProvider,
  settings: GenerationSettings,
): Promise<GenerationOutcome> {
  const prompt = buildWeeklyInsightPrompt(aggregate);
  let output: WeeklyInsightOutput | undefined;
  let generations = 0;
  let lastReason: LlmFailureReason | 'schema_invalid' = 'schema_invalid';

  while (output === undefined && generations < MAX_GENERATION_ATTEMPTS) {
    generations += 1;
    try {
      const result = await provider.generateStructured(prompt, WEEKLY_INSIGHT_OUTPUT_JSON_SCHEMA, {
        maxOutputTokens: settings.maxOutputTokens,
        ...(settings.signal ? { signal: settings.signal } : {}),
        timeoutMs: settings.timeoutMs,
      });
      const parsed = weeklyInsightOutputSchema.safeParse(result.value);
      if (parsed.success) output = parsed.data;
      else lastReason = 'schema_invalid';
    } catch (error) {
      const reason = error instanceof LlmProviderError ? error.reason : 'provider_error';
      if (!schemaLike.has(reason)) return { generations, reason, status: 'generation_failed' };
      lastReason = reason;
    }
  }
  if (output === undefined) return { generations, reason: lastReason, status: 'generation_failed' };

  const grounding = checkGrounding(output, aggregate);
  const safety = checkSafety(output, aggregate);
  if (safety.length > 0) return { generations, grounding, safety, status: 'failed_safety' };
  if (grounding.length > 0) return { generations, grounding, status: 'failed_grounding' };
  return { generations, output, status: 'ready' };
}
