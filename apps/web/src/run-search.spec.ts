import { describe, expect, it } from 'vitest';

import {
  defaultDraft,
  defaultTimeZone,
  describeAppliedFilters,
  formatDistance,
  formatDuration,
  formatLocalDate,
  formatStartedAt,
  sortLabel,
  toSearchParams,
  validateDraft,
  type RunSearchDraft,
} from './run-search.js';

const draft = (patch: Partial<RunSearchDraft> = {}): RunSearchDraft => ({ ...defaultDraft(), ...patch });

describe('the default search', () => {
  it('is this month, newest first, in kilometres, with no distance bounds', () => {
    expect(defaultDraft()).toEqual({
      maxDistance: '',
      minDistance: '',
      period: { kind: 'preset', preset: 'this-month' },
      sort: 'newest',
      unit: 'km',
    });
  });
});

describe('the time zone of the browser', () => {
  it('is a name the server contract accepts', () => {
    const zone = defaultTimeZone();
    expect(zone.length).toBeGreaterThan(0);
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
  });

  it('falls back to UTC when the browser reports nothing usable', () => {
    expect(defaultTimeZone(() => undefined)).toBe('UTC');
    expect(defaultTimeZone(() => '+01:00')).toBe('UTC');
    expect(defaultTimeZone(() => 'Mars/Olympus')).toBe('UTC');
    expect(defaultTimeZone(() => 'Europe/Warsaw')).toBe('Europe/Warsaw');
  });
});

describe('validating the editable draft', () => {
  it('turns a preset and no bounds into a request without a unit', () => {
    const result = validateDraft(draft(), 'Europe/Warsaw');
    expect(result).toEqual({
      filters: {
        maxDistance: null,
        minDistance: null,
        period: { kind: 'preset', preset: 'this-month' },
        sort: 'newest',
        timeZone: 'Europe/Warsaw',
        unit: 'km',
      },
      ok: true,
    });
  });

  it('keeps the chosen unit with the bounds and trims them', () => {
    const result = validateDraft(draft({ maxDistance: ' 10.5 ', minDistance: '5', unit: 'mi' }), 'UTC');
    expect(result).toMatchObject({
      filters: { maxDistance: '10.5', minDistance: '5', unit: 'mi' },
      ok: true,
    });
  });

  it('accepts a decimal comma and sends a decimal point', () => {
    const result = validateDraft(draft({ minDistance: '10,5' }), 'UTC');
    expect(result).toMatchObject({ filters: { minDistance: '10.5' }, ok: true });
  });

  it.each([
    ['a negative number', '-1'],
    ['an exponent', '1e3'],
    ['text', 'five'],
    ['four decimals', '1.2345'],
    ['more than the largest bound', '100001'],
    ['a leading zero', '05'],
  ])('refuses %s as a bound', (_label, value) => {
    const result = validateDraft(draft({ minDistance: value }), 'UTC');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/distance/iu);
    }
  });

  it('refuses a minimum above the maximum', () => {
    const result = validateDraft(draft({ maxDistance: '4', minDistance: '5' }), 'UTC');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/minimum/iu);
    }
  });

  it('requires both dates, in order, and at most 366 days', () => {
    const dates = (fromDate: string, toDate: string) =>
      validateDraft(draft({ period: { fromDate, kind: 'dates', toDate } }), 'UTC');
    expect(dates('2026-10-01', '2026-10-31').ok).toBe(true);
    expect(dates('', '2026-10-31').ok).toBe(false);
    expect(dates('2026-10-01', '').ok).toBe(false);
    expect(dates('2026-10-31', '2026-10-01').ok).toBe(false);
    expect(dates('2026-01-01', '2027-01-02').ok).toBe(false);
    expect(dates('2027-01-01', '2027-12-31').ok).toBe(true);
    expect(dates('2026-02-30', '2026-03-01').ok).toBe(false);
  });
});

