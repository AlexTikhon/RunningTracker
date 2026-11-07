import { describe, expect, it } from 'vitest';

import { openApiDocument, weeklyReviewQuerySchema, weeklyReviewSchema, WEEKLY_REVIEW_VERSION } from './index.js';

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
