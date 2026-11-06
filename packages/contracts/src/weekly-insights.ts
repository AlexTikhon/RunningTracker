import { z } from 'zod';

import { dailyMetricsLocalDateSchema } from './daily-metrics.js';
import { ianaTimeZoneSchema, parseLocalDate, timestampSchema, uuidSchema } from './primitives.js';

// Weekly insight of the signed-in person (ADR-0076). The numbers are computed by the server from the person's own
// check-ins, activities and GPS runs; a local language model only writes text about them, and the server checks that
// text before it is stored. Owner-only like the data it is derived from: no request carries an owner.
export const WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH = 600;
export const WEEKLY_INSIGHT_OBSERVATIONS_MAX = 4;
export const WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH = 300;
export const WEEKLY_INSIGHT_METRIC_KEYS_MAX = 6;
export const WEEKLY_INSIGHT_METRIC_KEY_MAX_LENGTH = 64;
export const WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH = 300;
export const WEEKLY_INSIGHT_DATA_GAPS_MAX = 6;
export const WEEKLY_INSIGHT_DATA_GAP_MAX_LENGTH = 200;

export const WEEKLY_INSIGHT_NOT_FOUND = 'WEEKLY_INSIGHT_NOT_FOUND';
export const WEEKLY_INSIGHTS_DISABLED = 'WEEKLY_INSIGHTS_DISABLED';
export const WEEKLY_INSIGHTS_BUSY = 'WEEKLY_INSIGHTS_BUSY';

/**
 * - `pending`: accepted, generation has not finished (it may be queued, running, or waiting for a new request after a
 *   server restart; sending the same request again resumes it).
 * - `ready`: the output passed the schema, grounding and safety checks.
 * - `generation_failed`: the model did not answer, or answered twice with something that is not the schema. Sending
 *   the same request again tries once more.
 * - `failed_grounding`: the answer used a number or a metric key that is not in the computed data. Discarded.
 * - `failed_safety`: the answer contained medical content, or did not limit itself to rest or professional advice
 *   when the week had extreme soreness or sleep values. Discarded.
 * A failed status never carries model output.
 */
export const weeklyInsightStatuses = [
  'pending',
  'ready',
  'generation_failed',
  'failed_grounding',
  'failed_safety',
] as const;
export const weeklyInsightStatusSchema = z.enum(weeklyInsightStatuses);

// No NUL (PostgreSQL jsonb text cannot hold it), no unpaired surrogate, and something other than whitespace.
const insightText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, 'The text must not be blank')
    .refine((value) => !value.includes('\u0000'), 'The text must not contain NUL characters')
    .refine((value) => !/\p{Cs}/u.test(value), 'The text must be well-formed Unicode text');

/** A dotted path into the computed weekly data, for example `sleep.avgMinutes`. */
export const weeklyInsightMetricKeySchema = z
  .string()
  .max(WEEKLY_INSIGHT_METRIC_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u, 'Expected a dotted metric key such as sleep.avgMinutes');

export const weeklyInsightObservationSchema = z.strictObject({
  metricKeys: z.array(weeklyInsightMetricKeySchema).min(1).max(WEEKLY_INSIGHT_METRIC_KEYS_MAX),
  text: insightText(WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH),
});

/** What the model must answer, and what a `ready` insight carries. Unknown fields are refused. */
export const weeklyInsightOutputSchema = z.strictObject({
  dataGaps: z.array(insightText(WEEKLY_INSIGHT_DATA_GAP_MAX_LENGTH)).max(WEEKLY_INSIGHT_DATA_GAPS_MAX),
  observations: z.array(weeklyInsightObservationSchema).max(WEEKLY_INSIGHT_OBSERVATIONS_MAX),
  suggestion: insightText(WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH),
  summary: insightText(WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH),
});

function isMonday(value: string): boolean {
  const parsed = parseLocalDate(value);
  return parsed !== null && new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay() === 1;
}

/** The Monday a week starts on, as a local calendar date (YYYY-MM-DD). Weeks run Monday to Sunday. */
export const weeklyInsightWeekStartSchema = dailyMetricsLocalDateSchema.refine(isMonday, 'The week must start on a Monday');

/**
 * Asks for the insight of one week. `timeZone` is used only when the person has no check-in in that week: otherwise
 * the zone stored on their check-ins decides where the week's days begin and end.
 */
export const createWeeklyInsightRequestSchema = z.strictObject({
  timeZone: ianaTimeZoneSchema,
  weekStart: weeklyInsightWeekStartSchema,
});

export const weeklyInsightQuerySchema = z.strictObject({ weekStart: weeklyInsightWeekStartSchema });

export const weeklyInsightAcceptedSchema = z.strictObject({
  id: uuidSchema,
  status: weeklyInsightStatusSchema,
});

export const weeklyInsightViewSchema = z
  .strictObject({
    createdAt: timestampSchema,
    id: uuidSchema,
    model: z.string().min(1).max(64),
    /** Present exactly when `status` is `ready`. */
    output: weeklyInsightOutputSchema.nullable(),
    promptVersion: z.string().min(1).max(64),
    status: weeklyInsightStatusSchema,
    timeZone: z.string().min(1).max(64),
    weekStart: weeklyInsightWeekStartSchema,
  })
  .refine((view) => (view.status === 'ready') === (view.output !== null), {
    message: 'output is present exactly when status is ready',
    path: ['output'],
  });

export type WeeklyInsightStatus = z.infer<typeof weeklyInsightStatusSchema>;
export type WeeklyInsightObservation = z.infer<typeof weeklyInsightObservationSchema>;
export type WeeklyInsightOutput = z.infer<typeof weeklyInsightOutputSchema>;
export type CreateWeeklyInsightRequest = z.infer<typeof createWeeklyInsightRequestSchema>;
export type WeeklyInsightQuery = z.infer<typeof weeklyInsightQuerySchema>;
export type WeeklyInsightAccepted = z.infer<typeof weeklyInsightAcceptedSchema>;
export type WeeklyInsightView = z.infer<typeof weeklyInsightViewSchema>;
