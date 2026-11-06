import type { DailyMetricsView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  CHECKIN_HISTORY_DAYS,
  checkInDateProblem,
  draftFromView,
  emptyCheckInDraft,
  formatCheckInDate,
  historyDays,
  historyRange,
  localDateIn,
  summarizeCheckIn,
  validateCheckInDraft,
  type CheckInDraft,
} from './daily-checkin.js';

const view = (localDate: string, overrides: Partial<DailyMetricsView> = {}): DailyMetricsView => ({
  createdAt: '2026-10-05T08:00:00.000Z',
  localDate,
  mood: 4,
  note: 'Slept well',
  sleepMinutes: 455,
  sleepQuality: 3,
  soreness: 0,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-10-05T08:00:00.000Z',
  weightKg: 72.3,
  ...overrides,
});

const draft = (patch: Partial<CheckInDraft>): CheckInDraft => ({ ...emptyCheckInDraft, ...patch });
const errorsOf = (patch: Partial<CheckInDraft>) => {
  const result = validateCheckInDraft(draft(patch));
  return result.ok ? [] : result.errors;
};

describe('check-in draft validation', () => {
  it('turns a full draft into the six values, sleep as minutes and weight with either separator', () => {
    expect(
      validateCheckInDraft(
        draft({ mood: '4', note: 'Slept well', sleepHours: '7', sleepMinutes: '35', sleepQuality: '3', soreness: '0', weightKg: '72,35' }),
      ),
    ).toEqual({ ok: true, values: { mood: 4, note: 'Slept well', sleepMinutes: 455, sleepQuality: 3, soreness: 0, weightKg: 72.35 } });
  });

  it('sends null for every field left empty, and a note of only spaces as no note', () => {
    expect(validateCheckInDraft(draft({ mood: '2', note: '   ' }))).toEqual({
      ok: true,
      values: { mood: 2, note: null, sleepMinutes: null, sleepQuality: null, soreness: null, weightKg: null },
    });
    // Hours alone, minutes alone and a zero all count as a recorded sleep.
    expect(validateCheckInDraft(draft({ sleepHours: '8' }))).toMatchObject({ values: { sleepMinutes: 480 } });
    expect(validateCheckInDraft(draft({ sleepMinutes: '45' }))).toMatchObject({ values: { sleepMinutes: 45 } });
    expect(validateCheckInDraft(draft({ soreness: '0' }))).toMatchObject({ ok: true, values: { soreness: 0 } });
  });

  it('asks for at least one value', () => {
    expect(errorsOf({})).toEqual(['Enter at least one value.']);
    expect(errorsOf({ note: '  ' })).toEqual(['Enter at least one value.']);
  });

  it('refuses weights out of range or with more than two decimals', () => {
    for (const weightKg of ['19.99', '400.01', '72.355', 'heavy', '-70', '1e2']) {
      expect(errorsOf({ weightKg })).toEqual([expect.stringContaining('Weight must be between 20 and 400 kg') as string]);
    }
    expect(errorsOf({ weightKg: '20' })).toEqual([]);
    expect(errorsOf({ weightKg: '400.00' })).toEqual([]);
  });

  it('refuses sleep over 24 hours, minutes over 59 and non-numbers', () => {
    expect(errorsOf({ sleepHours: '24', sleepMinutes: '1' })).toEqual(['Sleep cannot be more than 24 hours.']);
    expect(errorsOf({ sleepHours: '24' })).toEqual([]);
    expect(errorsOf({ sleepHours: '7', sleepMinutes: '60' })).toEqual(['Sleep must be whole hours and 0 to 59 minutes.']);
    expect(errorsOf({ sleepHours: '7.5' })).toEqual(['Sleep must be whole hours and 0 to 59 minutes.']);
  });

  it('refuses a note over 500 characters', () => {
    expect(errorsOf({ note: 'x'.repeat(500) })).toEqual([]);
    expect(errorsOf({ note: 'x'.repeat(501) })).toEqual(['The note can be at most 500 characters.']);
  });

  it('shows a stored day so that saving it unchanged sends the same values again', () => {
    const stored = view('2026-10-05');
    const shown = draftFromView(stored);
    expect(shown).toEqual({ mood: '4', note: 'Slept well', sleepHours: '7', sleepMinutes: '35', sleepQuality: '3', soreness: '0', weightKg: '72.3' });
    expect(validateCheckInDraft(shown)).toEqual({
      ok: true,
      values: { mood: 4, note: 'Slept well', sleepMinutes: 455, sleepQuality: 3, soreness: 0, weightKg: 72.3 },
    });
    expect(draftFromView(view('2026-10-05', { mood: null, note: null, sleepMinutes: null, sleepQuality: null, soreness: null, weightKg: 80 }))).toEqual({
      ...emptyCheckInDraft,
      weightKg: '80',
    });
  });
});

