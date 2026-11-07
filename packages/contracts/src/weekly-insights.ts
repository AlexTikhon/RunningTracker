import { z } from 'zod';

import { dailyMetricsLocalDateSchema } from './daily-metrics.js';
import { ianaTimeZoneSchema, parseLocalDate, timestampSchema, uuidSchema } from './primitives.js';

// Weekly insight of the signed-in person (ADR-0076). Every number is computed by the server from the person's own
// check-ins, activities and GPS runs and published as a FACT: an id, a value, a unit and, where it applies, a
// direction and a weekday, with a text rendered by code. A local language model writes prose WITHOUT numbers, days or
// dates, and cites the facts each observation is about as CLAIMS that repeat the fact's value, unit, direction and day;
// the server refuses an answer whose claims do not match the facts exactly. Owner-only like the data it is derived
// from: no request carries an owner.

export const WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH = 400;
export const WEEKLY_INSIGHT_OBSERVATIONS_MAX = 4;
export const WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH = 240;
export const WEEKLY_INSIGHT_CLAIMS_MAX = 3;
export const WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH = 240;
export const WEEKLY_INSIGHT_FACT_TEXT_MAX_LENGTH = 120;
export const WEEKLY_INSIGHT_DATA_GAPS_MAX = 10;
/** Attempts a week's insight may use for one input (first generation plus retries of interrupted or failed jobs). */
export const WEEKLY_INSIGHT_MAX_ATTEMPTS = 3;

export const WEEKLY_INSIGHT_NOT_FOUND = 'WEEKLY_INSIGHT_NOT_FOUND';
export const WEEKLY_INSIGHTS_DISABLED = 'WEEKLY_INSIGHTS_DISABLED';
export const WEEKLY_INSIGHTS_BUSY = 'WEEKLY_INSIGHTS_BUSY';
export const WEEKLY_INSIGHT_RETRY_LIMIT = 'WEEKLY_INSIGHT_RETRY_LIMIT';

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * - `queued`, `running`: accepted; generation has not finished. Polling is expected.
 * - `ready`: the answer passed the schema, claim grounding and safety checks.
 * - `generation_failed`: the model did not answer within the budget, or answered twice with something that is not the
 *   schema. A new request retries it while attempts remain.
 * - `failed_grounding`: a claim did not match the computed facts, or the prose contained a number, a day or a date.
 * - `failed_safety`: the prose contained medical content or advice to ignore symptoms or avoid help.
 * - `interrupted`: the job ended without a result (server shutdown or restart, or the result could not be stored). A
 *   new request retries it while attempts remain.
 * A failed or interrupted status never carries model output.
 */
export const weeklyInsightStatuses = [
  'queued',
  'running',
  'ready',
  'generation_failed',
  'failed_grounding',
  'failed_safety',
  'interrupted',
] as const;
export const weeklyInsightStatusSchema = z.enum(weeklyInsightStatuses);

/**
 * - `current`: the person's data for the week, read now, gives the same computed input as the insight was made from.
 * - `stale`: the data changed since (a new check-in, a late GPS upload, a newly published GPS summary, the week ended).
 *   The insight is shown as out of date; asking again replaces it.
 * - `outdated_policy`: made under an older aggregation, grounding or safety policy. Its output is withheld.
 */
export const weeklyInsightFreshnessValues = ['current', 'stale', 'outdated_policy'] as const;
export const weeklyInsightFreshnessSchema = z.enum(weeklyInsightFreshnessValues);

export const weeklyInsightUnits = ['minutes', 'hours', 'days', 'percent', 'kg', 'km', 'count', 'score_1_5', 'score_0_10'] as const;
export const weeklyInsightUnitSchema = z.enum(weeklyInsightUnits);

/** `none` when a fact has no direction (only changes have one). */
export const weeklyInsightDirections = ['up', 'down', 'same', 'none'] as const;
export const weeklyInsightDirectionSchema = z.enum(weeklyInsightDirections);

/** `none` when a fact belongs to no single day. */
export const weeklyInsightDaySchema = z.enum([...WEEKDAY_NAMES, 'none']);

export const weeklyInsightDataGapCodes = [
  'no_check_ins',
  'missing_check_in_days',
  'no_activities',
  'gps_distance_pending',
  'manual_and_gps_runs_may_overlap',
  'multiple_time_zones',
  'week_in_progress',
] as const;
export const weeklyInsightDataGapCodeSchema = z.enum(weeklyInsightDataGapCodes);

// No NUL (PostgreSQL jsonb text cannot hold it), no unpaired surrogate, and something other than whitespace.
const insightText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, 'The text must not be blank')
    .refine((value) => !value.includes('\u0000'), 'The text must not contain NUL characters')
    .refine((value) => !/\p{Cs}/u.test(value), 'The text must be well-formed Unicode text');

/** A fact id such as `sleep.average_minutes` or `manual.run.distance`. */
export const weeklyInsightFactIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*){1,2}$/u, 'Expected a fact id such as sleep.average_minutes');

