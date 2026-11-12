import {
  ACTIVITY_TRENDS_VERSION,
  activityTrendsSchema,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  summarizeGpxActivityTrendDays,
  summarizeManualActivityTrendDays,
  summarizeRecordedRunTrendDays,
  type ActivityHistorySource,
  type ActivityTrends,
  type ActivityType,
} from '@running-tracker/contracts';

// Test fixtures for the Activity section of Trends (ADR-0089): valid answers built with the contract's own summary
// functions, read in UTC so every date is 24 hours unless a test passes its own bounds.

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
  const base = dailyTrendsDatesOf(range).map((localDate) => {
    const day = options.days?.[localDate] ?? { count: 0 };
    return {
      ...boundsOf(localDate),
      count: day.count,
      distance: day.distance ?? none,
      duration: day.duration ?? (source === 'recorded_run' || day.count === 0 ? noDuration : { totalS: 1_800 * day.count, withValue: day.count }),
      localDate,
      summaries: day.summaries ?? { current: 0, pending: day.count, stale: 0 },
    };
  });
  const common = {
    applied: { endDate, source, timeZone, type },
    provenance: { computedAt: '2026-11-12T10:00:00.000Z', persisted: false, policyVersion: ACTIVITY_TRENDS_VERSION, snapshot: 'single_read_only_transaction', source: 'computed_by_app' },
    range: {
      ...range,
      endsAt: base.at(-1)!.endsAt,
      includesToday: endDate === (options.today ?? endDate),
      requestedDays: 28,
      startsAt: base[0]!.startsAt,
      today: options.today ?? endDate,
    },
  };
  if (source === 'recorded_run') {
    const days = base.map(({ duration, ...day }) => ({ ...day, observedDuration: duration }));
    return activityTrendsSchema.parse({ ...common, days, source, summary: summarizeRecordedRunTrendDays(days) });
  }
  // Manual and GPX days have no summary states.
  const strip = base.map((day) => ({ count: day.count, distance: day.distance, duration: day.duration, endsAt: day.endsAt, localDate: day.localDate, startsAt: day.startsAt }));
  if (source === 'gpx') {
    const days = strip.map(({ duration, ...day }) => ({ ...day, elapsedDuration: duration }));
    return activityTrendsSchema.parse({ ...common, days, source, summary: summarizeGpxActivityTrendDays(days) });
  }
  const days = strip.map(({ duration, ...day }) => ({ ...day, enteredDuration: duration }));
  return activityTrendsSchema.parse({ ...common, days, source, summary: summarizeManualActivityTrendDays(days) });
}
