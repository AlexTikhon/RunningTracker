import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_TRENDS_VERSION,
  activityTrendsComparisonOf,
  activityTrendsComparisonReasons,
  activityTrendsPercentTenths,
  activityTrendsPeriodReasons,
  activityTrendsQuerySchema,
  activityTrendsSchema,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  manualActivityTrendDaySchema,
  openApiDocument,
  previousActivityTrendsPeriodOf,
  recordedRunTrendDaySchema,
  summarizeGpxActivityTrendDays,
  summarizeManualActivityTrendDays,
  summarizeRecordedRunTrendDays,
  type ActivityTrendsComparisonReason,
  type ManualActivityTrendDay,
  type ManualActivityTrendsComparison,
  type RecordedRunTrendDay,
} from './index.js';

// Days of a range in UTC (every date 24 hours), enough for the contract's own checks.
function utcBounds(endDate: string) {
  const range = dailyTrendsRangeOf(endDate);
  const dates = dailyTrendsDatesOf(range);
  return dates.map((localDate) => {
    const startsAt = `${localDate}T00:00:00.000Z`;
    return { endsAt: new Date(Date.parse(startsAt) + 86_400_000).toISOString(), localDate, startsAt };
  });
}

const none = { totalM: null, withValue: 0 };
const noDuration = { totalS: null, withValue: 0 };

function manualDays(endDate: string, overrides: Record<string, Partial<ManualActivityTrendDay>> = {}): ManualActivityTrendDay[] {
  return utcBounds(endDate).map((bounds) => ({ ...bounds, count: 0, distance: none, enteredDuration: noDuration, ...overrides[bounds.localDate] }));
}

function runDays(endDate: string, overrides: Record<string, Partial<RecordedRunTrendDay>> = {}): RecordedRunTrendDay[] {
  return utcBounds(endDate).map((bounds) => ({
    ...bounds,
    count: 0,
    distance: none,
    observedDuration: noDuration,
    summaries: { current: 0, pending: 0, stale: 0 },
    ...overrides[bounds.localDate],
  }));
}

function rangeFor(endDate: string, days: Array<{ endsAt: string; startsAt: string }>, today = endDate) {
  const range = dailyTrendsRangeOf(endDate);
  return { ...range, endsAt: days.at(-1)!.endsAt, includesToday: endDate === today, requestedDays: 28 as const, startsAt: days[0]!.startsAt, today };
}

const provenance = {
  computedAt: '2026-11-12T10:00:00.000Z',
  persisted: false,
  policyVersion: ACTIVITY_TRENDS_VERSION,
  snapshot: 'single_read_only_transaction',
  source: 'computed_by_app',
};

function manualTrends(endDate: string, days: ManualActivityTrendDay[]) {
  return {
    applied: { endDate, source: 'manual', timeZone: 'UTC', type: 'ride' },
    days,
    provenance,
    range: rangeFor(endDate, days),
    source: 'manual',
    summary: summarizeManualActivityTrendDays(days),
  };
}