describe('dates', () => {
  it("finds today in the person's zone: just after Warsaw midnight it is still yesterday in UTC", () => {
    const instant = Date.parse('2026-07-15T22:30:00.000Z');
    expect(localDateIn('Europe/Warsaw', instant)).toBe('2026-07-16');
    expect(localDateIn('UTC', instant)).toBe('2026-07-15');
    expect(localDateIn('Europe/Warsaw', Date.parse('2026-07-15T21:59:59.999Z'))).toBe('2026-07-15');
  });

  it('allows dates from 2000-01-01 to today only', () => {
    expect(checkInDateProblem('2026-10-06', '2026-10-06')).toBeNull();
    expect(checkInDateProblem('2000-01-01', '2026-10-06')).toBeNull();
    expect(checkInDateProblem('2026-10-07', '2026-10-06')).toBe('The date cannot be after today.');
    expect(checkInDateProblem('1999-12-31', '2026-10-06')).toBe('The date cannot be before 1 January 2000.');
    expect(checkInDateProblem('', '2026-10-06')).toBe('Choose a date.');
  });

  it('formats a calendar date without moving it through a zone', () => {
    expect(formatCheckInDate('2026-11-06')).toMatch(/^Fri,? 6 Nov 2026$/u);
  });
});

describe('history window', () => {
  it('covers 14 days ending today, across a month end', () => {
    expect(CHECKIN_HISTORY_DAYS).toBe(14);
    expect(historyRange('2026-11-06')).toEqual({ from: '2026-10-24', to: '2026-11-06' });
  });

  it('lists every day newest first, with the days without a check-in kept as empty', () => {
    const days = historyDays('2026-11-06', [view('2026-11-05'), view('2026-10-24', { mood: 1 })]);
    expect(days).toHaveLength(14);
    expect(days.map((day) => day.localDate).slice(0, 3)).toEqual(['2026-11-06', '2026-11-05', '2026-11-04']);
    expect(days.at(-1)?.localDate).toBe('2026-10-24');
    expect(days.filter((day) => day.metrics !== null).map((day) => day.localDate)).toEqual(['2026-11-05', '2026-10-24']);
    expect(days[0]?.metrics).toBeNull();
    // A day outside the window is not shown.
    expect(historyDays('2026-11-06', [view('2026-10-23')]).every((day) => day.metrics === null)).toBe(true);
  });

  it('summarizes the recorded values in the form order and leaves out the missing ones', () => {
    expect(summarizeCheckIn(view('2026-11-05'))).toEqual([
      { label: 'Weight', value: '72.3 kg' },
      { label: 'Sleep', value: '7 h 35 min' },
      { label: 'Sleep quality', value: '3/5' },
      { label: 'Mood', value: '4/5' },
      { label: 'Soreness', value: '0/10' },
    ]);
    expect(summarizeCheckIn(view('2026-11-05', { mood: null, sleepMinutes: null, sleepQuality: null, soreness: null, weightKg: 70 }))).toEqual([
      { label: 'Weight', value: '70 kg' },
    ]);
  });
});
