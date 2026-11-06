import { describe, expect, it } from 'vitest';

import { ApiError } from '../http/errors.js';
import { activityListContext, decodeActivityCursor, encodeActivityCursor } from './activity-cursor.js';

const userId = '44444444-4444-4444-8444-444444444444';
const otherUserId = '66666666-6666-4666-8666-666666666666';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrgId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const activityId = 'ac000000-0000-4000-8000-000000000001';
const startedAt = '2026-10-05T06:00:00.123456Z';

const context = activityListContext({ orgId, userId });
const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

function invalidCursor(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
    return;
  }
  throw new Error('Expected the cursor to be refused');
}

describe('activity list cursor', () => {
  it('round-trips a position bound to the person and the organization', () => {
    const cursor = encodeActivityCursor({ activityId, context, startedAt });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeActivityCursor(cursor, { context })).toEqual({ activityId, context, startedAt, version: 1 });
  });

  it('derives a different context for another person or organization, and the same one for the same scope', () => {
    expect(activityListContext({ orgId, userId })).toBe(context);
    expect(activityListContext({ orgId, userId: otherUserId })).not.toBe(context);
    expect(activityListContext({ orgId: otherOrgId, userId })).not.toBe(context);
    expect(context).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('refuses a cursor issued to another person or in another organization', () => {
    const foreignPerson = encodeActivityCursor({ activityId, context: activityListContext({ orgId, userId: otherUserId }), startedAt });
    const foreignOrg = encodeActivityCursor({ activityId, context: activityListContext({ orgId: otherOrgId, userId }), startedAt });
    invalidCursor(() => decodeActivityCursor(foreignPerson, { context }));
    invalidCursor(() => decodeActivityCursor(foreignOrg, { context }));
  });

  it('refuses tampered, malformed and differently shaped cursors', () => {
    const valid = { activityId, context, startedAt, version: 1 };
    for (const cursor of [
      'not base64url!',
      '%%%',
      Buffer.from('not json', 'utf8').toString('base64url'),
      encode(null),
      encode([]),
      encode({ ...valid, version: 2 }),
      encode({ ...valid, extra: true }),
      encode({ ...valid, activityId: 'nope' }),
      encode({ ...valid, startedAt: '2026-10-05' }),
      encode({ ...valid, context: 'A'.repeat(43) }),
      encode({ activityId, context, version: 1 }),
    ]) {
      invalidCursor(() => decodeActivityCursor(cursor, { context }));
    }
  });

  it('lowercases the activity id it hands to SQL', () => {
    const upper = encode({ activityId: activityId.toUpperCase(), context, startedAt, version: 1 });
    expect(decodeActivityCursor(upper, { context }).activityId).toBe(activityId);
  });
});
