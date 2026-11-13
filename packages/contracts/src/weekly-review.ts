import { z } from 'zod';

import { addLocalDays } from './daily-metrics.js';
import {
  DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL,
  DAILY_MOVEMENT_STEPS_MAX,
  dailyActiveEnergyKcalSchema,
  dailyMovementSources,
  dailyStepsSchema,
} from './daily-movement.js';
import { ACTIVITY_TYPES } from './activities.js';
import { localDateSchema, timestampSchema, ianaTimeZoneSchema } from './primitives.js';
import { weeklyInsightDataGapSchema, weeklyInsightFactSchema, weeklyInsightWeekStartSchema } from './weekly-insights.js';

// Weekly review of the signed-in person (the deterministic slice after ADR-0076). Computed by the server, on request,
// from the person's own check-ins, manual activities, GPS runs and manual daily movement, read in one database snapshot.
// Every number and every sentence is written by code: no language model is involved, nothing is queued, and nothing is
// stored. It is therefore always available, whether AI generation is on or off and whether or not an AI insight exists
// for the week. Owner-only like the data it is derived from: no request carries an owner.

/**
 * The version of the review's statement and coverage rules. Change it when a statement's meaning or a denominator
 * changes. The facts and data gaps follow the aggregation policy named in `provenance.policyVersion`.
 * - `weekly-review-1`: ADR-0077.
 * - `weekly-review-2`: adds `movement` and the `movement.*` statements (ADR-0079). Nothing else changed meaning.
 * - `weekly-review-3`: adds `importedActivities` and the `imported.*` statement (ADR-0086). `manual.*`, the facts and
 *   the coverage count manual activities only, as before: no other source existed until then.
 * - `weekly-review-4`: adds `tcxImportedActivities` and the `imported.tcx` statement (ADR-0091). `importedActivities`
 *   and `imported.gpx` stay GPX imports only; `manual.*`, the facts and the coverage are unchanged.
 */
export const WEEKLY_REVIEW_VERSION = 'weekly-review-4';

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
 * - `movement.*`: manual daily movement (steps, active energy), each metric against the 7 calendar days, recorded
 *   totals with their coverage, the manual source, and days saved in other zones. Never added to activity figures.
 * - `imported.*`: activities imported from GPX files (ADR-0086) and TCX files (ADR-0091), each format described apart from
 *   the other, from manual activities and from GPS runs.
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
  'movement.none',
  'movement.steps_recorded',
  'movement.steps_not_recorded',
  'movement.active_energy_recorded',
  'movement.active_energy_not_recorded',
  'movement.manual_source',
  'movement.time_zones',
  'imported.gpx',
  'imported.tcx',
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

/** Integer tenths of a kcal of a value with at most one decimal (exact for every value the contract accepts). */
const kcalTenths = (kcal: number) => Math.round(kcal * 10);

/**
 * One calendar day of the week as manual movement saw it. A day without a record says so (`recorded: false`) and has
 * no values: it is unknown, never zero. A recorded day keeps each value as stored, so a recorded 0 stays 0 and a value
 * left empty stays null; `source` and `timeZone` are the stored provenance and the zone of the day's first write.
 */
export const weeklyReviewMovementDaySchema = z.discriminatedUnion('recorded', [
  z.strictObject({ localDate: localDateSchema, recorded: z.literal(false) }),
  z
    .strictObject({
      activeEnergyKcal: dailyActiveEnergyKcalSchema.nullable(),
      localDate: localDateSchema,
      recorded: z.literal(true),
      source: z.enum(dailyMovementSources),
      steps: dailyStepsSchema.nullable(),
      timeZone: z.string().min(1).max(64),
    })
    .refine((day) => day.steps !== null || day.activeEnergyKcal !== null, 'A recorded day has at least one value'),
]);

/**
 * Manual daily movement of the week (ADR-0079). Days are the stored local dates from Monday to Sunday inclusive, each
 * day as it was entered: a daily total is never moved by a zone, and movement never moves the week's GPS or activity
 * boundaries. Each metric has its own coverage against the 7 calendar days, independent of check-ins and of the other
 * metric. A `recordedTotal` adds up the recorded days only (null when none: unknown, not zero; 0 when only zeros were
 * recorded); it is never added to manual activity or GPS figures, and nothing is derived from it. Energy totals are
 * added as integer tenths of a kcal, so 0.1 + 0.2 is 0.3 exactly.
 */
