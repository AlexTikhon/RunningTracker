import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_HISTORY_SOURCES,
  ACTIVITY_TRENDS_VERSION,
  activityHistoryItemSchema,
  activityHistoryQuerySchema,
  activityTrendsComparisonOf,
  activityTrendsDurationKeyOf,
  activityTrendsQuerySchema,
  activityTrendsSchema,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  previousActivityTrendsPeriodOf,
  summarizeTcxActivityTrendDays,
  TCX_IMPORT_CONTENT_TYPE,
  TCX_IMPORT_METRICS_VERSION,
  TCX_NAMESPACE_V2,
  tcxCanonicalDecimalSchema,
  tcxImportConfirmQuerySchema,
  tcxImportPreviewSchema,
  tcxImportSummarySchema,
  tcxRoundHalfUp,
  tcxUnsupportedDetailsSchema,
  type TcxActivityTrendDay,
} from './index.js';

// ADR-0091: the TCX import contract, and TCX as its own source in the history and in activity trends.
const summary = {
  distanceM: 4000,
  lapCount: 2,
  lapTotals: { distanceMeters: '3999.75', totalTimeSeconds: '900.5' },
  metricsVersion: TCX_IMPORT_METRICS_VERSION,
  reportedDurationS: 901,
  startedAt: '2026-11-12T07:00:00.000Z',
};

describe('TCX import contract', () => {
  it('names the format, its namespace and its media type', () => {
    expect([TCX_IMPORT_CONTENT_TYPE, TCX_NAMESPACE_V2, TCX_IMPORT_METRICS_VERSION]).toEqual([
      'application/vnd.garmin.tcx+xml',
      'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2',
      'tcx-summary-1',
    ]);
  });

  it('requires each rounded total to be the half-up rounding of its exact lap sum', () => {
    expect(tcxImportSummarySchema.parse(summary)).toEqual(summary);
    expect(tcxImportSummarySchema.safeParse({ ...summary, reportedDurationS: 900 }).success).toBe(false);
    expect(tcxImportSummarySchema.safeParse({ ...summary, distanceM: 3999 }).success).toBe(false);
    expect(tcxImportSummarySchema.safeParse({ ...summary, lapTotals: { ...summary.lapTotals, totalTimeSeconds: '900.4999' } }).success).toBe(false);
    expect(tcxImportSummarySchema.safeParse({ ...summary, lapTotals: { ...summary.lapTotals, totalTimeSeconds: '900.4999' }, reportedDurationS: 900 }).success).toBe(true);
    // No end time, no elapsed duration: the laps report durations, not a span of the clock.
    expect(tcxImportSummarySchema.safeParse({ ...summary, endedAt: '2026-11-12T07:15:00.000Z' }).success).toBe(false);
    expect(tcxImportSummarySchema.safeParse({ ...summary, elapsedDurationS: 901 }).success).toBe(false);
    expect(tcxImportSummarySchema.safeParse({ ...summary, metricsVersion: 'gpx-summary-1' }).success).toBe(false);
    expect(tcxImportSummarySchema.safeParse({ ...summary, lapCount: 0 }).success).toBe(false);
  });

  it('accepts only canonical non-negative decimals for the exact sums', () => {
    for (const value of ['0', '12', '12.5', '0.0001', '1609.3399658203125']) expect(tcxCanonicalDecimalSchema.safeParse(value).success).toBe(true);
    for (const value of ['', '-1', '+1', '01', '1.50', '1.', '.5', '1e3', 'NaN', '1.0']) expect(tcxCanonicalDecimalSchema.safeParse(value).success).toBe(false);
    expect(['0.5', '0.4999', '2.5', '172800.4999999999999999999'].map(tcxRoundHalfUp)).toEqual([1, 0, 3, 172_800]);
  });

  it('keeps the preview and the confirmation query strict', () => {
    expect(tcxImportPreviewSchema.parse({ duplicateOf: null, summary })).toEqual({ duplicateOf: null, summary });
    expect(tcxImportPreviewSchema.safeParse({ duplicateOf: null, summary, saved: true }).success).toBe(false);
    const query = { idempotencyKey: 'b9000000-0000-4000-8000-000000000001', type: 'swim' };
    expect(tcxImportConfirmQuerySchema.parse(query)).toEqual(query);
    for (const extra of [{ source: 'tcx' }, { durationS: '1' }, { startedAt: '2026-11-12T07:00:00Z' }, { sport: 'Biking' }]) {
      expect(tcxImportConfirmQuerySchema.safeParse({ ...query, ...extra }).success).toBe(false);
    }
    expect(tcxImportConfirmQuerySchema.safeParse({ idempotencyKey: query.idempotencyKey }).success).toBe(false);
    expect(tcxUnsupportedDetailsSchema.safeParse({ reason: 'lap_order' }).success).toBe(true);
    expect(tcxUnsupportedDetailsSchema.safeParse({ reason: 'time_order' }).success).toBe(false);
  });
});

describe('TCX in the activity history (activity-history-3)', () => {
  const item = {
    activityId: 'a9000000-0000-4000-8000-000000000001',
    distanceM: 4000,
    reportedDurationS: 901,
    source: 'tcx',
    startedAt: '2026-11-12T07:00:00.000Z',
    type: 'swim',
  };

  it('is its own source with its own duration name, never an elapsed or entered duration', () => {
    expect(ACTIVITY_HISTORY_SOURCES).toEqual(['manual', 'gpx', 'tcx', 'recorded_run']);
    expect(activityHistoryItemSchema.parse(item)).toEqual(item);
    const { reportedDurationS, ...rest } = item;
    expect(activityHistoryItemSchema.safeParse({ ...rest, elapsedDurationS: reportedDurationS }).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...rest, enteredDurationS: reportedDurationS }).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...item, source: 'gpx' }).success).toBe(false);
    // Every TCX import has a distance; it carries no effort or notes.
    expect(activityHistoryItemSchema.safeParse({ ...item, distanceM: null }).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...item, notes: 'x' }).success).toBe(false);
    expect(activityHistoryQuerySchema.parse({ source: 'tcx' })).toEqual({ source: 'tcx' });
  });
});

