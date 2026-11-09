import { describe, expect, it } from 'vitest';

import {
  DAILY_TRENDS_RANGE_DAYS,
  DAILY_TRENDS_VERSION,
  dailyTrendsDatesOf,
  dailyTrendsQuerySchema,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  isEmptyDailyTrends,
  openApiDocument,
  summarizeDailyTrendDays,
  type DailyTrendDay,
  type DailyTrends,
} from './index.js';

const END = '2026-11-09';
const noFood = { entriesWithEnergy: 0, loggedEntries: 0, recordedKcal: null };

/** Every date of the range ending on `endDate`, without values, with `overrides` by date. */
function daysFor(endDate: string, overrides: Record<string, Partial<DailyTrendDay>> = {}): DailyTrendDay[] {
  return dailyTrendsDatesOf(dailyTrendsRangeOf(endDate)).map((localDate) => ({
    foodEnergy: noFood,
    localDate,
    sleepMinutes: null,
    steps: null,
    weightKg: null,
    ...overrides[localDate],
  }));
}

function trendsFor(endDate: string, days: DailyTrendDay[], today: string = endDate): DailyTrends {
  const range = dailyTrendsRangeOf(endDate);
  return {
    days,
    provenance: {
      computedAt: '2026-11-09T10:00:00.000Z',
      persisted: false,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
      trendsVersion: DAILY_TRENDS_VERSION,
    },
    range: {
      days: range.days,
      endDate,
      includesToday: endDate === today,
      requestedDays: DAILY_TRENDS_RANGE_DAYS,
      shortenedByLowerBound: range.shortenedByLowerBound,
      startDate: range.startDate,
      timeZone: 'Europe/Warsaw',
      today,
    },
    summary: summarizeDailyTrendDays(days),
  };
}

