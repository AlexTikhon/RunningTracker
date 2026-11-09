import { DAILY_OVERVIEW_VERSION, dailyOverviewSchema, type DailyOverview } from '@running-tracker/contracts';

/** No meal entry for the date (ADR-0083). */
export const noMeals = {
  carbohydrateG: { recordedEntries: 0, total: null },
  count: 0,
  energyKcal: { recordedEntries: 0, total: null },
  fatG: { recordedEntries: 0, total: null },
  proteinG: { recordedEntries: 0, total: null },
  source: 'manual',
} as const;

/** An empty, finished day in Warsaw; tests override what they need. Parsed, so a fixture can never break the contract. */
export function overviewFixture(overrides: Partial<DailyOverview> = {}): DailyOverview {
  return dailyOverviewSchema.parse({
    checkIn: { recorded: false },
    day: { endsAt: '2026-11-05T23:00:00.000Z', inProgress: false, localDate: '2026-11-05', startsAt: '2026-11-04T23:00:00.000Z', timeZone: 'Europe/Warsaw' },
    gpsRuns: { count: 0, currentDistanceM: null, withCurrentDistance: 0, withoutCurrentDistance: 0 },
    manualActivities: { byType: [], count: 0, enteredDurationS: 0 },
    meals: noMeals,
    movement: { recorded: false },
    provenance: { computedAt: '2026-11-08T10:00:00.000Z', overviewVersion: DAILY_OVERVIEW_VERSION, persisted: false, snapshot: 'single_read_only_transaction', source: 'computed_by_app' },
    ...overrides,
  });
}

export const noteOnlyCheckIn = {
  hasNote: true,
  mood: null,
  recorded: true,
  sleepMinutes: null,
  sleepQuality: null,
  soreness: null,
  timeZone: 'Europe/Warsaw',
  weightKg: null,
} as const;
