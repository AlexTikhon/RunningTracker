import { z } from 'zod';

import { activityTypeSchema } from './activities.js';
import { activityHistorySourceSchema } from './activity-history.js';
import { dailyMetricsLocalDateSchema } from './daily-metrics.js';
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
// does, so the three cannot be added together by accident:
// - `manual`: `enteredDuration`, what the person typed;
// - `gpx`: `elapsedDuration`, first to last point of the file, pauses included, not moving time (ADR-0086);
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
 * `endDate` (not before 2000-01-01; "not after today in `timeZone` by the server's clock" is checked by the service),
 * the IANA `timeZone` that decides both "today" and every item's date, ONE `source` and ONE activity `type`. All four are
 * required and single-valued; a recorded run is a run, so `source=recorded_run` accepts only `type=run`.
 */
export const activityTrendsQuerySchema = z
  .strictObject({
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
export const recordedRunTrendsSummarySchema = z.strictObject({
  ...summaryBase,
  observedDuration: rangeDuration,
  summaries: activityTrendSummaryStatesSchema,
});

export type ManualActivityTrendDay = z.infer<typeof manualActivityTrendDaySchema>;
export type GpxActivityTrendDay = z.infer<typeof gpxActivityTrendDaySchema>;
export type RecordedRunTrendDay = z.infer<typeof recordedRunTrendDaySchema>;
export type ActivityTrendDay = ManualActivityTrendDay | GpxActivityTrendDay | RecordedRunTrendDay;
export type ManualActivityTrendsSummary = z.infer<typeof manualActivityTrendsSummarySchema>;
export type GpxActivityTrendsSummary = z.infer<typeof gpxActivityTrendsSummarySchema>;
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

const daysMessage = { message: 'days are every date of the range, oldest first, and tile its interval', path: ['days'] };
const summaryMessage = { message: 'the summary is computed from the days by the contract', path: ['summary'] };

export const manualActivityTrendsSchema = z
  .strictObject({
    source: z.literal('manual'),
    applied: appliedOf(z.literal('manual'), activityTypeSchema),
    range: activityTrendsRangeSchema,
    days: z.array(manualActivityTrendDaySchema).min(1).max(DAILY_TRENDS_RANGE_DAYS),
    summary: manualActivityTrendsSummarySchema,
    provenance: activityTrendsProvenanceSchema,
  })
  .refine((trends) => daysTileRange(trends.range, trends.days), daysMessage)
  .refine((trends) => canonical(trends.summary) === canonical(summarizeManualActivityTrendDays(trends.days)), summaryMessage);

export const gpxActivityTrendsSchema = z
  .strictObject({
    source: z.literal('gpx'),
    applied: appliedOf(z.literal('gpx'), activityTypeSchema),
    range: activityTrendsRangeSchema,
    days: z.array(gpxActivityTrendDaySchema).min(1).max(DAILY_TRENDS_RANGE_DAYS),
    summary: gpxActivityTrendsSummarySchema,
    provenance: activityTrendsProvenanceSchema,
  })
  .refine((trends) => daysTileRange(trends.range, trends.days), daysMessage)
  .refine((trends) => canonical(trends.summary) === canonical(summarizeGpxActivityTrendDays(trends.days)), summaryMessage);

export const recordedRunTrendsSchema = z
  .strictObject({
    source: z.literal('recorded_run'),
    applied: appliedOf(z.literal('recorded_run'), z.literal('run')),
    range: activityTrendsRangeSchema,
    days: z.array(recordedRunTrendDaySchema).min(1).max(DAILY_TRENDS_RANGE_DAYS),
    summary: recordedRunTrendsSummarySchema,
    provenance: activityTrendsProvenanceSchema,
  })
  .refine((trends) => daysTileRange(trends.range, trends.days), daysMessage)
  .refine((trends) => canonical(trends.summary) === canonical(summarizeRecordedRunTrendDays(trends.days)), summaryMessage);

/** The answer for one source: `source` (also echoed in `applied`) says which day and summary shape it carries. */
export const activityTrendsSchema = z.discriminatedUnion('source', [manualActivityTrendsSchema, gpxActivityTrendsSchema, recordedRunTrendsSchema]);

export type ActivityTrendsQuery = z.infer<typeof activityTrendsQuerySchema>;
export type ActivityTrendsSource = z.infer<typeof activityHistorySourceSchema>;
export type ActivityTrends = z.infer<typeof activityTrendsSchema>;
export type ManualActivityTrends = z.infer<typeof manualActivityTrendsSchema>;
export type GpxActivityTrends = z.infer<typeof gpxActivityTrendsSchema>;
export type RecordedRunTrends = z.infer<typeof recordedRunTrendsSchema>;
export type ActivityTrendsRange = z.infer<typeof activityTrendsRangeSchema>;