export const weeklyReviewMovementSchema = z
  .strictObject({
    /** Every value counted here was entered manually; no other source exists yet. */
    source: z.literal('manual'),
    daysInWeek: z.literal(7),
    /** Days with a movement record, whichever values it holds. */
    daysWithRecord: dayCount,
    steps: z.strictObject({
      daysRecorded: dayCount,
      recordedTotal: z.int().min(0).max(7 * DAILY_MOVEMENT_STEPS_MAX).nullable(),
    }),
    activeEnergyKcal: z.strictObject({
      daysRecorded: dayCount,
      recordedTotal: z
        .number()
        .finite()
        .min(0)
        .max(7 * DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL)
        .refine((value) => kcalTenths(value) / 10 === value, 'A total has at most one decimal')
        .nullable(),
    }),
    /** Monday to Sunday, in order. */
    days: z.array(weeklyReviewMovementDaySchema).length(7),
  })
  .superRefine((movement, context) => {
    const recorded = movement.days.flatMap((day) => (day.recorded ? [day] : []));
    const steps = recorded.flatMap((day) => (day.steps === null ? [] : [day.steps]));
    const energy = recorded.flatMap((day) => (day.activeEnergyKcal === null ? [] : [kcalTenths(day.activeEnergyKcal)]));
    const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: 'custom', message, path });
    if (movement.daysWithRecord !== recorded.length) issue('days with a record must match the recorded days', ['daysWithRecord']);
    if (movement.steps.daysRecorded !== steps.length) issue('days with steps must match the days', ['steps', 'daysRecorded']);
    if (movement.activeEnergyKcal.daysRecorded !== energy.length) {
      issue('days with active energy must match the days', ['activeEnergyKcal', 'daysRecorded']);
    }
    const stepsTotal = steps.length === 0 ? null : steps.reduce((sum, value) => sum + value, 0);
    if (movement.steps.recordedTotal !== stepsTotal) issue('the steps total is the sum of the recorded days', ['steps', 'recordedTotal']);
    const energyTenths = energy.length === 0 ? null : energy.reduce((sum, value) => sum + value, 0);
    const total = movement.activeEnergyKcal.recordedTotal;
    if ((total === null ? null : kcalTenths(total)) !== energyTenths) {
      issue('the active energy total is the sum of the recorded days', ['activeEnergyKcal', 'recordedTotal']);
    }
  });

// At most 10,000 activities of at most 48 hours and 1,000 km each.
const importedSeconds = z.int().min(0).max(10_000 * 172_800);
const importedMetres = z.int().min(0).max(10_000 * 1_000_000);

export const weeklyReviewImportedTypeSchema = z.strictObject({
  type: z.enum(ACTIVITY_TYPES),
  count: itemCount,
  elapsedDurationS: importedSeconds,
  distanceM: importedMetres,
});

/**
 * Activities imported from GPX files that started in the week's range (ADR-0086), in the week's zone like manual
 * activities. Review-only: not part of `facts`, `coverage` or `dataGaps`, which AI insights share, and never added to
 * manual activity or GPS run figures. `elapsedDurationS` is elapsed time (first to last point, pauses included), not
 * moving time; `distanceM` is the server-computed distance of the imports. An import is never compared with GPS runs,
 * so the same outing recorded both ways is counted in both parts.
 */
export const weeklyReviewImportedActivitiesSchema = z
  .strictObject({
    source: z.literal('gpx'),
    count: itemCount,
    elapsedDurationS: importedSeconds,
    distanceM: importedMetres,
    /** Types with at least one import, in the order of ACTIVITY_TYPES. */
    byType: z.array(weeklyReviewImportedTypeSchema).max(ACTIVITY_TYPES.length),
  })
  .superRefine((imported, context) => {
    const issue = (message: string, path: string[]) => context.addIssue({ code: 'custom', message, path });
    const sum = (field: 'count' | 'distanceM' | 'elapsedDurationS') => imported.byType.reduce((total, entry) => total + entry[field], 0);
    if (sum('count') !== imported.count) issue('the per-type counts add up to the count', ['count']);
    if (sum('elapsedDurationS') !== imported.elapsedDurationS) issue('the per-type durations add up to the duration', ['elapsedDurationS']);
    if (sum('distanceM') !== imported.distanceM) issue('the per-type distances add up to the distance', ['distanceM']);
    const order = imported.byType.map((entry) => ACTIVITY_TYPES.indexOf(entry.type));
    if (order.some((position, index) => index > 0 && order[index - 1]! >= position)) {
      issue('types are listed once each, in the order of ACTIVITY_TYPES', ['byType']);
    }
    if (imported.byType.some((entry) => entry.count === 0)) issue('only types with an import are listed', ['byType']);
  });

