import type { WeeklyInsightOutput } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { checkGrounding, extractNumbers, isGrounded } from './grounding.js';
import { aggregateWeek, resolveWeekWindow, type CheckInRecord } from './weekly-aggregate.js';

const checkIn = (localDate: string, values: Partial<CheckInRecord>): CheckInRecord => ({
  localDate,
  mood: null,
  sleepMinutes: null,
  sleepQuality: null,
  soreness: null,
  timeZone: 'Europe/Warsaw',
  weightKg: null,
  ...values,
});

// sleep: 450, 405, 500 -> avg 452 min / 7.5 h; weight 72.45 -> 71.85 (delta -0.6); 3 of 7 days (43%).
const aggregate = aggregateWeek({
  activities: [{ distanceM: 5000, durationS: 1500, startedAtMs: Date.parse('2026-11-03T06:00:00Z'), type: 'run' }],
  checkIns: [
    checkIn('2026-11-02', { mood: 4, sleepMinutes: 450, weightKg: 72.45 }),
    checkIn('2026-11-04', { mood: 3, sleepMinutes: 405 }),
    checkIn('2026-11-07', { mood: 2, sleepMinutes: 500, weightKg: 71.85 }),
  ],
  gpsRuns: [],
  todayLocalDate: '2026-11-20',
  window: resolveWeekWindow({ checkIns: [], requestTimeZone: 'Europe/Warsaw', weekStart: '2026-11-02' }),
});

const output = (overrides: Partial<WeeklyInsightOutput> = {}): WeeklyInsightOutput => ({
  dataGaps: ['There was no check-in on 4 days.'],
  observations: [{ metricKeys: ['sleep.avgMinutes', 'sleep.avgHours'], text: 'You slept 452 minutes (7.5 hours) on average.' }],
  suggestion: 'Keep a steady bedtime.',
  summary: 'You checked in on 3 of 7 days (43%) and logged one manual run of 5 km.',
  ...overrides,
});

describe('grounding: number extraction', () => {
  it('reads digits, decimals, thousands groups, glued units, ranges and number words', () => {
    const values = (text: string) => extractNumbers(text).numbers.map((number) => number.value);
    expect(values('452 minutes, 7.5 h, 1,500 m, 5km, 2nd day, 6-8 hours')).toEqual([452, 7.5, 1500, 5, 2, 6, 8]);
    expect(values('three runs, twice, a dozen, zero gaps')).toEqual([3, 2, 12, 0]);
    expect(values('one more, once a week, Monday')).toEqual([]);
    expect(values('3, 4 and 5')).toEqual([3, 4, 5]);
    expect(extractNumbers('7.50').numbers[0]).toEqual({ decimals: 2, text: '7.50', value: 7.5 });
  });

  it('takes dates as a whole, not as numbers', () => {
    expect(extractNumbers('From 2026-11-02 to 2026-11-08.')).toEqual({ dates: ['2026-11-02', '2026-11-08'], numbers: [] });
  });

  it('accepts a value rounded half away from zero or cut to the written precision, and nothing looser', () => {
    const grounded = (text: string, values: number[]) => isGrounded(extractNumbers(text).numbers[0]!, values);
    expect(grounded('7.5', [7.5])).toBe(true);
    expect(grounded('7.50', [7.5])).toBe(true);
    expect(grounded('8', [7.5])).toBe(true);
    expect(grounded('7', [7.5])).toBe(true);
    expect(grounded('72.5', [72.45])).toBe(true);
    expect(grounded('72.4', [72.45])).toBe(true);
    expect(grounded('72.3', [72.45])).toBe(false);
    expect(grounded('0.6', [-0.6])).toBe(true);
    expect(grounded('7.6', [7.5])).toBe(false);
    expect(grounded('453', [452])).toBe(false);
    expect(grounded('1,500', [1500])).toBe(true);
  });
});

describe('grounding check (ADR-0076)', () => {
  it('passes an answer whose numbers, dates and metric keys all come from the aggregate', () => {
    expect(checkGrounding(output(), aggregate)).toEqual([]);
    expect(
      checkGrounding(output({ summary: 'Weight went from 72.45 to 71.85 kg, down 0.6 kg, in the week of 2026-11-02.' }), aggregate),
    ).toEqual([]);
  });

  it('catches a hallucinated number in every text field', () => {
    const violations = checkGrounding(
      output({
        dataGaps: ['Sleep was missing on 11 days.'],
        observations: [{ metricKeys: ['sleep.avgMinutes'], text: 'You slept 480 minutes on average.' }],
        suggestion: 'Aim for 9.5 hours of sleep.',
        summary: 'You ran 42 km this week.',
      }),
      aggregate,
    );
    expect(violations).toEqual([
      { detail: '42', field: 'summary', kind: 'ungrounded_number' },
      { detail: '480', field: 'observations', kind: 'ungrounded_number' },
      { detail: '9.5', field: 'suggestion', kind: 'ungrounded_number' },
      { detail: '11', field: 'dataGaps', kind: 'ungrounded_number' },
    ]);
  });

  it('catches a unit conversion or sum the aggregate does not contain', () => {
    // 5 km is in the data; 5000 m and 3.1 miles are not.
    expect(checkGrounding(output({ summary: 'You ran 5000 m, about 3.1 miles.' }), aggregate).map((violation) => violation.detail)).toEqual([
      '5000',
      '3.1',
    ]);
  });

  it('catches spelled-out numbers and foreign dates', () => {
    expect(checkGrounding(output({ summary: 'You checked in on eleven days, starting 2026-10-26.' }), aggregate)).toEqual([
      { detail: '2026-10-26', field: 'summary', kind: 'ungrounded_date' },
      { detail: 'eleven', field: 'summary', kind: 'ungrounded_number' },
    ]);
  });

  it('catches a metric key the aggregate does not have, including a key whose value is null', () => {
    const violations = checkGrounding(
      output({
        observations: [{ metricKeys: ['sleep.avgMinutes', 'sleep.remMinutes', 'sleep.avgQuality'], text: 'Sleep was steady.' }],
      }),
      aggregate,
    );
    expect(violations).toEqual([
      { detail: 'sleep.remMinutes', field: 'observations', kind: 'unknown_metric_key' },
      { detail: 'sleep.avgQuality', field: 'observations', kind: 'unknown_metric_key' },
    ]);
  });
});
