import {
  ACTIVITY_TRENDS_COMPARISON_VERSION,
  ACTIVITY_TRENDS_VERSION,
  activityTrendsComparisonReasons,
  activityTrendsPeriodReasons,
  activityTrendsSchema,
  addLocalDays,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  DAILY_TRENDS_RANGE_DAYS,
  previousActivityTrendsPeriodOf,
  type ActivityTrends,
  type ActivityTrendsChange,
  type ActivityTrendsComparisonReason,
  type ActivityTrendsPeriodDates,
  type ActivityTrendsQuery,
  type GpxActivityTrendDay,
  type GpxActivityTrendsSummary,
  type ManualActivityTrendDay,
  type ManualActivityTrendsSummary,
  type RecordedRunTrendDay,
  type RecordedRunTrendsSummary,
  type ActivityTrendsDurationKey,
  type TcxActivityTrendDay,
  type TcxActivityTrendsSummary,
} from '@running-tracker/contracts';
import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import { localDateOf, startOfLocalDate } from '../runs/run-search-period.js';

// Activity trends (ADR-0089): computed on every read, never stored, never queued, no model. It writes nothing.
//
// One REPEATABLE READ READ ONLY transaction holds the membership check and ONE range statement for the requested source
// (a fixed number, whatever the range: never one read per date, never a page of the history, never a raw point). The
// snapshot is taken by the transaction's first statement (setting the tenant context), so a write committed after it is
// not seen; nothing is read after the transaction ends. Row-level security is in force (runtime role, tenant context),
// and every statement also names the organization and the owner: the run policies let this role read runs shared with
// the person, and the explicit `run.user_id` predicate is what keeps them out of these figures.
//
// Attribution: Today's rule (ADR-0082) and the history's day filter (ADR-0088). The service locates the start of every
// date of the range in the requested zone from the zone's own offset history (startOfLocalDate), never by adding 24 hours,
// and passes those instants as the lower bounds of the buckets. PostgreSQL's width_bucket puts each item in the last
// bucket whose bound is at or before its start, and the statement keeps only items in [start of the first date, start of
// the date after the last), so every item counts on exactly the date it started on.

/** Barriers for deterministic snapshot tests. Never set in production (createApp refuses them outside APP_ENV=test). */
export interface ActivityTrendsTestHooks {
  /** Inside the read transaction, after the membership check and before the aggregate statement. */
  beforeAggregateRead?: () => Promise<void>;
}

export interface ActivityTrendsServiceOptions {
  clock: Clock;
  hooks?: ActivityTrendsTestHooks;
  pool: Pick<Pool, 'connect'>;
}

// A date's floating-point sum rounded once to a whole unit, halves up (ADR-0089), as JavaScript's Math.round rounds a
// non-negative number. PostgreSQL's round(double precision) rounds halves to even, and a cast to numeric keeps only 15
// significant digits, so neither is used: x - floor(x) is exact for a non-negative double, and the comparison with 0.5
// decides the half without any intermediate rounding.
const halfUp = (sum: string) => `(floor(${sum}) + CASE WHEN ${sum} - floor(${sum}) >= 0.5 THEN 1 ELSE 0 END)::bigint`;

// $1 organization, $2 owner, $3 the start of every date of the range (ascending bucket lower bounds; a date the zone
// skipped repeats the next date's start), $4 start of the range (inclusive), $5 start of the date after the range
// (exclusive), $6 source ('manual', 'gpx' or 'tcx'), $7 activity type.
//
// `daily`: one row per date with at least one item: how many started, the sum of their stored durations (every activity
// has one: entered for a manual entry, elapsed for a GPX import, reported for a TCX import), how many record a distance and
// the sum over exactly those
// (count(col) and sum(col) skip NULL, so a missing distance adds nothing and a recorded 0 counts). The range predicate
// together with the owner predicates is a range of activities_owner_started_idx (org_id, user_id, started_at DESC, id
// DESC); source and type are filters on it. No note, effort, id or single row is selected.
//
// width_bucket returns how many bounds are at or before the start, so an item lands in the LAST date whose start is at or
// before it. A skipped date's bound equals the next date's, so its bucket number is never returned: its items (none can
// exist) and the next date's all go to the next date, without loss or duplication.
//
// `rounded` rounds each date's distance once. The statement returns those dates (`day_number` 1..days) and, after them,
// exactly one range row (`day_number` NULL): an aggregate without GROUP BY, so it exists when the range has no item. Its
// totals add the dates' ROUNDED integers, so a range total is the sum of the daily column; the CTE is read twice, so
// PostgreSQL materializes it once and both parts come from the same rows of the same snapshot.
export const activityTrendsActivitiesSql = `/* activity-trends:activities */
WITH daily AS (
  SELECT width_bucket(activity.started_at, $3::timestamptz[]) AS day_number,
         count(*)::integer AS count,
         sum(activity.duration_s) AS duration_s,
         count(activity.distance_m)::integer AS with_distance,
         sum(activity.distance_m) AS distance_sum
    FROM activities AS activity
   WHERE activity.org_id = $1
     AND activity.user_id = $2
     AND activity.started_at >= $4::timestamptz
     AND activity.started_at < $5::timestamptz
     AND activity.source = $6::text
     AND activity.type = $7::text
   GROUP BY 1
), rounded AS (
  SELECT day_number, count, duration_s, with_distance,
         CASE WHEN with_distance > 0 THEN ${halfUp('distance_sum')} END AS distance_m
    FROM daily
)
SELECT day_number, count, duration_s::text AS duration_s, with_distance, distance_m::text AS distance_m,
       NULL::integer AS days_with_entries, NULL::integer AS days_with_distance
  FROM rounded
UNION ALL
SELECT NULL::integer, coalesce(sum(count), 0)::integer, sum(duration_s)::text, coalesce(sum(with_distance), 0)::integer,
       sum(distance_m)::text, count(*)::integer, count(distance_m)::integer
  FROM rounded
 ORDER BY day_number NULLS LAST`;