export const weeklyReviewTcxImportedTypeSchema = z.strictObject({
  type: z.enum(ACTIVITY_TYPES),
  count: itemCount,
  reportedDurationS: importedSeconds,
  distanceM: importedMetres,
});

/**
 * Activities imported from TCX files that started in the week's range (ADR-0091), in the week's zone like manual
 * activities. Review-only like GPX imports: not part of `facts`, `coverage` or `dataGaps`, which AI insights share, and
 * never added to manual activities, GPX imports or GPS runs. `reportedDurationS` is the sum of the imports' reported
 * durations (each the sum of its laps' TotalTimeSeconds, rounded once at import): neither elapsed time nor moving time.
 * `distanceM` is the sum of the imports' lap distances. A TCX import is never compared with any other source.
 */
export const weeklyReviewTcxImportedActivitiesSchema = z
  .strictObject({
    source: z.literal('tcx'),
    count: itemCount,
    reportedDurationS: importedSeconds,
    distanceM: importedMetres,
    /** Types with at least one import, in the order of ACTIVITY_TYPES. */
    byType: z.array(weeklyReviewTcxImportedTypeSchema).max(ACTIVITY_TYPES.length),
  })
  .superRefine((imported, context) => {
    const issue = (message: string, path: string[]) => context.addIssue({ code: 'custom', message, path });
    const sum = (field: 'count' | 'distanceM' | 'reportedDurationS') => imported.byType.reduce((total, entry) => total + entry[field], 0);
    if (sum('count') !== imported.count) issue('the per-type counts add up to the count', ['count']);
    if (sum('reportedDurationS') !== imported.reportedDurationS) issue('the per-type durations add up to the duration', ['reportedDurationS']);
    if (sum('distanceM') !== imported.distanceM) issue('the per-type distances add up to the distance', ['distanceM']);
    const order = imported.byType.map((entry) => ACTIVITY_TYPES.indexOf(entry.type));
    if (order.some((position, index) => index > 0 && order[index - 1]! >= position)) {
      issue('types are listed once each, in the order of ACTIVITY_TYPES', ['byType']);
    }
    if (imported.byType.some((entry) => entry.count === 0)) issue('only types with an import are listed', ['byType']);
  });

export const weeklyReviewSchema = z
  .strictObject({
    coverage: weeklyReviewCoverageSchema,
    /** Code-written data gaps and source limitations. */
    dataGaps: z.array(weeklyInsightDataGapSchema).max(10),
    /** Every number of the week that has a value; a value that was not recorded has no fact (never a zero). */
    facts: z.array(weeklyInsightFactSchema).max(WEEKLY_REVIEW_FACTS_MAX),
    /** GPX imports, review-only: not part of `facts`, `coverage` or `dataGaps`, which AI insights share. */
    importedActivities: weeklyReviewImportedActivitiesSchema,
    /** Manual daily movement, review-only: not part of `facts`, `coverage` or `dataGaps`, which AI insights share. */
    movement: weeklyReviewMovementSchema,
    provenance: weeklyReviewProvenanceSchema,
    /** Code-written descriptive sentences, in a stable order. */
    statements: z.array(weeklyReviewStatementSchema).max(WEEKLY_REVIEW_STATEMENTS_MAX),
    /** TCX imports, review-only: not part of `facts`, `coverage` or `dataGaps`, which AI insights share. */
    tcxImportedActivities: weeklyReviewTcxImportedActivitiesSchema,
    week: weeklyReviewWeekSchema,
  })
  .refine((review) => review.movement.days.every((day, index) => day.localDate === addLocalDays(review.week.start, index)), {
    message: 'movement days are the week from Monday to Sunday, in order',
    path: ['movement', 'days'],
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
export type WeeklyReviewMovementDay = z.infer<typeof weeklyReviewMovementDaySchema>;
export type WeeklyReviewMovement = z.infer<typeof weeklyReviewMovementSchema>;
export type WeeklyReviewImportedActivities = z.infer<typeof weeklyReviewImportedActivitiesSchema>;
export type WeeklyReviewTcxImportedActivities = z.infer<typeof weeklyReviewTcxImportedActivitiesSchema>;
export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;
export type WeeklyReviewQuery = z.infer<typeof weeklyReviewQuerySchema>;