describe('the request for a page', () => {
  it('sends a preset with the zone and nothing about an owner', () => {
    const params = toSearchParams({
      maxDistance: null,
      minDistance: null,
      period: { kind: 'preset', preset: 'previous-month' },
      sort: 'newest',
      timeZone: 'Europe/Warsaw',
      unit: 'km',
    });
    expect(params).toEqual({ preset: 'previous-month', sort: 'newest', timeZone: 'Europe/Warsaw' });
  });

  it('sends dates, bounds with their unit, and the cursor of the next page', () => {
    const params = toSearchParams(
      {
        maxDistance: '10',
        minDistance: '5',
        period: { fromDate: '2026-10-01', kind: 'dates', toDate: '2026-10-31' },
        sort: 'longest',
        timeZone: 'Europe/Warsaw',
        unit: 'mi',
      },
      'opaque',
    );
    expect(params).toEqual({
      cursor: 'opaque',
      distanceUnit: 'mi',
      fromDate: '2026-10-01',
      maxDistance: '10',
      minDistance: '5',
      sort: 'longest',
      timeZone: 'Europe/Warsaw',
      toDate: '2026-10-31',
    });
  });

  it('sends only the bound that was given, with the unit', () => {
    const params = toSearchParams({
      maxDistance: null,
      minDistance: '3',
      period: { kind: 'preset', preset: 'this-month' },
      sort: 'shortest',
      timeZone: 'UTC',
      unit: 'km',
    });
    expect(params.minDistance).toBe('3');
    expect(params.distanceUnit).toBe('km');
    expect(params).not.toHaveProperty('maxDistance');
  });
});

describe('what the screen shows', () => {
  it('formats distance in the unit of the applied search with two decimals', () => {
    expect(formatDistance(10_000, 'km')).toBe('10.00 km');
    expect(formatDistance(4_999.96, 'km')).toBe('5.00 km');
    expect(formatDistance(1_609.344, 'mi')).toBe('1.00 mi');
    expect(formatDistance(10_000, 'mi')).toBe('6.21 mi');
    expect(formatDistance(0, 'km')).toBe('0.00 km');
  });

  it('formats observed duration as m:ss or h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(1_800)).toBe('30:00');
    expect(formatDuration(3_723)).toBe('1:02:03');
    expect(formatDuration(36_000)).toBe('10:00:00');
  });

  it('shows the start in the selected zone, not the browser’s or UTC', () => {
    const instant = '2026-10-31T23:30:00.000Z';
    expect(formatStartedAt(instant, 'Europe/Warsaw')).toBe('1 Nov 2026, 00:30');
    expect(formatStartedAt(instant, 'America/New_York')).toBe('31 Oct 2026, 19:30');
    expect(formatStartedAt(instant, 'UTC')).toBe('31 Oct 2026, 23:30');
  });

  it('shows a calendar date without moving it through a zone', () => {
    expect(formatLocalDate('2026-10-01')).toBe('1 Oct 2026');
    expect(formatLocalDate('2027-01-31')).toBe('31 Jan 2027');
  });

  it('labels the sorts', () => {
    expect(sortLabel('newest')).toBe('Newest first');
    expect(sortLabel('longest')).toBe('Longest first');
    expect(sortLabel('shortest')).toBe('Shortest first');
  });

  it('describes applied filters in words, with the period the server resolved', () => {
    const filters = {
      maxDistance: '10',
      minDistance: '5',
      period: { kind: 'preset', preset: 'this-month' } as const,
      sort: 'longest' as const,
      timeZone: 'Europe/Warsaw',
      unit: 'km' as const,
    };
    expect(describeAppliedFilters(filters, { fromDate: '2026-10-01', toDate: '2026-10-31' })).toEqual({
      distance: '5–10 km',
      period: 'This month · 1 Oct 2026 – 31 Oct 2026',
      sort: 'Longest first',
      timeZone: 'Europe/Warsaw',
    });
    expect(describeAppliedFilters(filters, null).period).toBe('This month');
    expect(describeAppliedFilters({ ...filters, maxDistance: null }, null).distance).toBe('at least 5 km');
    expect(describeAppliedFilters({ ...filters, minDistance: null }, null).distance).toBe('up to 10 km');
    expect(describeAppliedFilters({ ...filters, maxDistance: null, minDistance: null }, null).distance).toBe(
      'any distance',
    );
    expect(
      describeAppliedFilters(
        { ...filters, period: { fromDate: '2026-10-01', kind: 'dates', toDate: '2026-10-05' } },
        null,
      ).period,
    ).toBe('1 Oct 2026 – 5 Oct 2026');
  });
});