describe('TCX in activity trends', () => {
  const endDate = '2026-11-12';
  const days = (overrides: Record<string, Partial<TcxActivityTrendDay>> = {}): TcxActivityTrendDay[] =>
    dailyTrendsDatesOf(dailyTrendsRangeOf(endDate)).map((localDate) => {
      const startsAt = `${localDate}T00:00:00.000Z`;
      return {
        count: 0,
        distance: { totalM: null, withValue: 0 },
        endsAt: new Date(Date.parse(startsAt) + 86_400_000).toISOString(),
        localDate,
        reportedDuration: { totalS: null, withValue: 0 },
        startsAt,
        ...overrides[localDate],
      };
    });
  const answer = (tcxDays: TcxActivityTrendDay[]) => {
    const range = { ...dailyTrendsRangeOf(endDate), endsAt: tcxDays.at(-1)!.endsAt, includesToday: false, requestedDays: 28 as const, startsAt: tcxDays[0]!.startsAt, today: '2026-11-13' };
    return {
      applied: { endDate, source: 'tcx', timeZone: 'UTC', type: 'swim' },
      days: tcxDays,
      provenance: { computedAt: '2026-11-13T10:00:00.000Z', persisted: false, policyVersion: ACTIVITY_TRENDS_VERSION, snapshot: 'single_read_only_transaction', source: 'computed_by_app' },
      range,
      source: 'tcx',
      summary: summarizeTcxActivityTrendDays(tcxDays),
    };
  };
  const twoSwims = days({ '2026-11-10': { count: 2, distance: { totalM: 3000, withValue: 2 }, reportedDuration: { totalS: 3600, withValue: 2 } } });

  it('is a source of its own: any type, the reported duration, every import records it', () => {
    expect(activityTrendsQuerySchema.parse({ endDate, source: 'tcx', timeZone: 'UTC', type: 'swim' })).toMatchObject({ source: 'tcx' });
    const parsed = activityTrendsSchema.parse(answer(twoSwims));
    expect(parsed.source).toBe('tcx');
    expect(parsed.summary).toMatchObject({ count: 2, reportedDuration: { daysWithValue: 1, totalS: 3600, withValue: 2 } });
    // An import without its reported duration, or a TCX day named with another source's duration, is refused.
    const missing = days({ '2026-11-10': { count: 2, distance: { totalM: 3000, withValue: 2 }, reportedDuration: { totalS: 1800, withValue: 1 } } });
    expect(activityTrendsSchema.safeParse(answer(missing)).success).toBe(false);
    const renamed = answer(twoSwims);
    expect(activityTrendsSchema.safeParse({ ...renamed, days: renamed.days.map(({ reportedDuration, ...day }) => ({ ...day, elapsedDuration: reportedDuration })) }).success).toBe(false);
    expect(activityTrendsSchema.safeParse({ ...renamed, source: 'gpx', applied: { ...renamed.applied, source: 'gpx' } }).success).toBe(false);
  });

  it('compares TCX periods under the reported duration, by the ADR-0090 rules', () => {
    const base = answer(twoSwims);
    const previousPeriod = previousActivityTrendsPeriodOf(endDate).period!;
    const previousDays = dailyTrendsDatesOf(previousPeriod).map((localDate) => {
      const startsAt = `${localDate}T00:00:00.000Z`;
      const day = { count: 0, distance: { totalM: null, withValue: 0 }, endsAt: new Date(Date.parse(startsAt) + 86_400_000).toISOString(), localDate, reportedDuration: { totalS: null, withValue: 0 }, startsAt };
      return localDate === '2026-10-10' ? { ...day, count: 1, distance: { totalM: 2000, withValue: 1 }, reportedDuration: { totalS: 2400, withValue: 1 } } : day;
    });
    const comparison = activityTrendsComparisonOf({
      endDate,
      previous: {
        period: { ...previousPeriod, endsAt: base.range.startsAt, requestedDays: 28, startsAt: previousDays[0]!.startsAt },
        summary: summarizeTcxActivityTrendDays(previousDays),
      },
      range: base.range,
      source: 'tcx',
      summary: base.summary,
    });
    const parsed = activityTrendsSchema.parse({ ...base, applied: { ...base.applied, compare: 'previous_period' }, comparison });
    expect(parsed.comparison?.metrics).toMatchObject({
      count: { change: { absolute: 1, percent: 100, status: 'available' }, current: 2, previous: 1 },
      distance: { change: { absolute: 1000, percent: 50, status: 'available' } },
      reportedDuration: { change: { absolute: 1200, percent: 50, status: 'available' }, current: 3600, previous: 2400 },
    });
  });

  it('names every source duration explicitly', () => {
    expect(ACTIVITY_HISTORY_SOURCES.map(activityTrendsDurationKeyOf)).toEqual(['enteredDuration', 'elapsedDuration', 'reportedDuration', 'observedDuration']);
    expect(() => activityTrendsDurationKeyOf('fit' as never)).toThrow(/Unknown activity trends source/u);
  });
});
