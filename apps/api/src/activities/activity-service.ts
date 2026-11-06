import {
  ACTIVITY_PAGE_DEFAULT,
  activityListResponseSchema,
  activityViewSchema,
  type ActivityListQuery,
  type ActivityListResponse,
  type ActivityView,
  type CreateActivityRequest,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import { activityListContext, decodeActivityCursor, encodeActivityCursor } from './activity-cursor.js';

// Every statement runs inside withAuthenticatedTenantTransaction, so the membership was rechecked and row-level
// security (owner-only, ADR-0072) is in force. The owner is still stated in each statement: ownership must not rest on
// the policy alone.

interface ActivityRow {
  activity_id: string;
  created_at: string;
  distance_m: number | null;
  duration_s: number;
  notes: string | null;
  rpe: number | null;
  source: string;
  started_at: string;
  type: string;
}

interface OwnedActivityRow extends ActivityRow {
  payload_matches: boolean;
}

export interface CreateActivityResult {
  activity: ActivityView;
  created: boolean;
}

const utcMicroseconds = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const projection = `activity.id AS activity_id,
         activity.type,
         ${utcMicroseconds('activity.started_at')} AS started_at,
         activity.duration_s,
         activity.distance_m,
         activity.rpe,
         activity.notes,
         activity.source,
         ${utcMicroseconds('activity.created_at')} AS created_at`;

// $1 organization, $2 activity, $3 owner, then the canonical payload. PostgreSQL decides equality, so one instant
// written with different fraction digits is the same start, and NULL equals NULL for the optional fields.
export const ownedActivitySql = `SELECT ${projection},
         (
           activity.type = $4
           AND activity.started_at = $5::timestamptz
           AND activity.duration_s = $6
           AND activity.distance_m IS NOT DISTINCT FROM $7::double precision
           AND activity.rpe IS NOT DISTINCT FROM $8::smallint
           AND activity.notes IS NOT DISTINCT FROM $9::text
         ) AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.id = $2 AND activity.user_id = $3`;

export const insertActivitySql = `INSERT INTO activities (
         org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, source, created_at
       )
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::double precision, $8::smallint, $9::text, 'manual', $10::timestamptz)
       ON CONFLICT (org_id, id) DO NOTHING`;

// $1 organization, $2 owner, $3/$4 keyset position or NULL, $5 fetch size. The order is total: start, then id.
export const activityPageSql = `SELECT ${projection}
  FROM activities AS activity
  WHERE activity.org_id = $1
    AND activity.user_id = $2
    AND ($3::timestamptz IS NULL OR (activity.started_at, activity.id) < ($3::timestamptz, $4::uuid))
  ORDER BY activity.started_at DESC, activity.id DESC
  LIMIT $5`;

// Trailing zeros of the microsecond fraction are dropped, at least three digits stay, as for runs. The cursor keeps
// the full microsecond value, so the keyset comparison is exact.
function transportTimestamp(value: string): string {
  const matched = /^(.*\.)(\d{6})Z$/u.exec(value);
  if (!matched) {
    throw new Error('PostgreSQL returned an unexpected UTC timestamp representation');
  }
  return `${matched[1]}${matched[2]!.replace(/0+$/u, '').padEnd(3, '0')}Z`;
}

function mapActivity(row: ActivityRow): ActivityView {
  return activityViewSchema.parse({
    activityId: row.activity_id,
    createdAt: transportTimestamp(row.created_at),
    distanceM: row.distance_m,
    durationS: row.duration_s,
    notes: row.notes,
    rpe: row.rpe,
    source: row.source,
    startedAt: transportTimestamp(row.started_at),
    type: row.type,
  });
}

const notFound = () => new ApiError(404, 'ACTIVITY_NOT_FOUND', 'The activity does not exist or is not accessible');
const conflict = () =>
  new ApiError(409, 'ACTIVITY_CONFLICT', 'The activity ID is already bound to a different payload');

async function readOwned(
  client: PoolClient,
  parameters: unknown[],
): Promise<OwnedActivityRow | undefined> {
  const result = await client.query<OwnedActivityRow>(ownedActivitySql, parameters);
  return result.rows[0];
}

export async function createActivity(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  activityId: string,
  request: CreateActivityRequest,
  clock: Clock,
): Promise<CreateActivityResult> {
  const now = clock.utcNow();
  // The future bound depends on the clock, so it is not a CHECK (ADR-0072). Compared in SQL so that a start written
  // with microseconds is judged exactly, against the injected clock's instant rather than the database's now().
  const timing = await client.query<{ too_late: boolean }>(
    `SELECT $1::timestamptz > $2::timestamptz + interval '24 hours' AS too_late`,
    [request.startedAt, now.toISOString()],
  );
  if (timing.rows[0]?.too_late !== false) {
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      'The activity start cannot be more than 24 hours after server time',
    );
  }

  const payload = [
    request.type,
    request.startedAt,
    request.durationS,
    request.distanceM ?? null,
    request.rpe ?? null,
    request.notes ?? null,
  ];
  const ownedParameters = [orgId, activityId, session.userId, ...payload];

  const existing = await readOwned(client, ownedParameters);
  if (existing) {
    if (!existing.payload_matches) throw conflict();
    return { activity: mapActivity(existing), created: false };
  }

  // Another member's row with this id is invisible here: the insert does nothing and the read below finds no row of
  // this person's, which is answered like a missing activity (ADR-0072 explains why that is not an oracle).
  const inserted = await client.query(insertActivitySql, [
    orgId,
    activityId,
    session.userId,
    ...payload,
    now.toISOString(),
  ]);

  const stored = await readOwned(client, ownedParameters);
  if (!stored) throw notFound();
  if (!stored.payload_matches) throw conflict();
  return { activity: mapActivity(stored), created: inserted.rowCount === 1 };
}

export async function readActivity(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  activityId: string,
): Promise<ActivityView> {
  const result = await client.query<ActivityRow>(
    `SELECT ${projection}
     FROM activities AS activity
     WHERE activity.org_id = $1 AND activity.id = $2 AND activity.user_id = $3`,
    [orgId, activityId, session.userId],
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  return mapActivity(row);
}

export async function listActivities(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  query: ActivityListQuery,
): Promise<ActivityListResponse> {
  const context = activityListContext({ orgId, userId: session.userId });
  const cursor = query.cursor === undefined ? undefined : decodeActivityCursor(query.cursor, { context });
  const limit = query.limit ?? ACTIVITY_PAGE_DEFAULT;
  const result = await client.query<ActivityRow>(activityPageSql, [
    orgId,
    session.userId,
    cursor?.startedAt ?? null,
    cursor?.activityId ?? null,
    limit + 1,
  ]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return activityListResponseSchema.parse({
    items: rows.map(mapActivity),
    nextCursor:
      result.rows.length > limit && last
        ? encodeActivityCursor({ activityId: last.activity_id, context, startedAt: last.started_at })
        : null,
  });
}

/**
 * A hard delete of the person's own activity. There is no tombstone (ADR-0072), so "deleted now", "already deleted",
 * "never existed" and "someone else's" cannot be told apart and are all answered alike by the route (204). Another
 * member's row is untouched: both RLS and the owner predicate exclude it.
 */
export async function deleteActivity(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  activityId: string,
): Promise<void> {
  await client.query('DELETE FROM activities WHERE org_id = $1 AND id = $2 AND user_id = $3', [
    orgId,
    activityId,
    session.userId,
  ]);
}
