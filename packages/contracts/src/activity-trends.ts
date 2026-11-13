import { z } from 'zod';

import { activityTypeSchema } from './activities.js';
import { activityHistorySourceSchema } from './activity-history.js';
import { addLocalDays, DAILY_METRICS_LOCAL_DATE_MIN, dailyMetricsLocalDateSchema } from './daily-metrics.js';
import { DAILY_TRENDS_RANGE_DAYS, dailyTrendsDatesOf, dailyTrendsRangeOf } from './daily-trends.js';
import { ianaTimeZoneSchema, localDateSchema, timestampSchema } from './primitives.js';

// Activity trends of the signed-in person (ADR-0089): for ONE source and ONE activity type, what was recorded on each of
// the 28 local calendar dates ending on `endDate`, computed by PostgreSQL on every read in one snapshot and never stored.
// Owner-only like its sources: no request carries an owner, and a run another person shared never counts.
//
// Attribution is Today's and the activity history's (ADR-0082, ADR-0088): an item belongs to the local calendar date on
// which it STARTED in the requested zone, [start of the date, start of the next date), located from the zone's own rules,
// so a date is 23 or 25 hours long around a daylight saving change. An item that continued past midnight counts on the
// date it started on, with its whole duration.
//
// Sources are never combined: one request, one source. Each source names its duration for what it is, as the history
// does, so the four cannot be added together by accident:
// - `manual`: `enteredDuration`, what the person typed;
// - `gpx`: `elapsedDuration`, first to last point of the file, pauses included, not moving time (ADR-0086);
// - `tcx`: `reportedDuration`, the sum of each file's lap total times rounded once per file; neither elapsed nor moving
//   time (ADR-0091);
// - `recorded_run`: `observedDuration`, the accepted GPS edges of a summary whose source revision equals the run's data
//   revision (ADR-0013/0015). A pending or stale summary counts the run and adds to missing coverage, never a metric.
//
// Three states stay apart on every date and for the range:
// - no entries: `count` 0 and every metric `{ withValue: 0, total: null }`;
// - entries whose metric is unknown: `count` > 0 with `withValue` below it (`total` null when none has the value);
// - a genuinely recorded zero: `withValue` > 0 and a total of 0.
// Zero logged entries does not mean the person was inactive: it means nothing of this source and type was recorded.

/**
 * The version of the attribution, rounding and counting rules. Change it when a field's meaning changes.
 * - `activity-trends-1`: ADR-0089.
 */
export const ACTIVITY_TRENDS_VERSION = 'activity-trends-1';

// Counts and totals are non-negative integers that a JSON number holds exactly.
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dayCount = z.number().int().min(0).max(DAILY_TRENDS_RANGE_DAYS);
const total = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The version of the period comparison rules (ADR-0090): which periods are compared, when a metric's change is available
 * and why not, and how a percentage is rounded. Change it when a field's meaning changes.
 * - `activity-trends-comparison-1`: ADR-0090.
 */
export const ACTIVITY_TRENDS_COMPARISON_VERSION = 'activity-trends-comparison-1';

/** The comparison modes a request may ask for. `previous_period`: the 28 local dates immediately before the range. */
export const ACTIVITY_TRENDS_COMPARISON_MODES = ['previous_period'] as const;
export const activityTrendsComparisonModeSchema = z.enum(ACTIVITY_TRENDS_COMPARISON_MODES);
export type ActivityTrendsComparisonMode = z.infer<typeof activityTrendsComparisonModeSchema>;

/**
 * `endDate` (not before 2000-01-01; "not after today in `timeZone` by the server's clock" is checked by the service),
 * the IANA `timeZone` that decides both "today" and every item's date, ONE `source` and ONE activity `type`. All four are
 * required and single-valued; a recorded run is a run, so `source=recorded_run` accepts only `type=run`. `compare` is
 * optional and single-valued (ADR-0090): `previous_period` adds the comparison with the 28 dates before the range.
 */
export const activityTrendsQuerySchema = z
  .strictObject({
    compare: activityTrendsComparisonModeSchema.optional(),
    endDate: dailyMetricsLocalDateSchema,
    source: activityHistorySourceSchema,
    timeZone: ianaTimeZoneSchema,
    type: activityTypeSchema,
  })
  .refine((query) => query.source !== 'recorded_run' || query.type === 'run', {
    message: 'A recorded run is a run: source=recorded_run supports only type=run',
    path: ['type'],
  });

/**
 * A duration of the items of a date (or of the range): how many items record it and the sum over exactly those, in whole
 * seconds. `totalS` is null exactly when no item records it, so a missing value never reads as 0.
 */
export const activityTrendDurationSchema = z
  .strictObject({ withValue: count, totalS: total.nullable() })
  .refine((metric) => (metric.totalS === null) === (metric.withValue === 0), {
    message: 'a total exists exactly when at least one item records the value',
    path: ['totalS'],
  });

/** A distance, in whole metres, over exactly the items that record one; null when none does. */
export const activityTrendDistanceSchema = z
  .strictObject({ withValue: count, totalM: total.nullable() })
  .refine((metric) => (metric.totalM === null) === (metric.withValue === 0), {
    message: 'a total exists exactly when at least one item records the value',
    path: ['totalM'],
  });

/** Recorded runs of a date by the state of their summary: current for the run's data, not yet published, or older. */
export const activityTrendSummaryStatesSchema = z.strictObject({ current: count, pending: count, stale: count });

