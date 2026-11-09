import {
  DAILY_TRENDS_RANGE_DAYS,
  DAILY_TRENDS_VERSION,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  summarizeDailyTrendDays,
  type DailyTrendDay,
  type DailyTrends,
  type DailyTrendsQuery,
} from '@running-tracker/contracts';
import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import { localDateOf } from '../runs/run-search-period.js';

// 28-day trends (ADR-0084): computed on every read, never stored, never queued, no model. It writes nothing.
//
// One REPEATABLE READ READ ONLY transaction holds the membership check and three range statements, one per source table
// (check-ins, manual movement, meals), each bounded by the range's first and last calendar date: a fixed number of
// statements whatever the range, never one read per date. The snapshot is taken by the transaction's first statement
// (setting the tenant context), so a write committed after that, also one committed between the statements, is not seen;
// nothing is read after the transaction ends. Every statement names the organization and the owner and runs with
// row-level security in force.
//
// Attribution: every source is a daily record and belongs to its stored `local_date`. The requested zone decides only
// "today" (the latest allowed end date); no statement takes it, so no record moves to another date.

/** Barriers for deterministic snapshot tests. Never set in production. */
export interface DailyTrendsTestHooks {
  /** Inside the read transaction, after the check-ins were read and before movement and meals are read. */
  afterCheckInsRead?: () => Promise<void>;
}

export interface DailyTrendsServiceOptions {
  clock: Clock;
  hooks?: DailyTrendsTestHooks;
  pool: Pick<Pool, 'connect'>;
}

interface CheckInRow {
  local_date: string;
  sleep_minutes: number | null;
  /** numeric(5,2) as text: exact. */
  weight_kg: string | null;
}

interface StepsRow {
  local_date: string;
  steps: number;
}

interface FoodEnergyRow {
  entries_with_energy: number;
  local_date: string;
  logged_entries: number;
  /** numeric sum as text, or null when no entry of the date records energy. */
  recorded_kcal: string | null;
}

export interface DailyTrendsSourceRows {
  checkIns: CheckInRow[];
  foodEnergy: FoodEnergyRow[];
  steps: StepsRow[];
}

// $1 organization, $2 owner, $3 first date, $4 last date (both inclusive). Only the two values the trends show; a check-in
// with neither (mood or a note only) has no value for them and is not selected. The note is never selected. The
// owner/date unique key serves the range.
export const dailyTrendsCheckInsSql = `/* daily-trends:check-ins */
SELECT to_char(metric.local_date, 'YYYY-MM-DD') AS local_date,
       metric.weight_kg::text AS weight_kg,
       metric.sleep_minutes
  FROM daily_metrics AS metric
 WHERE metric.org_id = $1
   AND metric.user_id = $2
   AND metric.local_date BETWEEN $3::date AND $4::date
   AND (metric.weight_kg IS NOT NULL OR metric.sleep_minutes IS NOT NULL)
 ORDER BY metric.local_date`;

// $1 organization, $2 owner, $3 first date, $4 last date. The manual row only (a later importer's rows must never be added
// to it), and only dates with a step count (a recorded 0 included). Active energy is not part of the trends.
export const dailyTrendsStepsSql = `/* daily-trends:steps */
SELECT to_char(movement.local_date, 'YYYY-MM-DD') AS local_date,
       movement.steps
  FROM daily_movement AS movement
 WHERE movement.org_id = $1
   AND movement.user_id = $2
   AND movement.source = 'manual'
   AND movement.local_date BETWEEN $3::date AND $4::date
   AND movement.steps IS NOT NULL
 ORDER BY movement.local_date`;

// $1 organization, $2 owner, $3 first date, $4 last date. Manual entries only, grouped by their stored date: the number
// logged, the number with energy (count(col) counts a recorded 0 too) and the sum over exactly those in numeric
// arithmetic (no floating point, no rounding; NULL when none records energy). No title, type, macronutrient or single
// value is selected. The owner/date index serves the range.
export const dailyTrendsFoodEnergySql = `/* daily-trends:food-energy */
SELECT to_char(meal.local_date, 'YYYY-MM-DD') AS local_date,
       count(*)::integer AS logged_entries,
       count(meal.energy_kcal)::integer AS entries_with_energy,
       sum(meal.energy_kcal)::text AS recorded_kcal
  FROM meals AS meal
 WHERE meal.org_id = $1
   AND meal.user_id = $2
   AND meal.source = 'manual'
   AND meal.local_date BETWEEN $3::date AND $4::date
 GROUP BY meal.local_date
 ORDER BY meal.local_date`;

