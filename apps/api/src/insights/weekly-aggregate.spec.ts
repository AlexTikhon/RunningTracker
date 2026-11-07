import { describe, expect, it } from 'vitest';

import {
  aggregateWeek,
  canonicalJson,
  hasExtremeValues,
  resolveWeekWindow,
  roundTo,
  type CheckInRecord,
  type GpsRunRecord,
  type ManualActivityRecord,
} from './weekly-aggregate.js';
import { inputHashOf, weekSourcesSql } from './weekly-insight-service.js';

const WEEK = '2026-11-02'; // a Monday; Europe/Warsaw is on CET (UTC+1) all week
const day = (offset: number) => `2026-11-0${2 + offset}`;
const at = (iso: string) => Date.parse(iso);

function checkIn(localDate: string, values: Partial<CheckInRecord> = {}): CheckInRecord {
  return {
    localDate,
    mood: null,
    sleepMinutes: null,
    sleepQuality: null,
    soreness: null,
    timeZone: 'Europe/Warsaw',
    weightKg: null,
    ...values,
  };
}

function activity(startedAt: string, values: Partial<ManualActivityRecord> = {}): ManualActivityRecord {
  return { distanceM: null, durationS: 1800, startedAtMs: at(startedAt), type: 'run', ...values };
}

function gpsRun(startedAt: string, minutes: number, distanceM: number | null): GpsRunRecord {
  return { distanceM, finishedAtMs: at(startedAt) + minutes * 60_000, startedAtMs: at(startedAt) };
}

function build(input: {
  activities?: ManualActivityRecord[];
  checkIns?: CheckInRecord[];
  gpsRuns?: GpsRunRecord[];
  requestTimeZone?: string;
  today?: string;
  weekStart?: string;
}) {
  const checkIns = input.checkIns ?? [];
  const window = resolveWeekWindow({
    checkIns,
    requestTimeZone: input.requestTimeZone ?? 'Europe/Warsaw',
    weekStart: input.weekStart ?? WEEK,
  });
  return aggregateWeek({
    activities: input.activities ?? [],
    checkIns,
    gpsRuns: input.gpsRuns ?? [],
    todayLocalDate: input.today ?? '2026-11-20',
    window,
  });
}