// $1 organization, $2 owner, $3 the start of every date of the range, $4 start of the range, $5 its exclusive end.
//
// The person's own finished runs, one row per date: how many started, how many have a summary for their current data
// revision (ADR-0015: the check of run search, run details, Today and the history), how many have none yet (pending) or
// one for an older revision (stale), and the observed durations and distances of the current ones only, each rounded once
// per date. A pending or stale run is counted and adds to missing coverage; its old values are never selected. The summary
// lookup is bound to the organization too; no point, geometry, share or other person's row is read. The range row follows
// the dates as in the activity statement.
//
// Plan (EXPLAIN under the runtime role, ADR-0089): the runs of the range come from runs_owner_started_idx. The summary is
// a LATERAL lookup with OFFSET 0, which keeps PostgreSQL from flattening it into a join, so each run of the range probes
// run_summaries_pkey once. As a plain LEFT JOIN the planner hashed a sequential scan of the WHOLE run_summaries table
// (every organization's rows, filtered by its row-level security policy), whose cost grows with the database rather than
// with the range.
export const activityTrendsRecordedRunsSql = `/* activity-trends:recorded-runs */
WITH daily AS (
  SELECT width_bucket(run.started_at, $3::timestamptz[]) AS day_number,
         count(*)::integer AS count,
         (count(*) FILTER (WHERE summary.source_revision = run.data_revision))::integer AS current,
         (count(*) FILTER (WHERE summary.run_id IS NULL))::integer AS pending,
         (count(*) FILTER (WHERE summary.source_revision <> run.data_revision))::integer AS stale,
         sum(summary.observed_duration_s) FILTER (WHERE summary.source_revision = run.data_revision) AS observed_sum,
         sum(summary.distance_m) FILTER (WHERE summary.source_revision = run.data_revision) AS distance_sum
    FROM runs AS run
    LEFT JOIN LATERAL (
          SELECT found.run_id, found.source_revision, found.observed_duration_s, found.distance_m
            FROM run_summaries AS found
           WHERE found.org_id = $1 AND found.org_id = run.org_id AND found.run_id = run.id
          OFFSET 0) AS summary ON true
   WHERE run.org_id = $1
     AND run.user_id = $2
     AND run.status = 'finished'
     AND run.started_at >= $4::timestamptz
     AND run.started_at < $5::timestamptz
   GROUP BY 1
), rounded AS (
  SELECT day_number, count, current, pending, stale,
         CASE WHEN current > 0 THEN ${halfUp('observed_sum')} END AS observed_duration_s,
         CASE WHEN current > 0 THEN ${halfUp('distance_sum')} END AS distance_m
    FROM daily
)
SELECT day_number, count, current, pending, stale, observed_duration_s::text AS observed_duration_s,
       distance_m::text AS distance_m, NULL::integer AS days_with_entries, NULL::integer AS days_with_value
  FROM rounded
UNION ALL
SELECT NULL::integer, coalesce(sum(count), 0)::integer, coalesce(sum(current), 0)::integer, coalesce(sum(pending), 0)::integer,
       coalesce(sum(stale), 0)::integer, sum(observed_duration_s)::text, sum(distance_m)::text, count(*)::integer,
       count(observed_duration_s)::integer
  FROM rounded
 ORDER BY day_number NULLS LAST`;

/** A row of the activity statement: a date (`day_number` 1..days) or the range (`day_number` null, `days_with_*` set). */
export interface ActivityTrendsActivityRow {
  count: number;
  day_number: number | null;
  /** Range row only: dates with a distance. */
  days_with_distance: number | null;
  /** Range row only: dates with at least one item. */
  days_with_entries: number | null;
  /** Whole metres as text (a date's sum rounded halves up, or the range's sum of those), null when none records one. */
  distance_m: string | null;
  /** bigint sum as text, null for a range without items. */
  duration_s: string | null;
  with_distance: number;
}

/** A row of the recorded-run statement: a date or the range, like the activity row. */
export interface ActivityTrendsRunRow {
  count: number;
  current: number;
  day_number: number | null;
  /** Range row only: dates with at least one run. */
  days_with_entries: number | null;
  /** Range row only: dates with at least one current summary. */
  days_with_value: number | null;
  distance_m: string | null;
  observed_duration_s: string | null;
  pending: number;
  stale: number;
}

export interface ActivityTrendsInterval {
  /** Every date of the range with its half-open UTC interval, oldest first. */
  days: Array<{ endsAt: string; localDate: string; startsAt: string }>;
  endDate: string;
  endsAt: string;
  shortenedByLowerBound: boolean;
  startDate: string;
  startsAt: string;
}

/**
 * The range for an end date (28 calendar dates, or fewer when 2000-01-01 cuts it, the Trends rule of ADR-0084) with the
 * interval of every date in the zone: from its local start to the next date's local start, so 23 or 25 hours long around
 * a daylight saving change, and empty (start === end) for a date the zone skipped entirely, such as Pacific/Apia's
 * 2011-12-30. The bounds are whole seconds, so the millisecond ISO strings are exact.
 */
export function activityTrendsIntervalOf(endDate: string, timeZone: string): ActivityTrendsInterval {
  const range = dailyTrendsRangeOf(endDate);
  const dates = dailyTrendsDatesOf(range);
  const starts = [...dates, addLocalDays(endDate, 1)].map((localDate) => new Date(startOfLocalDate(localDate, timeZone)).toISOString());
  return {
    days: dates.map((localDate, index) => ({ endsAt: starts[index + 1]!, localDate, startsAt: starts[index]! })),
    endDate,
    endsAt: starts.at(-1)!,
    shortenedByLowerBound: range.shortenedByLowerBound,
    startDate: range.startDate,
    startsAt: starts[0]!,
  };
}

