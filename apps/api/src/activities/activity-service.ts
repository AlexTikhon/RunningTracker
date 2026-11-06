import {
  ACTIVITY_ALREADY_SAVED,
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

// The activity's six details as parameters $first..$first+5. PostgreSQL decides equality, so one instant written with
// different fraction digits is the same start, and NULL equals NULL for the optional fields.
const detailsMatch = (first: number) => `activity.type = $${first}
           AND activity.started_at = $${first + 1}::timestamptz
           AND activity.duration_s = $${first + 2}
           AND activity.distance_m IS NOT DISTINCT FROM $${first + 3}::double precision
           AND activity.rpe IS NOT DISTINCT FROM $${first + 4}::smallint
           AND activity.notes IS NOT DISTINCT FROM $${first + 5}::text`;

// By id: $1 organization, $2 activity, $3 owner, $4..$9 details, $10 idempotency key. The key is part of what an id is
// bound to, so the same id under another form session is a conflict like any other changed field.
export const ownedActivitySql = `SELECT ${projection},
         (${detailsMatch(4)} AND activity.idempotency_key IS NOT DISTINCT FROM $10::uuid) AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.id = $2 AND activity.user_id = $3`;

// By form session (ADR-0073): $1 organization, $2 owner, $3 idempotency key, $4..$9 details. The unique constraint
// (org_id, user_id, idempotency_key) guarantees at most one row.
export const keyedActivitySql = `SELECT ${projection},
         (${detailsMatch(4)}) AS payload_matches
  FROM activities AS activity
  WHERE activity.org_id = $1 AND activity.user_id = $2 AND activity.idempotency_key = $3::uuid`;

// No conflict target: a clash on the id (another member's row, or a concurrent identical request) and a clash on the
// form session's key (a concurrent save under another id) both insert nothing, and the reads that follow decide.
export const insertActivitySql = `INSERT INTO activities (
         org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, idempotency_key, source, created_at
       )
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::double precision, $8::smallint, $9::text, $10::uuid, 'manual',
               $11::timestamptz)
       ON CONFLICT DO NOTHING`;

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
const alreadySaved = (activityId: string) =>
  new ApiError(
    409,
    ACTIVITY_ALREADY_SAVED,
    'An activity was already saved from this form with different details; these details were not saved',
    { activityId },
  );

async function readOne(
  client: PoolClient,
  sql: string,
  parameters: unknown[],
): Promise<OwnedActivityRow | undefined> {
  const result = await client.query<OwnedActivityRow>(sql, parameters);
  return result.rows[0];
}

// The form session already saved an activity: the same details are that activity (a retry under another id), other
// details are the earlier save having gone through, which the person must be told about.
function keyedOutcome(keyed: OwnedActivityRow): CreateActivityResult {
  if (!keyed.payload_matches) throw alreadySaved(keyed.activity_id);
  return { activity: mapActivity(keyed), created: false };
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

  const details = [
    request.type,
    request.startedAt,
    request.durationS,
    request.distanceM ?? null,
    request.rpe ?? null,
    request.notes ?? null,
  ];
  const key = request.idempotencyKey.toLowerCase();
  const parameters = [orgId, activityId, session.userId, ...details, key];
  const keyedParameters = [orgId, session.userId, key, ...details];

  // 1. The id decides first: an exact retry, or a conflict on an id this person already used.
  const existing = await readOne(client, ownedActivitySql, parameters);
  if (existing) {
    if (!existing.payload_matches) throw conflict();
    return { activity: mapActivity(existing), created: false };
  }
  // 2. The form session: has this key already created an activity under another id?
  const keyed = await readOne(client, keyedActivitySql, keyedParameters);
  if (keyed) return keyedOutcome(keyed);

  // 3. Insert. Another member's row with this id is invisible here: the insert does nothing and the reads below find no
  // row of this person's, which is answered like a missing activity (ADR-0072 explains why that is not an oracle). A
  // concurrent save of the same form session under another id also inserts nothing; its row is found by key.
  const inserted = await client.query(insertActivitySql, [...parameters, now.toISOString()]);

  const stored = await readOne(client, ownedActivitySql, parameters);
  if (stored) {
    if (!stored.payload_matches) throw conflict();
    return { activity: mapActivity(stored), created: inserted.rowCount === 1 };
  }
  const keyedAfterInsert = await readOne(client, keyedActivitySql, keyedParameters);
  if (keyedAfterInsert) return keyedOutcome(keyedAfterInsert);
  throw notFound();
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