const dayBase = {
  localDate: localDateSchema,
  /** The first instant of the date in the requested zone (inclusive). */
  startsAt: timestampSchema,
  /**
   * The first instant of the next date in the requested zone (exclusive): usually 23, 24 or 25 hours after `startsAt`;
   * equal to `startsAt` for a date the zone skipped entirely, which then has no items.
   */
  endsAt: timestampSchema,
  /** Items of the source and type that started in [startsAt, endsAt). */
  count,
  distance: activityTrendDistanceSchema,
};

const withinCount = (day: { count: number; distance: { withValue: number } }) => day.distance.withValue <= day.count;

export const manualActivityTrendDaySchema = z
  .strictObject({ ...dayBase, enteredDuration: activityTrendDurationSchema })
  .refine(withinCount, { message: 'more distances than items', path: ['distance'] })
  .refine((day) => day.enteredDuration.withValue === day.count, {
    message: 'every manual entry records its entered duration',
    path: ['enteredDuration'],
  });

export const gpxActivityTrendDaySchema = z
  .strictObject({ ...dayBase, elapsedDuration: activityTrendDurationSchema })
  .refine(withinCount, { message: 'more distances than items', path: ['distance'] })
  .refine((day) => day.elapsedDuration.withValue === day.count, {
    message: 'every GPX import records its elapsed duration',
    path: ['elapsedDuration'],
  });

export const tcxActivityTrendDaySchema = z
  .strictObject({ ...dayBase, reportedDuration: activityTrendDurationSchema })
  .refine(withinCount, { message: 'more distances than items', path: ['distance'] })
  .refine((day) => day.reportedDuration.withValue === day.count, {
    message: 'every TCX import records its reported duration',
    path: ['reportedDuration'],
  });

export const recordedRunTrendDaySchema = z
  .strictObject({ ...dayBase, observedDuration: activityTrendDurationSchema, summaries: activityTrendSummaryStatesSchema })
  .refine((day) => day.summaries.current + day.summaries.pending + day.summaries.stale === day.count, {
    message: 'every run has exactly one summary state',
    path: ['summaries'],
  })
  .refine((day) => day.observedDuration.withValue === day.summaries.current && day.distance.withValue === day.summaries.current, {
    message: 'metrics come from current summaries only',
    path: ['observedDuration'],
  });

const rangeDuration = z.strictObject({ withValue: count, totalS: total.nullable(), daysWithValue: dayCount });
const rangeDistance = z.strictObject({ withValue: count, totalM: total.nullable(), daysWithValue: dayCount });

const summaryBase = {
  /** Dates of the range with at least one item. */
  daysWithEntries: dayCount,
  /** Items in the whole range. */
  count,
  distance: rangeDistance,
};

export const manualActivityTrendsSummarySchema = z.strictObject({ ...summaryBase, enteredDuration: rangeDuration });
export const gpxActivityTrendsSummarySchema = z.strictObject({ ...summaryBase, elapsedDuration: rangeDuration });
export const tcxActivityTrendsSummarySchema = z.strictObject({ ...summaryBase, reportedDuration: rangeDuration });
export const recordedRunTrendsSummarySchema = z.strictObject({
  ...summaryBase,
  observedDuration: rangeDuration,
  summaries: activityTrendSummaryStatesSchema,
});

export type ManualActivityTrendDay = z.infer<typeof manualActivityTrendDaySchema>;
export type GpxActivityTrendDay = z.infer<typeof gpxActivityTrendDaySchema>;
export type TcxActivityTrendDay = z.infer<typeof tcxActivityTrendDaySchema>;
export type RecordedRunTrendDay = z.infer<typeof recordedRunTrendDaySchema>;
export type ActivityTrendDay = ManualActivityTrendDay | GpxActivityTrendDay | TcxActivityTrendDay | RecordedRunTrendDay;
export type ManualActivityTrendsSummary = z.infer<typeof manualActivityTrendsSummarySchema>;
export type GpxActivityTrendsSummary = z.infer<typeof gpxActivityTrendsSummarySchema>;
export type TcxActivityTrendsSummary = z.infer<typeof tcxActivityTrendsSummarySchema>;
export type RecordedRunTrendsSummary = z.infer<typeof recordedRunTrendsSummarySchema>;

type DurationOf = { withValue: number; totalS: number | null };
type DistanceOf = { withValue: number; totalM: number | null };

function summarizeMetric<Day>(days: readonly Day[], metricOf: (day: Day) => DurationOf): z.infer<typeof rangeDuration>;
function summarizeMetric<Day>(days: readonly Day[], metricOf: (day: Day) => DistanceOf, unit: 'M'): z.infer<typeof rangeDistance>;
function summarizeMetric<Day>(days: readonly Day[], metricOf: (day: Day) => DurationOf | DistanceOf, unit: 'M' | 'S' = 'S') {
  const metrics = days.map(metricOf);
  const totalOf = (metric: DurationOf | DistanceOf) => ('totalS' in metric ? metric.totalS : metric.totalM);
  const recorded = metrics.filter((metric) => totalOf(metric) !== null);
  const sum = recorded.length === 0 ? null : recorded.reduce((accumulator, metric) => accumulator + totalOf(metric)!, 0);
  const withValue = metrics.reduce((accumulator, metric) => accumulator + metric.withValue, 0);
  return unit === 'M' ? { daysWithValue: recorded.length, totalM: sum, withValue } : { daysWithValue: recorded.length, totalS: sum, withValue };
}

const summaryBaseOf = (days: readonly ActivityTrendDay[]) => ({
  count: days.reduce((sum, day) => sum + day.count, 0),
  daysWithEntries: days.filter((day) => day.count > 0).length,
  distance: summarizeMetric(days, (day) => day.distance, 'M'),
});