describe('weekly aggregation (ADR-0076)', () => {
  it('summarises an empty week as zero coverage, null values and the matching flags', () => {
    const aggregate = build({});
    expect(aggregate.checkIns).toEqual({ coveragePercent: 0, daysInWeek: 7, daysMissing: 7, daysWithData: 0 });
    expect(aggregate.sleep).toEqual({
      avgHours: null,
      avgMinutes: null,
      avgQuality: null,
      daysReported: 0,
      maxDay: null,
      maxMinutes: null,
      minDay: null,
      minMinutes: null,
      qualityDaysReported: 0,
    });
    expect(aggregate.mood.byDay.map((entry) => entry.value)).toEqual(Array(7).fill(null));
    expect(aggregate.mood.byDay.map((entry) => entry.day)).toEqual([
      'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    ]);
    expect(aggregate.weight).toEqual({ daysReported: 0, deltaKg: null, firstDay: null, firstKg: null, lastDay: null, lastKg: null });
    expect(aggregate.manualActivities).toEqual({ byType: {}, count: 0, totalDurationMinutes: 0 });
    expect(aggregate.gpsRuns).toEqual({ count: 0, distanceKm: null, runsWithCurrentDistance: 0, runsWithoutCurrentDistance: 0, totalDurationMinutes: 0 });
    expect(aggregate.flags).toEqual(['no_activities', 'no_check_ins']);
    expect(aggregate.week).toEqual({
      end: '2026-11-08',
      inProgress: false,
      start: WEEK,
      timeZone: 'Europe/Warsaw',
      timeZoneSource: 'request',
    });
  });

  it('computes a partial week: averages over reported days, day-by-day values with gaps, weight first/last/delta', () => {
    const aggregate = build({
      checkIns: [
        checkIn(day(0), { mood: 4, sleepMinutes: 450, sleepQuality: 4, soreness: 2, weightKg: 72.4 }),
        checkIn(day(2), { mood: 3, sleepMinutes: 405, soreness: 5 }),
        checkIn(day(5), { mood: 2, sleepMinutes: 500, sleepQuality: 3, soreness: 3, weightKg: 71.85 }),
      ],
    });
    expect(aggregate.checkIns).toEqual({ coveragePercent: 43, daysInWeek: 7, daysMissing: 4, daysWithData: 3 });
    expect(aggregate.sleep).toEqual({
      avgHours: 7.5,
      avgMinutes: 452,
      avgQuality: 3.5,
      daysReported: 3,
      maxDay: 'Saturday',
      maxMinutes: 500,
      minDay: 'Wednesday',
      minMinutes: 405,
      qualityDaysReported: 2,
    });
    expect(aggregate.mood).toEqual({
      average: 3,
      byDay: [
        { day: 'Monday', value: 4 },
        { day: 'Tuesday', value: null },
        { day: 'Wednesday', value: 3 },
        { day: 'Thursday', value: null },
        { day: 'Friday', value: null },
        { day: 'Saturday', value: 2 },
        { day: 'Sunday', value: null },
      ],
      daysReported: 3,
    });
    expect(aggregate.soreness.average).toBe(3.3);
    expect(aggregate.soreness.max).toBe(5);
    expect(aggregate.soreness.maxDay).toBe('Wednesday');
    expect(aggregate.weight).toEqual({
      daysReported: 2,
      deltaKg: -0.55,
      firstDay: 'Monday',
      firstKg: 72.4,
      lastDay: 'Saturday',
      lastKg: 71.85,
    });
    expect(aggregate.flags).toEqual(['no_activities', 'sparse_check_ins']);
    expect(aggregate.week.timeZoneSource).toBe('check_ins');
  });

  it('computes a full week with full coverage, and a single weight has no delta', () => {
    const checkIns = Array.from({ length: 7 }, (_unused, index) =>
      checkIn(day(index), { mood: 3, sleepMinutes: 420 + index, weightKg: index === 3 ? 70 : null }),
    );
    const aggregate = build({ checkIns });
    expect(aggregate.checkIns).toEqual({ coveragePercent: 100, daysInWeek: 7, daysMissing: 0, daysWithData: 7 });
    expect(aggregate.sleep.avgMinutes).toBe(423);
    expect(aggregate.weight).toMatchObject({ daysReported: 1, deltaKg: null, firstDay: 'Thursday', firstKg: 70, lastKg: 70 });
    expect(aggregate.flags).not.toContain('sparse_check_ins');
    expect(aggregate.flags).not.toContain('no_check_ins');
  });

  it('counts a note-only day as no data (notes are never model input)', () => {
    const aggregate = build({ checkIns: [checkIn(day(1))] });
    expect(aggregate.checkIns.daysWithData).toBe(0);
    expect(aggregate.flags).toContain('no_check_ins');
  });

  it('reports manual activities by type and GPS runs separately, never adding run distances across sources', () => {
    const aggregate = build({
      activities: [
        activity('2026-11-03T06:00:00Z', { distanceM: 5000, durationS: 1500, type: 'run' }),
        activity('2026-11-04T06:00:00Z', { distanceM: null, durationS: 2700, type: 'strength' }),
        activity('2026-11-05T06:00:00Z', { distanceM: 2500, durationS: 1530, type: 'run' }),
      ],
      gpsRuns: [gpsRun('2026-11-03T06:00:00Z', 25, 5012.4), gpsRun('2026-11-06T06:00:00Z', 40, null)],
    });
    expect(aggregate.manualActivities).toEqual({
      byType: {
        run: { count: 2, distanceKm: 7.5, durationMinutes: 51 },
        strength: { count: 1, distanceKm: null, durationMinutes: 45 },
      },
      count: 3,
      totalDurationMinutes: 96,
    });
    expect(aggregate.gpsRuns).toEqual({ count: 2, distanceKm: 5.01, runsWithCurrentDistance: 1, runsWithoutCurrentDistance: 1, totalDurationMinutes: 65 });
    expect(aggregate.flags).toEqual(
      expect.arrayContaining(['manual_and_gps_runs_may_overlap', 'gps_distance_pending', 'no_check_ins']),
    );
    // No combined figure exists anywhere: 7.5 + 5.01 is not a value of the aggregate.
    expect(canonicalJson(aggregate)).not.toContain('12.51');
  });

  it('flags the overlap only when both manual runs and GPS runs exist', () => {
    expect(build({ activities: [activity('2026-11-03T06:00:00Z', { type: 'walk' })], gpsRuns: [gpsRun('2026-11-03T07:00:00Z', 20, 3000)] }).flags)
      .not.toContain('manual_and_gps_runs_may_overlap');
    expect(build({ activities: [activity('2026-11-03T06:00:00Z')] }).flags).not.toContain('manual_and_gps_runs_may_overlap');
  });

  it('places the week boundaries at local midnight: Europe/Warsaw versus UTC', () => {
    const warsaw = resolveWeekWindow({ checkIns: [], requestTimeZone: 'Europe/Warsaw', weekStart: WEEK });
    const utc = resolveWeekWindow({ checkIns: [], requestTimeZone: 'UTC', weekStart: WEEK });
    expect(new Date(warsaw.rangeStartMs).toISOString()).toBe('2026-11-01T23:00:00.000Z');
    expect(new Date(warsaw.rangeEndMs).toISOString()).toBe('2026-11-08T23:00:00.000Z');
    expect(new Date(utc.rangeStartMs).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(new Date(utc.rangeEndMs).toISOString()).toBe('2026-11-09T00:00:00.000Z');

    const sundayLateUtc = activity('2026-11-01T23:30:00Z', { type: 'walk' }); // Monday 00:30 in Warsaw
    const sundayNightUtc = activity('2026-11-08T23:30:00Z', { type: 'ride' }); // next Monday 00:30 in Warsaw
    const exactStart = activity('2026-11-01T23:00:00Z', { type: 'hike' }); // Monday 00:00:00 in Warsaw: inside
    const justBeforeEnd = activity('2026-11-08T22:59:59.999Z', { type: 'swim' }); // Sunday 23:59:59.999 in Warsaw
    const activities = [sundayLateUtc, sundayNightUtc, exactStart, justBeforeEnd];

    expect(Object.keys(build({ activities, requestTimeZone: 'Europe/Warsaw' }).manualActivities.byType).sort()).toEqual([
      'hike',
      'swim',
      'walk',
    ]);
    expect(Object.keys(build({ activities, requestTimeZone: 'UTC' }).manualActivities.byType).sort()).toEqual([
      'ride',
      'swim',
    ]);
  });

  it('handles the spring daylight-saving week (167 hours) in Europe/Warsaw', () => {
    const window = resolveWeekWindow({ checkIns: [], requestTimeZone: 'Europe/Warsaw', weekStart: '2026-03-23' });
    expect(new Date(window.rangeStartMs).toISOString()).toBe('2026-03-22T23:00:00.000Z');
    expect(new Date(window.rangeEndMs).toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect((window.rangeEndMs - window.rangeStartMs) / 3_600_000).toBe(167);
    const aggregate = build({
      activities: [
        activity('2026-03-29T21:30:00Z', { type: 'walk' }), // Sunday 23:30 CEST: inside
        activity('2026-03-29T22:30:00Z', { type: 'ride' }), // Monday 00:30 CEST: next week
      ],
      weekStart: '2026-03-23',
    });
    expect(Object.keys(aggregate.manualActivities.byType)).toEqual(['walk']);
  });

  it('handles the autumn daylight-saving week (169 hours) in Europe/Warsaw', () => {
    const window = resolveWeekWindow({ checkIns: [], requestTimeZone: 'Europe/Warsaw', weekStart: '2026-10-19' });
    expect(new Date(window.rangeStartMs).toISOString()).toBe('2026-10-18T22:00:00.000Z');
    expect(new Date(window.rangeEndMs).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect((window.rangeEndMs - window.rangeStartMs) / 3_600_000).toBe(169);
    const aggregate = build({
      activities: [
        activity('2026-10-18T21:30:00Z', { type: 'walk' }), // Sunday 23:30 CEST, previous week
        activity('2026-10-25T22:30:00Z', { type: 'ride' }), // Sunday 23:30 CET: inside
      ],
      weekStart: '2026-10-19',
    });
    expect(Object.keys(aggregate.manualActivities.byType)).toEqual(['ride']);
  });

  it('reads the week in the zone stored on the check-ins, the most frequent first, and falls back to the request zone', () => {
    const tokyo = (date: string) => checkIn(date, { mood: 3, timeZone: 'Asia/Tokyo' });
    const warsaw = (date: string) => checkIn(date, { mood: 3, timeZone: 'Europe/Warsaw' });
    const majority = resolveWeekWindow({ checkIns: [warsaw(day(0)), tokyo(day(1)), tokyo(day(2))], requestTimeZone: 'UTC', weekStart: WEEK });
    expect(majority).toMatchObject({ timeZone: 'Asia/Tokyo', timeZoneSource: 'check_ins', zonesOnCheckIns: ['Asia/Tokyo', 'Europe/Warsaw'] });
    const tie = resolveWeekWindow({ checkIns: [tokyo(day(3)), warsaw(day(1))], requestTimeZone: 'UTC', weekStart: WEEK });
    expect(tie.timeZone).toBe('Europe/Warsaw');
    const outside = resolveWeekWindow({ checkIns: [tokyo('2026-11-09')], requestTimeZone: 'UTC', weekStart: WEEK });
    expect(outside).toMatchObject({ timeZone: 'UTC', timeZoneSource: 'request' });
    expect(build({ checkIns: [warsaw(day(0)), tokyo(day(1))] }).flags).toContain('multiple_time_zones');
  });

  it('flags extreme soreness and sleep at the documented thresholds', () => {
    const flagsFor = (values: Partial<CheckInRecord>) => build({ checkIns: [checkIn(day(0), values)] }).flags;
    expect(flagsFor({ soreness: 8 })).toContain('extreme_soreness');
    expect(flagsFor({ soreness: 7 })).not.toContain('extreme_soreness');
    expect(flagsFor({ sleepMinutes: 239 })).toContain('extreme_short_sleep');
    expect(flagsFor({ sleepMinutes: 240 })).not.toContain('extreme_short_sleep');
    expect(flagsFor({ sleepMinutes: 721 })).toContain('extreme_long_sleep');
    expect(flagsFor({ sleepMinutes: 720 })).not.toContain('extreme_long_sleep');
    expect(hasExtremeValues({ flags: ['extreme_soreness'] })).toBe(true);
    expect(hasExtremeValues({ flags: ['large_weight_change', 'sparse_check_ins'] })).toBe(false);
  });

  it('flags a weight change of two kilograms or more and the week in progress', () => {
    const jump = build({ checkIns: [checkIn(day(0), { weightKg: 70 }), checkIn(day(6), { weightKg: 72 })] });
    expect(jump.weight.deltaKg).toBe(2);
    expect(jump.flags).toContain('large_weight_change');
    const small = build({ checkIns: [checkIn(day(0), { weightKg: 70 }), checkIn(day(6), { weightKg: 71.99 })] });
    expect(small.flags).not.toContain('large_weight_change');
    const current = build({ today: '2026-11-04' });
    expect(current.week.inProgress).toBe(true);
    expect(current.flags).toContain('week_in_progress');
  });

  it('ignores records outside the week whatever the caller passes', () => {
    const aggregate = build({
      activities: [activity('2026-10-30T10:00:00Z'), activity('2026-11-10T10:00:00Z')],
      checkIns: [checkIn('2026-11-01', { mood: 5 }), checkIn('2026-11-09', { mood: 1 })],
      gpsRuns: [gpsRun('2026-11-12T10:00:00Z', 30, 5000)],
    });
    expect(aggregate.checkIns.daysWithData).toBe(0);
    expect(aggregate.manualActivities.count).toBe(0);
    expect(aggregate.gpsRuns.count).toBe(0);
  });

  it('is deterministic: the order of the records changes neither the aggregate nor its input hash', () => {
    const checkIns = [checkIn(day(4), { mood: 2 }), checkIn(day(1), { mood: 4, weightKg: 70.1 }), checkIn(day(6), { weightKg: 70.5 })];
    const activities = [activity('2026-11-05T06:00:00Z', { type: 'swim' }), activity('2026-11-03T06:00:00Z')];
    const first = build({ activities, checkIns });
    const second = build({ activities: activities.toReversed(), checkIns: checkIns.toReversed() });
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(inputHashOf(second)).toBe(inputHashOf(first));
    expect(inputHashOf(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(inputHashOf(build({ activities, checkIns: checkIns.slice(1) }))).not.toBe(inputHashOf(first));
  });

  it('rounds half away from zero without producing negative zero', () => {
    expect(roundTo(2.345, 2)).toBe(2.35);
    expect(roundTo(-2.345, 2)).toBe(-2.35);
    expect(Object.is(roundTo(-0.001, 2), 0)).toBe(true);
    expect(roundTo(452.5, 0)).toBe(453);
  });

  it('never selects notes, activity effort, coordinates or identifiers for the model input', () => {
    expect(weekSourcesSql).not.toMatch(/\bnotes?\b/u);
    expect(weekSourcesSql).not.toMatch(/\brpe\b/u);
    expect(weekSourcesSql).not.toMatch(/geom|point|latitude|longitude/u);
    expect(weekSourcesSql).not.toMatch(/'id'|'runId'|'userId'/u);
    // A GPS distance only from a summary that is current for the run's data.
    expect(weekSourcesSql).toContain('summary.source_revision = run.data_revision');
  });
});
