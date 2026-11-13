import {
  ACTIVITY_TYPES,
  addLocalDays,
  DAILY_OVERVIEW_VERSION,
  dailyOverviewSchema,
  type ActivityType,
  type DailyOverview,
  type DailyOverviewQuery,
} from '@running-tracker/contracts';
import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import { localDateOf, startOfLocalDate } from '../runs/run-search-period.js';

// The daily overview (Today, ADR-0082): computed on every read, never stored, never queued, no model. It writes nothing.
//
// One REPEATABLE READ READ ONLY transaction holds the membership check and both source statements. The snapshot is
// taken by the transaction's first statement (setting the tenant context), so a write committed after that, also one
// committed between the two source statements, is not seen; nothing is read after the transaction ends. Every
// statement names the organization and the owner and runs with row-level security in force; GPS runs are filtered by
// owner explicitly, so a run another person shared with this one never counts.
//
// The statements follow the two attribution rules:
// - day records: the check-in and the manual movement stored for the calendar date itself (`local_date`), whatever
//   zone they were saved in. The requested zone plays no part, so a record is never moved to another date.
// - timestamped sources: manual activities, GPX-imported (ADR-0086) and TCX-imported (ADR-0091) activities, each kept
//   apart, and finished GPS runs whose
//   start lies in [start of the date, start of the next date) in the requested zone. The bounds are computed from the zone's own rules (startOfLocalDate), so a day is
//   23 or 25 hours long around a daylight saving change.
// - meals (ADR-0083): entries logged for the calendar date itself, like a check-in. Their own statement, read last, in
//   the same snapshot: a meal written or deleted after the transaction's first statement is not seen.

/** Barriers for deterministic snapshot tests. Never set in production. */
export interface DailyOverviewTestHooks {
  /** Inside the read transaction, after the day records were read and before the timestamped sources are read. */
  afterDayRecordsRead?: () => Promise<void>;
}

export interface DailyOverviewServiceOptions {
  clock: Clock;
  hooks?: DailyOverviewTestHooks;
  pool: Pick<Pool, 'connect'>;
}

interface CheckInJson {
  hasNote: boolean;
  mood: number | null;
  sleepMinutes: number | null;
  sleepQuality: number | null;
  soreness: number | null;
  timeZone: string;
  weightKg: number | null;
}

interface MovementJson {
  activeEnergyKcal: string | null;
  source: string;
  steps: number | null;
  timeZone: string;
}

interface DayRecordsRow {
  check_in: CheckInJson | null;
  movement: MovementJson | null;
}

interface StartedRow {
  activities: Array<{ count: number; enteredDurationS: number; type: ActivityType }>;
  gpx_activities: Array<{ count: number; elapsedDurationS: number; type: ActivityType }>;
  tcx_activities: Array<{ count: number; reportedDurationS: number; type: ActivityType }>;
  gps_runs: { count: number; currentDistanceM: number | null; withCurrentDistance: number };
}

/** One metric's coverage and exact total (numeric as text, or null when no entry records it). */
interface MealMetricRow {
  recorded: number;
  total: string | null;
}

export interface MealsRow {
  carbohydrate_g: MealMetricRow;
  count: number;
  energy_kcal: MealMetricRow;
  fat_g: MealMetricRow;
  protein_g: MealMetricRow;
}

// $1 organization, $2 owner, $3 local date. The note's text is never selected: only whether one exists, so that a
// note-only check-in still counts as a record. Movement is the manual row only (a later importer's rows must not be
// mixed in). Both unique keys (owner and date) serve the lookups.
export const dailyOverviewDayRecordsSql = `/* daily-overview:day-records */
SELECT
  (SELECT json_build_object(
            'timeZone', metric.time_zone,
            'weightKg', metric.weight_kg,
            'sleepMinutes', metric.sleep_minutes,
            'sleepQuality', metric.sleep_quality,
            'mood', metric.mood,
            'soreness', metric.soreness,
            'hasNote', metric.note IS NOT NULL)
     FROM daily_metrics AS metric
    WHERE metric.org_id = $1 AND metric.user_id = $2 AND metric.local_date = $3::date) AS check_in,
  (SELECT json_build_object(
            'timeZone', movement.time_zone,
            'source', movement.source,
            'steps', movement.steps,
            'activeEnergyKcal', movement.active_energy_kcal::text)
     FROM daily_movement AS movement
    WHERE movement.org_id = $1 AND movement.user_id = $2 AND movement.local_date = $3::date
      AND movement.source = 'manual') AS movement`;