/** A number the server computed, with its rendering. Written by code only. */
export const weeklyInsightFactSchema = z.strictObject({
  day: weeklyInsightDaySchema,
  direction: weeklyInsightDirectionSchema,
  id: weeklyInsightFactIdSchema,
  label: insightText(80),
  text: insightText(WEEKLY_INSIGHT_FACT_TEXT_MAX_LENGTH),
  unit: weeklyInsightUnitSchema,
  /** Non-negative; a change is its magnitude, with `direction` saying which way. */
  value: z.number().finite().nonnegative(),
});

/** What the model writes to cite a fact. Accepted only when every field equals the fact's. */
export const weeklyInsightClaimSchema = z.strictObject({
  day: weeklyInsightDaySchema,
  direction: weeklyInsightDirectionSchema,
  factId: weeklyInsightFactIdSchema,
  unit: weeklyInsightUnitSchema,
  value: z.number().finite(),
});

/** The model's answer. Unknown fields are refused. `suggestion` is null in a week with extreme values. */
export const weeklyInsightModelOutputSchema = z.strictObject({
  observations: z
    .array(
      z.strictObject({
        claims: z.array(weeklyInsightClaimSchema).min(1).max(WEEKLY_INSIGHT_CLAIMS_MAX),
        text: insightText(WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH),
      }),
    )
    .max(WEEKLY_INSIGHT_OBSERVATIONS_MAX),
  suggestion: insightText(WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH).nullable(),
  summary: insightText(WEEKLY_INSIGHT_SUMMARY_MAX_LENGTH),
});

export const weeklyInsightDataGapSchema = z.strictObject({
  code: weeklyInsightDataGapCodeSchema,
  text: insightText(200),
});

/**
 * What a `ready` insight carries. `summary`, observation `text` and a `model` suggestion are AI-generated prose; the
 * facts, the data gaps and an `approved` suggestion are written by code.
 */
export const weeklyInsightOutputSchema = z.strictObject({
  dataGaps: z.array(weeklyInsightDataGapSchema).max(WEEKLY_INSIGHT_DATA_GAPS_MAX),
  observations: z
    .array(
      z.strictObject({
        facts: z.array(weeklyInsightFactSchema).min(1).max(WEEKLY_INSIGHT_CLAIMS_MAX),
        text: insightText(WEEKLY_INSIGHT_OBSERVATION_MAX_LENGTH),
      }),
    )
    .max(WEEKLY_INSIGHT_OBSERVATIONS_MAX),
  suggestion: z.strictObject({
    /** Present for an `approved` suggestion: which one of the fixed set code selected. */
    id: z.string().regex(/^[a-z][a-z_]{0,47}$/u).nullable(),
    source: z.enum(['model', 'approved']),
    text: insightText(WEEKLY_INSIGHT_SUGGESTION_MAX_LENGTH),
  }),
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
    attempts: z.number().int().min(1).max(100),
    createdAt: timestampSchema,
    /** A code (never model text) for a failed or interrupted status, for example `timeout` or `claim_mismatch`. */
    failureReason: z.string().regex(/^[a-z][a-z_]{0,47}$/u).nullable(),
    freshness: weeklyInsightFreshnessSchema,
    id: uuidSchema,
    model: z.string().min(1).max(64),
    /** Present exactly when `status` is `ready` and `freshness` is not `outdated_policy`. */
    output: weeklyInsightOutputSchema.nullable(),
    policyVersion: z.string().min(1).max(64),
    promptVersion: z.string().min(1).max(64),
    /** Whether asking again (POST) would start a new generation for this week. */
    retryable: z.boolean(),
    status: weeklyInsightStatusSchema,
    timeZone: z.string().min(1).max(64),
    updatedAt: timestampSchema,
    weekStart: weeklyInsightWeekStartSchema,
  })
  .refine((view) => (view.status === 'ready' && view.freshness !== 'outdated_policy') === (view.output !== null), {
    message: 'output is present exactly when status is ready and the policy is current',
    path: ['output'],
  });

export type WeeklyInsightStatus = z.infer<typeof weeklyInsightStatusSchema>;
export type WeeklyInsightFreshness = z.infer<typeof weeklyInsightFreshnessSchema>;
export type WeeklyInsightUnit = z.infer<typeof weeklyInsightUnitSchema>;
export type WeeklyInsightDirection = z.infer<typeof weeklyInsightDirectionSchema>;
export type WeeklyInsightDay = z.infer<typeof weeklyInsightDaySchema>;
export type WeeklyInsightDataGapCode = z.infer<typeof weeklyInsightDataGapCodeSchema>;
export type WeeklyInsightFact = z.infer<typeof weeklyInsightFactSchema>;
export type WeeklyInsightClaim = z.infer<typeof weeklyInsightClaimSchema>;
export type WeeklyInsightModelOutput = z.infer<typeof weeklyInsightModelOutputSchema>;
export type WeeklyInsightDataGap = z.infer<typeof weeklyInsightDataGapSchema>;
export type WeeklyInsightOutput = z.infer<typeof weeklyInsightOutputSchema>;
export type CreateWeeklyInsightRequest = z.infer<typeof createWeeklyInsightRequestSchema>;
export type WeeklyInsightQuery = z.infer<typeof weeklyInsightQuerySchema>;
export type WeeklyInsightAccepted = z.infer<typeof weeklyInsightAcceptedSchema>;
export type WeeklyInsightView = z.infer<typeof weeklyInsightViewSchema>;
