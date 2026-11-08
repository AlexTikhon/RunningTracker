import { describe, expect, it } from 'vitest';

import { openApiDocument, weeklyReviewMovementDaySchema, weeklyReviewQuerySchema, weeklyReviewSchema, WEEKLY_REVIEW_VERSION } from './index.js';

const review = {
  coverage: {
    daysInWeek: 7,
    daysWithCheckInRecord: 5,
    daysWithCheckInValues: 4,
    gpsRuns: { count: 2, withCurrentDistance: 1, withoutCurrentDistance: 1 },
    manualActivities: { count: 3, withDistance: 2 },
    metrics: {
      mood: { daysRecorded: 2 },
      sleepDuration: { daysRecorded: 3 },
      sleepQuality: { daysRecorded: 1 },
      soreness: { daysRecorded: 0 },
      weight: { daysRecorded: 4 },
    },
    noteOnlyDays: 1,
    sleepQualityWithoutDurationDays: 1,
  },
  dataGaps: [{ code: 'missing_check_in_days', text: 'No check-in values on 3 of 7 days.' }],
  facts: [{ day: 'none', direction: 'none', id: 'sleep.nights_reported', label: 'Nights with sleep logged', text: 'Nights with sleep logged: 3 days', unit: 'days', value: 3 }],
  // The required regression: Monday steps 0, Tuesday both values, Wednesday energy only, the other days missing.
  movement: {
    activeEnergyKcal: { daysRecorded: 2, recordedTotal: 662.5 },
    days: [
      { activeEnergyKcal: null, localDate: '2026-11-02', recorded: true, source: 'manual', steps: 0, timeZone: 'Europe/Warsaw' },
      { activeEnergyKcal: 412.5, localDate: '2026-11-03', recorded: true, source: 'manual', steps: 8042, timeZone: 'Europe/Warsaw' },
      { activeEnergyKcal: 250, localDate: '2026-11-04', recorded: true, source: 'manual', steps: null, timeZone: 'America/New_York' },
      { localDate: '2026-11-05', recorded: false },
      { localDate: '2026-11-06', recorded: false },
      { localDate: '2026-11-07', recorded: false },
      { localDate: '2026-11-08', recorded: false },
    ],
    daysInWeek: 7,
    daysWithRecord: 3,
    source: 'manual',
    steps: { daysRecorded: 2, recordedTotal: 8042 },
  },
  provenance: {
    computedAt: '2026-11-20T10:00:00.000Z',
    persisted: false,
    policyVersion: 'weekly-insight-policy-2',
    reviewVersion: WEEKLY_REVIEW_VERSION,
    snapshot: 'single_read_only_transaction',
    source: 'computed_by_app',
  },
  statements: [{ code: 'sleep_duration.coverage', text: 'Sleep duration was recorded on 3 of 4 days with check-in values.' }],
  week: { end: '2026-11-08', inProgress: false, start: '2026-11-02', timeZone: 'Europe/Warsaw', timeZoneSource: 'check_ins', zonesOnCheckIns: ['Europe/Warsaw'] },
};

