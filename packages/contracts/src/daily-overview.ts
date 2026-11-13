import { z } from 'zod';

import { ACTIVITY_TYPES, activityTypeSchema } from './activities.js';
import {
  dailyMetricsLocalDateSchema,
  dailyMoodSchema,
  dailySleepMinutesSchema,
  dailySleepQualitySchema,
  dailySorenessSchema,
  dailyWeightKgSchema,
} from './daily-metrics.js';
import { dailyActiveEnergyKcalSchema, dailyMovementSources, dailyStepsSchema } from './daily-movement.js';
import { hasAtMostOneDecimal, MEAL_NUTRITION_FIELDS, MEAL_SOURCES } from './meals.js';
import { ianaTimeZoneSchema, localDateSchema, timestampSchema, uuidSchema } from './primitives.js';

// The daily overview (Today) of the signed-in person: what their own records hold for one local calendar date, read on
// request in one database snapshot. Read-only and derived: nothing is stored, queued or sent to a model. Owner-only
// like the data it is read from: no request carries an owner.
//
// Two attribution rules, both deliberate (ADR-0082):
// - A check-in and a movement day belong to the calendar date they were stored for (`local_date`), whatever zone they
//   were saved in and whatever zone the overview is viewed in. Their stored zone is returned so the screen can say when
//   it differs from the view zone; the record is never moved to another date.
// - A manual activity, a GPX or TCX import and a GPS run belong to the date on which they STARTED in the requested zone: the half-open
//   interval from that date's local midnight to the next date's local midnight, located from the zone's own rules (23
//   or 25 hours around a daylight saving change, never assumed to be 24).
// - A meal entry belongs to the calendar date it was logged for (`local_date`), like a check-in (ADR-0083).

/**
 * The version of the overview's attribution and counting rules. Change it when a field's meaning changes.
 * - `daily-overview-1`: ADR-0082.
 * - `daily-overview-2`: ADR-0083 adds `meals` (entries logged for the date, recorded nutrition totals and their
 *   coverage); every other part is unchanged.
 * - `daily-overview-3`: ADR-0086 adds `importedActivities` (GPX imports, kept apart). `manualActivities` now counts rows
 *   with the manual source only; before ADR-0086 no other source existed, so its meaning is unchanged.
 * - `daily-overview-4`: ADR-0091 adds `tcxImportedActivities` (TCX imports with their reported duration, kept apart from
 *   manual entries, GPX imports and GPS runs). `importedActivities` stays GPX imports only; every other part is unchanged.
 */
export const DAILY_OVERVIEW_VERSION = 'daily-overview-4';

const itemCount = z.number().int().min(0).max(10_000);
// At most 10,000 activities of at most 48 h each.
const durationSeconds = z.number().int().min(0).max(10_000 * 172_800);
// Rounded to the nearest metre; at most 10,000 runs of a bounded length.
const distanceMetres = z.number().int().min(0).max(1_000_000_000);
const storedZone = z.string().min(1).max(64);

/** The day the overview describes and how its timestamped sources were attributed to it. */
export const dailyOverviewDaySchema = z
  .strictObject({
    /** The selected local calendar date. */
    localDate: localDateSchema,
    /** The requested (view) zone, in the platform's canonical spelling. */
    timeZone: storedZone,
    /** The first instant of the date in `timeZone` (inclusive). */
    startsAt: timestampSchema,
    /** The first instant of the next date in `timeZone` (exclusive). Not always 24 hours after `startsAt`. */
    endsAt: timestampSchema,
    /** Whether the date is today in `timeZone` by the server's clock: later records can still change the overview. */
    inProgress: z.boolean(),
  })
  .refine((day) => Date.parse(day.startsAt) <= Date.parse(day.endsAt), { message: 'the day cannot end before it starts', path: ['endsAt'] });

/**
 * The person's check-in stored for the date. A record with only a note is a record (`recorded: true`, every value
 * null, `hasNote: true`); the note's text is never part of the overview. A value that was not recorded is null
 * (unknown), never zero; a recorded zero stays zero.
 */