function assertEndNotAfterToday(endDate: string, timeZone: string, nowMs: number): string {
  const today = localDateOf(nowMs, timeZone);
  if (endDate > today) {
    throw new ApiError(400, 'INVALID_REQUEST', `The end date cannot be after today (${today} in ${timeZone})`, {
      fields: [{ message: `Must not be after ${today}`, path: ['endDate'] }],
    });
  }
  return today;
}

/**
 * The statement's date rows by date index and its one range row. A bucket outside the range, a repeated bucket, a bucket
 * of a skipped (empty) date or a missing or repeated range row would be a statement defect, never silently dropped.
 */
function splitRows<Row extends { day_number: number | null }>(
  rows: readonly Row[],
  interval: ActivityTrendsInterval,
): { byDay: Map<number, Row>; range: Row } {
  const byDay = new Map<number, Row>();
  let range: Row | undefined;
  for (const row of rows) {
    if (row.day_number === null) {
      if (range !== undefined) throw new Error('The activity trends statement returned more than one range row');
      range = row;
      continue;
    }
    const index = row.day_number - 1;
    const day = interval.days[index];
    if (!Number.isInteger(row.day_number) || day === undefined || day.startsAt === day.endsAt || byDay.has(index)) {
      throw new Error(`The activity trends statement returned an unexpected date bucket: ${String(row.day_number)}`);
    }
    byDay.set(index, row);
  }
  if (range === undefined) throw new Error('The activity trends statement returned no range row');
  return { byDay, range };
}

function exactInteger(text: string, what: string): number {
  const value = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value)) throw new Error(`PostgreSQL returned a ${what} that is not a safe non-negative integer`);
  return value;
}

/**
 * A total PostgreSQL computed (a date's sum rounded once, halves up, or a range's sum of those integers): present exactly
 * when at least one item records the value, so a missing value is null and a recorded 0 stays 0.
 */
function sqlTotal(withValue: number, text: string | null, what: string): number | null {
  if (withValue === 0) {
    if (text !== null) throw new Error(`PostgreSQL returned a ${what} for items that record none`);
    return null;
  }
  if (text === null) throw new Error(`PostgreSQL returned no ${what} for recorded items`);
  return exactInteger(text, what);
}

function rangeCount(value: number | null, what: string): number {
  if (value === null || !Number.isInteger(value) || value < 0 || value > DAILY_TRENDS_RANGE_DAYS) {
    throw new Error(`PostgreSQL returned no valid ${what} for the range`);
  }
  return value;
}

interface GenericDay {
  count: number;
  distance: { totalM: number | null; withValue: number };
  duration: { totalS: number | null; withValue: number };
  endsAt: string;
  localDate: string;
  startsAt: string;
}

interface GenericSummary {
  count: number;
  daysWithEntries: number;
  distance: { daysWithValue: number; totalM: number | null; withValue: number };
  duration: { daysWithValue: number; totalS: number | null; withValue: number };
}

/** Manual, GPX or TCX dates and the range, every figure as PostgreSQL returned it. */
export function manualOrGpxTrendsOf(
  interval: ActivityTrendsInterval,
  rows: readonly ActivityTrendsActivityRow[],
): { days: GenericDay[]; summary: GenericSummary } {
  const { byDay, range } = splitRows(rows, interval);
  const days = interval.days.map((day, index): GenericDay => {
    const row = byDay.get(index);
    if (row === undefined) {
      return { ...day, count: 0, distance: { totalM: null, withValue: 0 }, duration: { totalS: null, withValue: 0 } };
    }
    return {
      ...day,
      count: row.count,
      distance: { totalM: sqlTotal(row.with_distance, row.distance_m, 'distance'), withValue: row.with_distance },
      duration: { totalS: sqlTotal(row.count, row.duration_s, 'duration sum'), withValue: row.count },
    };
  });
  return { days, summary: activitySummaryOf(range) };
}

/** A range row of the activity statement (the range, or in a comparison the previous period) as a summary. */
function activitySummaryOf(range: ActivityTrendsActivityRow): GenericSummary {
  const daysWithEntries = rangeCount(range.days_with_entries, 'days with entries');
  return {
    count: range.count,
    daysWithEntries,
    distance: {
      daysWithValue: rangeCount(range.days_with_distance, 'days with a distance'),
      totalM: sqlTotal(range.with_distance, range.distance_m, 'range distance'),
      withValue: range.with_distance,
    },
    // Every activity records its duration, so the dates with a duration are the dates with entries.
    duration: { daysWithValue: daysWithEntries, totalS: sqlTotal(range.count, range.duration_s, 'range duration'), withValue: range.count },
  };
}

/** A range row of the recorded-run statement as a summary. */
function recordedRunSummaryOf(range: ActivityTrendsRunRow): RecordedRunTrendsSummary {
  // Distance and observed duration come from the same current summaries, so they have the same dates with a value.
  const daysWithValue = rangeCount(range.days_with_value, 'days with a current summary');
  return {
    count: range.count,
    daysWithEntries: rangeCount(range.days_with_entries, 'days with entries'),
    distance: { daysWithValue, totalM: sqlTotal(range.current, range.distance_m, 'range distance'), withValue: range.current },
    observedDuration: {
      daysWithValue,
      totalS: sqlTotal(range.current, range.observed_duration_s, 'range observed duration'),
      withValue: range.current,
    },
    summaries: { current: range.current, pending: range.pending, stale: range.stale },
  };
}

