import { DAILY_OVERVIEW_VERSION } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { buildDailyOverview, localDayInterval } from './daily-overview-service.js';

const HOUR_MS = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('localDayInterval: the half-open interval of a local date', () => {
  it('is 24 hours on an ordinary Warsaw day', () => {
    const day = localDayInterval('2026-11-08', 'Europe/Warsaw');
    expect([iso(day.startsAtMs), iso(day.endsAtMs)]).toEqual(['2026-11-07T23:00:00.000Z', '2026-11-08T23:00:00.000Z']);
  });

  it('is 23 hours on the Warsaw spring-forward date (02:00 -> 03:00 on 29 March 2026)', () => {
    const day = localDayInterval('2026-03-29', 'Europe/Warsaw');
    expect([iso(day.startsAtMs), iso(day.endsAtMs)]).toEqual(['2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z']);
    expect(day.endsAtMs - day.startsAtMs).toBe(23 * HOUR_MS);
  });

  it('is 25 hours on the Warsaw fall-back date (03:00 -> 02:00 on 25 October 2026)', () => {
    const day = localDayInterval('2026-10-25', 'Europe/Warsaw');
    expect([iso(day.startsAtMs), iso(day.endsAtMs)]).toEqual(['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
    expect(day.endsAtMs - day.startsAtMs).toBe(25 * HOUR_MS);
  });

  it('places neighbouring days edge to edge, so an instant belongs to exactly one date', () => {
    for (const [date, next] of [
      ['2026-03-28', '2026-03-29'],
      ['2026-03-29', '2026-03-30'],
      ['2026-10-24', '2026-10-25'],
      ['2026-10-25', '2026-10-26'],
      ['2026-12-31', '2027-01-01'],
    ] as const) {
      expect(localDayInterval(date, 'Europe/Warsaw').endsAtMs).toBe(localDayInterval(next, 'Europe/Warsaw').startsAtMs);
    }
  });

  it('follows the zone, not UTC: the same date starts 25 hours apart in Kiritimati and Pago Pago', () => {
    const east = localDayInterval('2026-11-08', 'Pacific/Kiritimati');
    const west = localDayInterval('2026-11-08', 'Pacific/Pago_Pago');
    expect(iso(east.startsAtMs)).toBe('2026-11-07T10:00:00.000Z');
    expect(iso(west.startsAtMs)).toBe('2026-11-08T11:00:00.000Z');
  });
});

const emptyRecords = { check_in: null, movement: null };
const emptyStarted = { activities: [], gps_runs: { count: 0, currentDistanceM: null, withCurrentDistance: 0 } };
const base = {
  computedAt: '2026-11-08T10:00:00.000Z',
  dayRecords: emptyRecords,
  interval: localDayInterval('2026-11-08', 'Europe/Warsaw'),
  localDate: '2026-11-08',
  started: emptyStarted,
  timeZone: 'Europe/Warsaw',
  today: '2026-11-08',
};

describe('buildDailyOverview', () => {
  it('builds an empty day with its interval, version and provenance', () => {
    expect(buildDailyOverview(base)).toEqual({
      checkIn: { recorded: false },
      day: { endsAt: '2026-11-08T23:00:00.000Z', inProgress: true, localDate: '2026-11-08', startsAt: '2026-11-07T23:00:00.000Z', timeZone: 'Europe/Warsaw' },
      gpsRuns: { count: 0, currentDistanceM: null, withCurrentDistance: 0, withoutCurrentDistance: 0 },
      manualActivities: { byType: [], count: 0, enteredDurationS: 0 },
      movement: { recorded: false },
      provenance: {
        computedAt: '2026-11-08T10:00:00.000Z',
        overviewVersion: DAILY_OVERVIEW_VERSION,
        persisted: false,
        snapshot: 'single_read_only_transaction',
        source: 'computed_by_app',
      },
    });
    expect(buildDailyOverview({ ...base, today: '2026-11-09' }).day.inProgress).toBe(false);
  });

  it('keeps a note-only check-in as a record, a recorded zero as zero and the stored zones as stored', () => {
    const overview = buildDailyOverview({
      ...base,
      dayRecords: {
        check_in: { hasNote: true, mood: null, sleepMinutes: null, sleepQuality: null, soreness: null, timeZone: 'Asia/Tokyo', weightKg: null },
        movement: { activeEnergyKcal: '0.0', source: 'manual', steps: 0, timeZone: 'America/New_York' },
      },
    });
    expect(overview.checkIn).toEqual({
      hasNote: true,
      mood: null,
      recorded: true,
      sleepMinutes: null,
      sleepQuality: null,
      soreness: null,
      timeZone: 'Asia/Tokyo',
      weightKg: null,
    });
    expect(overview.movement).toEqual({ activeEnergyKcal: 0, recorded: true, source: 'manual', steps: 0, timeZone: 'America/New_York' });
    expect(overview.day.timeZone).toBe('Europe/Warsaw');
  });

  it('orders activity types, adds their counts and durations, and splits GPS runs by current distance', () => {
    const overview = buildDailyOverview({
      ...base,
      started: {
        activities: [
          { count: 1, enteredDurationS: 1200, type: 'strength' },
          { count: 2, enteredDurationS: 5400, type: 'run' },
          { count: 1, enteredDurationS: 600, type: 'walk' },
        ],
        gps_runs: { count: 3, currentDistanceM: 5012.4999, withCurrentDistance: 2 },
      },
    });
    expect(overview.manualActivities).toEqual({
      byType: [
        { count: 2, enteredDurationS: 5400, type: 'run' },
        { count: 1, enteredDurationS: 600, type: 'walk' },
        { count: 1, enteredDurationS: 1200, type: 'strength' },
      ],
      count: 4,
      enteredDurationS: 7200,
    });
    expect(overview.gpsRuns).toEqual({ count: 3, currentDistanceM: 5012, withCurrentDistance: 2, withoutCurrentDistance: 1 });
  });

  it('gives no distance when no run has a current summary, never zero', () => {
    const overview = buildDailyOverview({ ...base, started: { activities: [], gps_runs: { count: 2, currentDistanceM: null, withCurrentDistance: 0 } } });
    expect(overview.gpsRuns).toEqual({ count: 2, currentDistanceM: null, withCurrentDistance: 0, withoutCurrentDistance: 2 });
  });

  it('refuses rows the contract does not allow instead of passing them on', () => {
    expect(() =>
      buildDailyOverview({
        ...base,
        dayRecords: { check_in: null, movement: { activeEnergyKcal: null, source: 'healthkit', steps: 1, timeZone: 'UTC' } },
      }),
    ).toThrow();
  });
});