// $1 organization, $2 owner, $3 first instant of the date, $4 first instant of the next date (exclusive). An activity
// counts with its full stored duration on the date it started, also when it continues past midnight. Manual and
// GPX-imported activities are grouped separately by their server-owned source (ADR-0086): an import is never counted as
// a manual entry, and its duration is the elapsed time of the file. TCX imports are grouped apart again (ADR-0091): their
// duration is the reported duration (the laps' total times, rounded once at import). A GPS run is the person's own, finished, and has a
// distance only from a summary computed for its current data revision; the distance total is the sum over exactly those
// runs. No point, note, distance of an activity or effort is selected.
export const dailyOverviewStartedSql = `/* daily-overview:started-in-day */
SELECT
  (SELECT coalesce(json_agg(json_build_object(
            'type', grouped.type,
            'count', grouped.count,
            'enteredDurationS', grouped.entered_duration_s)), '[]'::json)
     FROM (SELECT activity.type, count(*)::integer AS count, sum(activity.duration_s)::bigint AS entered_duration_s
             FROM activities AS activity
            WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.source = 'manual'
              AND activity.started_at >= $3::timestamptz AND activity.started_at < $4::timestamptz
            GROUP BY activity.type) AS grouped) AS activities,
  (SELECT coalesce(json_agg(json_build_object(
            'type', grouped.type,
            'count', grouped.count,
            'elapsedDurationS', grouped.elapsed_duration_s)), '[]'::json)
     FROM (SELECT activity.type, count(*)::integer AS count, sum(activity.duration_s)::bigint AS elapsed_duration_s
             FROM activities AS activity
            WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.source = 'gpx'
              AND activity.started_at >= $3::timestamptz AND activity.started_at < $4::timestamptz
            GROUP BY activity.type) AS grouped) AS gpx_activities,
  (SELECT coalesce(json_agg(json_build_object(
            'type', grouped.type,
            'count', grouped.count,
            'reportedDurationS', grouped.reported_duration_s)), '[]'::json)
     FROM (SELECT activity.type, count(*)::integer AS count, sum(activity.duration_s)::bigint AS reported_duration_s
             FROM activities AS activity
            WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.source = 'tcx'
              AND activity.started_at >= $3::timestamptz AND activity.started_at < $4::timestamptz
            GROUP BY activity.type) AS grouped) AS tcx_activities,
  (SELECT json_build_object(
            'count', count(*)::integer,
            'withCurrentDistance', (count(*) FILTER (WHERE summary.source_revision = run.data_revision))::integer,
            'currentDistanceM', sum(summary.distance_m) FILTER (WHERE summary.source_revision = run.data_revision))
     FROM runs AS run
     LEFT JOIN run_summaries AS summary ON summary.org_id = run.org_id AND summary.run_id = run.id
    WHERE run.org_id = $1 AND run.user_id = $2 AND run.status = 'finished' AND run.finished_at IS NOT NULL
      AND run.started_at >= $3::timestamptz AND run.started_at < $4::timestamptz) AS gps_runs`;

// $1 organization, $2 owner, $3 local date. Manual entries only (a later importer's rows must not be mixed in). count(col)
// counts the entries that hold a value (a recorded 0 included), so each metric's coverage is independent; sum(col) adds
// exactly those values in numeric arithmetic (no floating point, no rounding) and is NULL when none holds one. No title,
// type or single value is selected. The owner/date index serves the lookup.
export const dailyOverviewMealsSql = `/* daily-overview:meals */
SELECT count(*)::integer AS count,
       json_build_object('recorded', count(meal.energy_kcal)::integer, 'total', sum(meal.energy_kcal)::text) AS energy_kcal,
       json_build_object('recorded', count(meal.protein_g)::integer, 'total', sum(meal.protein_g)::text) AS protein_g,
       json_build_object('recorded', count(meal.carbohydrate_g)::integer, 'total', sum(meal.carbohydrate_g)::text) AS carbohydrate_g,
       json_build_object('recorded', count(meal.fat_g)::integer, 'total', sum(meal.fat_g)::text) AS fat_g
  FROM meals AS meal
 WHERE meal.org_id = $1 AND meal.user_id = $2 AND meal.local_date = $3::date AND meal.source = 'manual'`;

// A sum of values with at most one decimal has at most one decimal, so the text parses to exactly the number it denotes.
const mealMetric = (metric: MealMetricRow) => ({
  recordedEntries: metric.recorded,
  total: metric.total === null ? null : Number(metric.total),
});

/** The half-open UTC interval of a local calendar date in a zone: from its start up to the next date's start. */
export function localDayInterval(localDate: string, timeZone: string): { endsAtMs: number; startsAtMs: number } {
  return { endsAtMs: startOfLocalDate(addLocalDays(localDate, 1), timeZone), startsAtMs: startOfLocalDate(localDate, timeZone) };
}

function assertNotAfterToday(localDate: string, timeZone: string, nowMs: number): string {
  const today = localDateOf(nowMs, timeZone);
  if (localDate > today) {
    throw new ApiError(400, 'INVALID_REQUEST', `The date cannot be after today (${today} in ${timeZone})`, {
      fields: [{ message: `Must not be after ${today}`, path: ['localDate'] }],
    });
  }
  return today;
}

