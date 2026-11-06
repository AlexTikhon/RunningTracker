import { describe, expect, it } from 'vitest';

import {
  DAILY_METRICS_NOT_FOUND,
  DAILY_METRICS_RANGE_MAX_DAYS,
  addLocalDays,
  dailyMetricsListQuerySchema,
  dailyMetricsListResponseSchema,
  dailyMetricsPathSchema,
  dailyMetricsViewSchema,
  localDateSpanDays,
  openApiDocument,
  putDailyMetricsRequestSchema,
} from './index.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const full = {
  mood: 4,
  note: 'Slept well',
  sleepMinutes: 450,
  sleepQuality: 4,
  soreness: 2,
  timeZone: 'Europe/Warsaw',
  weightKg: 72.35,
};
const view = {
  createdAt: '2026-10-05T08:00:00.123Z',
  localDate: '2026-10-05',
  mood: 4,
  note: 'Slept well',
  sleepMinutes: 450,
  sleepQuality: 4,
  soreness: 2,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-10-05T08:00:00.123Z',
  weightKg: 72.35,
};

const accepts = (body: unknown) => putDailyMetricsRequestSchema.safeParse(body).success;

describe('daily metrics replacement request', () => {
  it('accepts every value, or any single one, with the zone', () => {
    expect(putDailyMetricsRequestSchema.parse(full)).toEqual(full);
    for (const field of ['mood', 'note', 'sleepMinutes', 'sleepQuality', 'soreness', 'weightKg'] as const) {
      expect(accepts({ timeZone: 'UTC', [field]: full[field] })).toBe(true);
    }
  });

  it('requires at least one non-null value: omitted and null are both "no value"', () => {
    expect(accepts({ timeZone: 'UTC' })).toBe(false);
    expect(
      accepts({ mood: null, note: null, sleepMinutes: null, sleepQuality: null, soreness: null, timeZone: 'UTC', weightKg: null }),
    ).toBe(false);
    expect(accepts({ mood: null, soreness: 0, timeZone: 'UTC' })).toBe(true);
    expect(accepts({ sleepMinutes: 0, timeZone: 'UTC' })).toBe(true);
  });

  it('bounds each value inclusively', () => {
    const one = (field: string, value: unknown) => accepts({ timeZone: 'UTC', [field]: value });
    for (const [field, low, high] of [
      ['weightKg', 20, 400],
      ['sleepMinutes', 0, 1_440],
      ['sleepQuality', 1, 5],
      ['mood', 1, 5],
      ['soreness', 0, 10],
    ] as const) {
      expect(one(field, low)).toBe(true);
      expect(one(field, high)).toBe(true);
      expect(one(field, low - 1)).toBe(false);
      expect(one(field, high + 1)).toBe(false);
    }
    expect(one('weightKg', 19.99)).toBe(false);
    expect(one('weightKg', 400.01)).toBe(false);
  });

  it('takes weight with at most two decimals and the scales as integers', () => {
    expect(accepts({ timeZone: 'UTC', weightKg: 72.3 })).toBe(true);
    expect(accepts({ timeZone: 'UTC', weightKg: 72.355 })).toBe(false);
    expect(accepts({ timeZone: 'UTC', weightKg: '72.3' })).toBe(false);
    for (const field of ['sleepMinutes', 'sleepQuality', 'mood', 'soreness']) {
      expect(accepts({ timeZone: 'UTC', [field]: 2.5 })).toBe(false);
    }
  });

  it('bounds the note to 500 characters of well-formed text', () => {
    expect(accepts({ note: 'x'.repeat(500), timeZone: 'UTC' })).toBe(true);
    for (const note of ['', 'x'.repeat(501), 'a\u0000b', 'broken \uD800']) {
      expect(accepts({ note, timeZone: 'UTC' })).toBe(false);
    }
  });

  it('requires an IANA zone and refuses offsets, abbreviations and unknown fields', () => {
    for (const timeZone of [undefined, '', '+01:00', 'CET1', 'Mars/Olympus']) {
      expect(accepts({ ...full, timeZone })).toBe(false);
    }
    expect(accepts({ ...full, timeZone: 'Pacific/Kiritimati' })).toBe(true);
    for (const extra of [{ userId: orgId }, { localDate: '2026-10-05' }, { createdAt: view.createdAt }]) {
      expect(accepts({ ...full, ...extra })).toBe(false);
    }
  });
});

