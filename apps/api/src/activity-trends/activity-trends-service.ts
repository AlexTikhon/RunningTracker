import {
  ACTIVITY_TRENDS_VERSION,
  activityTrendsSchema,
  addLocalDays,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  DAILY_TRENDS_RANGE_DAYS,
  type ActivityTrends,
  type ActivityTrendsQuery,
  type GpxActivityTrendDay,
  type GpxActivityTrendsSummary,
  type ManualActivityTrendDay,
  type ManualActivityTrendsSummary,
  type RecordedRunTrendDay,
  type RecordedRunTrendsSummary,
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
// (exclusive), $6 source ('manual' or 'gpx'), $7 activity type.
//
// `daily`: one row per date with at least one item: how many started, the sum of their stored durations (every activity
// has one: entered for a manual entry, elapsed for a GPX import), how many record a distance and the sum over exactly those
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

/** Manual or GPX dates and the range, every figure as PostgreSQL returned it. */
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
  const daysWithEntries = rangeCount(range.days_with_entries, 'days with entries');
  return {
    days,
    summary: {
      count: range.count,
      daysWithEntries,
      distance: {
        daysWithValue: rangeCount(range.days_with_distance, 'days with a distance'),
        totalM: sqlTotal(range.with_distance, range.distance_m, 'range distance'),
        withValue: range.with_distance,
      },
      // Every activity records its duration, so the dates with a duration are the dates with entries.
      duration: { daysWithValue: daysWithEntries, totalS: sqlTotal(range.count, range.duration_s, 'range duration'), withValue: range.count },
    },
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
  // Distance and observed duration come from the same current summaries, so they have the same dates with a value.
  const daysWithValue = rangeCount(range.days_with_value, 'days with a current summary');
  return {
    days,
    summary: {
      count: range.count,
      daysWithEntries: rangeCount(range.days_with_entries, 'days with entries'),
      distance: { daysWithValue, totalM: sqlTotal(range.current, range.distance_m, 'range distance'), withValue: range.current },
      observedDuration: {
        daysWithValue,
        totalS: sqlTotal(range.current, range.observed_duration_s, 'range observed duration'),
        withValue: range.current,
      },
      summaries: { current: range.current, pending: range.pending, stale: range.stale },
    },
  };
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
    return activityTrendsSchema.parse({ ...common, days, source: 'recorded_run', summary });
  }
  if (!('activities' in input.rows)) throw new Error('Activity trends need the activity statement');
  const generic = manualOrGpxTrendsOf(interval, input.rows.activities);
  const { duration: rangeDuration, ...rangeBase } = generic.summary;
  if (query.source === 'manual') {
    const days: ManualActivityTrendDay[] = generic.days.map(({ duration, ...day }) => ({ ...day, enteredDuration: duration }));
    const summary: ManualActivityTrendsSummary = { ...rangeBase, enteredDuration: rangeDuration };
    return activityTrendsSchema.parse({ ...common, days, source: 'manual', summary });
  }
  const days: GpxActivityTrendDay[] = generic.days.map(({ duration, ...day }) => ({ ...day, elapsedDuration: duration }));
  const summary: GpxActivityTrendsSummary = { ...rangeBase, elapsedDuration: rangeDuration };
  return activityTrendsSchema.parse({ ...common, days, source: 'gpx', summary });
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
}
