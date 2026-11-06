import {
  DAILY_METRICS_NOT_FOUND,
  dailyMetricsListResponseSchema,
  dailyMetricsViewSchema,
  type DailyMetricsListQuery,
  type DailyMetricsListResponse,
  type DailyMetricsView,
  type PutDailyMetricsRequest,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import { localDateOf } from '../runs/run-search-period.js';

// Every statement runs inside withAuthenticatedTenantTransaction, so the membership was rechecked and row-level
// security (owner-only, ADR-0074) is in force. The owner is still stated in each statement: ownership must not rest on
// the policy alone.

interface DailyMetricsRow {
  created_at: string;
  local_date: string;
  mood: number | null;
  note: string | null;
  sleep_minutes: number | null;
  sleep_quality: number | null;
  soreness: number | null;
  time_zone: string;
  updated_at: string;
  weight_kg: string | null;
}

export interface PutDailyMetricsResult {
  created: boolean;
  view: DailyMetricsView;
}

const utcMicroseconds = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const projection = `to_char(metric.local_date, 'YYYY-MM-DD') AS local_date,
         metric.time_zone,
         metric.weight_kg::text AS weight_kg,
         metric.sleep_minutes,
         metric.sleep_quality,
         metric.mood,
         metric.soreness,
         metric.note,
         ${utcMicroseconds('metric.created_at')} AS created_at,
         ${utcMicroseconds('metric.updated_at')} AS updated_at`;

// $1 organization, $2 owner, $3 date, $4 zone, $5..$10 values. The zone is written only by the insert: a replacement
// keeps the zone of the first write (the runtime role has no UPDATE privilege on it either). A replacement with the
// values already stored updates nothing, so an exact retry leaves `updated_at` as it was; it then returns no row and
// the caller reads the day. `xmax = 0` is PostgreSQL's mark of a row version this statement inserted. The id and both
// timestamps are database defaults (clock_timestamp()), never the application clock.
export const upsertDailyMetricsSql = `INSERT INTO daily_metrics AS metric (
         org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, sleep_quality, mood, soreness, note
       )
       VALUES ($1, $2, $3::date, $4, $5::numeric, $6::integer, $7::smallint, $8::smallint, $9::smallint, $10::text)
       ON CONFLICT (org_id, user_id, local_date) DO UPDATE
       SET weight_kg = EXCLUDED.weight_kg,
           sleep_minutes = EXCLUDED.sleep_minutes,
           sleep_quality = EXCLUDED.sleep_quality,
           mood = EXCLUDED.mood,
           soreness = EXCLUDED.soreness,
           note = EXCLUDED.note
       WHERE (metric.weight_kg, metric.sleep_minutes, metric.sleep_quality, metric.mood, metric.soreness, metric.note)
             IS DISTINCT FROM
             (EXCLUDED.weight_kg, EXCLUDED.sleep_minutes, EXCLUDED.sleep_quality, EXCLUDED.mood, EXCLUDED.soreness,
              EXCLUDED.note)
       RETURNING ${projection}, (metric.xmax = 0) AS inserted`;

// $1 organization, $2 owner, $3 date.
export const dailyMetricsByDateSql = `SELECT ${projection}
  FROM daily_metrics AS metric
  WHERE metric.org_id = $1 AND metric.user_id = $2 AND metric.local_date = $3::date`;

// $1 organization, $2 owner, $3/$4 inclusive dates. The owner/date unique index serves the range.
export const dailyMetricsRangeSql = `SELECT ${projection}
  FROM daily_metrics AS metric
  WHERE metric.org_id = $1
    AND metric.user_id = $2
    AND metric.local_date BETWEEN $3::date AND $4::date
  ORDER BY metric.local_date`;

// Trailing zeros of the microsecond fraction are dropped, at least three digits stay, as for activities and runs.
function transportTimestamp(value: string): string {
  const matched = /^(.*\.)(\d{6})Z$/u.exec(value);
  if (!matched) {
    throw new Error('PostgreSQL returned an unexpected UTC timestamp representation');
  }
  return `${matched[1]}${matched[2]!.replace(/0+$/u, '').padEnd(3, '0')}Z`;
}

function mapDailyMetrics(row: DailyMetricsRow): DailyMetricsView {
  return dailyMetricsViewSchema.parse({
    createdAt: transportTimestamp(row.created_at),
    localDate: row.local_date,
    mood: row.mood,
    note: row.note,
    sleepMinutes: row.sleep_minutes,
    sleepQuality: row.sleep_quality,
    soreness: row.soreness,
    timeZone: row.time_zone,
    updatedAt: transportTimestamp(row.updated_at),
    // numeric(5,2) as text, e.g. "72.30"; the number it denotes has at most two decimals.
    weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
  });
}

const notFound = () =>
  new ApiError(404, DAILY_METRICS_NOT_FOUND, 'No check-in is recorded for this date');

// `Intl` accepts any letter case; the stored zone is the platform's canonical spelling.
function canonicalTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
}