export const dailyOverviewCheckInSchema = z.discriminatedUnion('recorded', [
  z.strictObject({ recorded: z.literal(false) }),
  z
    .strictObject({
      recorded: z.literal(true),
      hasNote: z.boolean(),
      mood: dailyMoodSchema.nullable(),
      sleepMinutes: dailySleepMinutesSchema.nullable(),
      sleepQuality: dailySleepQualitySchema.nullable(),
      soreness: dailySorenessSchema.nullable(),
      /** The zone the day was first saved in. May differ from the view zone; the record still belongs to this date. */
      timeZone: storedZone,
      weightKg: dailyWeightKgSchema.nullable(),
    })
    .refine(
      (checkIn) =>
        checkIn.hasNote ||
        [checkIn.mood, checkIn.sleepMinutes, checkIn.sleepQuality, checkIn.soreness, checkIn.weightKg].some((value) => value !== null),
      'A stored check-in has at least one value or a note',
    ),
]);

/**
 * The person's manually entered movement stored for the date. Steps and user-reported active energy as entered: never
 * estimated, never added to activity or GPS figures. Null is unknown; a recorded 0 stays 0.
 */
export const dailyOverviewMovementSchema = z.discriminatedUnion('recorded', [
  z.strictObject({ recorded: z.literal(false) }),
  z
    .strictObject({
      recorded: z.literal(true),
      activeEnergyKcal: dailyActiveEnergyKcalSchema.nullable(),
      /** Server-owned provenance; manual entry is the only source. */
      source: z.enum(dailyMovementSources),
      steps: dailyStepsSchema.nullable(),
      /** The zone the day was first saved in. May differ from the view zone; the record still belongs to this date. */
      timeZone: storedZone,
    })
    .refine((movement) => movement.steps !== null || movement.activeEnergyKcal !== null, 'A stored movement day has at least one value'),
]);

export const dailyOverviewActivityTypeSchema = z.strictObject({
  type: activityTypeSchema,
  count: itemCount.min(1),
  /** The full entered duration of this type's activities that started on the date. */
  enteredDurationS: durationSeconds,
});

/**
 * The person's manual activities that STARTED on the date in the requested zone. `enteredDurationS` is the full
 * duration the person entered for those activities, also for one that continued past midnight; it is not the time
 * spent within the date. Only types with at least one activity are listed, in the order of `ACTIVITY_TYPES`. No note,
 * distance or effort is part of the overview.
 */
export const dailyOverviewManualActivitiesSchema = z
  .strictObject({
    byType: z.array(dailyOverviewActivityTypeSchema).max(ACTIVITY_TYPES.length),
    count: itemCount,
    enteredDurationS: durationSeconds,
  })
  .refine((activities) => activities.byType.reduce((sum, entry) => sum + entry.count, 0) === activities.count, {
    message: 'the per-type counts add up to the count',
    path: ['count'],
  })
  .refine((activities) => activities.byType.reduce((sum, entry) => sum + entry.enteredDurationS, 0) === activities.enteredDurationS, {
    message: 'the per-type durations add up to the duration',
    path: ['enteredDurationS'],
  })
  .refine(
    (activities) => activities.byType.every((entry, index) => index === 0 || ACTIVITY_TYPES.indexOf(activities.byType[index - 1]!.type) < ACTIVITY_TYPES.indexOf(entry.type)),
    { message: 'types are listed once each, in the order of ACTIVITY_TYPES', path: ['byType'] },
  );

export const dailyOverviewImportedActivityTypeSchema = z.strictObject({
  type: activityTypeSchema,
  count: itemCount,
  elapsedDurationS: durationSeconds,
});

/**
 * The person's GPX-imported activities that STARTED on the date in the requested zone (ADR-0086), kept apart from manual
 * entries and from GPS runs and never added to either. `elapsedDurationS` is the elapsed time of the imported files, from
 * the first to the last point, pauses included: not moving time, and the full time also for an import that continued
 * past midnight. An import is never compared with GPS runs, so the same outing recorded both ways appears in both parts.
 */
export const dailyOverviewImportedActivitiesSchema = z
  .strictObject({
    source: z.literal('gpx'),
    byType: z.array(dailyOverviewImportedActivityTypeSchema).max(ACTIVITY_TYPES.length),
    count: itemCount,
    elapsedDurationS: durationSeconds,
  })
  .refine((activities) => activities.byType.reduce((sum, entry) => sum + entry.count, 0) === activities.count, {
    message: 'the per-type counts add up to the count',
    path: ['count'],
  })
  .refine((activities) => activities.byType.reduce((sum, entry) => sum + entry.elapsedDurationS, 0) === activities.elapsedDurationS, {
    message: 'the per-type durations add up to the duration',
    path: ['elapsedDurationS'],
  })
  .refine(
    (activities) => activities.byType.every((entry, index) => index === 0 || ACTIVITY_TYPES.indexOf(activities.byType[index - 1]!.type) < ACTIVITY_TYPES.indexOf(entry.type)),
    { message: 'types are listed once each, in the order of ACTIVITY_TYPES', path: ['byType'] },
  );

