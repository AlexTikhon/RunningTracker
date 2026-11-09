import { createHash } from 'node:crypto';

import {
  MEAL_ALREADY_SAVED,
  MEAL_NOT_FOUND,
  MEAL_PAGE_DEFAULT,
  mealListResponseSchema,
  mealViewSchema,
  type CreateMealRequest,
  type MealListQuery,
  type MealListResponse,
  type MealView,
  type UpdateMealRequest,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { assertNotAfterToday, canonicalTimeZone, transportTimestamp } from '../daily-metrics/daily-metrics-service.js';
import { ApiError } from '../http/errors.js';
import { decodeMealCursor, encodeMealCursor, mealListContext } from './meal-cursor.js';

// The manual meal log (ADR-0083). Every statement runs inside withAuthenticatedTenantTransaction, so the membership was
// rechecked, row-level security (owner-only) is in force and the transaction's statement and lock timeouts apply. The
// owner is still stated in each statement: ownership must not rest on the policy alone. The id, the source and both
// instants are the database's; nothing here names them on a write.

interface MealRow {
  carbohydrate_g: string | null;
  created_at: string;
  energy_kcal: string | null;
  fat_g: string | null;
  local_date: string;
  meal_id: string;
  meal_type: string;
  protein_g: string | null;
  source: string;
  time_zone: string;
  title: string;
  updated_at: string;
}

export interface CreateMealResult {
  created: boolean;
  view: MealView;
}

const utcMicroseconds = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const projection = `meal.id AS meal_id,
         to_char(meal.local_date, 'YYYY-MM-DD') AS local_date,
         meal.time_zone,
         meal.meal_type,
         meal.title,
         meal.energy_kcal::text AS energy_kcal,
         meal.protein_g::text AS protein_g,
         meal.carbohydrate_g::text AS carbohydrate_g,
         meal.fat_g::text AS fat_g,
         meal.source,
         ${utcMicroseconds('meal.created_at')} AS created_at,
         ${utcMicroseconds('meal.updated_at')} AS updated_at`;

// $1 organization, $2 owner, $3 date, $4 zone, $5 type, $6 title, $7..$10 values, $11 key, $12 creation digest. The key
// is unique per owner and organization: a second insert of the same form session (a retry, or a racing duplicate that
// waits for the first to commit) inserts nothing and returns no row, and the caller reads the entry by key.
export const insertMealSql = `INSERT INTO meals AS meal (
         org_id, user_id, local_date, time_zone, meal_type, title,
         energy_kcal, protein_g, carbohydrate_g, fat_g, idempotency_key, creation_digest
       )
       VALUES ($1, $2, $3::date, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::uuid, $12::bytea)
       ON CONFLICT (org_id, user_id, idempotency_key) DO NOTHING
       RETURNING ${projection}`;

// $1 organization, $2 owner, $3 key, $4 creation digest. At most one row (the unique key).
export const mealByKeySql = `SELECT ${projection}, (meal.creation_digest = $4::bytea) AS payload_matches
  FROM meals AS meal
  WHERE meal.org_id = $1 AND meal.user_id = $2 AND meal.idempotency_key = $3::uuid`;

// $1 organization, $2 owner, $3 entry.
export const mealByIdSql = `SELECT ${projection}
  FROM meals AS meal
  WHERE meal.org_id = $1 AND meal.user_id = $2 AND meal.id = $3::uuid`;

// $1 organization, $2 owner, $3 entry, $4 type, $5 title, $6..$9 values. A replacement with the values already stored
// updates nothing, so an exact retry leaves `updated_at` as it was and returns no row (the caller then reads the entry).
// numeric equality decides "the same value": 12.5 and 12.50 are one value.
export const updateMealSql = `UPDATE meals AS meal
       SET meal_type = $4,
           title = $5,
           energy_kcal = $6::numeric,
           protein_g = $7::numeric,
           carbohydrate_g = $8::numeric,
           fat_g = $9::numeric
       WHERE meal.org_id = $1 AND meal.user_id = $2 AND meal.id = $3::uuid
         AND (meal.meal_type, meal.title, meal.energy_kcal, meal.protein_g, meal.carbohydrate_g, meal.fat_g)
             IS DISTINCT FROM ($4::text, $5::text, $6::numeric, $7::numeric, $8::numeric, $9::numeric)
       RETURNING ${projection}`;

// $1 organization, $2 owner, $3 date, $4/$5 keyset position or NULL, $6 fetch size. The order is total: the instant the
// entry was logged, then its id. The owner/date/instant index serves it.
export const mealPageSql = `SELECT ${projection}
  FROM meals AS meal
  WHERE meal.org_id = $1
    AND meal.user_id = $2
    AND meal.local_date = $3::date
    AND ($4::timestamptz IS NULL OR (meal.created_at, meal.id) > ($4::timestamptz, $5::uuid))
  ORDER BY meal.created_at, meal.id
  LIMIT $6`;

/**
 * The SHA-256 of the canonical creation request: what a retry with the same idempotency key must repeat. The contract
 * has already turned -0 into 0, and JSON numbers parse to one value whatever their spelling (12.50 is 12.5), so equal
 * requests have equal digests. The zone is canonical (a different spelling of one zone is the same request).
 */
export function mealCreationDigest(request: CreateMealRequest, timeZone: string): Buffer {
  const canonical = JSON.stringify([
    'meal-create',
    1,
    request.localDate,
    timeZone,
    request.mealType,
    request.title,
    request.energyKcal ?? null,
    request.proteinG ?? null,
    request.carbohydrateG ?? null,
    request.fatG ?? null,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest();
}

const numericParameter = (value: number | null | undefined): string | null =>
  value === undefined || value === null ? null : String(value);

// numeric as text, e.g. "412.5", "0.0" or "250"; the database refuses a meaningful second decimal (migration 0039), so
// the number it denotes has at most one decimal and parses exactly.
const numericValue = (value: string | null): number | null => (value === null ? null : Number(value));

function mapMeal(row: MealRow): MealView {
  return mealViewSchema.parse({
    carbohydrateG: numericValue(row.carbohydrate_g),
    createdAt: transportTimestamp(row.created_at),
    energyKcal: numericValue(row.energy_kcal),
    fatG: numericValue(row.fat_g),
    localDate: row.local_date,
    mealId: row.meal_id,
    mealType: row.meal_type,
    proteinG: numericValue(row.protein_g),
    source: row.source,
    timeZone: row.time_zone,
    title: row.title,
    updatedAt: transportTimestamp(row.updated_at),
  });
}

const notFound = () => new ApiError(404, MEAL_NOT_FOUND, 'The meal entry does not exist or is not accessible');
const alreadySaved = (mealId: string) =>
  new ApiError(
    409,
    MEAL_ALREADY_SAVED,
    'A meal entry was already saved from this form with different details; these details were not saved',
    { mealId },
  );

/**
 * Creates an entry, idempotently per form session: the first request with a key creates it (201); the same key with the
 * same request returns it (200, also after the entry was edited); the same key with another request is
 * 409 MEAL_ALREADY_SAVED naming it, and nothing is stored.
 */
export async function createMeal(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  request: CreateMealRequest,
  clock: Pick<Clock, 'utcNow'>,
): Promise<CreateMealResult> {
  const timeZone = canonicalTimeZone(request.timeZone);
  assertNotAfterToday(request.localDate, timeZone, clock);
  const key = request.idempotencyKey.toLowerCase();
  const digest = mealCreationDigest(request, timeZone);

  const inserted = await client.query<MealRow>(insertMealSql, [
    orgId,
    session.userId,
    request.localDate,
    timeZone,
    request.mealType,
    request.title,
    numericParameter(request.energyKcal),
    numericParameter(request.proteinG),
    numericParameter(request.carbohydrateG),
    numericParameter(request.fatG),
    key,
    digest,
  ]);
  const row = inserted.rows[0];
  if (row) return { created: true, view: mapMeal(row) };

  // The form session already created an entry (the insert met the unique key, after waiting for a racing insert to
  // commit). The same request is that entry; another request is the earlier save having gone through.
  const keyed = (await client.query<MealRow & { payload_matches: boolean }>(mealByKeySql, [orgId, session.userId, key, digest])).rows[0];
  if (!keyed) throw new Error('The meal entry that holds this idempotency key is not readable');
  if (!keyed.payload_matches) throw alreadySaved(keyed.meal_id);
  return { created: false, view: mapMeal(keyed) };
}

export async function readMeal(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  mealId: string,
): Promise<MealView> {
  const row = (await client.query<MealRow>(mealByIdSql, [orgId, session.userId, mealId])).rows[0];
  if (!row) throw notFound();
  return mapMeal(row);
}

/** Replaces the editable fields. An exact retry changes nothing, not even `updatedAt`. */
export async function updateMeal(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  mealId: string,
  request: UpdateMealRequest,
): Promise<MealView> {
  const updated = await client.query<MealRow>(updateMealSql, [
    orgId,
    session.userId,
    mealId,
    request.mealType,
    request.title,
    numericParameter(request.energyKcal),
    numericParameter(request.proteinG),
    numericParameter(request.carbohydrateG),
    numericParameter(request.fatG),
  ]);
  const row = updated.rows[0];
  if (row) return mapMeal(row);
  // Nothing changed (the entry already holds these values), or there is no such entry of this person's.
  return readMeal(client, session, orgId, mealId);
}

export async function listMeals(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  query: MealListQuery,
): Promise<MealListResponse> {
  const context = mealListContext({ localDate: query.localDate, orgId, userId: session.userId });
  const cursor = query.cursor === undefined ? undefined : decodeMealCursor(query.cursor, { context });
  const limit = query.limit ?? MEAL_PAGE_DEFAULT;
  const result = await client.query<MealRow>(mealPageSql, [
    orgId,
    session.userId,
    query.localDate,
    cursor?.createdAt ?? null,
    cursor?.mealId ?? null,
    limit + 1,
  ]);
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return mealListResponseSchema.parse({
    items: rows.map(mapMeal),
    nextCursor:
      result.rows.length > limit && last
        ? encodeMealCursor({ context, createdAt: last.created_at, mealId: last.meal_id })
        : null,
  });
}

/**
 * A hard delete of the person's own entry. "Deleted now", "already deleted", "never existed" and "someone else's" are
 * answered alike by the route (204). The AFTER DELETE trigger records the erasure (identifiers and version only) in the
 * erasure ledger in this statement (ADR-0073); if it cannot, the statement fails and nothing is deleted.
 */
export async function deleteMeal(
  client: PoolClient,
  session: Pick<StoredSession, 'userId'>,
  orgId: string,
  mealId: string,
): Promise<void> {
  await client.query('DELETE FROM meals WHERE org_id = $1 AND user_id = $2 AND id = $3::uuid', [orgId, session.userId, mealId]);
}
