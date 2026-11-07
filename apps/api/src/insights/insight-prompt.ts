import {
  WEEKDAY_NAMES,
  WEEKLY_INSIGHT_CLAIMS_MAX,
  WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH,
  WEEKLY_INSIGHT_OBSERVATIONS_MAX,
  WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH,
  WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH,
  weeklyInsightDirections,
  weeklyInsightUnits,
  type WeeklyInsightFact,
} from '@running-tracker/contracts';

import { canonicalJson, hasExtremeValues, type WeeklyAggregate } from './weekly-aggregate.js';

// The prompt of the weekly insight (ADR-0076). Any change to the wording, the data layout or the output schema below
// changes what a model is asked, so it must come with a new version: a stored insight records the version it was
// generated with, and a new version regenerates rather than reusing an answer to a different question.
//
// What the model receives: the week's first and last date, its flags, and the fact catalogue (id, label, value, unit,
// direction, day). Never notes, coordinates, run or activity identifiers, or the person's identity.
export const WEEKLY_INSIGHT_PROMPT_VERSION = 'weekly-insight-v2';

/**
 * The system message. It does not depend on the person or the week, so a local model can reuse its evaluated prefix
 * between requests.
 */
export const WEEKLY_INSIGHT_SYSTEM_PROMPT = [
  'You write a short, friendly weekly wellbeing summary for one person. You describe the week; you are not a doctor or a coach.',
  'The user message lists the week\'s facts as JSON. Software computed every fact, and the app shows every number itself.',
  '',
  'Answer with JSON only:',
  '- summary: two or three sentences of plain prose about the week.',
  `- observations: up to ${WEEKLY_INSIGHT_OBSERVATIONS_MAX}. Each has text (one sentence of prose) and claims: the 1 to ${WEEKLY_INSIGHT_CLAIMS_MAX} facts that sentence is about. A claim copies one fact exactly: factId is the fact's id, and value, unit, direction and day are exactly as in that fact.`,
  '- suggestion: one simple, non-medical habit for the coming week, or null when the user message says to write null.',
  '',
  'Rules for summary, observation text and suggestion:',
  '1. Never write a number, in digits or in words. Never name a weekday, a month or a date. The app shows those from your claims.',
  '2. Describe only what the facts say. Do not compare facts or guess causes. Write "went up" or "went down" only about a fact whose direction is up or down, and cite that fact.',
  '3. Never diagnose, never name an illness, injury or medical condition, never mention medication, supplements, diets or treatments, and never tell the person to ignore pain or to avoid seeking help.',
  '4. Manual activities and GPS runs are separate sources that may describe the same run. Never add them together.',
  '5. A fact that is not in the list was not recorded. Do not guess it and do not treat it as zero.',
].join('\n');

export const WEEKLY_INSIGHT_FACTS_HEADER = 'Week facts (JSON):';
export const WEEKLY_INSIGHT_SUGGESTION_NULL = 'Suggestion: write null. This week has extreme values; the app adds its own suggestion.';
export const WEEKLY_INSIGHT_SUGGESTION_WRITE = 'Suggestion: write one.';

export interface InsightPrompt {
  system: string;
  user: string;
}

/** The facts as the model sees them: without the rendered text (it adds nothing the fields do not say). */
function promptFacts(facts: readonly WeeklyInsightFact[]): unknown[] {
  return facts.map(({ day, direction, id, label, unit, value }) => ({ day, direction, id, label, unit, value }));
}

/** The exact model input for one week. */
export function buildWeeklyInsightPrompt(aggregate: WeeklyAggregate, facts: readonly WeeklyInsightFact[]): InsightPrompt {
  const flags = aggregate.flags.length === 0 ? 'none' : aggregate.flags.join(', ');
  return {
    system: WEEKLY_INSIGHT_SYSTEM_PROMPT,
    user: [
      `Week: ${aggregate.week.start} to ${aggregate.week.end}.`,
      `Flags: ${flags}.`,
      hasExtremeValues(aggregate) ? WEEKLY_INSIGHT_SUGGESTION_NULL : WEEKLY_INSIGHT_SUGGESTION_WRITE,
      '',
      WEEKLY_INSIGHT_FACTS_HEADER,
      canonicalJson(promptFacts(facts)),
    ].join('\n'),
  };
}

const text = (maxLength: number) => ({ maxLength, minLength: 1, type: 'string' });

/**
 * The output shape sent to the model as its structured-output format, for one week: `factId` is restricted to that
 * week's fact ids. It mirrors `weeklyInsightModelOutputSchema` from the contracts package, which remains the authority:
 * every answer is parsed with the Zod schema and then checked claim by claim, whatever the model's runtime made of this
 * one (length limits, for example, are not enforced by every grammar).
 */
export function weeklyInsightOutputJsonSchema(facts: readonly WeeklyInsightFact[]): Record<string, unknown> {
  return {
    additionalProperties: false,
    properties: {
      summary: text(WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH),
      observations: {
        items: {
          additionalProperties: false,
          properties: {
            text: text(WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH),
            claims: {
              items: {
                additionalProperties: false,
                properties: {
                  factId: { enum: facts.map((entry) => entry.id), type: 'string' },
                  value: { type: 'number' },
                  unit: { enum: [...weeklyInsightUnits], type: 'string' },
                  direction: { enum: [...weeklyInsightDirections], type: 'string' },
                  day: { enum: [...WEEKDAY_NAMES, 'none'], type: 'string' },
                },
                required: ['factId', 'value', 'unit', 'direction', 'day'],
                type: 'object',
              },
              maxItems: WEEKLY_INSIGHT_CLAIMS_MAX,
              minItems: 1,
              type: 'array',
            },
          },
          required: ['text', 'claims'],
          type: 'object',
        },
        maxItems: WEEKLY_INSIGHT_OBSERVATIONS_MAX,
        type: 'array',
      },
      suggestion: { anyOf: [text(WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH), { type: 'null' }] },
    },
    required: ['summary', 'observations', 'suggestion'],
    type: 'object',
  };
}