export const dailyOverviewTcxImportedActivityTypeSchema = z.strictObject({
  type: activityTypeSchema,
  count: itemCount,
  reportedDurationS: durationSeconds,
});

/**
 * The person's TCX-imported activities that STARTED on the date in the requested zone (ADR-0091), kept apart from manual
 * entries, GPX imports and GPS runs and never added to any of them. `reportedDurationS` is the sum of the imports'
 * reported durations (each the sum of its laps' TotalTimeSeconds, rounded once at import): neither elapsed time nor moving
 * time, and the full value also for an import that continued past midnight.
 */
export const dailyOverviewTcxImportedActivitiesSchema = z
  .strictObject({
    source: z.literal('tcx'),
    byType: z.array(dailyOverviewTcxImportedActivityTypeSchema).max(ACTIVITY_TYPES.length),
    count: itemCount,
    reportedDurationS: durationSeconds,
  })
  .refine((activities) => activities.byType.reduce((sum, entry) => sum + entry.count, 0) === activities.count, {
    message: 'the per-type counts add up to the count',
    path: ['count'],
  })
  .refine((activities) => activities.byType.reduce((sum, entry) => sum + entry.reportedDurationS, 0) === activities.reportedDurationS, {
    message: 'the per-type durations add up to the duration',
    path: ['reportedDurationS'],
  })
  .refine(
    (activities) => activities.byType.every((entry, index) => index === 0 || ACTIVITY_TYPES.indexOf(activities.byType[index - 1]!.type) < ACTIVITY_TYPES.indexOf(entry.type)),
    { message: 'types are listed once each, in the order of ACTIVITY_TYPES', path: ['byType'] },
  );

/**
 * The person's own finished GPS runs that STARTED on the date in the requested zone. Runs another person shared with
 * them never count. A distance comes only from a summary computed for the run's current data revision:
 * `currentDistanceM` is the sum over the `withCurrentDistance` runs only (null when there are none), so a partial total
 * covers exactly those runs and the others are unknown, never zero.
 */
export const dailyOverviewGpsRunsSchema = z
  .strictObject({
    count: itemCount,
    currentDistanceM: distanceMetres.nullable(),
    withCurrentDistance: itemCount,
    withoutCurrentDistance: itemCount,
  })
  .refine((runs) => runs.withCurrentDistance + runs.withoutCurrentDistance === runs.count, {
    message: 'every GPS run either has a current distance or not',
    path: ['count'],
  })
  .refine((runs) => (runs.currentDistanceM === null) === (runs.withCurrentDistance === 0), {
    message: 'a distance total exists exactly when at least one run has a current distance',
    path: ['currentDistanceM'],
  });

// A sum of one-decimal values computed by PostgreSQL in exact numeric arithmetic: non-negative, finite, at most one
// decimal. At most 10,000 entries of at most 20,000 kcal (or 2,000 g) each, far below the range where a JSON number
// could not hold one decimal exactly.
const recordedTotal = z.number().finite().min(0).max(10_000 * 20_000).refine(hasAtMostOneDecimal, 'A recorded total has at most one decimal');

/**
 * One nutrition metric over the date's entries, with its own coverage: `recordedEntries` is the number of entries that
 * hold a value for it (a recorded 0 included), and `total` is the exact sum over exactly those entries. With no
 * recorded value the total is null (unknown), never 0; recorded zeros give 0. Entries without a value are unknown and
 * add nothing.
 */
export const dailyOverviewMealMetricSchema = z
  .strictObject({
    recordedEntries: itemCount,
    total: recordedTotal.nullable(),
  })
  .refine((metric) => (metric.total === null) === (metric.recordedEntries === 0), {
    message: 'a total exists exactly when at least one entry records the value',
    path: ['total'],
  });