const issuesOf = (value: unknown) => {
  const parsed = dailyTrendsSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('daily trends range', () => {
  it('is the 28 calendar dates ending on the end date, inclusive, oldest first', () => {
    const range = dailyTrendsRangeOf(END);
    expect(range).toEqual({ days: 28, endDate: END, shortenedByLowerBound: false, startDate: '2026-10-13' });
    const dates = dailyTrendsDatesOf(range);
    expect(dates).toHaveLength(28);
    expect(dates[0]).toBe('2026-10-13');
    expect(dates.at(-1)).toBe(END);
  });

  it('has every date exactly once across both daylight saving changes and a leap day', () => {
    // 2026-10-25 (fall back, 25 hours in Warsaw) and 2026-03-29 (spring forward, 23 hours) are ordinary calendar dates.
    for (const [endDate, inside] of [
      ['2026-11-05', '2026-10-25'],
      ['2026-04-10', '2026-03-29'],
      ['2024-03-10', '2024-02-29'],
    ] as const) {
      const dates = dailyTrendsDatesOf(dailyTrendsRangeOf(endDate));
      expect(dates).toHaveLength(28);
      expect(new Set(dates).size).toBe(28);
      expect(dates).toContain(inside);
      for (let index = 1; index < dates.length; index += 1) {
        expect(Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`)).toBe(86_400_000);
      }
    }
    expect(dailyTrendsDatesOf(dailyTrendsRangeOf('2026-03-01'))[0]).toBe('2026-02-02');
  });

  it('is shortened only by the lower bound 2000-01-01, and says so', () => {
    expect(dailyTrendsRangeOf('2000-01-01')).toEqual({ days: 1, endDate: '2000-01-01', shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(dailyTrendsRangeOf('2000-01-10')).toEqual({ days: 10, endDate: '2000-01-10', shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(dailyTrendsRangeOf('2000-01-27')).toMatchObject({ days: 27, shortenedByLowerBound: true });
    expect(dailyTrendsRangeOf('2000-01-28')).toEqual({ days: 28, endDate: '2000-01-28', shortenedByLowerBound: false, startDate: '2000-01-01' });
  });
});

describe('daily trends summary', () => {
  it('has no value and no total for an empty range: null, never zero', () => {
    expect(summarizeDailyTrendDays(daysFor(END))).toEqual({
      foodEnergy: { daysWithEnergy: 0, daysWithEntries: 0, entriesWithEnergy: 0, loggedEntries: 0, recordedTotalKcal: null, source: 'manual' },
      sleep: { averageMinutes: null, daysRecorded: 0, recordedTotalMinutes: null },
      steps: { daysRecorded: 0, recordedTotal: null, source: 'manual' },
      weight: { changeKg: null, daysRecorded: 0, first: null, last: null },
    });
  });

  it('keeps recorded zeros as values: totals and averages of 0 over the recorded dates', () => {
    const days = daysFor(END, {
      '2026-11-01': { foodEnergy: { entriesWithEnergy: 2, loggedEntries: 2, recordedKcal: 0 }, sleepMinutes: 0, steps: 0 },
      '2026-11-02': { sleepMinutes: 0, steps: 0 },
    });
    const summary = summarizeDailyTrendDays(days);
    expect(summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 0, source: 'manual' });
    expect(summary.sleep).toEqual({ averageMinutes: 0, daysRecorded: 2, recordedTotalMinutes: 0 });
    expect(summary.foodEnergy).toMatchObject({ daysWithEnergy: 1, entriesWithEnergy: 2, recordedTotalKcal: 0 });
  });

  it('gives each series its own coverage, and averages sleep over the recorded dates only', () => {
    const days = daysFor(END, {
      '2026-10-13': { sleepMinutes: 420, steps: 8042 },
      '2026-10-20': { sleepMinutes: 450 },
      '2026-11-09': { steps: 0, weightKg: 72.4 },
    });
    const summary = summarizeDailyTrendDays(days);
    expect(summary.sleep).toEqual({ averageMinutes: 435, daysRecorded: 2, recordedTotalMinutes: 870 });
    expect(summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 8042, source: 'manual' });
    expect(summary.weight.daysRecorded).toBe(1);
  });

  it('rounds the sleep average to the nearest minute with halves up, in integers', () => {
    const average = (...minutes: number[]) =>
      summarizeDailyTrendDays(daysFor(END, Object.fromEntries(minutes.map((value, index) => [dailyTrendsDatesOf(dailyTrendsRangeOf(END))[index]!, { sleepMinutes: value }]))))
        .sleep.averageMinutes;
    expect(average(421, 422)).toBe(422); // 421.5
    expect(average(420, 421, 421)).toBe(421); // 420.67
    expect(average(420, 420, 421)).toBe(420); // 420.33
    expect(average(1, 0)).toBe(1); // 0.5
    expect(average(1_440)).toBe(1_440);
  });

  it('has no first, last or change for a single weight; with two or more recorded dates the exact change', () => {
    const single = summarizeDailyTrendDays(daysFor(END, { '2026-10-20': { weightKg: 72.35 } }));
    expect(single.weight).toEqual({ changeKg: null, daysRecorded: 1, first: null, last: null });

    const several = summarizeDailyTrendDays(
      daysFor(END, { '2026-10-14': { weightKg: 72.35 }, '2026-10-30': { weightKg: 90 }, '2026-11-08': { weightKg: 72.3 } }),
    );
    // 72.3 - 72.35 in binary floating point is -0.04999999999999716.
    expect(several.weight).toEqual({
      changeKg: -0.05,
      daysRecorded: 3,
      first: { kg: 72.35, localDate: '2026-10-14' },
      last: { kg: 72.3, localDate: '2026-11-08' },
    });
    expect(summarizeDailyTrendDays(daysFor(END, { '2026-10-14': { weightKg: 70.1 }, '2026-10-15': { weightKg: 70.3 } })).weight.changeKg).toBe(0.2);
  });

  it('adds food energy exactly, with day and entry coverage kept apart', () => {
    const days = daysFor(END, {
      '2026-10-13': { foodEnergy: { entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: 0.1 } },
      '2026-10-14': { foodEnergy: { entriesWithEnergy: 1, loggedEntries: 3, recordedKcal: 0.2 } },
      // A title-only day: entries logged, none with energy.
      '2026-10-15': { foodEnergy: { entriesWithEnergy: 0, loggedEntries: 2, recordedKcal: null } },
      '2026-10-16': { foodEnergy: { entriesWithEnergy: 2, loggedEntries: 2, recordedKcal: 1061.1 } },
    });
    expect(summarizeDailyTrendDays(days).foodEnergy).toEqual({
      daysWithEnergy: 3,
      daysWithEntries: 4,
      entriesWithEnergy: 4,
      loggedEntries: 8,
      recordedTotalKcal: 1061.4, // 0.1 + 0.2 + 1061.1, never 1061.3999999999999
      source: 'manual',
    });
  });
});

describe('daily trends contract', () => {
  it('accepts a consistent response and pins the version', () => {
    const days = daysFor(END, { '2026-11-01': { foodEnergy: { entriesWithEnergy: 1, loggedEntries: 2, recordedKcal: 350.5 }, steps: 0, weightKg: 72.4 } });
    expect(dailyTrendsSchema.parse(trendsFor(END, days))).toEqual(trendsFor(END, days));
    expect(DAILY_TRENDS_VERSION).toBe('daily-trends-1');
    const shortened = trendsFor('2000-01-03', daysFor('2000-01-03'), '2026-11-09');
    expect(dailyTrendsSchema.parse(shortened).range).toMatchObject({ days: 3, includesToday: false, shortenedByLowerBound: true, startDate: '2000-01-01' });
  });

  it('refuses a summary that is not computed from the days', () => {
    const days = daysFor(END, { '2026-11-01': { steps: 100 } });
    const trends = trendsFor(END, days);
    expect(issuesOf({ ...trends, summary: { ...trends.summary, steps: { daysRecorded: 1, recordedTotal: 101, source: 'manual' } } })).toContain(
      'the summary is computed from the days by summarizeDailyTrendDays',
    );
    // A single measurement presented as a change.
    const one = trendsFor(END, daysFor(END, { '2026-11-01': { weightKg: 70 } }));
    const asChange = { ...one.summary, weight: { changeKg: 0, daysRecorded: 1, first: { kg: 70, localDate: '2026-11-01' }, last: { kg: 70, localDate: '2026-11-01' } } };
    expect(issuesOf({ ...one, summary: asChange })).toContain('the summary is computed from the days by summarizeDailyTrendDays');
    // A missing value counted as zero.
    expect(issuesOf({ ...trends, summary: { ...trends.summary, sleep: { averageMinutes: 0, daysRecorded: 28, recordedTotalMinutes: 0 } } })).not.toEqual([]);
  });

  it('refuses days that are not every date of the range, oldest first, once each', () => {
    const days = daysFor(END);
    expect(issuesOf(trendsFor(END, days.slice(1)))).toContain('days are every date of the range, oldest first, once each');
    expect(issuesOf(trendsFor(END, days.toReversed()))).toContain('days are every date of the range, oldest first, once each');
    const duplicated = [...days.slice(0, 27), days[26]!];
    expect(issuesOf(trendsFor(END, duplicated))).toContain('days are every date of the range, oldest first, once each');
  });

  it('refuses inconsistent food energy and an energy total of 0 that nobody recorded', () => {
    const bad = (foodEnergy: unknown) => issuesOf(trendsFor(END, daysFor(END, { '2026-11-01': { foodEnergy: foodEnergy as DailyTrendDay['foodEnergy'] } })));
    expect(bad({ entriesWithEnergy: 0, loggedEntries: 2, recordedKcal: 0 })).toContain('a total exists exactly when at least one entry records energy');
    expect(bad({ entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: null })).toContain('a total exists exactly when at least one entry records energy');
    expect(bad({ entriesWithEnergy: 3, loggedEntries: 2, recordedKcal: 5 })).toContain('energy cannot be recorded for more entries than were logged');
    expect(bad({ entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: 0.05 })).toContain('A recorded total has at most one decimal');
  });

  it('refuses personal text and unknown fields anywhere', () => {
    const trends = trendsFor(END, daysFor(END));
    expect(issuesOf({ ...trends, days: [{ ...trends.days[0], note: 'x' }, ...trends.days.slice(1)] })).not.toEqual([]);
    expect(issuesOf({ ...trends, days: [{ ...trends.days[0], foodEnergy: { ...noFood, titles: ['Soup'] } }, ...trends.days.slice(1)] })).not.toEqual([]);
    expect(issuesOf({ ...trends, extra: true })).not.toEqual([]);
  });

  it('refuses a range that is not the 28 dates ending on the end date, ends after today, or misstates today', () => {
    const trends = trendsFor(END, daysFor(END));
    expect(issuesOf({ ...trends, range: { ...trends.range, shortenedByLowerBound: true } })).toContain(
      'the range is the 28 dates ending on endDate, cut only by 2000-01-01',
    );
    expect(issuesOf({ ...trends, range: { ...trends.range, today: '2026-11-08' } })).toContain(
      'the range cannot end after today, and includesToday says whether it ends today',
    );
    expect(issuesOf({ ...trends, range: { ...trends.range, includesToday: false } })).toContain(
      'the range cannot end after today, and includesToday says whether it ends today',
    );
  });

  it('calls a range empty only when no series has a value and no entry was logged', () => {
    expect(isEmptyDailyTrends(trendsFor(END, daysFor(END)))).toBe(true);
    expect(isEmptyDailyTrends(trendsFor(END, daysFor(END, { '2026-11-01': { steps: 0 } })))).toBe(false);
    expect(isEmptyDailyTrends(trendsFor(END, daysFor(END, { '2026-11-01': { foodEnergy: { entriesWithEnergy: 0, loggedEntries: 1, recordedKcal: null } } })))).toBe(false);
  });
});

describe('daily trends query', () => {
  it('takes exactly an end date not before 2000-01-01 and an IANA zone', () => {
    expect(dailyTrendsQuerySchema.parse({ endDate: END, timeZone: 'Europe/Warsaw' })).toEqual({ endDate: END, timeZone: 'Europe/Warsaw' });
    expect(dailyTrendsQuerySchema.parse({ endDate: '2000-01-01', timeZone: 'UTC' }).endDate).toBe('2000-01-01');
    for (const query of [
      {},
      { endDate: END },
      { timeZone: 'UTC' },
      { endDate: '1999-12-31', timeZone: 'UTC' },
      { endDate: '2026-02-30', timeZone: 'UTC' },
      { endDate: END, timeZone: '+01:00' },
      { endDate: END, timeZone: 'Mars/Olympus_Mons' },
      { endDate: END, timeZone: 'UTC', days: '7' },
      { endDate: [END, END], timeZone: 'UTC' },
    ]) {
      expect(dailyTrendsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('is documented in OpenAPI with its two query parameters and schema', () => {
    const path = openApiDocument.paths['/api/orgs/{orgId}/daily-trends'] as unknown as { get: { parameters: Array<{ $ref: string }>; tags: string[] } };
    expect(path.get.tags).toEqual(['Daily trends']);
    expect(path.get.parameters.map((parameter) => parameter.$ref)).toEqual([
      '#/components/parameters/OrgId',
      '#/components/parameters/TrendsEndDate',
      '#/components/parameters/TrendsTimeZone',
    ]);
    expect(openApiDocument.components.schemas).toHaveProperty('DailyTrends');
  });
});
