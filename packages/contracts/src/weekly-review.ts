import { z } from 'zod';

import { localDateSchema, timestampSchema, ianaTimeZoneSchema } from './primitives.js';
import { weeklyInsightDataGapSchema, weeklyInsightFactSchema, weeklyInsightWeekStartSchema } from './weekly-insights.js';

// Weekly review of the signed-in person (the deterministic slice after ADR-0076). Computed by the server, on request,
// from the person's own check-ins, manual activities and GPS runs, read in one database snapshot. Every number and
// every sentence is written by code: no language model is involved, nothing is queued, and nothing is stored. It is
// therefore always available, whether AI generation is on or off and whether or not an AI insight exists for the week.
// Owner-only like the data it is derived from: no request carries an owner.

/**
 * The version of the review's statement and coverage rules. Change it when a statement's meaning or a denominator
 * changes. The facts and data gaps follow the aggregation policy named in `provenance.policyVersion`.
 */
export const WEEKLY_REVIEW_VERSION = 'weekly-review-1';

export const WEEKLY_REVIEW_STATEMENTS_MAX = 40;
export const WEEKLY_REVIEW_FACTS_MAX = 64;
export const WEEKLY_REVIEW_STATEMENT_MAX_LENGTH = 240;

/**
 * Stable codes of the code-written statements. A client may rely on a code's meaning; the text may be reworded.
 * - `week.*`: the week is still in progress, which zone it is read in and why.
 * - `check_ins.*`: days with numeric check-in values; days whose check-in holds only a note.
 * - `sleep_duration.*` and `sleep_quality.*`: separate on purpose. A quality rating never implies a duration.
 * - `weight.*`: a direction only from two or more measurements.
 * - `manual.*`: manual activities, in total and per type.
 * - `gps.*`: GPS runs, with a distance only from current summaries, and which runs it covers.
 * - `sources.*`: limits of combining sources.
 */
export const weeklyReviewStatementCodes = [
  'week.in_progress',
  'week.time_zone_from_request',
  'week.multiple_time_zones',
  'check_ins.none',
  'check_ins.coverage',
  'check_ins.note_only_days',
  'sleep_duration.not_recorded',
  'sleep_duration.coverage',
  'sleep_duration.values',
  'sleep_quality.not_rated',
  'sleep_quality.coverage',
  'sleep_quality.without_duration',
  'mood.not_rated',
  'mood.coverage',
  'soreness.not_rated',
  'soreness.coverage',
  'weight.not_recorded',
  'weight.single_measurement',
  'weight.change',
  'manual.none',
  'manual.total',
  'manual.hike',
  'manual.other',
  'manual.ride',
  'manual.run',
  'manual.strength',
  'manual.swim',
  'manual.walk',
  'gps.none',
  'gps.totals',
  'gps.partial_distance',
  'gps.no_distance',
  'sources.manual_and_gps_runs_separate',
] as const;
export const weeklyReviewStatementCodeSchema = z.enum(weeklyReviewStatementCodes);

export const weeklyReviewStatementSchema = z.strictObject({
  code: weeklyReviewStatementCodeSchema,
  text: z.string().min(1).max(WEEKLY_REVIEW_STATEMENT_MAX_LENGTH),
});

const dayCount = z.number().int().min(0).max(7);
const itemCount = z.number().int().min(0).max(10_000);

/**
 * How much of the week each source covers, with every denominator explicit:
 * - `daysInWeek`: always 7 (Monday to Sunday).
 * - `daysWithCheckInRecord`: days with any check-in, a note-only one included.
 * - `daysWithCheckInValues`: days with at least one numeric value (weight, sleep duration, sleep quality, mood,
 *   soreness). A note-only check-in is not one of them.
 * - `noteOnlyDays`: `daysWithCheckInRecord - daysWithCheckInValues`.
 * - `metrics.*.daysRecorded`: days with that particular value; never more than `daysWithCheckInValues`.
 * - `sleepQualityWithoutDurationDays`: days with a sleep-quality rating and no sleep duration.
 */