/**
 * The range-level figures of a source's days, defined once: the API computes them with these functions and the contract
 * refuses a summary that differs. Totals add the dates' integer totals, so a range total is exactly the sum of the column
 * of the daily table; a date without a value adds nothing and is not a zero.
 */
export function summarizeManualActivityTrendDays(days: readonly ManualActivityTrendDay[]): ManualActivityTrendsSummary {
  return { ...summaryBaseOf(days), enteredDuration: summarizeMetric(days, (day) => day.enteredDuration) };
}

export function summarizeGpxActivityTrendDays(days: readonly GpxActivityTrendDay[]): GpxActivityTrendsSummary {
  return { ...summaryBaseOf(days), elapsedDuration: summarizeMetric(days, (day) => day.elapsedDuration) };
}

export function summarizeTcxActivityTrendDays(days: readonly TcxActivityTrendDay[]): TcxActivityTrendsSummary {
  return { ...summaryBaseOf(days), reportedDuration: summarizeMetric(days, (day) => day.reportedDuration) };
}

export function summarizeRecordedRunTrendDays(days: readonly RecordedRunTrendDay[]): RecordedRunTrendsSummary {
  return {
    ...summaryBaseOf(days),
    observedDuration: summarizeMetric(days, (day) => day.observedDuration),
    summaries: {
      current: days.reduce((sum, day) => sum + day.summaries.current, 0),
      pending: days.reduce((sum, day) => sum + day.summaries.pending, 0),
      stale: days.reduce((sum, day) => sum + day.summaries.stale, 0),
    },
  };
}

/** The range: its dates, how it relates to the request, its UTC bounds, and "today" in the requested zone. */
export const activityTrendsRangeSchema = z
  .strictObject({
    /** The first date of the range (inclusive). */
    startDate: localDateSchema,
    /** The requested end date (inclusive). */
    endDate: localDateSchema,
    /** The actual number of dates: the denominator of every day coverage figure. 28 unless 2000-01-01 shortened it. */
    days: z.number().int().min(1).max(DAILY_TRENDS_RANGE_DAYS),
    requestedDays: z.literal(DAILY_TRENDS_RANGE_DAYS),
    /** True when 2000-01-01 cut the range short, so `days` is below 28. */
    shortenedByLowerBound: z.boolean(),
    /** The first instant of `startDate` in the requested zone (inclusive). */
    startsAt: timestampSchema,
    /** The first instant of the date after `endDate` in the requested zone (exclusive). */
    endsAt: timestampSchema,
    /** Today in the requested zone by the server's clock: the latest allowed end date. */
    today: localDateSchema,
    /** Whether the range ends today, so later records can still change its last date. */
    includesToday: z.boolean(),
  })
  .refine(
    (range) => {
      const expected = dailyTrendsRangeOf(range.endDate);
      return expected.startDate === range.startDate && expected.days === range.days && expected.shortenedByLowerBound === range.shortenedByLowerBound;
    },
    { message: 'the range is the 28 dates ending on endDate, cut only by 2000-01-01', path: ['startDate'] },
  )
  .refine((range) => range.endDate <= range.today && range.includesToday === (range.endDate === range.today), {
    message: 'the range cannot end after today, and includesToday says whether it ends today',
    path: ['includesToday'],
  });

/** Where the figures come from: computed by the app from one snapshot on this read, never stored. */
export const activityTrendsProvenanceSchema = z.strictObject({
  computedAt: timestampSchema,
  policyVersion: z.literal(ACTIVITY_TRENDS_VERSION),
  persisted: z.literal(false),
  /** The range was aggregated in one REPEATABLE READ, READ ONLY transaction. */
  snapshot: z.literal('single_read_only_transaction'),
  source: z.literal('computed_by_app'),
});

const appliedOf = <Source extends z.ZodType, Type extends z.ZodType>(source: Source, type: Type) =>
  z.strictObject({
    /** The comparison mode applied (ADR-0090); absent when none was asked for. */
    compare: activityTrendsComparisonModeSchema.optional(),
    endDate: localDateSchema,
    source,
    /** The requested zone in the platform's canonical spelling. */
    timeZone: z.string().min(1).max(64),
    type,
  });

interface DayBounds {
  count: number;
  endsAt: string;
  localDate: string;
  startsAt: string;
}

/**
 * Days are every date of the range, oldest first, and their intervals tile the range without a gap or an overlap. A date
 * the zone skipped entirely (Pacific/Apia's 2011-12-30) is kept with an empty interval, startsAt === endsAt: no instant
 * belongs to it, so it can hold no item. A reversed interval is refused.
 */
function daysTileRange(range: z.infer<typeof activityTrendsRangeSchema>, days: readonly DayBounds[]): boolean {
  if (days.length !== range.days) return false;
  const dates = dailyTrendsDatesOf(range);
  return days.every(
    (day, index) =>
      day.localDate === dates[index] &&
      Date.parse(day.startsAt) <= Date.parse(day.endsAt) &&
      (day.startsAt !== day.endsAt || day.count === 0) &&
      (index === 0 ? day.startsAt === range.startsAt : day.startsAt === days[index - 1]!.endsAt) &&
      (index === days.length - 1 ? day.endsAt === range.endsAt : true),
  );
}