/**
 * The person's manual meal entries logged for the date (its stored calendar date, whatever zone it was logged in). The
 * nutrition values are user-reported totals per entry; each metric's coverage is independent of the others (energy may
 * be recorded for 2 of 3 entries and protein for 1). Food energy is what the person ate as they reported it: never
 * combined with active energy, never compared with a need or a target. No title is part of the overview.
 */
export const dailyOverviewMealsSchema = z
  .strictObject({
    count: itemCount,
    /** Server-owned provenance; manual entry is the only source. */
    source: z.enum(MEAL_SOURCES),
    energyKcal: dailyOverviewMealMetricSchema,
    proteinG: dailyOverviewMealMetricSchema,
    carbohydrateG: dailyOverviewMealMetricSchema,
    fatG: dailyOverviewMealMetricSchema,
  })
  .refine((meals) => MEAL_NUTRITION_FIELDS.every((field) => meals[field].recordedEntries <= meals.count), {
    message: 'a metric cannot be recorded for more entries than were logged',
    path: ['count'],
  });

/** Where the overview comes from: computed by the app on this read, from one snapshot, and never stored. */
export const dailyOverviewProvenanceSchema = z.strictObject({
  computedAt: timestampSchema,
  overviewVersion: z.string().min(1).max(64),
  persisted: z.literal(false),
  /** Every source was read in one REPEATABLE READ, READ ONLY transaction. */
  snapshot: z.literal('single_read_only_transaction'),
  source: z.literal('computed_by_app'),
});

export const dailyOverviewSchema = z.strictObject({
  checkIn: dailyOverviewCheckInSchema,
  day: dailyOverviewDaySchema,
  gpsRuns: dailyOverviewGpsRunsSchema,
  importedActivities: dailyOverviewImportedActivitiesSchema,
  manualActivities: dailyOverviewManualActivitiesSchema,
  meals: dailyOverviewMealsSchema,
  movement: dailyOverviewMovementSchema,
  provenance: dailyOverviewProvenanceSchema,
  tcxImportedActivities: dailyOverviewTcxImportedActivitiesSchema,
});

// The upper bound ("not after today in `timeZone` by the server's clock") is checked by the service.
export const dailyOverviewPathSchema = z.strictObject({ localDate: dailyMetricsLocalDateSchema, orgId: uuidSchema });

/** `timeZone`: the IANA zone the person views the day in; it decides the timestamped sources' interval and "today". */
export const dailyOverviewQuerySchema = z.strictObject({ timeZone: ianaTimeZoneSchema });

/**
 * True when nothing at all is recorded for the date. A note-only check-in, a movement day, a recorded 0 and a meal entry
 * (also a title-only one) are records.
 */
export function isEmptyDailyOverview(
  overview: Pick<DailyOverview, 'checkIn' | 'gpsRuns' | 'importedActivities' | 'manualActivities' | 'meals' | 'movement' | 'tcxImportedActivities'>,
): boolean {
  return (
    !overview.checkIn.recorded &&
    !overview.movement.recorded &&
    overview.manualActivities.count === 0 &&
    overview.importedActivities.count === 0 &&
    overview.tcxImportedActivities.count === 0 &&
    overview.gpsRuns.count === 0 &&
    overview.meals.count === 0
  );
}

export type DailyOverview = z.infer<typeof dailyOverviewSchema>;
export type DailyOverviewDay = z.infer<typeof dailyOverviewDaySchema>;
export type DailyOverviewCheckIn = z.infer<typeof dailyOverviewCheckInSchema>;
export type DailyOverviewMovement = z.infer<typeof dailyOverviewMovementSchema>;
export type DailyOverviewManualActivities = z.infer<typeof dailyOverviewManualActivitiesSchema>;
export type DailyOverviewImportedActivities = z.infer<typeof dailyOverviewImportedActivitiesSchema>;
export type DailyOverviewTcxImportedActivities = z.infer<typeof dailyOverviewTcxImportedActivitiesSchema>;
export type DailyOverviewGpsRuns = z.infer<typeof dailyOverviewGpsRunsSchema>;
export type DailyOverviewMeals = z.infer<typeof dailyOverviewMealsSchema>;
export type DailyOverviewMealMetric = z.infer<typeof dailyOverviewMealMetricSchema>;
export type DailyOverviewPath = z.infer<typeof dailyOverviewPathSchema>;
export type DailyOverviewQuery = z.infer<typeof dailyOverviewQuerySchema>;