export const weeklyReviewCoverageSchema = z
  .strictObject({
    daysInWeek: z.literal(7),
    daysWithCheckInRecord: dayCount,
    daysWithCheckInValues: dayCount,
    gpsRuns: z.strictObject({
      count: itemCount,
      /** Runs whose distance comes from a summary that is current for the run's data. */
      withCurrentDistance: itemCount,
      /** Runs with no summary yet, or one older than the run's data: their distance is unknown, never zero. */
      withoutCurrentDistance: itemCount,
    }),
    manualActivities: z.strictObject({
      count: itemCount,
      /** Manual activities for which a distance was entered. */
      withDistance: itemCount,
    }),
    metrics: z.strictObject({
      mood: z.strictObject({ daysRecorded: dayCount }),
      sleepDuration: z.strictObject({ daysRecorded: dayCount }),
      sleepQuality: z.strictObject({ daysRecorded: dayCount }),
      soreness: z.strictObject({ daysRecorded: dayCount }),
      weight: z.strictObject({ daysRecorded: dayCount }),
    }),
    noteOnlyDays: dayCount,
    sleepQualityWithoutDurationDays: dayCount,
  })
  .refine((coverage) => coverage.daysWithCheckInValues <= coverage.daysWithCheckInRecord, {
    message: 'days with values cannot exceed days with a record',
    path: ['daysWithCheckInValues'],
  })
  .refine((coverage) => coverage.noteOnlyDays === coverage.daysWithCheckInRecord - coverage.daysWithCheckInValues, {
    message: 'note-only days are the days with a record and no value',
    path: ['noteOnlyDays'],
  })
  .refine((coverage) => Object.values(coverage.metrics).every((metric) => metric.daysRecorded <= coverage.daysWithCheckInValues), {
    message: 'a metric cannot be recorded on more days than have values',
    path: ['metrics'],
  })
  .refine((coverage) => coverage.sleepQualityWithoutDurationDays <= coverage.metrics.sleepQuality.daysRecorded, {
    message: 'quality-only days cannot exceed days with a quality rating',
    path: ['sleepQualityWithoutDurationDays'],
  })
  .refine((coverage) => coverage.gpsRuns.withCurrentDistance + coverage.gpsRuns.withoutCurrentDistance === coverage.gpsRuns.count, {
    message: 'every GPS run either has a current distance or not',
    path: ['gpsRuns'],
  })
  .refine((coverage) => coverage.manualActivities.withDistance <= coverage.manualActivities.count, {
    message: 'activities with a distance cannot exceed activities',
    path: ['manualActivities'],
  });

export const weeklyReviewWeekSchema = z.strictObject({
  /** The Sunday the week ends on. */
  end: localDateSchema,
  /** Whether today, in the week's zone, is one of the week's days: later records can still change the review. */
  inProgress: z.boolean(),
  /** The Monday the week starts on. */
  start: weeklyInsightWeekStartSchema,
  /** The zone the week's days begin and end in, for activities and GPS runs too. */
  timeZone: z.string().min(1).max(64),
  /** `check_ins`: the most frequent zone on the week's check-ins. `request`: no check-in, so the requested zone. */
  timeZoneSource: z.enum(['check_ins', 'request']),
  /** Distinct zones stored on the week's check-ins, sorted. More than one is reported as a limitation. */
  zonesOnCheckIns: z.array(z.string().min(1).max(64)).max(7),
});

/**
 * Where the review comes from. It is never an AI insight: an AI insight has a model, a prompt version, an id and a
 * creation time, and is stored; the review has none of those and is recomputed from current data on every read.
 */
export const weeklyReviewProvenanceSchema = z.strictObject({
  computedAt: timestampSchema,
  /** Never stored: a deleted source record is gone from the next read. */
  persisted: z.literal(false),
  /** Aggregation and fact policy the facts and data gaps follow (shared with AI insights). */
  policyVersion: z.string().min(1).max(64),
  reviewVersion: z.string().min(1).max(64),
  /** Every source of the week was read in one statement of one REPEATABLE READ, READ ONLY transaction. */
  snapshot: z.literal('single_read_only_transaction'),
  source: z.literal('computed_by_app'),
});

export const weeklyReviewSchema = z.strictObject({
  coverage: weeklyReviewCoverageSchema,
  /** Code-written data gaps and source limitations. */
  dataGaps: z.array(weeklyInsightDataGapSchema).max(10),
  /** Every number of the week that has a value; a value that was not recorded has no fact (never a zero). */
  facts: z.array(weeklyInsightFactSchema).max(WEEKLY_REVIEW_FACTS_MAX),
  provenance: weeklyReviewProvenanceSchema,
  /** Code-written descriptive sentences, in a stable order. */
  statements: z.array(weeklyReviewStatementSchema).max(WEEKLY_REVIEW_STATEMENTS_MAX),
  week: weeklyReviewWeekSchema,
});

/**
 * `timeZone` is used only when the person has no check-in in the week: otherwise the zone stored on their check-ins
 * decides where the week's days begin and end. A week starting after today in `timeZone` is refused.
 */
export const weeklyReviewQuerySchema = z.strictObject({
  timeZone: ianaTimeZoneSchema,
  weekStart: weeklyInsightWeekStartSchema,
});

export type WeeklyReviewStatementCode = z.infer<typeof weeklyReviewStatementCodeSchema>;
export type WeeklyReviewStatement = z.infer<typeof weeklyReviewStatementSchema>;
export type WeeklyReviewCoverage = z.infer<typeof weeklyReviewCoverageSchema>;
export type WeeklyReviewWeek = z.infer<typeof weeklyReviewWeekSchema>;
export type WeeklyReviewProvenance = z.infer<typeof weeklyReviewProvenanceSchema>;
export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;
export type WeeklyReviewQuery = z.infer<typeof weeklyReviewQuerySchema>;