/** A JSON spelling with sorted keys, so two summaries compare by value whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparison with the previous period (ADR-0090)
//
// For end date E the range is E-27..E (the current period) and the previous period is E-55..E-28: the 28 local calendar
// dates immediately before it, located in the same zone by the same rules, for the same source and type. Both are read by
// one statement in the same snapshot; PostgreSQL computes both periods' figures (range totals are sums of the dates'
// rounded totals, ADR-0089), the absolute changes and the percentages. The functions below are the DEFINITION the schema
// checks the server's answer against: an answer that disagrees with them is refused, never corrected.
//
// A change is available per metric, never for the comparison as a whole, and every unavailable change says why with
// stable reason codes. Counts describe logged records only: they are compared whatever the metric coverage. A duration or
// distance is compared only when both periods have a defined total over ALL their items (no missing value, no pending or
// stale run summary). Full metric coverage says that every logged item records the value; it never says that every
// activity was logged.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Why a metric's change is not given. Period reasons apply to every metric; the others to a duration or a distance only.
 * - `current_period_in_progress`: the range ends today, so later records can still change it.
 * - `current_period_shortened`: 2000-01-01 cut the range below 28 dates.
 * - `previous_period_out_of_range`: every date of the previous period is before 2000-01-01.
 * - `previous_period_shortened`: 2000-01-01 cut the previous period below 28 dates.
 * - `{current,previous}_period_no_entries`: that period has no item, so the metric has no total (not a total of 0).
 * - `{current,previous}_values_missing`: some items of that period do not record the metric.
 * - `{current,previous}_summaries_pending` / `_stale`: some recorded runs of that period have no summary yet, or one for
 *   older data, so their values are unknown.
 */
export const ACTIVITY_TRENDS_COMPARISON_REASONS = [
  'current_period_in_progress',
  'current_period_shortened',
  'previous_period_out_of_range',
  'previous_period_shortened',
  'current_period_no_entries',
  'previous_period_no_entries',
  'current_values_missing',
  'previous_values_missing',
  'current_summaries_pending',
  'previous_summaries_pending',
  'current_summaries_stale',
  'previous_summaries_stale',
] as const;
export const activityTrendsComparisonReasonSchema = z.enum(ACTIVITY_TRENDS_COMPARISON_REASONS);
export type ActivityTrendsComparisonReason = z.infer<typeof activityTrendsComparisonReasonSchema>;

/** Why a percentage is not given although the absolute change is: the previous total is 0, so there is no ratio. */
export const ACTIVITY_TRENDS_PERCENT_UNAVAILABLE_REASONS = ['zero_baseline'] as const;

const reasonOrder = (reason: ActivityTrendsComparisonReason) => ACTIVITY_TRENDS_COMPARISON_REASONS.indexOf(reason);
const inReasonOrder = (reasons: readonly ActivityTrendsComparisonReason[]) =>
  [...new Set(reasons)].toSorted((left, right) => reasonOrder(left) - reasonOrder(right));

export interface ActivityTrendsPeriodDates {
  days: number;
  endDate: string;
  shortenedByLowerBound: boolean;
  startDate: string;
}

/**
 * The previous period of an end date E: the 28 dates E-55..E-28, cut by 2000-01-01 like a range (`period` with fewer
 * days and `shortenedByLowerBound`), or `period: null` when every one of its dates is before 2000-01-01. The requested
 * dates are always given, so a client can say which dates were out of range.
 */
export function previousActivityTrendsPeriodOf(endDate: string): {
  period: ActivityTrendsPeriodDates | null;
  requestedEndDate: string;
  requestedStartDate: string;
} {
  const requestedEndDate = addLocalDays(endDate, -DAILY_TRENDS_RANGE_DAYS);
  const requestedStartDate = addLocalDays(requestedEndDate, -(DAILY_TRENDS_RANGE_DAYS - 1));
  if (requestedEndDate < DAILY_METRICS_LOCAL_DATE_MIN) return { period: null, requestedEndDate, requestedStartDate };
  return { period: dailyTrendsRangeOf(requestedEndDate), requestedEndDate, requestedStartDate };
}

/** The reasons that apply to every metric: an unfinished range, or periods that are not both a full 28 dates. */
export function activityTrendsPeriodReasons(
  range: { days: number; includesToday: boolean },
  previous: { days: number } | null,
): ActivityTrendsComparisonReason[] {
  const reasons: ActivityTrendsComparisonReason[] = [];
  if (range.includesToday) reasons.push('current_period_in_progress');
  if (range.days < DAILY_TRENDS_RANGE_DAYS) reasons.push('current_period_shortened');
  if (previous === null) reasons.push('previous_period_out_of_range');
  else if (previous.days < DAILY_TRENDS_RANGE_DAYS) reasons.push('previous_period_shortened');
  return reasons;
}

/** What a period records of one metric: its items, how many record the value, and runs whose summary is not current. */
export interface ActivityTrendsComparisonSide {
  count: number;
  pending: number;
  stale: number;
  withValue: number;
}

/**
 * The reasons a metric's change is not given, in the order of ACTIVITY_TRENDS_COMPARISON_REASONS; empty when it is.
 * `count` takes only the period reasons: a count of logged records is defined in any period that exists, 0 included. A
 * duration or a distance also needs, in each period, at least one item and the value for every item.
 */
export function activityTrendsComparisonReasons(input: {
  current: ActivityTrendsComparisonSide;
  metric: 'count' | 'distance' | 'duration';
  periodReasons: readonly ActivityTrendsComparisonReason[];
  previous: ActivityTrendsComparisonSide | null;
}): ActivityTrendsComparisonReason[] {
  const reasons = [...input.periodReasons];
  if (input.metric !== 'count') {
    const sides = [['current', input.current], ['previous', input.previous]] as const;
    for (const [name, side] of sides) {
      if (side === null) continue;
      if (side.count === 0) {
        reasons.push(`${name}_period_no_entries`);
        continue;
      }
      if (side.pending > 0) reasons.push(`${name}_summaries_pending`);
      if (side.stale > 0) reasons.push(`${name}_summaries_stale`);
      // Items whose value is unknown for another reason than a summary state (a manual entry or import without it).
      if (side.withValue < side.count - side.pending - side.stale) reasons.push(`${name}_values_missing`);
    }
  }
  return inReasonOrder(reasons);
}

