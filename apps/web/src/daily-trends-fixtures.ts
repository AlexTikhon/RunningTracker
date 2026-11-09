import {
  DAILY_TRENDS_RANGE_DAYS,
  DAILY_TRENDS_VERSION,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  summarizeDailyTrendDays,
  type DailyTrendDay,
  type DailyTrends,
} from '@running-tracker/contracts';

/** A valid trends answer for the range ending on `endDate`, every date empty except `values` (by date). */
export function trendsFixture(endDate: string = '2026-11-09', values: Record<string, Partial<DailyTrendDay>> = {}, today: string = endDate): DailyTrends {
  const range = dailyTrendsRangeOf(endDate);
  const days = dailyTrendsDatesOf(range).map((localDate) => ({
    foodEnergy: { entriesWithEnergy: 0, loggedEntries: 0, recordedKcal: null },
    localDate,
    sleepMinutes: null,
    steps: null,
    weightKg: null,
    ...values[localDate],
  }));
  return dailyTrendsSchema.parse({
    days,
    provenance: {
      computedAt: '2026-11-09T09:00:00.000Z',
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
  });
}

/** A sparse range: a recorded zero, gaps between values, a title-only meal day and partial energy coverage. */
export const sparseTrends = () =>
  trendsFixture('2026-11-09', {
    '2026-10-13': { sleepMinutes: 420, steps: 8042, weightKg: 72.35 },
    '2026-10-14': { sleepMinutes: 450, steps: 0 },
    '2026-10-20': { foodEnergy: { entriesWithEnergy: 0, loggedEntries: 2, recordedKcal: null } },
    '2026-11-02': { foodEnergy: { entriesWithEnergy: 2, loggedEntries: 3, recordedKcal: 760.9 }, steps: 5000 },
    '2026-11-08': { weightKg: 72.3 },
  });
