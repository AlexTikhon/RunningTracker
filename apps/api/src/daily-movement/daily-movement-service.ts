import {
  DAILY_MOVEMENT_NOT_FOUND,
  dailyMovementListResponseSchema,
  dailyMovementViewSchema,
  type DailyMovementListQuery,
  type DailyMovementListResponse,
  type DailyMovementView,
  type PutDailyMovementRequest,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { assertNotAfterToday, canonicalTimeZone, transportTimestamp } from '../daily-metrics/daily-metrics-service.js';
import { ApiError } from '../http/errors.js';

// Manual daily movement (ADR-0078). Every statement runs inside withAuthenticatedTenantTransaction, so the membership
// was rechecked, row-level security (owner-only) is in force and the transaction's statement and lock timeouts apply.
// The owner and the manual source are still stated in each statement: ownership must not rest on the policy alone, and
// this route reads and writes the manual row only, whatever other source a later importer adds for the same day.

interface DailyMovementRow {
  active_energy_kcal: string | null;
  created_at: string;
  local_date: string;
  source: string;
  steps: number | null;
  time_zone: string;
  updated_at: string;
}

export interface PutDailyMovementResult {
  created: boolean;
  view: DailyMovementView;
}

const utcMicroseconds = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const projection = `to_char(movement.local_date, 'YYYY-MM-DD') AS local_date,
         movement.source,
         movement.time_zone,
         movement.steps,
         movement.active_energy_kcal::text AS active_energy_kcal,
         ${utcMicroseconds('movement.created_at')} AS created_at,
         ${utcMicroseconds('movement.updated_at')} AS updated_at`;

// $1 organization, $2 owner, $3 date, $4 zone, $5 steps, $6 active energy. The source is not a parameter: the column
// default ('manual') is the only value the runtime role can produce. The zone is written only by the insert; a
// replacement keeps the zone of the first write. A replacement with the values already stored updates nothing, so an
// exact retry leaves `updated_at` as it was and returns no row (the caller then reads the day). `xmax = 0` marks a row
// version this statement inserted. Two first writes racing for one day meet on the unique key: the later one waits,
// then updates the row the earlier one inserted (one row, last writer wins).
export const upsertDailyMovementSql = `INSERT INTO daily_movement AS movement (
         org_id, user_id, local_date, time_zone, steps, active_energy_kcal
       )
       VALUES ($1, $2, $3::date, $4, $5::integer, $6::numeric)
       ON CONFLICT (org_id, user_id, local_date, source) DO UPDATE
       SET steps = EXCLUDED.steps,
           active_energy_kcal = EXCLUDED.active_energy_kcal
       WHERE (movement.steps, movement.active_energy_kcal) IS DISTINCT FROM (EXCLUDED.steps, EXCLUDED.active_energy_kcal)
       RETURNING ${projection}, (movement.xmax = 0) AS inserted`;

// $1 organization, $2 owner, $3 date.
export const dailyMovementByDateSql = `SELECT ${projection}
  FROM daily_movement AS movement
  WHERE movement.org_id = $1 AND movement.user_id = $2 AND movement.local_date = $3::date AND movement.source = 'manual'`;

// $1 organization, $2 owner, $3/$4 inclusive dates. The owner/date/source unique index serves the range.
export const dailyMovementRangeSql = `SELECT ${projection}
  FROM daily_movement AS movement
  WHERE movement.org_id = $1
    AND movement.user_id = $2
    AND movement.local_date BETWEEN $3::date AND $4::date
    AND movement.source = 'manual'
  ORDER BY movement.local_date`;

function mapDailyMovement(row: DailyMovementRow): DailyMovementView {
  return dailyMovementViewSchema.parse({
    // numeric(6,1) as text, e.g. "412.5" or "0.0"; the number it denotes has at most one decimal.
    activeEnergyKcal: row.active_energy_kcal === null ? null : Number(row.active_energy_kcal),
    createdAt: transportTimestamp(row.created_at),
    localDate: row.local_date,
    source: row.source,
    steps: row.steps,
    timeZone: row.time_zone,
    updatedAt: transportTimestamp(row.updated_at),
  });
}

const notFound = () => new ApiError(404, DAILY_MOVEMENT_NOT_FOUND, 'No movement is recorded for this date');

export async function putDailyMovement(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  localDate: string,
  request: PutDailyMovementRequest,
  clock: Pick<Clock, 'utcNow'>,
): Promise<PutDailyMovementResult> {
  const timeZone = canonicalTimeZone(request.timeZone);
  assertNotAfterToday(localDate, timeZone, clock);

  const written = await client.query<DailyMovementRow & { inserted: boolean }>(upsertDailyMovementSql, [
    orgId,
    session.userId,
    localDate,
    timeZone,
    request.steps ?? null,
    request.activeEnergyKcal === undefined || request.activeEnergyKcal === null ? null : String(request.activeEnergyKcal),
  ]);
  const row = written.rows[0];
  if (row) return { created: row.inserted, view: mapDailyMovement(row) };

  // Nothing changed: the day already holds exactly these values.
  const unchanged = await client.query<DailyMovementRow>(dailyMovementByDateSql, [orgId, session.userId, localDate]);
  const stored = unchanged.rows[0];
  if (!stored) throw new Error('The unchanged daily movement row is not readable');
  return { created: false, view: mapDailyMovement(stored) };
}

export async function readDailyMovement(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  localDate: string,
): Promise<DailyMovementView> {
  const result = await client.query<DailyMovementRow>(dailyMovementByDateSql, [orgId, session.userId, localDate]);
  const row = result.rows[0];
  if (!row) throw notFound();
  return mapDailyMovement(row);
}

export async function listDailyMovement(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  query: DailyMovementListQuery,
): Promise<DailyMovementListResponse> {
  const result = await client.query<DailyMovementRow>(dailyMovementRangeSql, [orgId, session.userId, query.from, query.to]);
  return dailyMovementListResponseSchema.parse({ items: result.rows.map(mapDailyMovement) });
}

/**
 * A hard delete of the person's own manual day. "Deleted now", "already deleted", "never written" and "someone
 * else's" are answered alike by the route (204). The AFTER DELETE trigger records the erasure in the erasure ledger in
 * this statement (ADR-0073); if it cannot, the statement fails and nothing is deleted.
 */
export async function deleteDailyMovement(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  localDate: string,
): Promise<void> {
  await client.query(
    `DELETE FROM daily_movement WHERE org_id = $1 AND user_id = $2 AND local_date = $3::date AND source = 'manual'`,
    [orgId, session.userId, localDate],
  );
}