/**
 * The percentage change in tenths of a percent: (current - previous) / previous * 100, rounded to one decimal place with
 * halves away from zero (12.25 → 12.3, -12.25 → -12.3), computed exactly from the integer totals (no floating point); null
 * when the previous total is 0. PostgreSQL computes the same with numeric integer division (ADR-0090).
 */
export function activityTrendsPercentTenths(current: number, previous: number): number | null {
  if (previous === 0) return null;
  const difference = BigInt(current) - BigInt(previous);
  const base = BigInt(previous);
  const magnitude = ((difference < 0n ? -difference : difference) * 2000n + base) / (2n * base);
  const tenths = Number(difference < 0n ? -magnitude : magnitude);
  if (!Number.isSafeInteger(tenths)) throw new RangeError('The percentage change is too large to represent');
  return tenths;
}

const signedTotal = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
/** A percentage with at most one decimal, as tenths / 10 gives it. */
const percent = z
  .number()
  .finite()
  .refine((value) => Number.isSafeInteger(Math.round(value * 10)) && Math.round(value * 10) / 10 === value, 'A percentage has at most one decimal');

export const activityTrendsChangeSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('available'),
      /** current - previous, in the metric's unit (items, whole seconds or whole metres); signed. */
      absolute: signedTotal,
      /** The percentage change, one decimal, halves away from zero; null exactly when the previous total is 0. */
      percent: percent.nullable(),
      percentUnavailableReason: z.enum(ACTIVITY_TRENDS_PERCENT_UNAVAILABLE_REASONS).nullable(),
    })
    .refine((change) => (change.percent === null) === (change.percentUnavailableReason !== null), {
      message: 'a percentage is missing exactly when a reason says why',
      path: ['percentUnavailableReason'],
    }),
  z.strictObject({
    status: z.literal('unavailable'),
    reasons: z.array(activityTrendsComparisonReasonSchema).min(1).max(ACTIVITY_TRENDS_COMPARISON_REASONS.length),
  }),
]);

/** A count of logged items in each period (`previous` null when the previous period is out of range) and its change. */
export const activityTrendsCountComparisonSchema = z.strictObject({ current: count, previous: count.nullable(), change: activityTrendsChangeSchema });

/**
 * A duration (whole seconds) or a distance (whole metres) in each period: the period's total over the items that record
 * it, null when none does or the period does not exist, and its change.
 */
export const activityTrendsMetricComparisonSchema = z.strictObject({
  current: total.nullable(),
  previous: total.nullable(),
  change: activityTrendsChangeSchema,
});

/** A compared period: its actual dates (cut only by 2000-01-01) and its UTC interval in the requested zone. */
export const activityTrendsComparisonPeriodSchema = z
  .strictObject({
    startDate: localDateSchema,
    endDate: localDateSchema,
    days: z.number().int().min(1).max(DAILY_TRENDS_RANGE_DAYS),
    requestedDays: z.literal(DAILY_TRENDS_RANGE_DAYS),
    shortenedByLowerBound: z.boolean(),
    /** The first instant of `startDate` in the requested zone (inclusive). */
    startsAt: timestampSchema,
    /** The first instant of the date after `endDate` in the requested zone (exclusive). */
    endsAt: timestampSchema,
  })
  .refine(
    (period) => {
      const expected = dailyTrendsRangeOf(period.endDate);
      return (
        expected.startDate === period.startDate &&
        expected.days === period.days &&
        expected.shortenedByLowerBound === period.shortenedByLowerBound &&
        Date.parse(period.startsAt) <= Date.parse(period.endsAt)
      );
    },
    { message: 'a period is the 28 dates ending on endDate, cut only by 2000-01-01, with an ordered interval', path: ['startDate'] },
  );

type RangeSummary = ManualActivityTrendsSummary | GpxActivityTrendsSummary | TcxActivityTrendsSummary | RecordedRunTrendsSummary;

/** A range summary that is internally consistent (the previous period has no days to recompute it from). */
function consistentSummary(summary: RangeSummary, days: number): boolean {
  const duration = durationOfSummary(summary);
  const metricOk = (metric: { daysWithValue: number; withValue: number }, total: number | null) =>
    metric.withValue <= summary.count && metric.daysWithValue <= summary.daysWithEntries && (total === null) === (metric.withValue === 0);
  const statesOk =
    'summaries' in summary
      ? summary.summaries.current + summary.summaries.pending + summary.summaries.stale === summary.count &&
        duration.withValue === summary.summaries.current &&
        summary.distance.withValue === summary.summaries.current
      : duration.withValue === summary.count;
  return (
    summary.daysWithEntries <= days &&
    (summary.count === 0) === (summary.daysWithEntries === 0) &&
    metricOk(duration, duration.totalS) &&
    metricOk(summary.distance, summary.distance.totalM) &&
    statesOk
  );
}

// Every source's duration is named explicitly: no source falls through to another's (ADR-0091 audit).
function durationOfSummary(summary: RangeSummary): { daysWithValue: number; totalS: number | null; withValue: number } {
  if ('enteredDuration' in summary) return summary.enteredDuration;
  if ('elapsedDuration' in summary) return summary.elapsedDuration;
  if ('reportedDuration' in summary) return summary.reportedDuration;
  if ('observedDuration' in summary) return summary.observedDuration;
  throw new Error('A trends summary without a named duration');
}

