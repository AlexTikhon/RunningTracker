import { createHash } from 'node:crypto';

import {
  activityHistoryCursorSchema,
  type ActivityHistoryCursor,
  type ActivityHistorySource,
  type ActivityType,
} from '@running-tracker/contracts';

import { ApiError } from '../http/errors.js';

const CURSOR_VERSION = 1;

export interface ActivityHistoryScope {
  /** The day filter (ADR-0088): the date and the zone in its canonical spelling, or null for the whole history. */
  day: { localDate: string; timeZone: string } | null;
  orgId: string;
  source: ActivityHistorySource | null;
  type: ActivityType | null;
  userId: string;
}

/**
 * The person, the organization, both filters and the day filter a page of the history belongs to, as a digest
 * (ADR-0087, ADR-0088). A cursor carries it, so a position cannot be replayed by another person, in another organization,
 * under other filters, on another date or in another zone: the keyset position only means something inside the result
 * it was taken from. It is not a secret and not a signature, for the reason of ADR-0056 and ADR-0072: forging one only
 * moves a position inside the person's own rows, which RLS and the explicit owner predicates restrict.
 *
 * Compatibility: without a day filter the digest is exactly the one of ADR-0087, so a cursor issued before the day
 * filter existed keeps working for the whole history. With one, the date and zone are appended as one more element, so
 * the digest differs from every whole-history digest and from every other date or zone: an older cursor sent with a day
 * filter, or a day cursor sent without one, is refused as INVALID_CURSOR. The cursor's own `version` stays 1.
 */
export function activityHistoryContext(scope: ActivityHistoryScope): string {
  const parts: unknown[] = ['activity-history', CURSOR_VERSION, scope.userId, scope.orgId, scope.source ?? '*', scope.type ?? '*'];
  if (scope.day !== null) {
    parts.push({ localDate: scope.day.localDate, timeZone: scope.day.timeZone });
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

export function encodeActivityHistoryCursor(position: Omit<ActivityHistoryCursor, 'version'>): string {
  const cursor: ActivityHistoryCursor = { ...position, version: CURSOR_VERSION };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeActivityHistoryCursor(cursor: string, expected: { context: string }): ActivityHistoryCursor {
  const invalid = () => new ApiError(400, 'INVALID_CURSOR', 'The activity history cursor is invalid');
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  // The schema checks the start is a real calendar instant PostgreSQL accepts (not Date.parse, which rolls February 30
  // over to March 2), so an impossible position is refused here, before any database connection is taken.
  const parsed = activityHistoryCursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.context !== expected.context) {
    throw invalid();
  }
  return { ...parsed.data, id: parsed.data.id.toLowerCase() };
}
