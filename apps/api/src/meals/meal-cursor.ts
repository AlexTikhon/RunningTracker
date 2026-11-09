import { createHash } from 'node:crypto';

import { mealCursorSchema, type MealCursor } from '@running-tracker/contracts';

import { ApiError } from '../http/errors.js';

const CURSOR_VERSION = 1;

/**
 * The person, the organization and the local date a page of meal entries belongs to, as a digest. A cursor carries it,
 * so a position cannot be replayed by another person, in another organization or for another date. It is not a secret
 * and not a signature (as for activities, ADR-0072): forging one only moves a person's own keyset position inside their
 * own rows of that date, which RLS and the SQL both restrict.
 */
export function mealListContext(input: { localDate: string; orgId: string; userId: string }): string {
  const canonical = JSON.stringify(['meals', CURSOR_VERSION, input.userId, input.orgId, input.localDate]);
  return createHash('sha256').update(canonical).digest('base64url');
}

export function encodeMealCursor(position: Omit<MealCursor, 'version'>): string {
  const cursor: MealCursor = { ...position, version: CURSOR_VERSION };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeMealCursor(cursor: string, expected: { context: string }): MealCursor {
  const invalid = () => new ApiError(400, 'INVALID_CURSOR', 'The meal list cursor is invalid');
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = mealCursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.context !== expected.context) throw invalid();
  return { ...parsed.data, mealId: parsed.data.mealId.toLowerCase() };
}