const sideOf = (summary: RangeSummary, metric: 'distance' | 'duration'): ActivityTrendsComparisonSide => ({
  count: summary.count,
  pending: 'summaries' in summary ? summary.summaries.pending : 0,
  stale: 'summaries' in summary ? summary.summaries.stale : 0,
  withValue: metric === 'duration' ? durationOfSummary(summary).withValue : summary.distance.withValue,
});

const countSide = (summary: RangeSummary): ActivityTrendsComparisonSide => ({ count: summary.count, pending: 0, stale: 0, withValue: summary.count });

function changeOf(reasons: ActivityTrendsComparisonReason[], current: number | null, previous: number | null): z.infer<typeof activityTrendsChangeSchema> {
  if (reasons.length > 0) return { reasons, status: 'unavailable' };
  if (current === null || previous === null) throw new Error('A change without reasons needs both totals');
  const tenths = activityTrendsPercentTenths(current, previous);
  return {
    absolute: current - previous,
    percent: tenths === null ? null : tenths / 10,
    percentUnavailableReason: tenths === null ? 'zero_baseline' : null,
    status: 'available',
  };
}

/**
 * The comparison's metrics and period reasons as this contract defines them, from the range, the current summary and the
 * previous period (null when out of range) with its summary. The server's answer must equal this.
 */
export function activityTrendsComparisonFiguresOf(input: {
  previous: { days: number; summary: RangeSummary } | null;
  range: { days: number; includesToday: boolean };
  summary: RangeSummary;
}): {
  metrics: { count: z.infer<typeof activityTrendsCountComparisonSchema>; distance: z.infer<typeof activityTrendsMetricComparisonSchema>; duration: z.infer<typeof activityTrendsMetricComparisonSchema> };
  periodReasons: ActivityTrendsComparisonReason[];
} {
  const { previous, summary } = input;
  const periodReasons = activityTrendsPeriodReasons(input.range, previous);
  const reasons = (metric: 'count' | 'distance' | 'duration') =>
    activityTrendsComparisonReasons({
      current: metric === 'count' ? countSide(summary) : sideOf(summary, metric),
      metric,
      periodReasons,
      previous: previous === null ? null : metric === 'count' ? countSide(previous.summary) : sideOf(previous.summary, metric),
    });
  const metric = (name: 'distance' | 'duration') => {
    const totalOf = (of: RangeSummary) => (name === 'duration' ? durationOfSummary(of).totalS : of.distance.totalM);
    const current = totalOf(summary);
    const before = previous === null ? null : totalOf(previous.summary);
    return { change: changeOf(reasons(name), current, before), current, previous: before };
  };
  const previousCount = previous === null ? null : previous.summary.count;
  return {
    metrics: {
      count: { change: changeOf(reasons('count'), summary.count, previousCount), current: summary.count, previous: previousCount },
      distance: metric('distance'),
      duration: metric('duration'),
    },
    periodReasons,
  };
}

const comparisonPeriodsBase = {
  mode: z.literal('previous_period'),
  policyVersion: z.literal(ACTIVITY_TRENDS_COMPARISON_VERSION),
  /** The range itself (equal to `range`'s dates and interval), and whether it ends today. */
  current: z.strictObject({ inProgress: z.boolean(), period: activityTrendsComparisonPeriodSchema }),
  /** Reasons that apply to every metric, in the order of ACTIVITY_TRENDS_COMPARISON_REASONS; empty when none does. */
  periodReasons: z.array(activityTrendsComparisonReasonSchema).max(4),
};

const previousShape = {
  /** E-55 and E-28: the dates asked for, whether or not they exist. */
  requestedStartDate: localDateSchema,
  requestedEndDate: localDateSchema,
  /** The dates that exist (cut by 2000-01-01), or null when none does. */
  period: activityTrendsComparisonPeriodSchema.nullable(),
};

interface PreviousOf {
  period: { days: number } | null;
  /** The previous period's figures, computed like the range summary; null exactly when `period` is. */
  summary: RangeSummary | null;
}

const previousExists = { message: 'a previous period has figures exactly when it exists', path: ['summary'] };
const previousConsistent = { message: 'the previous summary is consistent with itself and its days', path: ['summary'] };
const existsExactly = (previous: PreviousOf) => (previous.period === null) === (previous.summary === null);
const consistentPrevious = (previous: PreviousOf) =>
  previous.period === null || previous.summary === null || consistentSummary(previous.summary, previous.period.days);

export const manualActivityTrendsComparisonSchema = z.strictObject({
  ...comparisonPeriodsBase,
  previous: z
    .strictObject({ ...previousShape, summary: manualActivityTrendsSummarySchema.nullable() })
    .refine(existsExactly, previousExists)
    .refine(consistentPrevious, previousConsistent),
  metrics: z.strictObject({ count: activityTrendsCountComparisonSchema, enteredDuration: activityTrendsMetricComparisonSchema, distance: activityTrendsMetricComparisonSchema }),
});
export const gpxActivityTrendsComparisonSchema = z.strictObject({
  ...comparisonPeriodsBase,
  previous: z
    .strictObject({ ...previousShape, summary: gpxActivityTrendsSummarySchema.nullable() })
    .refine(existsExactly, previousExists)
    .refine(consistentPrevious, previousConsistent),
  metrics: z.strictObject({ count: activityTrendsCountComparisonSchema, elapsedDuration: activityTrendsMetricComparisonSchema, distance: activityTrendsMetricComparisonSchema }),
});
export const tcxActivityTrendsComparisonSchema = z.strictObject({
  ...comparisonPeriodsBase,
  previous: z
    .strictObject({ ...previousShape, summary: tcxActivityTrendsSummarySchema.nullable() })
    .refine(existsExactly, previousExists)
    .refine(consistentPrevious, previousConsistent),
  metrics: z.strictObject({ count: activityTrendsCountComparisonSchema, reportedDuration: activityTrendsMetricComparisonSchema, distance: activityTrendsMetricComparisonSchema }),
});
export const recordedRunTrendsComparisonSchema = z.strictObject({
  ...comparisonPeriodsBase,
  previous: z
    .strictObject({ ...previousShape, summary: recordedRunTrendsSummarySchema.nullable() })
    .refine(existsExactly, previousExists)
    .refine(consistentPrevious, previousConsistent),
  metrics: z.strictObject({ count: activityTrendsCountComparisonSchema, observedDuration: activityTrendsMetricComparisonSchema, distance: activityTrendsMetricComparisonSchema }),
});