/** A numeric's text as a number. Weight has at most two decimals and an energy sum at most one, so it is exact. */
function exactNumber(text: string, what: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`PostgreSQL returned a ${what} that is not a finite number`);
  return value;
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

/** Every date of the range with the values its records hold; a date without a value is null, never zero. */
export function trendDaysOf(dates: readonly string[], rows: DailyTrendsSourceRows): DailyTrendDay[] {
  const checkIns = new Map(rows.checkIns.map((row) => [row.local_date, row]));
  const steps = new Map(rows.steps.map((row) => [row.local_date, row.steps]));
  const food = new Map(rows.foodEnergy.map((row) => [row.local_date, row]));
  const known = new Set(dates);
  for (const row of [...rows.checkIns, ...rows.steps, ...rows.foodEnergy]) {
    if (!known.has(row.local_date)) throw new Error(`A trends statement returned a date outside the range: ${row.local_date}`);
  }
  return dates.map((localDate) => {
    const checkIn = checkIns.get(localDate);
    const meals = food.get(localDate);
    return {
      foodEnergy:
        meals === undefined
          ? { entriesWithEnergy: 0, loggedEntries: 0, recordedKcal: null }
          : {
              entriesWithEnergy: meals.entries_with_energy,
              loggedEntries: meals.logged_entries,
              recordedKcal: meals.recorded_kcal === null ? null : exactNumber(meals.recorded_kcal, 'food energy sum'),
            },
      localDate,
      sleepMinutes: checkIn?.sleep_minutes ?? null,
      steps: steps.get(localDate) ?? null,
      weightKg: checkIn?.weight_kg === null || checkIn?.weight_kg === undefined ? null : exactNumber(checkIn.weight_kg, 'weight'),
    };
  });
}

export function buildDailyTrends(input: {
  computedAt: string;
  endDate: string;
  rows: DailyTrendsSourceRows;
  timeZone: string;
  today: string;
}): DailyTrends {
  const range = dailyTrendsRangeOf(input.endDate);
  const days = trendDaysOf(dailyTrendsDatesOf(range), input.rows);
  return dailyTrendsSchema.parse({
    days,
    provenance: {
      computedAt: input.computedAt,
      persisted: false,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
      trendsVersion: DAILY_TRENDS_VERSION,
    },
    range: {
      days: range.days,
      endDate: range.endDate,
      includesToday: range.endDate === input.today,
      requestedDays: DAILY_TRENDS_RANGE_DAYS,
      shortenedByLowerBound: range.shortenedByLowerBound,
      startDate: range.startDate,
      timeZone: input.timeZone,
      today: input.today,
    },
    summary: summarizeDailyTrendDays(days),
  });
}

export class DailyTrendsService {
  readonly #clock: Clock;
  readonly #hooks: DailyTrendsTestHooks | undefined;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor(options: DailyTrendsServiceOptions) {
    this.#clock = options.clock;
    this.#hooks = options.hooks;
    this.#pool = options.pool;
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, query: DailyTrendsQuery): Promise<DailyTrends> {
    const timeZone = canonicalTimeZone(query.timeZone);
    const now = this.#clock.utcNow();
    const today = assertEndNotAfterToday(query.endDate, timeZone, now.getTime());
    const range = dailyTrendsRangeOf(query.endDate);
    const parameters = [orgId, session.userId, range.startDate, range.endDate];
    const rows = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        const checkIns = (await client.query<CheckInRow>(dailyTrendsCheckInsSql, parameters)).rows;
        await this.#hooks?.afterCheckInsRead?.();
        const steps = (await client.query<StepsRow>(dailyTrendsStepsSql, parameters)).rows;
        const foodEnergy = (await client.query<FoodEnergyRow>(dailyTrendsFoodEnergySql, parameters)).rows;
        return { checkIns, foodEnergy, steps };
      },
      { snapshot: 'read-only snapshot' },
    );
    return buildDailyTrends({ computedAt: now.toISOString(), endDate: query.endDate, rows, timeZone, today });
  }
}