/**
 * The person's "today" is the calendar date of the injected clock's instant in the zone they say they are in. A date
 * after it is refused. The rule depends on a clock, so it is not a database CHECK (ADR-0074).
 */
export function assertNotAfterToday(localDate: string, timeZone: string, clock: Pick<Clock, 'utcNow'>): void {
  const today = localDateOf(clock.utcNow().getTime(), timeZone);
  if (localDate > today) {
    throw new ApiError(400, 'INVALID_REQUEST', `The date cannot be after today (${today} in ${timeZone})`, {
      fields: [{ message: `Must not be after ${today}`, path: ['localDate'] }],
    });
  }
}

export async function putDailyMetrics(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  localDate: string,
  request: PutDailyMetricsRequest,
  clock: Pick<Clock, 'utcNow'>,
): Promise<PutDailyMetricsResult> {
  const timeZone = canonicalTimeZone(request.timeZone);
  assertNotAfterToday(localDate, timeZone, clock);

  const written = await client.query<DailyMetricsRow & { inserted: boolean }>(upsertDailyMetricsSql, [
    orgId,
    session.userId,
    localDate,
    timeZone,
    request.weightKg === undefined || request.weightKg === null ? null : String(request.weightKg),
    request.sleepMinutes ?? null,
    request.sleepQuality ?? null,
    request.mood ?? null,
    request.soreness ?? null,
    request.note ?? null,
  ]);
  const row = written.rows[0];
  if (row) return { created: row.inserted, view: mapDailyMetrics(row) };

  // Nothing changed: the day already holds exactly these values.
  const unchanged = await client.query<DailyMetricsRow>(dailyMetricsByDateSql, [orgId, session.userId, localDate]);
  const stored = unchanged.rows[0];
  if (!stored) throw new Error('The unchanged daily metrics row is not readable');
  return { created: false, view: mapDailyMetrics(stored) };
}

export async function readDailyMetrics(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  localDate: string,
): Promise<DailyMetricsView> {
  const result = await client.query<DailyMetricsRow>(dailyMetricsByDateSql, [orgId, session.userId, localDate]);
  const row = result.rows[0];
  if (!row) throw notFound();
  return mapDailyMetrics(row);
}

export async function listDailyMetrics(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  query: DailyMetricsListQuery,
): Promise<DailyMetricsListResponse> {
  const result = await client.query<DailyMetricsRow>(dailyMetricsRangeSql, [orgId, session.userId, query.from, query.to]);
  return dailyMetricsListResponseSchema.parse({ items: result.rows.map(mapDailyMetrics) });
}

/**
 * A hard delete of the person's own day. "Deleted now", "already deleted", "never written" and "someone else's" are
 * answered alike by the route (204). The AFTER DELETE trigger records the erasure in the erasure ledger in this
 * statement (ADR-0073); if it cannot, the statement fails and nothing is deleted.
 */
export async function deleteDailyMetrics(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  localDate: string,
): Promise<void> {
  await client.query('DELETE FROM daily_metrics WHERE org_id = $1 AND user_id = $2 AND local_date = $3::date', [
    orgId,
    session.userId,
    localDate,
  ]);
}