export type ManualActivityTrendsComparison = z.infer<typeof manualActivityTrendsComparisonSchema>;
export type GpxActivityTrendsComparison = z.infer<typeof gpxActivityTrendsComparisonSchema>;
export type TcxActivityTrendsComparison = z.infer<typeof tcxActivityTrendsComparisonSchema>;
export type RecordedRunTrendsComparison = z.infer<typeof recordedRunTrendsComparisonSchema>;
export type ActivityTrendsComparison =
  | ManualActivityTrendsComparison
  | GpxActivityTrendsComparison
  | TcxActivityTrendsComparison
  | RecordedRunTrendsComparison;
export type ActivityTrendsChange = z.infer<typeof activityTrendsChangeSchema>;
export type ActivityTrendsComparisonPeriod = z.infer<typeof activityTrendsComparisonPeriodSchema>;

/** The name each source gives its duration (ADR-0087/0091). */
export type ActivityTrendsDurationKey = 'elapsedDuration' | 'enteredDuration' | 'observedDuration' | 'reportedDuration';

/**
 * The source's duration name, which its days, summaries and a comparison's metrics keep (ADR-0087's names, ADR-0091's
 * `reportedDuration`). Exhaustive: a new source fails to compile here instead of borrowing another source's name.
 */
export function activityTrendsDurationKeyOf(source: z.infer<typeof activityHistorySourceSchema>): ActivityTrendsDurationKey {
  switch (source) {
    case 'manual':
      return 'enteredDuration';
    case 'gpx':
      return 'elapsedDuration';
    case 'tcx':
      return 'reportedDuration';
    case 'recorded_run':
      return 'observedDuration';
    default: {
      const unknown: never = source;
      throw new Error(`Unknown activity trends source: ${String(unknown)}`);
    }
  }
}

/**
 * A whole comparison as this contract defines it, from the answer's range and summary and the previous period's actual
 * interval and figures (null when it is out of range). For fixtures and checks; the API takes its changes from SQL.
 */
export function activityTrendsComparisonOf(input: {
  endDate: string;
  previous: { period: ActivityTrendsComparisonPeriod; summary: RangeSummary } | null;
  range: z.infer<typeof activityTrendsRangeSchema>;
  source: z.infer<typeof activityHistorySourceSchema>;
  summary: RangeSummary;
}): ActivityTrendsComparison {
  const { range } = input;
  const requested = previousActivityTrendsPeriodOf(input.endDate);
  const figures = activityTrendsComparisonFiguresOf({
    previous: input.previous === null ? null : { days: input.previous.period.days, summary: input.previous.summary },
    range,
    summary: input.summary,
  });
  const { duration, ...rest } = figures.metrics;
  return {
    current: {
      inProgress: range.includesToday,
      period: {
        days: range.days,
        endDate: range.endDate,
        endsAt: range.endsAt,
        requestedDays: DAILY_TRENDS_RANGE_DAYS,
        shortenedByLowerBound: range.shortenedByLowerBound,
        startDate: range.startDate,
        startsAt: range.startsAt,
      },
    },
    metrics: { ...rest, [activityTrendsDurationKeyOf(input.source)]: duration },
    mode: 'previous_period',
    periodReasons: figures.periodReasons,
    policyVersion: ACTIVITY_TRENDS_COMPARISON_VERSION,
    previous: {
      period: input.previous?.period ?? null,
      requestedEndDate: requested.requestedEndDate,
      requestedStartDate: requested.requestedStartDate,
      summary: input.previous?.summary ?? null,
    },
  } as ActivityTrendsComparison;
}

interface ComparedTrends {
  applied: { compare?: ActivityTrendsComparisonMode | undefined; endDate: string };
  comparison?: ActivityTrendsComparison | undefined;
  range: z.infer<typeof activityTrendsRangeSchema>;
  summary: RangeSummary;
}

/**
 * A comparison belongs to the answer it is in: it is present exactly when `compare` was applied; its current period is
 * the range; its previous period is the one this contract defines for the end date, ends where the range starts, and its
 * metrics and reasons are the ones activityTrendsComparisonFiguresOf gives for these summaries.
 */
