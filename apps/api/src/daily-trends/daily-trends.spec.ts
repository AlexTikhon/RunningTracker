import { DAILY_TRENDS_VERSION, dailyTrendsSchema } from '@running-tracker/contracts';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import {
  buildDailyTrends,
  DailyTrendsService,
  dailyTrendsCheckInsSql,
  dailyTrendsFoodEnergySql,
  dailyTrendsStepsSql,
  trendDaysOf,
  type DailyTrendsSourceRows,
} from './daily-trends-service.js';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noRows: DailyTrendsSourceRows = { checkIns: [], foodEnergy: [], steps: [] };
const base = { computedAt: '2026-11-09T10:00:00.000Z', endDate: '2026-11-09', rows: noRows, timeZone: 'Europe/Warsaw', today: '2026-11-09' };

const clockAt = (iso: string): Clock => ({
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => 0,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(iso),
});

/** A pool whose one client answers the membership check, records every statement and returns the given source rows. */
function recordingPool(rows: DailyTrendsSourceRows = noRows) {
  const statements: Array<{ parameters: unknown[] | undefined; text: string }> = [];
  const client = {
    query: (text: string, parameters?: unknown[]) => {
      statements.push({ parameters, text });
      if (text.includes('FROM memberships')) return Promise.resolve({ rows: [{ allowed: true }] });
      if (text === dailyTrendsCheckInsSql) return Promise.resolve({ rows: rows.checkIns });
      if (text === dailyTrendsStepsSql) return Promise.resolve({ rows: rows.steps });
      if (text === dailyTrendsFoodEnergySql) return Promise.resolve({ rows: rows.foodEnergy });
      if (text === 'COMMIT') return Promise.resolve({ command: 'COMMIT', rows: [] });
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pick<Pool, 'connect'>;
  return { pool, statements };
}

describe('daily trends statements', () => {
  const sources = [dailyTrendsCheckInsSql, dailyTrendsStepsSql, dailyTrendsFoodEnergySql];

  it('name the organization, the owner and the inclusive date range in every statement, and take no zone', () => {
    for (const sql of sources) {
      expect(sql).toMatch(/\.org_id = \$1/u);
      expect(sql).toMatch(/\.user_id = \$2/u);
      expect(sql).toMatch(/\.local_date BETWEEN \$3::date AND \$4::date/u);
      expect(sql).not.toMatch(/\$5|time_zone|timestamptz|AT TIME ZONE/u);
    }
  });

  it('read manual movement and meals only, sum energy in numeric arithmetic, and select no free text', () => {
    expect(dailyTrendsStepsSql).toContain("movement.source = 'manual'");
    expect(dailyTrendsFoodEnergySql).toContain("meal.source = 'manual'");
    expect(dailyTrendsFoodEnergySql).toContain('sum(meal.energy_kcal)::text');
    expect(dailyTrendsFoodEnergySql).toContain('count(meal.energy_kcal)::integer');
    expect(dailyTrendsCheckInsSql).not.toMatch(/note/u);
    expect(dailyTrendsFoodEnergySql).not.toMatch(/title|meal_type|protein|carbohydrate|fat_g/u);
    expect(dailyTrendsStepsSql).not.toMatch(/active_energy/u);
  });
});

describe('trend days', () => {
  it('lists every date, a date without a value as null and a recorded zero as zero', () => {
    const days = trendDaysOf(['2026-11-07', '2026-11-08', '2026-11-09'], {
      checkIns: [{ local_date: '2026-11-08', sleep_minutes: 0, weight_kg: null }],
      foodEnergy: [{ entries_with_energy: 0, local_date: '2026-11-07', logged_entries: 2, recorded_kcal: null }],
      steps: [{ local_date: '2026-11-08', steps: 0 }],
    });
    expect(days).toEqual([
      { foodEnergy: { entriesWithEnergy: 0, loggedEntries: 2, recordedKcal: null }, localDate: '2026-11-07', sleepMinutes: null, steps: null, weightKg: null },
      { foodEnergy: { entriesWithEnergy: 0, loggedEntries: 0, recordedKcal: null }, localDate: '2026-11-08', sleepMinutes: 0, steps: 0, weightKg: null },
      { foodEnergy: { entriesWithEnergy: 0, loggedEntries: 0, recordedKcal: null }, localDate: '2026-11-09', sleepMinutes: null, steps: null, weightKg: null },
    ]);
  });

  it('parses numeric text exactly and refuses a row outside the range', () => {
    const [day] = trendDaysOf(['2026-11-09'], {
      checkIns: [{ local_date: '2026-11-09', sleep_minutes: null, weight_kg: '72.35' }],
      foodEnergy: [{ entries_with_energy: 2, local_date: '2026-11-09', logged_entries: 3, recorded_kcal: '1061.10' }],
      steps: [],
    });
    expect(day).toMatchObject({ foodEnergy: { recordedKcal: 1061.1 }, weightKg: 72.35 });
    expect(() => trendDaysOf(['2026-11-09'], { ...noRows, steps: [{ local_date: '2026-11-10', steps: 1 }] })).toThrow('outside the range');
  });
});

describe('buildDailyTrends', () => {
  it('answers an empty range: 28 dates, every value null, no totals, app-computed provenance', () => {
    const trends = buildDailyTrends(base);
    expect(trends.range).toEqual({
      days: 28,
      endDate: '2026-11-09',
      includesToday: true,
      requestedDays: 28,
      shortenedByLowerBound: false,
      startDate: '2026-10-13',
      timeZone: 'Europe/Warsaw',
      today: '2026-11-09',
    });
    expect(trends.days).toHaveLength(28);
    expect(trends.summary.steps.recordedTotal).toBeNull();
    expect(trends.summary.foodEnergy.recordedTotalKcal).toBeNull();
    expect(trends.provenance).toEqual({
      computedAt: base.computedAt,
      persisted: false,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
      trendsVersion: DAILY_TRENDS_VERSION,
    });
    expect(dailyTrendsSchema.parse(trends)).toEqual(trends);
  });

  it('shortens the range at the lower bound and uses the actual day count', () => {
    const trends = buildDailyTrends({ ...base, endDate: '2000-01-05', rows: { ...noRows, steps: [{ local_date: '2000-01-01', steps: 10 }] } });
    expect(trends.range).toMatchObject({ days: 5, includesToday: false, shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(trends.days.map((day) => day.localDate)).toEqual(['2000-01-01', '2000-01-02', '2000-01-03', '2000-01-04', '2000-01-05']);
    expect(trends.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 10, source: 'manual' });
  });

  it('summarizes sparse values with their own coverage and exact arithmetic', () => {
    const trends = buildDailyTrends({
      ...base,
      rows: {
        checkIns: [
          { local_date: '2026-10-14', sleep_minutes: 421, weight_kg: '72.35' },
          { local_date: '2026-10-20', sleep_minutes: 422, weight_kg: null },
          { local_date: '2026-11-08', sleep_minutes: null, weight_kg: '72.30' },
        ],
        foodEnergy: [
          { entries_with_energy: 1, local_date: '2026-10-14', logged_entries: 1, recorded_kcal: '0.1' },
          { entries_with_energy: 1, local_date: '2026-10-15', logged_entries: 2, recorded_kcal: '0.2' },
          { entries_with_energy: 0, local_date: '2026-10-16', logged_entries: 1, recorded_kcal: null },
        ],
        steps: [{ local_date: '2026-10-20', steps: 0 }],
      },
    });
    expect(trends.summary).toEqual({
      foodEnergy: { daysWithEnergy: 2, daysWithEntries: 3, entriesWithEnergy: 2, loggedEntries: 4, recordedTotalKcal: 0.3, source: 'manual' },
      sleep: { averageMinutes: 422, daysRecorded: 2, recordedTotalMinutes: 843 },
      steps: { daysRecorded: 1, recordedTotal: 0, source: 'manual' },
      weight: { changeKg: -0.05, daysRecorded: 2, first: { kg: 72.35, localDate: '2026-10-14' }, last: { kg: 72.3, localDate: '2026-11-08' } },
    });
  });
});

describe('DailyTrendsService', () => {
  it('reads three range statements and nothing per date, after the membership check, with the range bounds', async () => {
    const { pool, statements } = recordingPool();
    const service = new DailyTrendsService({ clock: clockAt('2026-11-09T10:00:00.000Z'), pool });
    const trends = await service.read({ userId: USER }, ORG, { endDate: '2026-11-09', timeZone: 'Europe/Warsaw' });
    expect(trends.days).toHaveLength(28);
    const sources = statements.filter((statement) => statement.text.includes('/* daily-trends:'));
    expect(sources.map((statement) => statement.text)).toEqual([dailyTrendsCheckInsSql, dailyTrendsStepsSql, dailyTrendsFoodEnergySql]);
    for (const statement of sources) expect(statement.parameters).toEqual([ORG, USER, '2026-10-13', '2026-11-09']);
    const membership = statements.findIndex((statement) => statement.text.includes('FROM memberships'));
    expect(membership).toBeGreaterThanOrEqual(0);
    expect(membership).toBeLessThan(statements.indexOf(sources[0]!));
    expect(statements.some((statement) => /REPEATABLE READ/u.test(statement.text) && /READ ONLY/u.test(statement.text))).toBe(true);
  });

  it('refuses an end date after today in the requested zone by the injected clock, before reading', async () => {
    const { pool, statements } = recordingPool();
    // 2026-11-09T10:30Z: already 10 November in Kiritimati (UTC+14), still 9 November in Warsaw.
    const service = new DailyTrendsService({ clock: clockAt('2026-11-09T10:30:00.000Z'), pool });
    await expect(service.read({ userId: USER }, ORG, { endDate: '2026-11-10', timeZone: 'Pacific/Kiritimati' })).resolves.toMatchObject({
      range: { includesToday: true, today: '2026-11-10' },
    });
    const before = statements.length;
    const refusal = await service.read({ userId: USER }, ORG, { endDate: '2026-11-10', timeZone: 'Europe/Warsaw' }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ code: 'INVALID_REQUEST', message: 'The end date cannot be after today (2026-11-09 in Europe/Warsaw)', statusCode: 400 });
    expect(statements.length).toBe(before);
  });

  it('follows the zone across a daylight saving midnight for "today" without moving any record', async () => {
    // 2026-03-28T23:30Z is 00:30 on 29 March in Warsaw (CET, before the 02:00 change) and still 28 March in London.
    const { pool } = recordingPool({ ...noRows, steps: [{ local_date: '2026-03-29', steps: 5 }] });
    const service = new DailyTrendsService({ clock: clockAt('2026-03-28T23:30:00.000Z'), pool });
    const warsaw = await service.read({ userId: USER }, ORG, { endDate: '2026-03-29', timeZone: 'Europe/Warsaw' });
    expect(warsaw.range).toMatchObject({ includesToday: true, today: '2026-03-29' });
    expect(warsaw.days.at(-1)).toMatchObject({ localDate: '2026-03-29', steps: 5 });
    await expect(service.read({ userId: USER }, ORG, { endDate: '2026-03-29', timeZone: 'Europe/London' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