describe('activity trends query', () => {
  const valid = { endDate: '2026-11-12', source: 'manual', timeZone: 'Europe/Warsaw', type: 'ride' };

  it('requires exactly one end date, zone, source and type', () => {
    expect(activityTrendsQuerySchema.parse(valid)).toEqual(valid);
    for (const key of Object.keys(valid)) {
      const missing: Record<string, string> = { ...valid };
      delete missing[key];
      expect(activityTrendsQuerySchema.safeParse(missing).success, key).toBe(false);
    }
    for (const query of [
      { ...valid, source: ['manual', 'gpx'] },
      { ...valid, type: ['ride', 'run'] },
      { ...valid, source: 'import' },
      { ...valid, type: 'yoga' },
      { ...valid, timeZone: '+01:00' },
      { ...valid, endDate: '1999-12-31' },
      { ...valid, endDate: '2026-02-30' },
      { ...valid, userId: '00000000-0000-4000-8000-000000000001' },
    ]) {
      expect(activityTrendsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('accepts a recorded run only as a run', () => {
    expect(activityTrendsQuerySchema.safeParse({ ...valid, source: 'recorded_run', type: 'run' }).success).toBe(true);
    for (const type of ['ride', 'walk', 'other']) {
      expect(activityTrendsQuerySchema.safeParse({ ...valid, source: 'recorded_run', type }).success, type).toBe(false);
    }
    expect(activityTrendsQuerySchema.safeParse({ ...valid, source: 'gpx', type: 'run' }).success).toBe(true);
  });
});

describe('activity trend days', () => {
  const bounds = { endsAt: '2026-11-13T00:00:00.000Z', localDate: '2026-11-12', startsAt: '2026-11-12T00:00:00.000Z' };

  it('keeps no entries, an unknown metric and a recorded zero apart', () => {
    // No entries.
    expect(manualActivityTrendDaySchema.safeParse({ ...bounds, count: 0, distance: none, enteredDuration: noDuration }).success).toBe(true);
    // Two entries, distance unknown for both.
    expect(manualActivityTrendDaySchema.safeParse({ ...bounds, count: 2, distance: none, enteredDuration: { totalS: 3_600, withValue: 2 } }).success).toBe(true);
    // A recorded zero distance.
    expect(
      manualActivityTrendDaySchema.safeParse({ ...bounds, count: 1, distance: { totalM: 0, withValue: 1 }, enteredDuration: { totalS: 60, withValue: 1 } }).success,
    ).toBe(true);
    // A zero total without an item that records it, or an item with a value but no total, is refused.
    expect(manualActivityTrendDaySchema.safeParse({ ...bounds, count: 0, distance: { totalM: 0, withValue: 0 }, enteredDuration: noDuration }).success).toBe(false);
    expect(
      manualActivityTrendDaySchema.safeParse({ ...bounds, count: 1, distance: { totalM: null, withValue: 1 }, enteredDuration: { totalS: 60, withValue: 1 } }).success,
    ).toBe(false);
    // More distances than items, or an entered duration missing for an entry, is refused.
    expect(
      manualActivityTrendDaySchema.safeParse({ ...bounds, count: 1, distance: { totalM: 10, withValue: 2 }, enteredDuration: { totalS: 60, withValue: 1 } }).success,
    ).toBe(false);
    expect(manualActivityTrendDaySchema.safeParse({ ...bounds, count: 2, distance: none, enteredDuration: { totalS: 60, withValue: 1 } }).success).toBe(false);
  });

  it('gives recorded-run metrics only for current summaries and accounts for every run', () => {
    const day = {
      ...bounds,
      count: 3,
      distance: { totalM: 5_012, withValue: 1 },
      observedDuration: { totalS: 1_800, withValue: 1 },
      summaries: { current: 1, pending: 1, stale: 1 },
    };
    expect(recordedRunTrendDaySchema.safeParse(day).success).toBe(true);
    // Pending and stale only: counted, no metric.
    expect(recordedRunTrendDaySchema.safeParse({ ...day, distance: none, observedDuration: noDuration, summaries: { current: 0, pending: 2, stale: 1 } }).success).toBe(true);
    // A metric from a non-current summary, or a run without a state, is refused.
    expect(recordedRunTrendDaySchema.safeParse({ ...day, distance: { totalM: 9_000, withValue: 2 } }).success).toBe(false);
    expect(recordedRunTrendDaySchema.safeParse({ ...day, summaries: { current: 1, pending: 1, stale: 0 } }).success).toBe(false);
    // The duration is the observed one; another source's name is refused.
    const { observedDuration, ...rest } = day;
    expect(recordedRunTrendDaySchema.safeParse({ ...rest, enteredDuration: observedDuration }).success).toBe(false);
  });
});

describe('activity trends response', () => {
  const END = '2026-11-12';

  it('accepts every date of the range with its summary and refuses a summary that differs', () => {
    const days = manualDays(END, {
      '2026-11-10': { count: 2, distance: { totalM: 12_345, withValue: 1 }, enteredDuration: { totalS: 5_400, withValue: 2 } },
      '2026-11-12': { count: 1, distance: { totalM: 0, withValue: 1 }, enteredDuration: { totalS: 600, withValue: 1 } },
    });
    const trends = manualTrends(END, days);
    expect(trends.summary).toEqual({
      count: 3,
      daysWithEntries: 2,
      distance: { daysWithValue: 2, totalM: 12_345, withValue: 2 },
      enteredDuration: { daysWithValue: 2, totalS: 6_000, withValue: 3 },
    });
    expect(activityTrendsSchema.parse(trends)).toEqual(trends);
    expect(activityTrendsSchema.safeParse({ ...trends, summary: { ...trends.summary, count: 4 } }).success).toBe(false);
    // A missing date, or dates out of order, is refused.
    expect(activityTrendsSchema.safeParse({ ...trends, days: days.slice(1), range: rangeFor(END, days) }).success).toBe(false);
    expect(activityTrendsSchema.safeParse({ ...trends, days: days.toReversed() }).success).toBe(false);
  });

  it('has no range total when no date records the value, and zero when only zeros are recorded', () => {
    const empty = summarizeManualActivityTrendDays(manualDays(END));
    expect(empty).toEqual({
      count: 0,
      daysWithEntries: 0,
      distance: { daysWithValue: 0, totalM: null, withValue: 0 },
      enteredDuration: { daysWithValue: 0, totalS: null, withValue: 0 },
    });
    const zero = summarizeGpxActivityTrendDays(
      utcBounds(END).map((bounds) =>
        bounds.localDate === END
          ? { ...bounds, count: 1, distance: { totalM: 0, withValue: 1 }, elapsedDuration: { totalS: 60, withValue: 1 } }
          : { ...bounds, count: 0, distance: none, elapsedDuration: noDuration },
      ),
    );
    expect(zero.distance).toEqual({ daysWithValue: 1, totalM: 0, withValue: 1 });
  });

  it('adds recorded-run states across the range and keeps metrics of current summaries only', () => {
    const days = runDays(END, {
      '2026-11-01': { count: 1, summaries: { current: 0, pending: 1, stale: 0 } },
      '2026-11-05': { count: 2, distance: { totalM: 10_000, withValue: 1 }, observedDuration: { totalS: 3_000, withValue: 1 }, summaries: { current: 1, pending: 0, stale: 1 } },
    });
    expect(summarizeRecordedRunTrendDays(days)).toEqual({
      count: 3,
      daysWithEntries: 2,
      distance: { daysWithValue: 1, totalM: 10_000, withValue: 1 },
      observedDuration: { daysWithValue: 1, totalS: 3_000, withValue: 1 },
      summaries: { current: 1, pending: 1, stale: 1 },
    });
    const trends = {
      applied: { endDate: END, source: 'recorded_run', timeZone: 'UTC', type: 'run' },
      days,
      provenance,
      range: rangeFor(END, days),
      source: 'recorded_run',
      summary: summarizeRecordedRunTrendDays(days),
    };
    expect(activityTrendsSchema.safeParse(trends).success).toBe(true);
    expect(activityTrendsSchema.safeParse({ ...trends, applied: { ...trends.applied, type: 'ride' } }).success).toBe(false);
    // The source and the echoed source cannot differ.
    expect(activityTrendsSchema.safeParse({ ...trends, applied: { ...trends.applied, source: 'manual' } }).success).toBe(false);
  });

  it('accepts 23- and 25-hour dates whose intervals tile the range, and refuses a gap or an overlap', () => {
    // Europe/Warsaw around 2026-10-25 (25 hours), ending on 2026-10-26.
    const end = '2026-10-26';
    const warsawStart = (localDate: string) => (localDate <= '2026-10-25' ? Date.parse(`${localDate}T00:00:00Z`) - 7_200_000 : Date.parse(`${localDate}T00:00:00Z`) - 3_600_000);
    const dates = dailyTrendsDatesOf(dailyTrendsRangeOf(end));
    const days: ManualActivityTrendDay[] = dates.map((localDate, index) => ({
      count: 0,
      distance: none,
      endsAt: new Date(warsawStart(dates[index + 1] ?? '2026-10-27')).toISOString(),
      enteredDuration: noDuration,
      localDate,
      startsAt: new Date(warsawStart(localDate)).toISOString(),
    }));
    const long = days.find((day) => day.localDate === '2026-10-25')!;
    expect(Date.parse(long.endsAt) - Date.parse(long.startsAt)).toBe(25 * 3_600_000);
    const trends = manualTrends(end, days);
    expect(activityTrendsSchema.safeParse(trends).success).toBe(true);
    const gap = days.map((day, index) => (index === 10 ? { ...day, endsAt: new Date(Date.parse(day.endsAt) - 1_000).toISOString() } : day));
    expect(activityTrendsSchema.safeParse({ ...trends, days: gap, summary: summarizeManualActivityTrendDays(gap) }).success).toBe(false);
  });

  it('keeps a date the zone skipped as an empty interval with no items, and refuses a reversed interval or an overlap', () => {
    // Pacific/Apia skipped 2011-12-30: 29 December (UTC-10) was followed by 31 December (UTC+14), both at 10:00 UTC on the 30th.
    const end = '2012-01-05';
    const apiaStart = (localDate: string) => Date.parse(`${localDate}T00:00:00Z`) + (localDate <= '2011-12-30' ? 10 : -14) * 3_600_000;
    const dates = dailyTrendsDatesOf(dailyTrendsRangeOf(end));
    const days: ManualActivityTrendDay[] = dates.map((localDate, index) => ({
      count: 0,
      distance: none,
      endsAt: new Date(apiaStart(dates[index + 1] ?? '2012-01-06')).toISOString(),
      enteredDuration: noDuration,
      localDate,
      startsAt: new Date(apiaStart(localDate)).toISOString(),
    }));
    const skipped = days.findIndex((day) => day.localDate === '2011-12-30');
    expect(days[skipped]).toMatchObject({ endsAt: '2011-12-30T10:00:00.000Z', startsAt: '2011-12-30T10:00:00.000Z' });
    expect(days).toHaveLength(28);
    // Items around the skipped date belong to its neighbours; it keeps zero entries and null totals.
    const around = days.map((day, index) =>
      index === skipped - 1 || index === skipped + 1 ? { ...day, count: 1, enteredDuration: { totalS: 60, withValue: 1 } } : day,
    );
    const trends = manualTrends(end, around);
    expect(activityTrendsSchema.safeParse(trends).success).toBe(true);
    expect(trends.summary).toMatchObject({ count: 2, daysWithEntries: 2 });

    const reject = (changed: ManualActivityTrendDay[]) =>
      activityTrendsSchema.safeParse({ ...trends, days: changed, summary: summarizeManualActivityTrendDays(changed) }).success;
    // An item on an instant-less date cannot exist.
    expect(reject(around.map((day, index) => (index === skipped ? { ...day, count: 1, enteredDuration: { totalS: 60, withValue: 1 } } : day)))).toBe(false);
    // A reversed interval: the skipped date ends before it starts (and the next date starts earlier: an overlap).
    const earlier = new Date(Date.parse(days[skipped]!.startsAt) - 1_000).toISOString();
    expect(reject(around.map((day, index) => (index === skipped ? { ...day, endsAt: earlier } : index === skipped + 1 ? { ...day, startsAt: earlier } : day)))).toBe(false);
    // An overlap: the next date starts before the skipped date's end.
    expect(reject(around.map((day, index) => (index === skipped + 1 ? { ...day, startsAt: earlier } : day)))).toBe(false);
  });

  it('discloses a range shortened by 2000-01-01 and refuses an end after today', () => {
    const end = '2000-01-10';
    const days = manualDays(end);
    expect(days).toHaveLength(10);
    const trends = manualTrends(end, days);
    expect(trends.range).toMatchObject({ days: 10, shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(activityTrendsSchema.safeParse(trends).success).toBe(true);
    expect(activityTrendsSchema.safeParse({ ...trends, range: { ...trends.range, shortenedByLowerBound: false } }).success).toBe(false);
    const future = manualTrends(END, manualDays(END));
    expect(activityTrendsSchema.safeParse({ ...future, range: { ...future.range, includesToday: false, today: '2026-11-11' } }).success).toBe(false);
  });

  it('is documented in the OpenAPI document with all four parameters required and the comparison optional', () => {
    const operation = (openApiDocument.paths as unknown as Record<string, { get?: { description?: string; parameters?: Array<{ $ref: string }> } }>)[
      '/api/orgs/{orgId}/activity-trends'
    ]?.get;
    expect(operation?.parameters?.map((parameter) => parameter.$ref.split('/').at(-1))).toEqual([
      'OrgId',
      'TrendsEndDate',
      'ActivityTrendsTimeZone',
      'ActivityTrendsSource',
      'ActivityTrendsType',
      'ActivityTrendsCompare',
    ]);
    const parameters = (openApiDocument.components as unknown as { parameters: Record<string, { required: boolean; schema: { enum: string[] } }> }).parameters;
    expect(parameters.ActivityTrendsCompare).toMatchObject({ required: false, schema: { enum: ['previous_period'] } });
    expect(operation?.description).toContain('ADR-0090');
    expect(operation?.description).toContain('current_period_in_progress, current_period_shortened, previous_period_out_of_range');
  });
});

describe('activity trends comparison with the previous period (ADR-0090)', () => {
  const valid = { endDate: '2026-11-12', source: 'manual', timeZone: 'Europe/Warsaw', type: 'ride' };
  const END = '2026-11-11';

  it('accepts compare=previous_period only, once', () => {
    expect(activityTrendsQuerySchema.parse({ ...valid, compare: 'previous_period' })).toEqual({ ...valid, compare: 'previous_period' });
    expect(activityTrendsQuerySchema.parse(valid)).toEqual(valid);
    for (const compare of ['', 'previous', 'previous_year', ['previous_period', 'previous_period']]) {
      expect(activityTrendsQuerySchema.safeParse({ ...valid, compare }).success, JSON.stringify(compare)).toBe(false);
    }
  });

  it('defines the previous period as the 28 dates before the range, cut by 2000-01-01 or out of range', () => {
    expect(previousActivityTrendsPeriodOf('2026-11-12')).toEqual({
      period: { days: 28, endDate: '2026-10-15', shortenedByLowerBound: false, startDate: '2026-09-18' },
      requestedEndDate: '2026-10-15',
      requestedStartDate: '2026-09-18',
    });
    // Across a leap day: E-55..E-28 by calendar arithmetic.
    expect(previousActivityTrendsPeriodOf('2024-03-28').period).toMatchObject({ endDate: '2024-02-29', startDate: '2024-02-02' });
    // The earliest end date with two full periods: 2000-02-25 (previous 2000-01-01..2000-01-28).
    expect(previousActivityTrendsPeriodOf('2000-02-25').period).toEqual({ days: 28, endDate: '2000-01-28', shortenedByLowerBound: false, startDate: '2000-01-01' });
    expect(previousActivityTrendsPeriodOf('2000-02-24').period).toEqual({ days: 27, endDate: '2000-01-27', shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(previousActivityTrendsPeriodOf('2000-01-29').period).toEqual({ days: 1, endDate: '2000-01-01', shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(previousActivityTrendsPeriodOf('2000-01-28')).toEqual({ period: null, requestedEndDate: '1999-12-31', requestedStartDate: '1999-12-04' });
  });

  it('rounds the percentage to one decimal, halves away from zero, exactly from integers', () => {
    expect(activityTrendsPercentTenths(3, 2)).toBe(500);
    expect(activityTrendsPercentTenths(2, 2)).toBe(0);
    expect(activityTrendsPercentTenths(0, 5)).toBe(-1_000);
    expect(activityTrendsPercentTenths(1, 3)).toBe(-667); // -66.666…
    expect(activityTrendsPercentTenths(2, 3)).toBe(-333); // -33.333…
    // Exact halves: 49/400 = 12.25 % → 12.3; -49/400 → -12.3 (half to even would give 12.2).
    expect(activityTrendsPercentTenths(449, 400)).toBe(123);
    expect(activityTrendsPercentTenths(351, 400)).toBe(-123);
    // 1/8000 = 0.0125 % → 0.0; a tiny change is not a negative zero.
    expect(Object.is(activityTrendsPercentTenths(7_999, 8_000), 0)).toBe(true);
    expect(activityTrendsPercentTenths(5, 0)).toBeNull();
    expect(activityTrendsPercentTenths(0, 0)).toBeNull();
    // Large totals stay exact (no floating point).
    expect(activityTrendsPercentTenths(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1)).toBe(0);
    expect(() => activityTrendsPercentTenths(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });

  it('gives period reasons to every metric and coverage reasons to durations and distances only', () => {
    const full = { count: 3, pending: 0, stale: 0, withValue: 3 };
    const reasons = (
      metric: 'count' | 'distance' | 'duration',
      current: typeof full,
      previous: typeof full | null,
      periodReasons: ActivityTrendsComparisonReason[] = [],
    ) => activityTrendsComparisonReasons({ current, metric, periodReasons, previous });
    expect(reasons('distance', full, full)).toEqual([]);
    expect(reasons('distance', { ...full, withValue: 2 }, full)).toEqual(['current_values_missing']);
    expect(reasons('distance', full, { ...full, count: 0, withValue: 0 })).toEqual(['previous_period_no_entries']);
    // Counts describe logged records: coverage never affects them, an empty period is a count of 0.
    expect(reasons('count', { ...full, withValue: 0 }, { ...full, count: 0, withValue: 0 })).toEqual([]);
    // Runs: pending and stale summaries are named; a current summary always has its values.
    expect(reasons('duration', { count: 3, pending: 1, stale: 1, withValue: 1 }, { count: 2, pending: 0, stale: 2, withValue: 0 })).toEqual([
      'current_summaries_pending',
      'current_summaries_stale',
      'previous_summaries_stale',
    ]);
    // Every applicable reason is listed, in the defined order, period reasons first.
    expect(reasons('duration', { ...full, withValue: 0 }, null, ['current_period_in_progress', 'previous_period_out_of_range'])).toEqual([
      'current_period_in_progress',
      'previous_period_out_of_range',
      'current_values_missing',
    ]);
    expect(activityTrendsPeriodReasons({ days: 28, includesToday: true }, { days: 28 })).toEqual(['current_period_in_progress']);
    expect(activityTrendsPeriodReasons({ days: 10, includesToday: false }, null)).toEqual(['current_period_shortened', 'previous_period_out_of_range']);
    expect(activityTrendsPeriodReasons({ days: 28, includesToday: false }, { days: 13 })).toEqual(['previous_period_shortened']);
  });

  function previousOf(endDate: string, days: ManualActivityTrendDay[]) {
    const { period } = previousActivityTrendsPeriodOf(endDate);
    const bounds = utcBounds(period!.endDate).slice(-period!.days);
    return {
      period: { ...period!, endsAt: bounds.at(-1)!.endsAt, requestedDays: 28 as const, startsAt: bounds[0]!.startsAt },
      summary: summarizeManualActivityTrendDays(days),
    };
  }

  function compared(endDate: string, current: ManualActivityTrendDay[], previousDays: ManualActivityTrendDay[] | null, today = '2026-11-12') {
    const base = manualTrends(endDate, current);
    const range = { ...base.range, includesToday: endDate === today, today };
    const previous = previousDays === null ? null : previousOf(endDate, previousDays);
    const comparison = activityTrendsComparisonOf({ endDate, previous, range, source: 'manual', summary: base.summary });
    return { ...base, applied: { ...base.applied, compare: 'previous_period' }, comparison: comparison as ManualActivityTrendsComparison, range };
  }

  const ride = (count: number, durationS: number, distanceM: number | null, withDistance = distanceM === null ? 0 : count) => ({
    count,
    distance: { totalM: distanceM, withValue: withDistance },
    enteredDuration: { totalS: durationS, withValue: count },
  });

  it('compares counts, durations and distances with signed changes and percentages', () => {
    const current = manualDays(END, { '2026-11-01': ride(3, 5_400, 30_000) });
    const previous = manualDays('2026-10-14', { '2026-10-01': ride(2, 3_600, 24_000) });
    const parsed = activityTrendsSchema.parse(compared(END, current, previous));
    if (parsed.source !== 'manual' || parsed.comparison === undefined) throw new Error('expected a manual comparison');
    expect(parsed.comparison.periodReasons).toEqual([]);
    expect(parsed.comparison.previous.period).toMatchObject({ days: 28, endDate: '2026-10-14', startDate: '2026-09-17' });
    expect(parsed.comparison.metrics).toEqual({
      count: { change: { absolute: 1, percent: 50, percentUnavailableReason: null, status: 'available' }, current: 3, previous: 2 },
      distance: { change: { absolute: 6_000, percent: 25, percentUnavailableReason: null, status: 'available' }, current: 30_000, previous: 24_000 },
      enteredDuration: { change: { absolute: 1_800, percent: 50, percentUnavailableReason: null, status: 'available' }, current: 5_400, previous: 3_600 },
    });
  });

  it('keeps an absolute change for a zero baseline and suppresses only its percentage', () => {
    const current = manualDays(END, { '2026-11-01': ride(1, 600, 2_000) });
    const previous = manualDays('2026-10-14', { '2026-10-01': ride(1, 600, 0) }); // a recorded zero distance
    const parsed = activityTrendsSchema.parse(compared(END, current, previous));
    if (parsed.source !== 'manual') throw new Error('expected manual');
    expect(parsed.comparison?.metrics.distance).toEqual({
      change: { absolute: 2_000, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' },
      current: 2_000,
      previous: 0,
    });
    expect(parsed.comparison?.metrics.enteredDuration.change).toMatchObject({ absolute: 0, percent: 0 });
  });

  it('describes empty periods: counts compare as 0, totals are undefined', () => {
    const parsed = activityTrendsSchema.parse(compared(END, manualDays(END), manualDays('2026-10-14')));
    if (parsed.source !== 'manual') throw new Error('expected manual');
    expect(parsed.comparison?.metrics.count).toEqual({
      change: { absolute: 0, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' },
      current: 0,
      previous: 0,
    });
    expect(parsed.comparison?.metrics.distance).toEqual({
      change: { reasons: ['current_period_no_entries', 'previous_period_no_entries'], status: 'unavailable' },
      current: null,
      previous: null,
    });
  });

  it('suppresses every change while the range includes today, and keeps the values', () => {
    const today = '2026-11-12';
    const current = manualDays(today, { '2026-11-01': ride(2, 1_200, 4_000) });
    const previous = manualDays('2026-10-15', { '2026-10-01': ride(1, 600, 2_000) });
    const parsed = activityTrendsSchema.parse(compared(today, current, previous, today));
    if (parsed.source !== 'manual') throw new Error('expected manual');
    expect(parsed.comparison?.current.inProgress).toBe(true);
    expect(parsed.comparison?.periodReasons).toEqual(['current_period_in_progress']);
    expect(parsed.comparison?.metrics.count).toEqual({ change: { reasons: ['current_period_in_progress'], status: 'unavailable' }, current: 2, previous: 1 });
  });

  it('never compares a shortened or missing previous period as a full one', () => {
    const shortened = activityTrendsSchema.parse(compared('2000-02-10', manualDays('2000-02-10'), manualDays('2000-01-13')));
    expect(shortened.comparison?.previous.period).toMatchObject({ days: 13, shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(shortened.comparison?.metrics.count.change).toEqual({ reasons: ['previous_period_shortened'], status: 'unavailable' });
    const missing = activityTrendsSchema.parse(compared('2000-01-10', manualDays('2000-01-10'), null));
    expect(missing.comparison?.previous).toEqual({ period: null, requestedEndDate: '1999-12-13', requestedStartDate: '1999-11-16', summary: null });
    expect(missing.comparison?.metrics.count).toEqual({
      change: { reasons: ['current_period_shortened', 'previous_period_out_of_range'], status: 'unavailable' },
      current: 0,
      previous: null,
    });
  });

  it('refuses a comparison that disagrees with the contract, or that was not asked for', () => {
    const current = manualDays(END, { '2026-11-01': ride(3, 5_400, 30_000) });
    const previous = manualDays('2026-10-14', { '2026-10-01': ride(2, 3_600, 24_000) });
    const trends = compared(END, current, previous);
    expect(activityTrendsSchema.safeParse(trends).success).toBe(true);
    const { metrics } = trends.comparison;
    const withCount = (count: object) => ({ ...trends, comparison: { ...trends.comparison, metrics: { ...metrics, count } } });
    const tampered = (change: object) => withCount({ ...metrics.count, change: { ...metrics.count.change, ...change } });
    expect(activityTrendsSchema.safeParse(tampered({ absolute: 2 })).success).toBe(false);
    expect(activityTrendsSchema.safeParse(tampered({ percent: 50.1 })).success).toBe(false);
    expect(activityTrendsSchema.safeParse(tampered({ percent: 50.05 })).success).toBe(false);
    expect(activityTrendsSchema.safeParse(tampered({ percent: null, percentUnavailableReason: 'zero_baseline' })).success).toBe(false);
    // An unavailable change where the contract gives one.
    expect(activityTrendsSchema.safeParse(withCount({ ...metrics.count, change: { reasons: ['current_values_missing'], status: 'unavailable' } })).success).toBe(false);
    // Present without `compare` in applied, or asked for and missing.
    expect(activityTrendsSchema.safeParse({ ...trends, applied: manualTrends(END, current).applied }).success).toBe(false);
    const withoutComparison: Record<string, unknown> = { ...trends };
    delete withoutComparison.comparison;
    expect(activityTrendsSchema.safeParse(withoutComparison).success).toBe(false);
    // A previous period that does not end where the range starts, or a summary inconsistent with itself.
    const previousBlock = trends.comparison.previous;
    expect(
      activityTrendsSchema.safeParse({ ...trends, comparison: { ...trends.comparison, previous: { ...previousBlock, period: { ...previousBlock.period!, endsAt: '2026-10-14T00:00:00.000Z' } } } })
        .success,
    ).toBe(false);
    expect(activityTrendsSchema.safeParse({ ...trends, comparison: { ...trends.comparison, previous: { ...previousBlock, summary: { ...previousBlock.summary!, count: 9 } } } }).success).toBe(
      false,
    );
    // The ordinary answer without a comparison is unchanged.
    expect(activityTrendsSchema.safeParse(manualTrends(END, current)).success).toBe(true);
  });

  it('keeps the source’s duration name in the comparison', () => {
    const days = runDays(END, {
      '2026-11-02': { count: 2, distance: { totalM: 5_000, withValue: 1 }, observedDuration: { totalS: 1_800, withValue: 1 }, summaries: { current: 1, pending: 1, stale: 0 } },
    });
    const range = { ...rangeFor(END, utcBounds(END)), includesToday: false, today: '2026-11-12' };
    const comparison = activityTrendsComparisonOf({ endDate: END, previous: null, range, source: 'recorded_run', summary: summarizeRecordedRunTrendDays(days) });
    expect(Object.keys(comparison.metrics).toSorted()).toEqual(['count', 'distance', 'observedDuration']);
    expect((comparison.metrics as { observedDuration: { change: unknown } }).observedDuration.change).toEqual({
      reasons: ['previous_period_out_of_range', 'current_summaries_pending'],
      status: 'unavailable',
    });
  });
});