export function buildDailyOverview(input: {
  computedAt: string;
  dayRecords: DayRecordsRow;
  interval: { endsAtMs: number; startsAtMs: number };
  localDate: string;
  meals: MealsRow;
  started: StartedRow;
  timeZone: string;
  today: string;
}): DailyOverview {
  const { check_in: checkIn, movement } = input.dayRecords;
  const byType = input.started.activities
    .map((entry) => ({ count: entry.count, enteredDurationS: Number(entry.enteredDurationS), type: entry.type }))
    .toSorted((left, right) => ACTIVITY_TYPES.indexOf(left.type) - ACTIVITY_TYPES.indexOf(right.type));
  const importedByType = input.started.gpx_activities
    .map((entry) => ({ count: entry.count, elapsedDurationS: Number(entry.elapsedDurationS), type: entry.type }))
    .toSorted((left, right) => ACTIVITY_TYPES.indexOf(left.type) - ACTIVITY_TYPES.indexOf(right.type));
  const tcxByType = input.started.tcx_activities
    .map((entry) => ({ count: entry.count, reportedDurationS: Number(entry.reportedDurationS), type: entry.type }))
    .toSorted((left, right) => ACTIVITY_TYPES.indexOf(left.type) - ACTIVITY_TYPES.indexOf(right.type));
  const gps = input.started.gps_runs;
  return dailyOverviewSchema.parse({
    checkIn: checkIn === null ? { recorded: false } : { recorded: true, ...checkIn },
    day: {
      endsAt: new Date(input.interval.endsAtMs).toISOString(),
      inProgress: input.localDate === input.today,
      localDate: input.localDate,
      startsAt: new Date(input.interval.startsAtMs).toISOString(),
      timeZone: input.timeZone,
    },
    gpsRuns: {
      count: gps.count,
      // Rounded once, after adding: the total of the current summaries' distances, to the nearest metre.
      currentDistanceM: gps.withCurrentDistance === 0 || gps.currentDistanceM === null ? null : Math.round(gps.currentDistanceM),
      withCurrentDistance: gps.withCurrentDistance,
      withoutCurrentDistance: gps.count - gps.withCurrentDistance,
    },
    importedActivities: {
      byType: importedByType,
      count: importedByType.reduce((sum, entry) => sum + entry.count, 0),
      elapsedDurationS: importedByType.reduce((sum, entry) => sum + entry.elapsedDurationS, 0),
      source: 'gpx',
    },
    manualActivities: {
      byType,
      count: byType.reduce((sum, entry) => sum + entry.count, 0),
      enteredDurationS: byType.reduce((sum, entry) => sum + entry.enteredDurationS, 0),
    },
    meals: {
      carbohydrateG: mealMetric(input.meals.carbohydrate_g),
      count: input.meals.count,
      energyKcal: mealMetric(input.meals.energy_kcal),
      fatG: mealMetric(input.meals.fat_g),
      proteinG: mealMetric(input.meals.protein_g),
      source: 'manual',
    },
    tcxImportedActivities: {
      byType: tcxByType,
      count: tcxByType.reduce((sum, entry) => sum + entry.count, 0),
      reportedDurationS: tcxByType.reduce((sum, entry) => sum + entry.reportedDurationS, 0),
      source: 'tcx',
    },
    movement:
      movement === null
        ? { recorded: false }
        : {
            // numeric as text; the database refuses a meaningful second decimal (migration 0035), so this is exact.
            activeEnergyKcal: movement.activeEnergyKcal === null ? null : Number(movement.activeEnergyKcal),
            recorded: true,
            source: movement.source,
            steps: movement.steps,
            timeZone: movement.timeZone,
          },
    provenance: {
      computedAt: input.computedAt,
      overviewVersion: DAILY_OVERVIEW_VERSION,
      persisted: false,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
    },
  });
}

export class DailyOverviewService {
  readonly #clock: Clock;
  readonly #hooks: DailyOverviewTestHooks | undefined;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor(options: DailyOverviewServiceOptions) {
    this.#clock = options.clock;
    this.#hooks = options.hooks;
    this.#pool = options.pool;
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, localDate: string, query: DailyOverviewQuery): Promise<DailyOverview> {
    const timeZone = canonicalTimeZone(query.timeZone);
    const now = this.#clock.utcNow();
    const today = assertNotAfterToday(localDate, timeZone, now.getTime());
    const interval = localDayInterval(localDate, timeZone);
    const { dayRecords, meals, started } = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        const records = (await client.query<DayRecordsRow>(dailyOverviewDayRecordsSql, [orgId, session.userId, localDate])).rows[0];
        if (!records) throw new Error('The daily overview day-record statement returned no row');
        await this.#hooks?.afterDayRecordsRead?.();
        const startedRow = (
          await client.query<StartedRow>(dailyOverviewStartedSql, [
            orgId,
            session.userId,
            new Date(interval.startsAtMs).toISOString(),
            new Date(interval.endsAtMs).toISOString(),
          ])
        ).rows[0];
        if (!startedRow) throw new Error('The daily overview timestamped-source statement returned no row');
        const mealsRow = (await client.query<MealsRow>(dailyOverviewMealsSql, [orgId, session.userId, localDate])).rows[0];
        if (!mealsRow) throw new Error('The daily overview meal statement returned no row');
        return { dayRecords: records, meals: mealsRow, started: startedRow };
      },
      { snapshot: 'read-only snapshot' },
    );
    return buildDailyOverview({ computedAt: now.toISOString(), dayRecords, interval, localDate, meals, started, timeZone, today });
  }
}
