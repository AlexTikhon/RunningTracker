import {
  WEEKLY_INSIGHT_DATA_GAP_MAX_LENGTH,
  WEEKLY_INSIGHT_DATA_GAPS_MAX,
  WEEKLY_INSIGHT_METRIC_KEYS_MAX,
  WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH,
  WEEKLY_INSIGHT_OBSERVATIONS_MAX,
  WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH,
  WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH,
} from '@running-tracker/contracts';

import { canonicalJson, metricKeysOf, type WeeklyAggregate } from './weekly-aggregate.js';

// The prompt of the weekly insight (ADR-0076). Any change to the wording, the data layout or the output schema below
// changes what a model is asked, so it must come with a new version: a stored insight records the version it was
// generated with, and a new version regenerates rather than reusing an answer to a different question.
export const WEEKLY_INSIGHT_PROMPT_VERSION = 'weekly-insight-v1';

/**
 * The system message. It does not depend on the person or the week, so a local model can reuse its evaluated prefix
 * between requests. The data and the allowed metric keys are in the user message.
 */
export const WEEKLY_INSIGHT_SYSTEM_PROMPT = [
  'You write a short weekly wellbeing summary for one person, based only on the JSON data in the user message.',
  'The data was computed by software. Your job is to describe it in plain, friendly English. You are not a doctor or a coach.',
  '',
  'Rules:',
  '1. Use only numbers that appear in the data, written as they appear there. Do not calculate, add up, convert units or estimate any new number. If a number you want is not in the data, describe it in words without a number.',
  '2. Refer to days by weekday name (Monday to Sunday), never by calendar date.',
  '3. Each observation lists in metricKeys the data keys it is based on, chosen only from the allowed metric keys in the user message.',
  '4. Never diagnose, never name an illness, injury or medical condition, never mention medication, supplements or diets, and never give medical or treatment instructions.',
  '5. The suggestion is one simple, non-medical habit for the coming week.',
  '6. If flags contains extreme_soreness, extreme_short_sleep or extreme_long_sleep, the suggestion must only recommend rest and recovery, or talking to a healthcare professional in general terms. Do not suggest any training or exercise then.',
  '7. manualActivities and gpsRuns are separate sources that may describe the same run (flag manual_and_gps_runs_may_overlap). Never add their counts, durations or distances together.',
  '8. dataGaps lists missing or incomplete data in plain words, for example days without a check-in. Use an empty list when nothing is missing.',
  `9. summary is at most ${WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH} characters. Give at most ${WEEKLY_INSIGHT_OBSERVATIONS_MAX} observations. Answer with JSON only.`,
].join('\n');

export const WEEKLY_INSIGHT_DATA_HEADER = 'Week data (JSON):';
export const WEEKLY_INSIGHT_KEYS_HEADER = 'Allowed metric keys:';

export interface InsightPrompt {
  system: string;
  user: string;
}

/** The exact model input for one week: the fixed instructions, then the canonical data and the keys it may cite. */
export function buildWeeklyInsightPrompt(aggregate: WeeklyAggregate): InsightPrompt {
  return {
    system: WEEKLY_INSIGHT_SYSTEM_PROMPT,
    user: `${WEEKLY_INSIGHT_DATA_HEADER}\n${canonicalJson(aggregate)}\n\n${WEEKLY_INSIGHT_KEYS_HEADER} ${metricKeysOf(aggregate).join(', ')}`,
  };
}

const text = (maxLength: number) => ({ maxLength, minLength: 1, type: 'string' });

/**
 * The output shape sent to the model as its structured-output format. It mirrors `weeklyInsightOutputSchema` from the
 * contracts package, which remains the authority: every answer is parsed with the Zod schema whatever the model's
 * runtime made of this one (length limits, for example, are not enforced by every grammar).
 */
export const WEEKLY_INSIGHT_OUTPUT_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    summary: text(WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH),
    observations: {
      items: {
        additionalProperties: false,
        properties: {
          text: text(WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH),
          metricKeys: { items: { type: 'string' }, maxItems: WEEKLY_INSIGHT_METRIC_KEYS_MAX, minItems: 1, type: 'array' },
        },
        required: ['text', 'metricKeys'],
        type: 'object',
      },
      maxItems: WEEKLY_INSIGHT_OBSERVATIONS_MAX,
      type: 'array',
    },
    suggestion: text(WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH),
    dataGaps: { items: text(WEEKLY_INSIGHT_DATA_GAP_MAX_LENGTH), maxItems: WEEKLY_INSIGHT_DATA_GAPS_MAX, type: 'array' },
  },
  required: ['summary', 'observations', 'suggestion', 'dataGaps'],
  type: 'object',
} as const;
