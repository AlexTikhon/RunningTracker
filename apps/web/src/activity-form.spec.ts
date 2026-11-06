import { describe, expect, it } from 'vitest';

import {
  defaultActivityDraft,
  distanceToMetres,
  formatLocalDateTimeInput,
  parseLocalDateTime,
  sameActivityRequest,
  validateActivityDraft,
  type ActivityDraft,
} from './activity-form.js';

// Built from local components, so these tests mean the same thing in every machine zone.
const localInput = (date: Date) => formatLocalDateTimeInput(date);
const nowMs = new Date(2026, 9, 6, 12, 0, 0).getTime();

const draft = (overrides: Partial<ActivityDraft> = {}): ActivityDraft => ({
  distance: '',
  hours: '',
  minutes: '45',
  notes: '',
  rpe: '',
  seconds: '',
  startedAtLocal: '2026-10-05T07:30',
  type: 'strength',
  unit: 'km',
  ...overrides,
});

function errorsOf(value: ActivityDraft): string[] {
  const result = validateActivityDraft(value, nowMs);
  return result.ok ? [] : result.errors;
}

describe('activity draft validation', () => {
  it('turns a minimal draft into a request with null optional fields', () => {
    const result = validateActivityDraft(draft(), nowMs);
    expect(result).toEqual({
      ok: true,
      request: {
        distanceM: null,
        durationS: 2_700,
        notes: null,
        rpe: null,
        startedAt: new Date(2026, 9, 5, 7, 30).toISOString(),
        type: 'strength',
      },
    });
  });

  it('starts from now, a run and empty optional fields', () => {
    const start = defaultActivityDraft(new Date(2026, 9, 6, 9, 5, 42));
    expect(start).toMatchObject({ distance: '', notes: '', rpe: '', startedAtLocal: '2026-10-06T09:05', type: 'run', unit: 'km' });
    expect(errorsOf(start)).toEqual(['Enter a duration of at least one second.']);
  });

  it('adds hours, minutes and seconds, and bounds the total to 48 hours', () => {
    const ok = validateActivityDraft(draft({ hours: '1', minutes: '2', seconds: '3' }), nowMs);
    expect(ok.ok && ok.request.durationS).toBe(3_723);
    const max = validateActivityDraft(draft({ hours: '48', minutes: '', seconds: '' }), nowMs);
    expect(max.ok && max.request.durationS).toBe(172_800);
    expect(errorsOf(draft({ hours: '48', minutes: '0', seconds: '1' }))).toEqual(['The duration cannot be longer than 48 hours.']);
    expect(errorsOf(draft({ hours: '', minutes: '', seconds: '' }))).toEqual(['Enter a duration of at least one second.']);
    expect(errorsOf(draft({ minutes: '0', seconds: '0' }))).toEqual(['Enter a duration of at least one second.']);
  });

  it('refuses minutes or seconds above 59 and anything that is not a whole number', () => {
    expect(errorsOf(draft({ minutes: '60' }))).toEqual(['Minutes and seconds must be whole numbers from 0 to 59.']);
    expect(errorsOf(draft({ seconds: '75' }))).toEqual(['Minutes and seconds must be whole numbers from 0 to 59.']);
    for (const minutes of ['1.5', '-5', '1e2', 'abc', 'NaN', ' ']) {
      expect(errorsOf(draft({ minutes }))).not.toEqual([]);
    }
    expect(errorsOf(draft({ hours: '1.5' }))).toEqual(['Hours must be a whole number.']);
  });

  it('converts kilometres and miles to metres exactly', () => {
    expect(distanceToMetres('5', 'km')).toBe(5_000);
    expect(distanceToMetres('0.001', 'km')).toBe(1);
    expect(distanceToMetres('42.195', 'km')).toBe(42_195);
    expect(distanceToMetres('1', 'mi')).toBe(1_609.344);
    expect(distanceToMetres('26.219', 'mi')).toBe(42_195.390336);
    // Binary multiplication would give 27.358847999999998 for 0.017 * 1609.344.
    expect(distanceToMetres('0.017', 'mi')).toBe(27.358848);
    expect(distanceToMetres('0', 'mi')).toBe(0);
  });

  it('accepts an optional distance up to 1000 km in either unit', () => {
    const km = validateActivityDraft(draft({ distance: '1000', unit: 'km' }), nowMs);
    expect(km.ok && km.request.distanceM).toBe(1_000_000);
    const mi = validateActivityDraft(draft({ distance: '621.371', unit: 'mi' }), nowMs);
    expect(mi.ok && mi.request.distanceM).toBe(999_999.690624);
    expect(errorsOf(draft({ distance: '1000.001', unit: 'km' }))).toEqual(['The distance cannot be more than 1000 km.']);
    expect(errorsOf(draft({ distance: '621.372', unit: 'mi' }))).toEqual(['The distance cannot be more than 1000 km.']);
  });

  it('refuses a distance that is not a plain decimal with at most three fraction digits', () => {
    for (const distance of ['-1', '1.2345', '1e3', 'NaN', 'Infinity', '01', '.5', '5.', '5 km', '1,5']) {
      expect(errorsOf(draft({ distance }))).toEqual(['Enter the distance as a number such as 5 or 12.345.']);
    }
  });

  it('accepts RPE 1 to 10 or none', () => {
    for (const rpe of ['1', '10']) {
      const result = validateActivityDraft(draft({ rpe }), nowMs);
      expect(result.ok && result.request.rpe).toBe(Number(rpe));
    }
    for (const rpe of ['0', '11', '2.5', 'x']) {
      expect(errorsOf(draft({ rpe }))).toEqual(['Effort (RPE) must be a whole number from 1 to 10.']);
    }
  });

  it('trims notes, sends blank notes as none, and bounds them to 1000 characters without NUL', () => {
    const trimmed = validateActivityDraft(draft({ notes: '  felt strong  ' }), nowMs);
    expect(trimmed.ok && trimmed.request.notes).toBe('felt strong');
    const blank = validateActivityDraft(draft({ notes: '   ' }), nowMs);
    expect(blank.ok && blank.request.notes).toBeNull();
    expect(errorsOf(draft({ notes: 'x'.repeat(1_000) }))).toEqual([]);
    expect(errorsOf(draft({ notes: 'x'.repeat(1_001) }))).toEqual(['Notes can be at most 1000 characters.']);
    expect(errorsOf(draft({ notes: 'a\u0000b' }))).toEqual(['Notes contain a character that cannot be stored.']);
  });

  it('refuses an unknown type', () => {
    expect(errorsOf(draft({ type: 'yoga' as ActivityDraft['type'] }))).toEqual(['Choose an activity type.']);
  });

  it('requires a real local date and time, from 2000 to at most 24 hours ahead', () => {
    expect(errorsOf(draft({ startedAtLocal: '' }))).toEqual(['Enter the date and time the activity started.']);
    expect(errorsOf(draft({ startedAtLocal: '2026-02-30T07:00' }))).toEqual(['Enter the date and time the activity started.']);
    expect(errorsOf(draft({ startedAtLocal: '2026-10-05 07:00' }))).toEqual(['Enter the date and time the activity started.']);
    expect(errorsOf(draft({ startedAtLocal: '1999-12-31T12:00' }))).toEqual(['The start cannot be before the year 2000.']);
    expect(errorsOf(draft({ startedAtLocal: localInput(new Date(nowMs + 24 * 3_600_000)) }))).toEqual([]);
    expect(errorsOf(draft({ startedAtLocal: localInput(new Date(nowMs + 24 * 3_600_000 + 60_000)) }))).toEqual([
      'The start cannot be more than 24 hours from now.',
    ]);
  });

  it('reads a datetime-local value as the browser\'s wall-clock time', () => {
    expect(parseLocalDateTime('2026-10-05T07:30')?.getTime()).toBe(new Date(2026, 9, 5, 7, 30).getTime());
    expect(parseLocalDateTime('2026-10-05T07:30:15')?.getTime()).toBe(new Date(2026, 9, 5, 7, 30, 15).getTime());
    expect(parseLocalDateTime('2026-13-05T07:30')).toBeNull();
    expect(parseLocalDateTime('2026-10-05T24:00')).toBeNull();
  });

  it('reports every problem at once', () => {
    expect(errorsOf(draft({ distance: 'x', minutes: '', rpe: '0' }))).toHaveLength(3);
  });

  it('compares two requests field by field, treating each optional field exactly', () => {
    const result = validateActivityDraft(draft({ distance: '5', notes: 'a', rpe: '3' }), nowMs);
    if (!result.ok) throw new Error('expected a valid draft');
    const request = result.request;
    expect(sameActivityRequest(request, { ...request })).toBe(true);
    expect(sameActivityRequest(request, { ...request, notes: 'b' })).toBe(false);
    expect(sameActivityRequest(request, { ...request, distanceM: null })).toBe(false);
    expect(sameActivityRequest(request, { ...request, rpe: 4 })).toBe(false);
    expect(sameActivityRequest(request, { ...request, durationS: request.durationS + 1 })).toBe(false);
    expect(sameActivityRequest(request, { ...request, type: 'run' })).toBe(false);
    expect(sameActivityRequest(request, { ...request, startedAt: '2000-01-01T00:00:00.000Z' })).toBe(false);
  });
});