describe('daily metrics paths, list and view', () => {
  it('takes a real calendar date not before 2000-01-01 in the path', () => {
    expect(dailyMetricsPathSchema.parse({ localDate: '2000-01-01', orgId })).toEqual({ localDate: '2000-01-01', orgId });
    for (const localDate of ['1999-12-31', '2026-02-30', '2026-10-5', '20261005', 'today']) {
      expect(dailyMetricsPathSchema.safeParse({ localDate, orgId }).success).toBe(false);
    }
  });

  it('takes an inclusive range of at most 92 days, from not after to', () => {
    expect(DAILY_METRICS_RANGE_MAX_DAYS).toBe(92);
    const ok = (from: string, to: string) => dailyMetricsListQuerySchema.safeParse({ from, to }).success;
    expect(ok('2026-10-05', '2026-10-05')).toBe(true);
    expect(ok('2026-07-01', '2026-09-30')).toBe(true); // 92 days
    expect(ok('2026-07-01', '2026-10-01')).toBe(false); // 93 days
    expect(ok('2026-10-06', '2026-10-05')).toBe(false);
    expect(ok('1999-12-31', '2000-01-01')).toBe(false);
    expect(dailyMetricsListQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false);
    expect(dailyMetricsListQuerySchema.safeParse({ from: 'x', to: 'y' }).success).toBe(false);
    expect(dailyMetricsListQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-02', userId: orgId }).success).toBe(false);
  });

  it('counts calendar days across month, leap day and year ends', () => {
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(localDateSpanDays('2026-03-29', '2026-03-29')).toBe(1);
    expect(localDateSpanDays('2026-01-01', '2026-12-31')).toBe(365);
  });

  it('describes a stored day strictly, with every nullable value present', () => {
    expect(dailyMetricsViewSchema.parse(view)).toEqual(view);
    expect(dailyMetricsViewSchema.safeParse({ ...view, mood: null, note: null, weightKg: null }).success).toBe(true);
    expect(dailyMetricsViewSchema.safeParse({ ...view, userId: orgId }).success).toBe(false);
    const withoutMood: Partial<typeof view> = { ...view };
    delete withoutMood.mood;
    expect(dailyMetricsViewSchema.safeParse(withoutMood).success).toBe(false);
  });

  it('bounds a list to 92 items and names the not-found code', () => {
    expect(dailyMetricsListResponseSchema.safeParse({ items: Array.from({ length: 92 }, () => view) }).success).toBe(true);
    expect(dailyMetricsListResponseSchema.safeParse({ items: Array.from({ length: 93 }, () => view) }).success).toBe(false);
    expect(DAILY_METRICS_NOT_FOUND).toBe('DAILY_METRICS_NOT_FOUND');
  });
});

describe('daily metrics OpenAPI operations', () => {
  it('documents the range list and the three day operations, with CSRF on mutations', () => {
    const list = openApiDocument.paths['/api/orgs/{orgId}/daily-metrics'];
    const item = openApiDocument.paths['/api/orgs/{orgId}/daily-metrics/{localDate}'];
    expect(Object.keys(list).sort()).toEqual(['get']);
    expect(Object.keys(item).sort()).toEqual(['delete', 'get', 'put']);
    expect(list.get.parameters).toContainEqual({ $ref: '#/components/parameters/DailyMetricsFrom' });
    expect(list.get.parameters).toContainEqual({ $ref: '#/components/parameters/DailyMetricsTo' });
    for (const operation of [item.put, item.delete]) {
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/CsrfToken' });
      expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/Origin' });
    }
    expect(Object.keys(item.put.responses).sort()).toEqual(['200', '201', 'default']);
    expect(Object.keys(item.delete.responses).sort()).toEqual(['204', 'default']);
    expect(openApiDocument.components.schemas.PutDailyMetricsRequest).toBeDefined();
    expect(openApiDocument.components.schemas.DailyMetricsView).toBeDefined();
    expect(openApiDocument.components.schemas.DailyMetricsListResponse).toBeDefined();
  });
});