/** Recorded-run dates and the range, every figure as PostgreSQL returned it. */
export function recordedRunTrendsOf(
  interval: ActivityTrendsInterval,
  rows: readonly ActivityTrendsRunRow[],
): { days: RecordedRunTrendDay[]; summary: RecordedRunTrendsSummary } {
  const { byDay, range } = splitRows(rows, interval);
  const days = interval.days.map((day, index): RecordedRunTrendDay => {
    const row = byDay.get(index);
    if (row === undefined) {
      return {
        ...day,
        count: 0,
        distance: { totalM: null, withValue: 0 },
        observedDuration: { totalS: null, withValue: 0 },
        summaries: { current: 0, pending: 0, stale: 0 },
      };
    }
    return {
      ...day,
      count: row.count,
      distance: { totalM: sqlTotal(row.current, row.distance_m, 'distance'), withValue: row.current },
      observedDuration: { totalS: sqlTotal(row.current, row.observed_duration_s, 'observed duration'), withValue: row.current },
      summaries: { current: row.current, pending: row.pending, stale: row.stale },
    };
  });
  return { days, summary: recordedRunSummaryOf(range) };
}

/**
 * The response from the statement's rows. Daily and range figures both come from PostgreSQL; the contract's schema then
 * checks that the range agrees with its own definition over the days (summarize*TrendDays) and refuses the answer if not.
 */
export function buildActivityTrends(input: {
  computedAt: string;
  interval: ActivityTrendsInterval;
  query: ActivityTrendsQuery;
  rows: { activities: ActivityTrendsActivityRow[] } | { runs: ActivityTrendsRunRow[] };
  timeZone: string;
  today: string;
}): ActivityTrends {
  return activityTrendsSchema.parse(assembleActivityTrends(input));
}

/** The unchecked answer of an ordinary read: `buildActivityTrends` and the comparison builder parse it. */
function assembleActivityTrends(input: {
  computedAt: string;
  interval: ActivityTrendsInterval;
  query: ActivityTrendsQuery;
  rows: { activities: ActivityTrendsActivityRow[] } | { runs: ActivityTrendsRunRow[] };
  timeZone: string;
  today: string;
}) {
  const { interval, query } = input;
  const common = {
    applied: { endDate: query.endDate, source: query.source, timeZone: input.timeZone, type: query.type },
    provenance: {
      computedAt: input.computedAt,
      persisted: false,
      policyVersion: ACTIVITY_TRENDS_VERSION,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
    },
    range: {
      days: interval.days.length,
      endDate: interval.endDate,
      endsAt: interval.endsAt,
      includesToday: interval.endDate === input.today,
      requestedDays: DAILY_TRENDS_RANGE_DAYS,
      shortenedByLowerBound: interval.shortenedByLowerBound,
      startDate: interval.startDate,
      startsAt: interval.startsAt,
      today: input.today,
    },
  };
  if (query.source === 'recorded_run') {
    if (!('runs' in input.rows)) throw new Error('Recorded-run trends need the recorded-run statement');
    const { days, summary } = recordedRunTrendsOf(interval, input.rows.runs);
    return { ...common, days, source: 'recorded_run' as const, summary };
  }
  if (!('activities' in input.rows)) throw new Error('Activity trends need the activity statement');
  const source = query.source;
  const generic = manualOrGpxTrendsOf(interval, input.rows.activities);
  const days = generic.days.map(({ duration, ...day }) => ({ ...day, [durationKeyOf(source)]: duration })) as
    | ManualActivityTrendDay[]
    | GpxActivityTrendDay[]
    | TcxActivityTrendDay[];
  return { ...common, days, source, summary: namedSummary(source, generic.summary) };
}

/** The sources whose items live in `activities` and share the activity statements. */
type ActivityTableSource = 'gpx' | 'manual' | 'tcx';

/**
 * The duration name of a source of the activities table (ADR-0087/0091). Exhaustive: a TCX import's reported duration is
 * never named as a GPX elapsed time or a manual entered duration, and an unknown source is an error.
 */
function durationKeyOf(source: ActivityTableSource): Exclude<ActivityTrendsDurationKey, 'observedDuration'> {
  switch (source) {
    case 'manual':
      return 'enteredDuration';
    case 'gpx':
      return 'elapsedDuration';
    case 'tcx':
      return 'reportedDuration';
    default: {
      const unknown: never = source;
      throw new Error(`Unknown activity source: ${String(unknown)}`);
    }
  }
}

