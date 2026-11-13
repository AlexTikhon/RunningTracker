import {
  ACTIVITY_TRENDS_VERSION,
  activityTrendsComparisonOf,
  activityTrendsSchema,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  previousActivityTrendsPeriodOf,
  summarizeGpxActivityTrendDays,
  summarizeManualActivityTrendDays,
  summarizeRecordedRunTrendDays,
  summarizeTcxActivityTrendDays,
  activityTrendsDurationKeyOf,
  type ActivityHistorySource,
  type ActivityTrends,
  type ActivityType,
} from '@running-tracker/contracts';

// Test fixtures for the Activity section of Trends (ADR-0089): valid answers built with the contract's own summary
// functions, read in UTC so every date is 24 hours unless a test passes its own bounds. Like the client's requests, an
// answer carries the comparison with the previous 28 dates (ADR-0090) unless `comparison: false`; `previous` gives the
// previous period's dates, built by the contract's own comparison function.

export interface FixtureDay {
  count: number;
  distance?: { totalM: number | null; withValue: number };
  duration?: { totalS: number | null; withValue: number };
  summaries?: { current: number; pending: number; stale: number };
}

const none = { totalM: null, withValue: 0 };
const noDuration = { totalS: null, withValue: 0 };

export function activityTrendsFixture(
  options: {
    days?: Record<string, FixtureDay>;
    endDate?: string;
    source?: ActivityHistorySource;
    timeZone?: string;
    today?: string;
    type?: ActivityType;
    /** Omits the comparison (an ordinary answer, as without `compare`). */
    comparison?: boolean;
    /** Dates of the previous period (E-55..E-28) with items. */
    previous?: Record<string, FixtureDay>;
    /** Overrides the UTC bounds of single dates (keys are dates; the neighbours follow so the range still tiles). */
    bounds?: (localDate: string) => { endsAt: string; startsAt: string };
  } = {},
): ActivityTrends {
  const endDate = options.endDate ?? '2026-11-12';
  const source = options.source ?? 'manual';
  const type = options.type ?? (source === 'recorded_run' ? 'run' : 'ride');
  const timeZone = options.timeZone ?? 'UTC';
  const range = dailyTrendsRangeOf(endDate);
  const boundsOf =
    options.bounds ??
    ((localDate: string) => {
      const startsAt = `${localDate}T00:00:00.000Z`;
      return { endsAt: new Date(Date.parse(startsAt) + 86_400_000).toISOString(), startsAt };
    });
  const daysOf = (dates: string[], entries: Record<string, FixtureDay> | undefined) => dates.map((localDate) => {
    const day = entries?.[localDate] ?? { count: 0 };
    return {
      ...boundsOf(localDate),
      count: day.count,
      distance: day.distance ?? none,
      duration: day.duration ?? (source === 'recorded_run' || day.count === 0 ? noDuration : { totalS: 1_800 * day.count, withValue: day.count }),
      localDate,
      summaries: day.summaries ?? { current: 0, pending: day.count, stale: 0 },
    };
  });
  const base = daysOf(dailyTrendsDatesOf(range), options.days);
  const common = {
    applied: { endDate, source, timeZone, type },
    provenance: { computedAt: '2026-11-12T10:00:00.000Z', persisted: false, policyVersion: ACTIVITY_TRENDS_VERSION, snapshot: 'single_read_only_transaction', source: 'computed_by_app' },
    range: {
      ...range,
      endsAt: base.at(-1)!.endsAt,
      includesToday: endDate === (options.today ?? endDate),
      requestedDays: 28 as const,
      startsAt: base[0]!.startsAt,
      today: options.today ?? endDate,
    },
  };
  type Built = ReturnType<typeof daysOf>;
  const runDays = (days: Built) => days.map(({ duration, ...day }) => ({ ...day, observedDuration: duration }));
  // Manual, GPX and TCX days have no summary states.
  const strip = (days: Built) =>
    days.map((day) => ({ count: day.count, distance: day.distance, duration: day.duration, endsAt: day.endsAt, localDate: day.localDate, startsAt: day.startsAt }));
  const summaryOf = (days: Built) => {
    switch (source) {
      case 'recorded_run':
        return summarizeRecordedRunTrendDays(runDays(days));
      case 'gpx':
        return summarizeGpxActivityTrendDays(strip(days).map(({ duration, ...day }) => ({ ...day, elapsedDuration: duration })));
      case 'tcx':
        return summarizeTcxActivityTrendDays(strip(days).map(({ duration, ...day }) => ({ ...day, reportedDuration: duration })));
      case 'manual':
        return summarizeManualActivityTrendDays(strip(days).map(({ duration, ...day }) => ({ ...day, enteredDuration: duration })));
    }
  };
  const answerDays =
    source === 'recorded_run'
      ? runDays(base)
      : strip(base).map(({ duration, ...day }) => ({ ...day, [activityTrendsDurationKeyOf(source)]: duration }));
  const summary = summaryOf(base);
  if (options.comparison === false) return activityTrendsSchema.parse({ ...common, days: answerDays, source, summary });
  const { period } = previousActivityTrendsPeriodOf(endDate);
  const previous =
    period === null
      ? null
      : (() => {
          const days = daysOf(dailyTrendsDatesOf(period), options.previous);
          return {
            period: { ...period, endsAt: common.range.startsAt, requestedDays: 28 as const, startsAt: boundsOf(period.startDate).startsAt },
            summary: summaryOf(days),
          };
        })();
  const comparison = activityTrendsComparisonOf({ endDate, previous, range: common.range, source, summary });
  return activityTrendsSchema.parse({ ...common, applied: { ...common.applied, compare: 'previous_period' }, comparison, days: answerDays, source, summary });
}