describe('weekly review contract', () => {
  it('accepts a consistent review', () => {
    expect(weeklyReviewSchema.parse(review)).toEqual(review);
  });

  it('refuses inconsistent denominators', () => {
    const coverage = (patch: Record<string, unknown>) => weeklyReviewSchema.safeParse({ ...review, coverage: { ...review.coverage, ...patch } }).success;
    expect(coverage({ daysWithCheckInValues: 6 })).toBe(false);
    expect(coverage({ noteOnlyDays: 0 })).toBe(false);
    expect(coverage({ metrics: { ...review.coverage.metrics, sleepDuration: { daysRecorded: 5 } } })).toBe(false);
    expect(coverage({ sleepQualityWithoutDurationDays: 2 })).toBe(false);
    expect(coverage({ gpsRuns: { count: 2, withCurrentDistance: 2, withoutCurrentDistance: 1 } })).toBe(false);
    expect(coverage({ manualActivities: { count: 1, withDistance: 2 } })).toBe(false);
  });

  it('names the version that added movement', () => {
    expect(WEEKLY_REVIEW_VERSION).toBe('weekly-review-2');
  });

  describe('movement', () => {
    type Movement = typeof review.movement;
    const days = review.movement.days;
    const accepts = (movement: Record<string, unknown>) => weeklyReviewSchema.safeParse({ ...review, movement }).success;
    const patched = (patch: Partial<Record<keyof Movement, unknown>>) => accepts({ ...review.movement, ...patch });

    it('refuses counts and totals that do not match the days', () => {
      expect(patched({ daysWithRecord: 2 })).toBe(false);
      expect(patched({ steps: { daysRecorded: 3, recordedTotal: 8042 } })).toBe(false);
      expect(patched({ steps: { daysRecorded: 2, recordedTotal: 8043 } })).toBe(false);
      expect(patched({ steps: { daysRecorded: 2, recordedTotal: null } })).toBe(false);
      expect(patched({ activeEnergyKcal: { daysRecorded: 1, recordedTotal: 662.5 } })).toBe(false);
      expect(patched({ activeEnergyKcal: { daysRecorded: 2, recordedTotal: 662.6 } })).toBe(false);
      expect(patched({ activeEnergyKcal: { daysRecorded: 2, recordedTotal: 662.55 } })).toBe(false);
    });

    it('distinguishes a metric never recorded (null total) from one recorded as zero (0 total)', () => {
      const zeros = [
        { activeEnergyKcal: null, localDate: '2026-11-02', recorded: true, source: 'manual', steps: 0, timeZone: 'UTC' },
        ...days.slice(1).map((day) => ({ localDate: day.localDate, recorded: false })),
      ];
      const base = { ...review.movement, daysWithRecord: 1, days: zeros };
      expect(accepts({ ...base, activeEnergyKcal: { daysRecorded: 0, recordedTotal: null }, steps: { daysRecorded: 1, recordedTotal: 0 } })).toBe(true);
      expect(accepts({ ...base, activeEnergyKcal: { daysRecorded: 0, recordedTotal: 0 }, steps: { daysRecorded: 1, recordedTotal: 0 } })).toBe(false);
      expect(accepts({ ...base, activeEnergyKcal: { daysRecorded: 0, recordedTotal: null }, steps: { daysRecorded: 1, recordedTotal: null } })).toBe(false);
    });

    it('needs the seven days of the week, in order, and a missing day without values', () => {
      expect(patched({ days: days.slice(0, 6) })).toBe(false);
      expect(patched({ days: [...days.slice(1), days[0]] })).toBe(false);
      expect(weeklyReviewSchema.safeParse({ ...review, week: { ...review.week, end: '2026-11-15', start: '2026-11-09' } }).success).toBe(false);
      expect(patched({ days: [...days.slice(0, 3), { localDate: '2026-11-05', recorded: false, steps: null }, ...days.slice(4)] })).toBe(false);
      expect(patched({ days: [...days.slice(0, 3), { activeEnergyKcal: null, localDate: '2026-11-05', recorded: true, source: 'manual', steps: null, timeZone: 'UTC' }, ...days.slice(4)] })).toBe(false);
    });

    it('names the manual source only, with energy to one decimal and no extra fields', () => {
      expect(patched({ source: 'apple_health' })).toBe(false);
      expect(patched({ days: [{ ...days[0], source: 'apple_health' }, ...days.slice(1)] })).toBe(false);
      expect(weeklyReviewMovementDaySchema.safeParse({ ...days[1], activeEnergyKcal: 412.55 }).success).toBe(false);
      expect(weeklyReviewMovementDaySchema.safeParse({ ...days[1], activeEnergyKcal: 412.5 }).success).toBe(true);
      expect(patched({ calories: 1 } as never)).toBe(false);
    });

    it('is part of the OpenAPI document', () => {
      expect(JSON.stringify(openApiDocument.components.schemas.WeeklyReview)).toContain('daysWithRecord');
    });
  });

  it('can only say it was computed by the app and not stored', () => {
    const provenance = (patch: Record<string, unknown>) =>
      weeklyReviewSchema.safeParse({ ...review, provenance: { ...review.provenance, ...patch } }).success;
    expect(provenance({ source: 'model' })).toBe(false);
    expect(provenance({ persisted: true })).toBe(false);
    expect(weeklyReviewSchema.safeParse({ ...review, model: 'qwen3:8b' }).success).toBe(false);
  });

  it('refuses unknown statement codes and needs a Monday and an IANA zone', () => {
    expect(weeklyReviewSchema.safeParse({ ...review, statements: [{ code: 'sleep.every_day', text: 'x' }] }).success).toBe(false);
    expect(weeklyReviewQuerySchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-02' }).success).toBe(true);
    expect(weeklyReviewQuerySchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-03' }).success).toBe(false);
    expect(weeklyReviewQuerySchema.safeParse({ timeZone: 'UTC+1', weekStart: '2026-11-02' }).success).toBe(false);
  });

  it('is documented in OpenAPI', () => {
    expect(openApiDocument.paths['/api/orgs/{orgId}/weekly-review'].get.responses['200']).toBeDefined();
    expect(openApiDocument.components.schemas.WeeklyReview).toBeDefined();
  });
});
