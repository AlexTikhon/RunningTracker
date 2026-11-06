import { createHash } from 'node:crypto';

import { activityCursorSchema, type ActivityCursor } from '@running-tracker/contracts';

import { ApiError } from '../http/errors.js';

const CURSOR_VERSION = 1;

/**
 * The person and the organization a page of activities belongs to, as a digest. A cursor carries it, so a position
 * cannot be replayed by another person or in another organization. It is not a secret and not a signature (ADR-0072):
 * forging one only moves a person's own keyset position inside their own rows, which RLS and the SQL both restrict.
 */
export function activityListContext(input: { orgId: string; userId: string }): string {
  const canonical = JSON.stringify(['activities', CURSOR_VERSION, input.userId, input.orgId]);
  return createHash('sha256').update(canonical).digest('base64url');
}

export function encodeActivityCursor(position: Omit<ActivityCursor, 'version'>): string {
  const cursor: ActivityCursor = { ...position, version: CURSOR_VERSION };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeActivityCursor(cursor: string, expected: { context: string }): ActivityCursor {
  const invalid = () => new ApiError(400, 'INVALID_CURSOR', 'The activity list cursor is invalid');
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = activityCursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.context !== expected.context) {
    throw invalid();
  }
  return { ...parsed.data, activityId: parsed.data.activityId.toLowerCase() };
}