function comparisonAgrees(trends: ComparedTrends, durationKey: ActivityTrendsDurationKey): boolean {
  const { comparison, range } = trends;
  if (comparison === undefined || trends.applied.compare === undefined) return comparison === undefined && trends.applied.compare === undefined;
  const current = comparison.current;
  const sameRange =
    current.inProgress === range.includesToday &&
    current.period.startDate === range.startDate &&
    current.period.endDate === range.endDate &&
    current.period.days === range.days &&
    current.period.shortenedByLowerBound === range.shortenedByLowerBound &&
    current.period.startsAt === range.startsAt &&
    current.period.endsAt === range.endsAt;
  const expected = previousActivityTrendsPeriodOf(trends.applied.endDate);
  const previous = comparison.previous;
  const samePrevious =
    previous.requestedStartDate === expected.requestedStartDate &&
    previous.requestedEndDate === expected.requestedEndDate &&
    (expected.period === null
      ? previous.period === null
      : previous.period !== null &&
        previous.period.startDate === expected.period.startDate &&
        previous.period.endDate === expected.period.endDate &&
        previous.period.days === expected.period.days &&
        previous.period.shortenedByLowerBound === expected.period.shortenedByLowerBound &&
        previous.period.endsAt === range.startsAt);
  if (!sameRange || !samePrevious) return false;
  const figures = activityTrendsComparisonFiguresOf({
    previous: previous.period === null || previous.summary === null ? null : { days: previous.period.days, summary: previous.summary },
    range,
    summary: trends.summary,
  });
  const { duration, ...rest } = figures.metrics;
  return (
    canonical(comparison.periodReasons) === canonical(figures.periodReasons) &&
    canonical(comparison.metrics) === canonical({ ...rest, [durationKey]: duration })
  );
}

const comparisonMessage = { message: 'the comparison is the one the contract defines for this range and these summaries', path: ['comparison'] };

const daysMessage = { message: 'days are every date of the range, oldest first, and tile its interval', path: ['days'] };
const summaryMessage = { message: 'the summary is computed from the days by the contract', path: ['summary'] };

export const manualActivityTrendsSchema = z
  .strictObject({
    source: z.literal('manual'),
    applied: appliedOf(z.literal('manual'), activityTypeSchema),
    range: activityTrendsRangeSchema,
    days: z.array(manualActivityTrendDaySchema).min(1).max(DAILY_TRENDS_RANGE_DAYS),
    summary: manualActivityTrendsSummarySchema,
    comparison: manualActivityTrendsComparisonSchema.optional(),
    provenance: activityTrendsProvenanceSchema,
  })
  .refine((trends) => daysTileRange(trends.range, trends.days), daysMessage)
  .refine((trends) => canonical(trends.summary) === canonical(summarizeManualActivityTrendDays(trends.days)), summaryMessage)
  .refine((trends) => comparisonAgrees(trends, 'enteredDuration'), comparisonMessage);

export const gpxActivityTrendsSchema = z
  .strictObject({
    source: z.literal('gpx'),
    applied: appliedOf(z.literal('gpx'), activityTypeSchema),
    range: activityTrendsRangeSchema,
    days: z.array(gpxActivityTrendDaySchema).min(1).max(DAILY_TRENDS_RANGE_DAYS),
    summary: gpxActivityTrendsSummarySchema,
    comparison: gpxActivityTrendsComparisonSchema.optional(),
    provenance: activityTrendsProvenanceSchema,
  })
  .refine((trends) => daysTileRange(trends.range, trends.days), daysMessage)
  .refine((trends) => canonical(trends.summary) === canonical(summarizeGpxActivityTrendDays(trends.days)), summaryMessage)
  .refine((trends) => comparisonAgrees(trends, 'elapsedDuration'), comparisonMessage);

export const tcxActivityTrendsSchema = z
  .strictObject({
    source: z.literal('tcx'),
    applied: appliedOf(z.literal('tcx'), activityTypeSchema),
    range: activityTrendsRangeSchema,
    days: z.array(tcxActivityTrendDaySchema).min(1).max(DAILY_TRENDS_RANGE_DAYS),
    summary: tcxActivityTrendsSummarySchema,
    comparison: tcxActivityTrendsComparisonSchema.optional(),
    provenance: activityTrendsProvenanceSchema,
  })
  .refine((trends) => daysTileRange(trends.range, trends.days), daysMessage)
  .refine((trends) => canonical(trends.summary) === canonical(summarizeTcxActivityTrendDays(trends.days)), summaryMessage)
  .refine((trends) => comparisonAgrees(trends, 'reportedDuration'), comparisonMessage);

export const recordedRunTrendsSchema = z
  .strictObject({
    source: z.literal('recorded_run'),
    applied: appliedOf(z.literal('recorded_run'), z.literal('run')),
    range: activityTrendsRangeSchema,
    days: z.array(recordedRunTrendDaySchema).min(1).max(DAILY_TRENDS_RANGE_DAYS),
    summary: recordedRunTrendsSummarySchema,
    comparison: recordedRunTrendsComparisonSchema.optional(),
    provenance: activityTrendsProvenanceSchema,
  })
  .refine((trends) => daysTileRange(trends.range, trends.days), daysMessage)
  .refine((trends) => canonical(trends.summary) === canonical(summarizeRecordedRunTrendDays(trends.days)), summaryMessage)
  .refine((trends) => comparisonAgrees(trends, 'observedDuration'), comparisonMessage);

/** The answer for one source: `source` (also echoed in `applied`) says which day and summary shape it carries. */
export const activityTrendsSchema = z.discriminatedUnion('source', [
  manualActivityTrendsSchema,
  gpxActivityTrendsSchema,
  tcxActivityTrendsSchema,
  recordedRunTrendsSchema,
]);

export type ActivityTrendsQuery = z.infer<typeof activityTrendsQuerySchema>;
export type ActivityTrendsSource = z.infer<typeof activityHistorySourceSchema>;
export type ActivityTrends = z.infer<typeof activityTrendsSchema>;
export type ManualActivityTrends = z.infer<typeof manualActivityTrendsSchema>;
export type GpxActivityTrends = z.infer<typeof gpxActivityTrendsSchema>;
export type TcxActivityTrends = z.infer<typeof tcxActivityTrendsSchema>;
export type RecordedRunTrends = z.infer<typeof recordedRunTrendsSchema>;
export type ActivityTrendsRange = z.infer<typeof activityTrendsRangeSchema>;
