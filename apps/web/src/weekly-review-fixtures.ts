import type { WeeklyReview } from '@running-tracker/contracts';

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
    provenance: {
      computedAt: '2026-11-09T08:00:00.000Z',
      persisted: false,
      policyVersion: 'weekly-insight-policy-2',
      reviewVersion: 'weekly-review-1',
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
