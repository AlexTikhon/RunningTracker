import { addLocalDays, type WeeklyReview, type WeeklyReviewMovement } from '@running-tracker/contracts';

/**
 * The movement part of a review of the week starting 2026-11-02, from the recorded days given (by offset from Monday);
 * counts and totals are computed as the server does (energy in integer tenths).
 */
export function movementFixture(
  recorded: readonly { activeEnergyKcal: number | null; offset: number; steps: number | null; timeZone?: string }[],
  weekStart = '2026-11-02',
): WeeklyReviewMovement {
  const byOffset = new Map(recorded.map((day) => [day.offset, day]));
  const days: WeeklyReviewMovement['days'] = Array.from({ length: 7 }, (_, offset) => {
    const localDate = addLocalDays(weekStart, offset);
    const day = byOffset.get(offset);
    return day === undefined
      ? { localDate, recorded: false }
      : { activeEnergyKcal: day.activeEnergyKcal, localDate, recorded: true, source: 'manual', steps: day.steps, timeZone: day.timeZone ?? 'Europe/Warsaw' };
  });
  const steps = recorded.flatMap((day) => (day.steps === null ? [] : [day.steps]));
  const tenths = recorded.flatMap((day) => (day.activeEnergyKcal === null ? [] : [Math.round(day.activeEnergyKcal * 10)]));
  return {
    activeEnergyKcal: { daysRecorded: tenths.length, recordedTotal: tenths.length === 0 ? null : tenths.reduce((sum, value) => sum + value, 0) / 10 },
    days,
    daysInWeek: 7,
    daysWithRecord: recorded.length,
    source: 'manual',
    steps: { daysRecorded: steps.length, recordedTotal: steps.length === 0 ? null : steps.reduce((sum, value) => sum + value, 0) },
  };
}

/** A weekly review for tests: four days with values, sleep duration on three of them, one note-only day. */
export function reviewFixture(patch: Partial<WeeklyReview> = {}): WeeklyReview {
  return {
    coverage: {
      daysInWeek: 7,
      daysWithCheckInRecord: 5,
      daysWithCheckInValues: 4,
      gpsRuns: { count: 2, withCurrentDistance: 1, withoutCurrentDistance: 1 },
      manualActivities: { count: 1, withDistance: 1 },
      metrics: {
        mood: { daysRecorded: 4 },
        sleepDuration: { daysRecorded: 3 },
        sleepQuality: { daysRecorded: 0 },
        soreness: { daysRecorded: 0 },
        weight: { daysRecorded: 1 },
      },
      noteOnlyDays: 1,
      sleepQualityWithoutDurationDays: 0,
    },
    dataGaps: [{ code: 'missing_check_in_days', text: 'No check-in values on 3 of 7 days; averages use the days that have them.' }],
    facts: [
      { day: 'none', direction: 'none', id: 'check_ins.days_with_data', label: 'Days with a check-in', text: 'Days with a check-in: 4 of 7', unit: 'days', value: 4 },
      { day: 'none', direction: 'none', id: 'sleep.average_minutes', label: 'Average sleep', text: 'Average sleep: 403 min', unit: 'minutes', value: 403 },
    ],
    movement: movementFixture([]),
    provenance: {
      computedAt: '2026-11-09T08:00:00.000Z',
      persisted: false,
      policyVersion: 'weekly-insight-policy-2',
      reviewVersion: 'weekly-review-2',
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
    },
    statements: [
      { code: 'check_ins.coverage', text: 'Check-ins with values on 4 of 7 days of the week.' },
      { code: 'check_ins.note_only_days', text: '1 day has a check-in with only a note; it is not counted as a day with values.' },
      { code: 'sleep_duration.coverage', text: 'Sleep duration was recorded on 3 of 4 days with check-in values.' },
    ],
    week: { end: '2026-11-08', inProgress: false, start: '2026-11-02', timeZone: 'Europe/Warsaw', timeZoneSource: 'check_ins', zonesOnCheckIns: ['Europe/Warsaw'] },
    ...patch,
  };
}
