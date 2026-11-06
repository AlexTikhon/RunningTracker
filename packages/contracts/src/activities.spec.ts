import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_DISTANCE_MAX_M,
  ACTIVITY_DURATION_MAX_S,
  ACTIVITY_NOTES_MAX_LENGTH,
  ACTIVITY_PAGE_MAX,
  ACTIVITY_TYPES,
  activityCursorSchema,
  activityListQuerySchema,
  activityListResponseSchema,
  activityPathSchema,
  activityViewSchema,
  createActivityRequestSchema,
  openApiDocument,
} from './index.js';

const activityId = 'ad32e5d8-dd0d-4652-b26a-026033120c33';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const minimal = { durationS: 1_800, startedAt: '2026-10-05T06:00:00.000Z', type: 'ride' };
const view = {
  activityId,
  createdAt: '2026-10-05T08:00:00.000Z',
  distanceM: 20_000,
  durationS: 1_800,
  notes: 'Easy spin',
  rpe: 4,
  source: 'manual',
  startedAt: '2026-10-05T06:00:00.000Z',
  type: 'ride',
};

function accepts(body: unknown): boolean {
  return createActivityRequestSchema.safeParse(body).success;
}

describe('activity creation request', () => {
  it('accepts the minimal payload and leaves the optional fields absent', () => {
    expect(createActivityRequestSchema.parse(minimal)).toEqual(minimal);
  });

  it('accepts every optional field, and null for each of them', () => {
    expect(accepts({ ...minimal, distanceM: 20_000.5, notes: 'Easy spin', rpe: 4 })).toBe(true);
    expect(accepts({ ...minimal, distanceM: null, notes: null, rpe: null })).toBe(true);
  });

  it('accepts exactly the seven activity types', () => {
    expect(ACTIVITY_TYPES).toEqual(['run', 'walk', 'ride', 'hike', 'swim', 'strength', 'other']);
    for (const type of ACTIVITY_TYPES) {
      expect(accepts({ ...minimal, type })).toBe(true);
    }
    for (const type of ['Run', 'yoga', '', null, 1]) {
      expect(accepts({ ...minimal, type })).toBe(false);
    }
  });

  it('refuses unknown fields, including an owner, an organization or a source', () => {
    for (const extra of [{ userId: activityId }, { orgId }, { source: 'manual' }, { id: activityId }, { foo: 1 }]) {
      expect(accepts({ ...minimal, ...extra })).toBe(false);
    }
  });

  it('requires type, startedAt and durationS', () => {
    expect(accepts({ durationS: 60, startedAt: minimal.startedAt })).toBe(false);
    expect(accepts({ durationS: 60, type: 'run' })).toBe(false);
    expect(accepts({ startedAt: minimal.startedAt, type: 'run' })).toBe(false);
  });

  it('bounds the duration to whole seconds from 1 to 48 hours', () => {
    expect(ACTIVITY_DURATION_MAX_S).toBe(172_800);
    expect(accepts({ ...minimal, durationS: 1 })).toBe(true);
    expect(accepts({ ...minimal, durationS: 172_800 })).toBe(true);
    for (const durationS of [0, -1, 172_801, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '60', null]) {
      expect(accepts({ ...minimal, durationS })).toBe(false);
    }
  });

  it('bounds the distance to finite metres from 0 to 1000 km and stores -0 as 0', () => {
    expect(ACTIVITY_DISTANCE_MAX_M).toBe(1_000_000);
    expect(accepts({ ...minimal, distanceM: 0 })).toBe(true);
    expect(accepts({ ...minimal, distanceM: 1_000_000 })).toBe(true);
    expect(createActivityRequestSchema.parse({ ...minimal, distanceM: -0 }).distanceM).toBe(0);
    expect(Object.is(createActivityRequestSchema.parse({ ...minimal, distanceM: -0 }).distanceM, 0)).toBe(true);
    for (const distanceM of [-0.001, 1_000_000.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5']) {
      expect(accepts({ ...minimal, distanceM })).toBe(false);
    }
  });

  it('refuses a distance that JSON parsing turned into Infinity', () => {
    expect(accepts(JSON.parse('{"type":"run","startedAt":"2026-10-05T06:00:00.000Z","durationS":60,"distanceM":1e400}'))).toBe(false);
  });

  it('bounds RPE to whole numbers from 1 to 10', () => {
    for (const rpe of [1, 10]) expect(accepts({ ...minimal, rpe })).toBe(true);
    for (const rpe of [0, 11, 2.5, -1, Number.NaN, '5']) expect(accepts({ ...minimal, rpe })).toBe(false);
  });

  it('bounds notes to 1..1000 characters and refuses NUL and unpaired surrogates', () => {
    expect(ACTIVITY_NOTES_MAX_LENGTH).toBe(1_000);
    expect(accepts({ ...minimal, notes: 'x' })).toBe(true);
    expect(accepts({ ...minimal, notes: 'x'.repeat(1_000) })).toBe(true);
    expect(accepts({ ...minimal, notes: 'x'.repeat(1_001) })).toBe(false);
    expect(accepts({ ...minimal, notes: '' })).toBe(false);
    expect(accepts({ ...minimal, notes: 'a\u0000b' })).toBe(false);
    expect(accepts({ ...minimal, notes: 'a\ud800b' })).toBe(false);
    expect(accepts({ ...minimal, notes: 'paired 😀 emoji' })).toBe(true);
  });

  it('requires a UTC timestamp not before 2000-01-01', () => {
    expect(accepts({ ...minimal, startedAt: '2000-01-01T00:00:00.000Z' })).toBe(true);
    expect(accepts({ ...minimal, startedAt: '2000-01-01T00:00:00Z' })).toBe(true);
    expect(accepts({ ...minimal, startedAt: '2026-10-05T06:00:00.123456Z' })).toBe(true);
    for (const startedAt of [
      '1999-12-31T23:59:59.999Z',
      '1970-01-01T00:00:00.000Z',
      '2026-10-05T06:00:00+02:00',
      '2026-10-05',
      'yesterday',
      '',
    ]) {
      expect(accepts({ ...minimal, startedAt })).toBe(false);
    }
  });
});

describe('activity paths, list query, response and cursor', () => {
  it('requires UUIDs in the path and nothing else', () => {
    expect(activityPathSchema.safeParse({ activityId, orgId }).success).toBe(true);
    expect(activityPathSchema.safeParse({ activityId: 'nope', orgId }).success).toBe(false);
    expect(activityPathSchema.safeParse({ activityId, orgId, extra: '1' }).success).toBe(false);
  });

  it('accepts a limit of 1..50 and a cursor, and refuses any other parameter', () => {
    expect(ACTIVITY_PAGE_MAX).toBe(50);
    expect(activityListQuerySchema.parse({})).toEqual({});
    expect(activityListQuerySchema.parse({ cursor: 'abc', limit: '50' })).toEqual({ cursor: 'abc', limit: 50 });
    for (const query of [{ limit: '0' }, { limit: '51' }, { limit: '1.5' }, { limit: '-1' }, { cursor: '' }, { userId: activityId }, { type: 'run' }]) {
      expect(activityListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('describes a stored activity strictly, with every nullable field present', () => {
    expect(activityViewSchema.parse(view)).toEqual(view);
    expect(activityViewSchema.safeParse({ ...view, distanceM: null, notes: null, rpe: null }).success).toBe(true);
    expect(activityViewSchema.safeParse({ ...view, userId: activityId }).success).toBe(false);
    const withoutNotes: Partial<typeof view> = { ...view };
    delete withoutNotes.notes;
    expect(activityViewSchema.safeParse(withoutNotes).success).toBe(false);
    expect(activityViewSchema.safeParse({ ...view, source: 'gpx' }).success).toBe(false);
  });

  it('bounds a page to 50 items', () => {
    const items = Array.from({ length: 51 }, () => view);
    expect(activityListResponseSchema.safeParse({ items: items.slice(0, 50), nextCursor: null }).success).toBe(true);
    expect(activityListResponseSchema.safeParse({ items, nextCursor: null }).success).toBe(false);
  });

  it('documents the cursor content: version 1, a digest context, a position', () => {
    const cursor = { activityId, context: 'A'.repeat(43), startedAt: '2026-10-05T06:00:00.123456Z', version: 1 };
    expect(activityCursorSchema.safeParse(cursor).success).toBe(true);
    expect(activityCursorSchema.safeParse({ ...cursor, version: 2 }).success).toBe(false);
    expect(activityCursorSchema.safeParse({ ...cursor, context: 'short' }).success).toBe(false);
    expect(activityCursorSchema.safeParse({ ...cursor, userId: activityId }).success).toBe(false);
  });
});

describe('activity OpenAPI operations', () => {
  it('documents the list and the three item operations, with CSRF on mutations', () => {
    const list = openApiDocument.paths['/api/orgs/{orgId}/activities'];
    const item = openApiDocument.paths['/api/orgs/{orgId}/activities/{activityId}'];
    expect(Object.keys(list).sort()).toEqual(['get']);
    expect(Object.keys(item).sort()).toEqual(['delete', 'get', 'put']);
    for (const operation of [item.put, item.delete]) {
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/CsrfToken' });
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/Origin' });
    }
    expect(Object.keys(item.put.responses).sort()).toEqual(['200', '201', 'default']);
    expect(Object.keys(item.delete.responses).sort()).toEqual(['204', 'default']);
    expect(openApiDocument.components.schemas.CreateActivityRequest).toBeDefined();
    expect(openApiDocument.components.schemas.ActivityView).toBeDefined();
    expect(openApiDocument.components.schemas.ActivityListResponse).toBeDefined();
  });
});
