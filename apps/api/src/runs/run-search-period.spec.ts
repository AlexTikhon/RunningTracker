import { describe, expect, it } from 'vitest';

import { localDateOf, resolveSearchPeriod, startOfLocalDate } from './run-search-period.js';

const HOUR = 3_600_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function dates(fromDate: string, toDate: string, timeZone: string) {
  const period = resolveSearchPeriod({ fromDate, toDate }, timeZone, new Date('2026-06-01T00:00:00.000Z'));
  return { from: period.from.toISOString(), to: period.to.toISOString() };
}

describe('the local calendar date of an instant', () => {
  it('follows the zone, not UTC', () => {
    const instant = Date.parse('2026-10-31T23:30:00.000Z');
    expect(localDateOf(instant, 'UTC')).toBe('2026-10-31');
    expect(localDateOf(instant, 'Europe/Warsaw')).toBe('2026-11-01');
    expect(localDateOf(instant, 'America/New_York')).toBe('2026-10-31');
    expect(localDateOf(instant, 'Pacific/Auckland')).toBe('2026-11-01');
  });
});

describe('a zone name in another letter case', () => {
  it('means the same zone, so one spelling cannot differ from another', () => {
    const instant = Date.parse('2026-10-31T23:30:00.000Z');
    expect(localDateOf(instant, 'europe/warsaw')).toBe(localDateOf(instant, 'Europe/Warsaw'));
    expect(startOfLocalDate('2026-10-25', 'EUROPE/WARSAW')).toBe(startOfLocalDate('2026-10-25', 'Europe/Warsaw'));
  });
});

describe('an explicit range of local dates', () => {
  it('is a half-open UTC interval from local midnight to the next local midnight', () => {
    expect(dates('2026-10-01', '2026-10-31', 'Europe/Warsaw')).toEqual({
      from: '2026-09-30T22:00:00.000Z',
      to: '2026-10-31T23:00:00.000Z',
    });
    expect(dates('2026-10-05', '2026-10-05', 'UTC')).toEqual({
      from: '2026-10-05T00:00:00.000Z',
      to: '2026-10-06T00:00:00.000Z',
    });
  });

  it('is 23 hours for the day clocks go forward (Europe/Warsaw, 2026-03-29)', () => {
    const day = dates('2026-03-29', '2026-03-29', 'Europe/Warsaw');
    expect(day).toEqual({ from: '2026-03-28T23:00:00.000Z', to: '2026-03-29T22:00:00.000Z' });
    expect((Date.parse(day.to) - Date.parse(day.from)) / HOUR).toBe(23);
  });

  it('is 25 hours for the day clocks go back (Europe/Warsaw, 2026-10-25)', () => {
    const day = dates('2026-10-25', '2026-10-25', 'Europe/Warsaw');
    expect(day).toEqual({ from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' });
    expect((Date.parse(day.to) - Date.parse(day.from)) / HOUR).toBe(25);
  });

  it('handles the United States transitions (America/New_York, 2026-03-08 and 2026-11-01)', () => {
    expect(dates('2026-03-08', '2026-03-08', 'America/New_York')).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    });
    expect(dates('2026-11-01', '2026-11-01', 'America/New_York')).toEqual({
      from: '2026-11-01T04:00:00.000Z',
      to: '2026-11-02T05:00:00.000Z',
    });
  });

  it('handles a half-hour daylight saving shift (Australia/Lord_Howe, 2026-10-04)', () => {
    const day = dates('2026-10-04', '2026-10-04', 'Australia/Lord_Howe');
    expect(day).toEqual({ from: '2026-10-03T13:30:00.000Z', to: '2026-10-04T13:00:00.000Z' });
  });

  it('starts a day at the transition when local midnight does not exist (America/Sao_Paulo, 2018-11-04)', () => {
    // Clocks jumped from 00:00 to 01:00 that day: the day began at the instant of the jump.
    expect(dates('2018-11-04', '2018-11-04', 'America/Sao_Paulo')).toEqual({
      from: '2018-11-04T03:00:00.000Z',
      to: '2018-11-05T02:00:00.000Z',
    });
  });

  it('starts the earlier of two local midnights (America/Havana, 2023-11-05)', () => {
    // 01:00 became 00:00 again, so 00:00 happened twice; the day began the first time.
    expect(dates('2023-11-05', '2023-11-05', 'America/Havana')).toEqual({
      from: '2023-11-05T04:00:00.000Z',
      to: '2023-11-06T05:00:00.000Z',
    });
  });

  it('ends a day at the later of two local midnights (America/Asuncion, 2023-03-25)', () => {
    // At 00:00 on the 26th clocks went back to 23:00 on the 25th, so the 25th had 25 hours and the
    // second pass through 23:00-24:00 still belongs to it.
    const day = dates('2023-03-25', '2023-03-25', 'America/Asuncion');
    expect(day).toEqual({ from: '2023-03-25T03:00:00.000Z', to: '2023-03-26T04:00:00.000Z' });
    expect((Date.parse(day.to) - Date.parse(day.from)) / HOUR).toBe(25);
  });

  it('is empty for a date that never existed (Pacific/Apia skipped 2011-12-30)', () => {
    const day = dates('2011-12-30', '2011-12-30', 'Pacific/Apia');
    expect(day.from).toBe(day.to);
    expect(dates('2011-12-31', '2011-12-31', 'Pacific/Apia').from).toBe(day.to);
  });

  it('crosses month, leap day and year boundaries by calendar date, not by a fixed number of hours', () => {
    expect(dates('2026-01-31', '2026-02-01', 'Europe/Warsaw')).toEqual({
      from: '2026-01-30T23:00:00.000Z',
      to: '2026-02-01T23:00:00.000Z',
    });
    expect(dates('2028-02-28', '2028-02-29', 'UTC')).toEqual({
      from: '2028-02-28T00:00:00.000Z',
      to: '2028-03-01T00:00:00.000Z',
    });
    expect(dates('2026-12-31', '2026-12-31', 'Europe/Warsaw')).toEqual({
      from: '2026-12-30T23:00:00.000Z',
      to: '2026-12-31T23:00:00.000Z',
    });
    expect(dates('2026-12-31', '2027-01-01', 'Europe/Warsaw')).toEqual({
      from: '2026-12-30T23:00:00.000Z',
      to: '2027-01-01T23:00:00.000Z',
    });
  });

  it('includes the last local date wholly and nothing after it', () => {
    const { from, to } = dates('2026-10-01', '2026-10-31', 'Europe/Warsaw');
    expect(localDateOf(Date.parse(from), 'Europe/Warsaw')).toBe('2026-10-01');
    expect(localDateOf(Date.parse(from) - 1, 'Europe/Warsaw')).toBe('2026-09-30');
    expect(localDateOf(Date.parse(to) - 1, 'Europe/Warsaw')).toBe('2026-10-31');
    expect(localDateOf(Date.parse(to), 'Europe/Warsaw')).toBe('2026-11-01');
  });
});