/** A manual, GPX or TCX summary under its source's duration name. */
function namedSummary(
  source: ActivityTableSource,
  generic: GenericSummary,
): ManualActivityTrendsSummary | GpxActivityTrendsSummary | TcxActivityTrendsSummary {
  const { duration, ...base } = generic;
  switch (source) {
    case 'manual':
      return { ...base, enteredDuration: duration };
    case 'gpx':
      return { ...base, elapsedDuration: duration };
    case 'tcx':
      return { ...base, reportedDuration: duration };
    default: {
      const unknown: never = source;
      throw new Error(`Unknown activity source: ${String(unknown)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparison with the previous period (ADR-0090)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The window a comparison reads: the previous period's dates (E-55..E-28, cut by 2000-01-01, possibly none) followed by
 * the range's (E-27..E), at most 56 dates, every start located in the zone by startOfLocalDate. The previous period ends
 * exactly where the range starts, so the two tile the window.
 */
export interface ActivityTrendsComparisonWindow {
  current: ActivityTrendsInterval;
  /** End of the window (exclusive): the first instant of the date after the range. */
  endsAt: string;
  previous: {
    period: (ActivityTrendsPeriodDates & { endsAt: string; startsAt: string }) | null;
    requestedEndDate: string;
    requestedStartDate: string;
  };
  /** How many leading bucket bounds belong to the previous period (0..28). */
  previousDays: number;
  /** Every date's start, previous period first: the bucket bounds. */
  starts: string[];
  /** Start of the window (inclusive): the previous period's first instant, or the range's when it has none. */
  startsAt: string;
}

export function activityTrendsComparisonWindowOf(endDate: string, timeZone: string): ActivityTrendsComparisonWindow {
  const current = activityTrendsIntervalOf(endDate, timeZone);
  const previous = previousActivityTrendsPeriodOf(endDate);
  const previousStarts = previous.period === null ? [] : dailyTrendsDatesOf(previous.period).map((localDate) => new Date(startOfLocalDate(localDate, timeZone)).toISOString());
  if (previous.period !== null && previous.period.endDate !== addLocalDays(current.startDate, -1)) {
    throw new Error('The previous period must end on the date before the range');
  }
  const starts = [...previousStarts, ...current.days.map((day) => day.startsAt)];
  if (starts.length > 2 * DAILY_TRENDS_RANGE_DAYS) throw new Error('A comparison reads at most 56 dates');
  return {
    current,
    endsAt: current.endsAt,
    previous: {
      period: previous.period === null ? null : { ...previous.period, endsAt: current.startsAt, startsAt: previousStarts[0]! },
      requestedEndDate: previous.requestedEndDate,
      requestedStartDate: previous.requestedStartDate,
    },
    previousDays: previousStarts.length,
    starts,
    startsAt: starts[0]!,
  };
}

// The absolute change and the percentage change in tenths of a percent of two period totals, in PostgreSQL: NULL when
// either total is NULL (undefined), the percentage also NULL for a zero baseline. The percentage is (current - previous) /
// previous * 100 rounded to one decimal, halves away from zero, by exact numeric integer division (div truncates, both
// operands are positive, so this is floor(|change| * 1000 / previous + 1/2) with the change's sign). Totals are integers
// here (sums of the dates' rounded totals), so ::numeric is exact; it only keeps |change| * 2000 from overflowing bigint.
const percentTenths = (current: string, previous: string) =>
  `CASE WHEN ${previous} > 0 THEN (sign(${current} - ${previous}) * div(abs(${current} - ${previous})::numeric * 2000 + ${previous}, ${previous}::numeric * 2))::text END`;

// $1 organization, $2 owner, $3 the start of every date of the window (previous period first, then the range), $4 start
// of the window (inclusive), $5 start of the date after the range (exclusive), $6 source, $7 activity type, $8 how many
// leading bounds belong to the previous period.
//
// The activity statement of ADR-0089 over the window instead of the range: each date is bucketed, filtered and rounded
// exactly as there, so the range's dates and range row are the same figures as an ordinary read's. A bucket above $8 is a
// date of the range (`day_number` = bucket - $8, 1..days); one at or below it is a date of the previous period, whose rows
// are not returned. Rows: `day` (a date of the range with an item), `current` and `previous` (one each, aggregates over
// the dates of that period, rounded per date then added; they exist when a period has no item), and one `change` row:
// current minus previous for the count, duration and distance, with each percentage in tenths. The CTEs are read more than
// once, so PostgreSQL materializes them: every row comes from the same per-date rows of the same statement snapshot.
export const activityTrendsActivitiesComparisonSql = `/* activity-trends:activities-comparison */
WITH daily AS (
  SELECT width_bucket(activity.started_at, $3::timestamptz[]) AS bucket,
         count(*)::integer AS count,
         sum(activity.duration_s) AS duration_s,
         count(activity.distance_m)::integer AS with_distance,
         sum(activity.distance_m) AS distance_sum
    FROM activities AS activity
   WHERE activity.org_id = $1
     AND activity.user_id = $2
     AND activity.started_at >= $4::timestamptz
     AND activity.started_at < $5::timestamptz
     AND activity.source = $6::text
     AND activity.type = $7::text
   GROUP BY 1
), rounded AS (
  SELECT bucket > $8::integer AS is_current, bucket - $8::integer AS day_number, count, duration_s, with_distance,
         CASE WHEN with_distance > 0 THEN ${halfUp('distance_sum')} END AS distance_m
    FROM daily
), periods AS (
  SELECT period.is_current,
         coalesce(sum(rounded.count), 0)::integer AS count,
         sum(rounded.duration_s) AS duration_s,
         coalesce(sum(rounded.with_distance), 0)::integer AS with_distance,
         sum(rounded.distance_m) AS distance_m,
         count(rounded.day_number)::integer AS days_with_entries,
         count(rounded.distance_m)::integer AS days_with_distance
    FROM (VALUES (false), (true)) AS period(is_current)
    LEFT JOIN rounded ON rounded.is_current = period.is_current
   GROUP BY period.is_current
)
SELECT 'day' AS row_kind, day_number, count, duration_s::text AS duration_s, with_distance, distance_m::text AS distance_m,
       NULL::integer AS days_with_entries, NULL::integer AS days_with_distance, NULL::text AS count_percent_tenths,
       NULL::text AS duration_percent_tenths, NULL::text AS distance_percent_tenths
  FROM rounded
 WHERE is_current
UNION ALL
SELECT CASE WHEN is_current THEN 'current' ELSE 'previous' END, NULL, count, duration_s::text, with_distance, distance_m::text,
       days_with_entries, days_with_distance, NULL, NULL, NULL
  FROM periods
UNION ALL
SELECT 'change', NULL, cur.count - prev.count, (cur.duration_s - prev.duration_s)::text, NULL,
       (cur.distance_m - prev.distance_m)::text, NULL, NULL, ${percentTenths('cur.count', 'prev.count')},
       ${percentTenths('cur.duration_s', 'prev.duration_s')}, ${percentTenths('cur.distance_m', 'prev.distance_m')}
  FROM periods AS cur
  JOIN periods AS prev ON cur.is_current AND NOT prev.is_current
 ORDER BY row_kind, day_number`;

// $1 organization, $2 owner, $3 the start of every date of the window, $4 its start, $5 its exclusive end, $6 how many
// leading bounds belong to the previous period.
//
// The recorded-run statement of ADR-0089 over the window, with the rows of the activity comparison: the owner's finished
// runs, each summary looked up by key (LATERAL ... OFFSET 0) and used only when it is current for the run's data; per
// date counts by summary state and the current summaries' observed durations and distances rounded once per date. The
// `change` row's count is runs (whatever their summary state); its duration and distance changes are NULL when either
// period has no current summary.
export const activityTrendsRecordedRunsComparisonSql = `/* activity-trends:recorded-runs-comparison */
WITH daily AS (
  SELECT width_bucket(run.started_at, $3::timestamptz[]) AS bucket,
         count(*)::integer AS count,
         (count(*) FILTER (WHERE summary.source_revision = run.data_revision))::integer AS current,
         (count(*) FILTER (WHERE summary.run_id IS NULL))::integer AS pending,
         (count(*) FILTER (WHERE summary.source_revision <> run.data_revision))::integer AS stale,
         sum(summary.observed_duration_s) FILTER (WHERE summary.source_revision = run.data_revision) AS observed_sum,
         sum(summary.distance_m) FILTER (WHERE summary.source_revision = run.data_revision) AS distance_sum
    FROM runs AS run
    LEFT JOIN LATERAL (
          SELECT found.run_id, found.source_revision, found.observed_duration_s, found.distance_m
            FROM run_summaries AS found
           WHERE found.org_id = $1 AND found.org_id = run.org_id AND found.run_id = run.id
          OFFSET 0) AS summary ON true
   WHERE run.org_id = $1
     AND run.user_id = $2
     AND run.status = 'finished'
     AND run.started_at >= $4::timestamptz
     AND run.started_at < $5::timestamptz
   GROUP BY 1
), rounded AS (
  SELECT bucket > $6::integer AS is_current, bucket - $6::integer AS day_number, count, current, pending, stale,
         CASE WHEN current > 0 THEN ${halfUp('observed_sum')} END AS observed_duration_s,
         CASE WHEN current > 0 THEN ${halfUp('distance_sum')} END AS distance_m
    FROM daily
), periods AS (
  SELECT period.is_current,
         coalesce(sum(rounded.count), 0)::integer AS count,
         coalesce(sum(rounded.current), 0)::integer AS current,
         coalesce(sum(rounded.pending), 0)::integer AS pending,
         coalesce(sum(rounded.stale), 0)::integer AS stale,
         sum(rounded.observed_duration_s) AS observed_duration_s,
         sum(rounded.distance_m) AS distance_m,
         count(rounded.day_number)::integer AS days_with_entries,
         count(rounded.observed_duration_s)::integer AS days_with_value
    FROM (VALUES (false), (true)) AS period(is_current)
    LEFT JOIN rounded ON rounded.is_current = period.is_current
   GROUP BY period.is_current
)
SELECT 'day' AS row_kind, day_number, count, current, pending, stale, observed_duration_s::text AS observed_duration_s,
       distance_m::text AS distance_m, NULL::integer AS days_with_entries, NULL::integer AS days_with_value,
       NULL::text AS count_percent_tenths, NULL::text AS duration_percent_tenths, NULL::text AS distance_percent_tenths
  FROM rounded
 WHERE is_current
UNION ALL
SELECT CASE WHEN is_current THEN 'current' ELSE 'previous' END, NULL, count, current, pending, stale,
       observed_duration_s::text, distance_m::text, days_with_entries, days_with_value, NULL, NULL, NULL
  FROM periods
UNION ALL
SELECT 'change', NULL, cur.count - prev.count, NULL, NULL, NULL, (cur.observed_duration_s - prev.observed_duration_s)::text,
       (cur.distance_m - prev.distance_m)::text, NULL, NULL, ${percentTenths('cur.count', 'prev.count')},
       ${percentTenths('cur.observed_duration_s', 'prev.observed_duration_s')}, ${percentTenths('cur.distance_m', 'prev.distance_m')}
  FROM periods AS cur
  JOIN periods AS prev ON cur.is_current AND NOT prev.is_current
 ORDER BY row_kind, day_number`;

type RowKind = 'change' | 'current' | 'day' | 'previous';

interface PercentColumns {
  count_percent_tenths: string | null;
  distance_percent_tenths: string | null;
  duration_percent_tenths: string | null;
}

/**
 * A row of the activity comparison statement. `day`, `current` and `previous` rows carry the columns of the ordinary
 * statement (`current` and `previous` as its range row). The `change` row carries signed differences: `count` (items),
 * `duration_s` and `distance_m` (text, NULL when either total is undefined), and the three percentages in tenths.
 */
export type ActivityTrendsActivityComparisonRow = Omit<ActivityTrendsActivityRow, 'count' | 'with_distance'> &
  PercentColumns & { count: number | null; row_kind: RowKind; with_distance: number | null };

/** A row of the recorded-run comparison statement; the `change` row has NULL run-state columns. */
export type ActivityTrendsRunComparisonRow = Omit<ActivityTrendsRunRow, 'count' | 'current' | 'pending' | 'stale'> &
  PercentColumns & { count: number | null; current: number | null; pending: number | null; stale: number | null; row_kind: RowKind };

function signedInteger(text: string, what: string): number {
  const value = Number(text);
  if (!/^-?\d+$/u.test(text) || !Number.isSafeInteger(value)) throw new Error(`PostgreSQL returned a ${what} that is not a safe integer`);
  return value;
}

/** The statement's rows by kind: the range's dates, and exactly one `current`, `previous` and `change` row. */
function splitComparisonRows<Row extends { row_kind: RowKind }>(rows: readonly Row[]): { change: Row; current: Row; days: Row[]; previous: Row } {
  const byKind = (kind: RowKind) => rows.filter((row) => row.row_kind === kind);
  const single = (kind: RowKind) => {
    const found = byKind(kind);
    if (found.length !== 1) throw new Error(`The activity trends comparison returned ${found.length} ${kind} rows`);
    return found[0]!;
  };
  if (rows.some((row) => !['change', 'current', 'day', 'previous'].includes(row.row_kind))) throw new Error('The activity trends comparison returned an unknown row');
  return { change: single('change'), current: single('current'), days: byKind('day'), previous: single('previous') };
}

const nonNull = (value: number | null, what: string): number => {
  if (value === null) throw new Error(`PostgreSQL returned no ${what}`);
  return value;
};

interface PeriodSide {
  count: number;
  distance: number;
  duration: number;
  pending: number;
  stale: number;
}

/** What a summary records, per metric, for the contract's availability rules. */
function sideOfSummary(summary: GenericSummary & { summaries?: { pending: number; stale: number } }): PeriodSide {
  return {
    count: summary.count,
    distance: summary.distance.withValue,
    duration: summary.duration.withValue,
    pending: summary.summaries?.pending ?? 0,
    stale: summary.summaries?.stale ?? 0,
  };
}

/**
 * One metric's change: unavailable with the contract's reasons, or available with PostgreSQL's absolute change and
 * percentage (tenths / 10; none for a zero baseline). The schema then checks both numbers against the contract's arithmetic.
 */
function changeFromSql(reasons: ActivityTrendsComparisonReason[], absolute: number | string | null, tenths: string | null, previousTotal: number | null, what: string): ActivityTrendsChange {
  if (reasons.length > 0) return { reasons, status: 'unavailable' };
  if (absolute === null || previousTotal === null) throw new Error(`PostgreSQL returned no ${what} change for comparable periods`);
  const change = typeof absolute === 'number' ? absolute : signedInteger(absolute, `${what} change`);
  if (previousTotal === 0) {
    if (tenths !== null) throw new Error(`PostgreSQL returned a ${what} percentage for a zero baseline`);
    return { absolute: change, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' };
  }
  if (tenths === null) throw new Error(`PostgreSQL returned no ${what} percentage`);
  return { absolute: change, percent: signedInteger(tenths, `${what} percentage`) / 10, percentUnavailableReason: null, status: 'available' };
}

/** The comparison object from the two period summaries and PostgreSQL's change row; availability is the contract's rule. */
function comparisonFrom(input: {
  change: PercentColumns & { count: number | null; distance: string | null; duration: string | null };
  current: GenericSummary & { summaries?: { pending: number; stale: number } };
  durationKey: ActivityTrendsDurationKey;
  includesToday: boolean;
  previous: (GenericSummary & { summaries?: { pending: number; stale: number } }) | null;
  previousSummary: unknown;
  range: { days: number };
  window: ActivityTrendsComparisonWindow;
}) {
  const { current, previous, window } = input;
  const periodReasons = activityTrendsPeriodReasons({ days: input.range.days, includesToday: input.includesToday }, window.previous.period);
  const currentSide = sideOfSummary(current);
  const previousSide = previous === null ? null : sideOfSummary(previous);
  const reasonsFor = (metric: 'count' | 'distance' | 'duration') =>
    activityTrendsComparisonReasons({
      current: { count: currentSide.count, pending: currentSide.pending, stale: currentSide.stale, withValue: metric === 'count' ? currentSide.count : currentSide[metric] },
      metric,
      periodReasons,
      previous:
        previousSide === null
          ? null
          : { count: previousSide.count, pending: previousSide.pending, stale: previousSide.stale, withValue: metric === 'count' ? previousSide.count : previousSide[metric] },
    });
  const previousDuration = previous === null ? null : previous.duration.totalS;
  const previousDistance = previous === null ? null : previous.distance.totalM;
  return {
    current: {
      inProgress: input.includesToday,
      period: {
        days: window.current.days.length,
        endDate: window.current.endDate,
        endsAt: window.current.endsAt,
        requestedDays: DAILY_TRENDS_RANGE_DAYS,
        shortenedByLowerBound: window.current.shortenedByLowerBound,
        startDate: window.current.startDate,
        startsAt: window.current.startsAt,
      },
    },
    metrics: {
      count: {
        change: changeFromSql(reasonsFor('count'), input.change.count, input.change.count_percent_tenths, previous === null ? null : previous.count, 'count'),
        current: current.count,
        previous: previous === null ? null : previous.count,
      },
      distance: {
        change: changeFromSql(reasonsFor('distance'), input.change.distance, input.change.distance_percent_tenths, previousDistance, 'distance'),
        current: current.distance.totalM,
        previous: previousDistance,
      },
      [input.durationKey]: {
        change: changeFromSql(reasonsFor('duration'), input.change.duration, input.change.duration_percent_tenths, previousDuration, 'duration'),
        current: current.duration.totalS,
        previous: previousDuration,
      },
    },
    mode: 'previous_period' as const,
    periodReasons,
    policyVersion: ACTIVITY_TRENDS_COMPARISON_VERSION,
    previous: {
      period: window.previous.period === null ? null : { ...window.previous.period, requestedDays: DAILY_TRENDS_RANGE_DAYS },
      requestedEndDate: window.previous.requestedEndDate,
      requestedStartDate: window.previous.requestedStartDate,
      summary: input.previousSummary,
    },
  };
}

/** An empty previous row is all a window without a previous period can give; anything else is a statement defect. */
function assertEmptyPrevious(row: { count: number | null }, window: ActivityTrendsComparisonWindow): void {
  if (window.previous.period === null && row.count !== 0) throw new Error('PostgreSQL returned items for a previous period that does not exist');
}

/**
 * The response of a comparison read: the range exactly as an ordinary read builds it (from the statement's `day` and
 * `current` rows), the previous period's summary from its `previous` row, and each metric's change from the `change` row
 * when the contract's rules allow it. The schema then checks the whole answer, the comparison included, against the
 * contract and refuses it if anything disagrees.
 */
export function buildActivityTrendsComparison(input: {
  computedAt: string;
  query: ActivityTrendsQuery;
  rows: { activities: ActivityTrendsActivityComparisonRow[] } | { runs: ActivityTrendsRunComparisonRow[] };
  timeZone: string;
  today: string;
  window: ActivityTrendsComparisonWindow;
}): ActivityTrends {
  const { query, window } = input;
  const interval = window.current;
  const ordinary = { computedAt: input.computedAt, interval, query, timeZone: input.timeZone, today: input.today };
  const includesToday = interval.endDate === input.today;
  if (query.source === 'recorded_run') {
    if (!('runs' in input.rows)) throw new Error('Recorded-run trends need the recorded-run comparison statement');
    const split = splitComparisonRows(input.rows.runs);
    const asRunRow = (row: ActivityTrendsRunComparisonRow): ActivityTrendsRunRow => ({
      count: nonNull(row.count, 'run count'),
      current: nonNull(row.current, 'current summaries'),
      day_number: row.row_kind === 'day' ? row.day_number : null,
      days_with_entries: row.days_with_entries,
      days_with_value: row.days_with_value,
      distance_m: row.distance_m,
      observed_duration_s: row.observed_duration_s,
      pending: nonNull(row.pending, 'pending summaries'),
      stale: nonNull(row.stale, 'stale summaries'),
    });
    const base = assembleActivityTrends({ ...ordinary, rows: { runs: [...split.days.map(asRunRow), asRunRow(split.current)] } });
    assertEmptyPrevious(split.previous, window);
    const previousSummary = window.previous.period === null ? null : recordedRunSummaryOf(asRunRow(split.previous));
    const asGeneric = (summary: RecordedRunTrendsSummary) => ({ ...summary, duration: summary.observedDuration });
    const comparison = comparisonFrom({
      change: { ...split.change, distance: split.change.distance_m, duration: split.change.observed_duration_s },
      current: asGeneric(base.summary as RecordedRunTrendsSummary),
      durationKey: 'observedDuration',
      includesToday,
      previous: previousSummary === null ? null : asGeneric(previousSummary),
      previousSummary,
      range: { days: interval.days.length },
      window,
    });
    return activityTrendsSchema.parse({ ...base, applied: { ...base.applied, compare: 'previous_period' }, comparison });
  }
  if (!('activities' in input.rows)) throw new Error('Activity trends need the activity comparison statement');
  const split = splitComparisonRows(input.rows.activities);
  const asActivityRow = (row: ActivityTrendsActivityComparisonRow): ActivityTrendsActivityRow => ({
    count: nonNull(row.count, 'item count'),
    day_number: row.row_kind === 'day' ? row.day_number : null,
    days_with_distance: row.days_with_distance,
    days_with_entries: row.days_with_entries,
    distance_m: row.distance_m,
    duration_s: row.duration_s,
    with_distance: nonNull(row.with_distance, 'items with a distance'),
  });
  const base = assembleActivityTrends({ ...ordinary, rows: { activities: [...split.days.map(asActivityRow), asActivityRow(split.current)] } });
  assertEmptyPrevious(split.previous, window);
  const current = activitySummaryOf(asActivityRow(split.current));
  const previous = window.previous.period === null ? null : activitySummaryOf(asActivityRow(split.previous));
  const comparison = comparisonFrom({
    change: { ...split.change, distance: split.change.distance_m, duration: split.change.duration_s },
    current,
    durationKey: durationKeyOf(query.source),
    includesToday,
    previous,
    previousSummary: previous === null ? null : namedSummary(query.source, previous),
    range: { days: interval.days.length },
    window,
  });
  return activityTrendsSchema.parse({ ...base, applied: { ...base.applied, compare: 'previous_period' }, comparison });
}

export class ActivityTrendsService {
  readonly #clock: Clock;
  readonly #hooks: ActivityTrendsTestHooks | undefined;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor(options: ActivityTrendsServiceOptions) {
    this.#clock = options.clock;
    this.#hooks = options.hooks;
    this.#pool = options.pool;
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, query: ActivityTrendsQuery): Promise<ActivityTrends> {
    const timeZone = canonicalTimeZone(query.timeZone);
    const now = this.#clock.utcNow();
    const today = assertEndNotAfterToday(query.endDate, timeZone, now.getTime());
    if (query.compare === 'previous_period') return this.#readComparison(session, orgId, query, timeZone, today, now);
    const interval = activityTrendsIntervalOf(query.endDate, timeZone);
    const bounds = [orgId, session.userId, interval.days.map((day) => day.startsAt), interval.startsAt, interval.endsAt];
    const rows = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        await this.#hooks?.beforeAggregateRead?.();
        if (query.source === 'recorded_run') {
          return { runs: (await client.query<ActivityTrendsRunRow>(activityTrendsRecordedRunsSql, bounds)).rows };
        }
        return {
          activities: (await client.query<ActivityTrendsActivityRow>(activityTrendsActivitiesSql, [...bounds, query.source, query.type])).rows,
        };
      },
      { snapshot: 'read-only snapshot' },
    );
    return buildActivityTrends({ computedAt: now.toISOString(), interval, query, rows, timeZone, today });
  }

  /**
   * Both periods in the same transaction and the same statement: the membership check and ONE comparison statement for
   * the source over at most 56 dates, so the previous period, the range and the changes come from one snapshot.
   */
  async #readComparison(
    session: Pick<StoredSession, 'userId'>,
    orgId: string,
    query: ActivityTrendsQuery,
    timeZone: string,
    today: string,
    now: Date,
  ): Promise<ActivityTrends> {
    const window = activityTrendsComparisonWindowOf(query.endDate, timeZone);
    const bounds = [orgId, session.userId, window.starts, window.startsAt, window.endsAt];
    const rows = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        await this.#hooks?.beforeAggregateRead?.();
        if (query.source === 'recorded_run') {
          return { runs: (await client.query<ActivityTrendsRunComparisonRow>(activityTrendsRecordedRunsComparisonSql, [...bounds, window.previousDays])).rows };
        }
        return {
          activities: (
            await client.query<ActivityTrendsActivityComparisonRow>(activityTrendsActivitiesComparisonSql, [...bounds, query.source, query.type, window.previousDays])
          ).rows,
        };
      },
      { snapshot: 'read-only snapshot' },
    );
    return buildActivityTrendsComparison({ computedAt: now.toISOString(), query, rows, timeZone, today, window });
  }
}
