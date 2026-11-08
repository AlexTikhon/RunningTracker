import { describe, expect, it } from 'vitest';

import {
  DAILY_METRICS_RANGE_MAX_DAYS,
  DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL,
  DAILY_MOVEMENT_LOCAL_DATE_MIN,
  DAILY_MOVEMENT_NOT_FOUND,
  DAILY_MOVEMENT_RANGE_MAX_DAYS,
  DAILY_MOVEMENT_STEPS_MAX,
  dailyMovementListQuerySchema,
  dailyMovementListResponseSchema,
  dailyMovementPathSchema,
  dailyMovementViewSchema,
  putDailyMetricsRequestSchema,
  putDailyMovementRequestSchema,
} from './index.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const view = {
  activeEnergyKcal: 412.5,
  createdAt: '2026-10-05T08:00:00.123Z',
  localDate: '2026-10-05',
  source: 'manual',
  steps: 8_042,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-10-05T08:00:00.123Z',
};

const accepts = (body: unknown) => putDailyMovementRequestSchema.safeParse(body).success;

describe('daily movement replacement request', () => {
  it('accepts both values, or either one, with the zone', () => {
    const full = { activeEnergyKcal: 412.5, steps: 8_042, timeZone: 'Europe/Warsaw' };
    expect(putDailyMovementRequestSchema.parse(full)).toEqual(full);
    expect(accepts({ steps: 8_042, timeZone: 'UTC' })).toBe(true);
    expect(accepts({ activeEnergyKcal: 412.5, timeZone: 'UTC' })).toBe(true);
  });

  it('treats a zero as a recorded value and omitted or null as unknown, requiring at least one value', () => {
    expect(accepts({ steps: 0, timeZone: 'UTC' })).toBe(true);
    expect(accepts({ activeEnergyKcal: 0, timeZone: 'UTC' })).toBe(true);
    expect(accepts({ activeEnergyKcal: null, steps: 0, timeZone: 'UTC' })).toBe(true);
    expect(accepts({ timeZone: 'UTC' })).toBe(false);
    expect(accepts({ activeEnergyKcal: null, steps: null, timeZone: 'UTC' })).toBe(false);
  });

  it('bounds steps as a whole number from 0 to the technical maximum', () => {
    expect(accepts({ steps: DAILY_MOVEMENT_STEPS_MAX, timeZone: 'UTC' })).toBe(true);
    for (const steps of [-1, DAILY_MOVEMENT_STEPS_MAX + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8000', true]) {
      expect(accepts({ steps, timeZone: 'UTC' })).toBe(false);
    }
  });

  it('bounds active energy to a finite, non-negative number with at most one decimal', () => {
    for (const activeEnergyKcal of [0, 0.1, 412.5, 19_999.9, DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL]) {
      expect(accepts({ activeEnergyKcal, timeZone: 'UTC' })).toBe(true);
    }
    for (const activeEnergyKcal of [
      -0.1,
      DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL + 0.1,
      412.55,
      0.05,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '412.5',
    ]) {
      expect(accepts({ activeEnergyKcal, timeZone: 'UTC' })).toBe(false);
    }
  });

  it('refuses an owner, an organization, a source, a date or any other unknown field, and a missing or offset zone', () => {
    for (const extra of [
      { userId: orgId },
      { orgId },
      { source: 'manual' },
      { source: 'apple_health' },
      { localDate: '2026-10-05' },
      { restingEnergyKcal: 1_500 },
      { caloriesEstimated: 300 },
    ]) {
      expect(accepts({ steps: 100, timeZone: 'UTC', ...extra })).toBe(false);
    }
    expect(accepts({ steps: 100 })).toBe(false);
    expect(accepts({ steps: 100, timeZone: '+01:00' })).toBe(false);
    expect(accepts({ steps: 100, timeZone: 'CET-ish' })).toBe(false);
  });

  it('is not accepted by the check-in contract, and the check-in body is not accepted here (separate entities)', () => {
    expect(putDailyMetricsRequestSchema.safeParse({ steps: 100, timeZone: 'UTC' }).success).toBe(false);
    expect(accepts({ mood: 3, timeZone: 'UTC' })).toBe(false);
  });
});

describe('daily movement path, range and view', () => {
  it('takes a real calendar date not before the check-in lower bound in the path', () => {
    expect(DAILY_MOVEMENT_LOCAL_DATE_MIN).toBe('2000-01-01');
    expect(dailyMovementPathSchema.safeParse({ localDate: '2000-01-01', orgId }).success).toBe(true);
    expect(dailyMovementPathSchema.safeParse({ localDate: '2024-02-29', orgId }).success).toBe(true);
    for (const localDate of ['1999-12-31', '2026-02-29', '2026-13-01', '2026-10-5', 'today']) {
      expect(dailyMovementPathSchema.safeParse({ localDate, orgId }).success).toBe(false);
    }
  });

  it('takes an inclusive range with the daily metrics bound, from not after to', () => {
    expect(DAILY_MOVEMENT_RANGE_MAX_DAYS).toBe(DAILY_METRICS_RANGE_MAX_DAYS);
    expect(dailyMovementListQuerySchema.safeParse({ from: '2026-07-01', to: '2026-09-30' }).success).toBe(true);
    expect(dailyMovementListQuerySchema.safeParse({ from: '2026-10-05', to: '2026-10-05' }).success).toBe(true);
    for (const query of [
      { from: '2026-07-01', to: '2026-10-01' },
      { from: '2026-10-06', to: '2026-10-05' },
      { from: '2026-10-01' },
      { from: '1999-12-31', to: '2000-01-01' },
      { from: '2026-10-01', to: '2026-10-02', userId: orgId },
    ]) {
      expect(dailyMovementListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('describes a stored day strictly, with server-owned manual provenance and at least one value', () => {
    expect(dailyMovementViewSchema.parse(view)).toEqual(view);
    expect(dailyMovementViewSchema.safeParse({ ...view, steps: 0, activeEnergyKcal: null }).success).toBe(true);
    expect(dailyMovementViewSchema.safeParse({ ...view, steps: null, activeEnergyKcal: null }).success).toBe(false);
    expect(dailyMovementViewSchema.safeParse({ ...view, source: 'apple_health' }).success).toBe(false);
    expect(dailyMovementViewSchema.safeParse({ ...view, userId: orgId }).success).toBe(false);
    const withoutSource: Partial<typeof view> = { ...view };
    delete withoutSource.source;
    expect(dailyMovementViewSchema.safeParse(withoutSource).success).toBe(false);
  });

  it('bounds a list to 92 items and names the not-found code', () => {
    expect(dailyMovementListResponseSchema.safeParse({ items: Array.from({ length: 92 }, () => view) }).success).toBe(true);
    expect(dailyMovementListResponseSchema.safeParse({ items: Array.from({ length: 93 }, () => view) }).success).toBe(false);
    expect(DAILY_MOVEMENT_NOT_FOUND).toBe('DAILY_MOVEMENT_NOT_FOUND');
  });
});
