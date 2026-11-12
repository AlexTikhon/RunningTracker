import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalTimeZone, sameTimeZone } from './time-zone.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('time-zone identity', () => {
  it('canonicalizes the spelling like the API and refuses a name that is not a zone', () => {
    expect(canonicalTimeZone('europe/warsaw')).toBe('Europe/Warsaw');
    expect(() => canonicalTimeZone('Not/A_Zone')).toThrow(RangeError);
  });

  it('treats a different spelling or an alias as the same zone and another zone as different', () => {
    expect(sameTimeZone('europe/warsaw', 'Europe/Warsaw')).toBe(true);
    expect(sameTimeZone('US/Eastern', 'America/New_York')).toBe(true);
    expect(sameTimeZone('Europe/Warsaw', 'Europe/Berlin')).toBe(false);
    expect(sameTimeZone('UTC', 'Europe/London')).toBe(false);
  });

  it('never throws for an invalid name: it names no zone', () => {
    expect(sameTimeZone('Not/A_Zone', 'Europe/Warsaw')).toBe(false);
    expect(sameTimeZone('Europe/Warsaw', 'Not/A_Zone')).toBe(false);
    expect(sameTimeZone('Not/A_Zone', 'Not/A_Zone')).toBe(false);
  });

  it('falls back to Temporal’s zone identity where Intl keeps an alias as spelled', () => {
    const RealFormat = Intl.DateTimeFormat;
    // An engine without alias resolution: only the case is normalized.
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale: string, options: Intl.DateTimeFormatOptions) {
      const real = new RealFormat(locale, options);
      return { resolvedOptions: () => ({ ...real.resolvedOptions(), timeZone: options.timeZone }) };
    } as unknown as typeof Intl.DateTimeFormat);
    expect(canonicalTimeZone('US/Eastern')).toBe('US/Eastern');
    expect(sameTimeZone('US/Eastern', 'America/New_York')).toBe(false);
    const primary: Record<string, string> = { 'America/New_York': 'America/New_York', 'US/Eastern': 'America/New_York', 'Europe/Berlin': 'Europe/Berlin' };
    class ZonedDateTime {
      readonly zone: string;
      public constructor(_epoch: bigint, timeZone: string) {
        const found = primary[timeZone];
        if (found === undefined) throw new RangeError(`unknown zone ${timeZone}`);
        this.zone = found;
      }
      public equals(other: ZonedDateTime): boolean {
        return this.zone === other.zone;
      }
    }
    vi.stubGlobal('Temporal', { ZonedDateTime });
    expect(sameTimeZone('US/Eastern', 'America/New_York')).toBe(true);
    expect(sameTimeZone('US/Eastern', 'Europe/Berlin')).toBe(false);
  });
});