describe('every day tiles the timeline exactly', () => {
  const zones = [
    'Europe/Warsaw',
    'America/New_York',
    'Australia/Lord_Howe',
    'America/Sao_Paulo',
    'America/Havana',
    'America/Asuncion',
    'Asia/Kolkata',
    'UTC',
  ];

  it.each(zones)('%s: consecutive days share a boundary and every instant inside has its date', (zone) => {
    const year = zone === 'America/Sao_Paulo' ? 2018 : 2023;
    let date = `${year}-01-01`;
    let previousEnd: number | null = null;
    for (let step = 0; step < 365; step += 1) {
      const next = new Date(Date.UTC(year, 0, 1 + step + 1)).toISOString().slice(0, 10);
      const start = startOfLocalDate(date, zone);
      const end = startOfLocalDate(next, zone);
      if (previousEnd !== null) {
        expect(iso(start)).toBe(iso(previousEnd));
      }
      expect((end - start) / HOUR).toBeGreaterThanOrEqual(23);
      expect((end - start) / HOUR).toBeLessThanOrEqual(25);
      // The first instant, the last, and a probe every 20 minutes carry exactly this date.
      for (let probe = start; probe < end; probe += 20 * 60_000) {
        if (localDateOf(probe, zone) !== date) {
          throw new Error(`${zone} ${iso(probe)} is ${localDateOf(probe, zone)}, expected ${date}`);
        }
      }
      expect(localDateOf(end - 1_000, zone)).toBe(date);
      expect(localDateOf(end, zone)).toBe(next);
      previousEnd = end;
      date = next;
    }
  });
});

describe('presets', () => {
  const now = (value: string) => new Date(value);

  it('resolve this month as the whole local calendar month of the injected clock', () => {
    const period = resolveSearchPeriod({ preset: 'this-month' }, 'Europe/Warsaw', now('2026-10-15T12:00:00.000Z'));
    expect(period.fromDate).toBe('2026-10-01');
    expect(period.toDate).toBe('2026-10-31');
    expect(period.from.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });

  it('resolve previous month, across a year boundary', () => {
    const period = resolveSearchPeriod({ preset: 'previous-month' }, 'Europe/Warsaw', now('2027-01-10T12:00:00.000Z'));
    expect([period.fromDate, period.toDate]).toEqual(['2026-12-01', '2026-12-31']);
    expect(period.from.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('resolve previous month before a leap day', () => {
    const period = resolveSearchPeriod({ preset: 'previous-month' }, 'UTC', now('2028-03-01T00:00:00.000Z'));
    expect([period.fromDate, period.toDate]).toEqual(['2028-02-01', '2028-02-29']);
  });

  it('decide the month in the requested zone at the instant of the clock', () => {
    const instant = now('2026-10-31T23:30:00.000Z');
    expect(resolveSearchPeriod({ preset: 'this-month' }, 'Europe/Warsaw', instant).fromDate).toBe('2026-11-01');
    expect(resolveSearchPeriod({ preset: 'this-month' }, 'America/New_York', instant).fromDate).toBe('2026-10-01');
    expect(resolveSearchPeriod({ preset: 'previous-month' }, 'Europe/Warsaw', instant).fromDate).toBe('2026-10-01');
  });

  it('change at the local month boundary, not at the UTC one', () => {
    const before = resolveSearchPeriod({ preset: 'this-month' }, 'Europe/Warsaw', now('2026-10-31T22:59:59.999Z'));
    const after = resolveSearchPeriod({ preset: 'this-month' }, 'Europe/Warsaw', now('2026-10-31T23:00:00.000Z'));
    expect(before.fromDate).toBe('2026-10-01');
    expect(after.fromDate).toBe('2026-11-01');
  });

  it('refuse a zone the platform does not know', () => {
    expect(() => resolveSearchPeriod({ preset: 'this-month' }, 'Mars/Olympus', now('2026-10-15T12:00:00.000Z'))).toThrow();
  });
});
