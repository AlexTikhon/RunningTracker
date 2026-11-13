import { ACTIVITY_TRENDS_COMPARISON_VERSION, ACTIVITY_TRENDS_VERSION, activityTrendsSchema, type ActivityTrendsQuery } from '@running-tracker/contracts';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import {
  activityTrendsActivitiesComparisonSql,
  activityTrendsActivitiesSql,
  activityTrendsComparisonWindowOf,
  activityTrendsIntervalOf,
  activityTrendsRecordedRunsComparisonSql,
  activityTrendsRecordedRunsSql,
  ActivityTrendsService,
  buildActivityTrends,
  buildActivityTrendsComparison,
  type ActivityTrendsActivityComparisonRow,
  type ActivityTrendsActivityRow,
  type ActivityTrendsRunComparisonRow,
  type ActivityTrendsRunRow,
} from './activity-trends-service.js';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WARSAW = 'Europe/Warsaw';

const clockAt = (iso: string): Clock => ({
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => 0,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(iso),
});

const query = (values: Partial<ActivityTrendsQuery> = {}): ActivityTrendsQuery => ({
  endDate: '2026-11-12',
  source: 'manual',
  timeZone: WARSAW,
  type: 'ride',
  ...values,
});

const EMPTY_ACTIVITY_RANGE: ActivityTrendsActivityRow = {
  count: 0,
  day_number: null,
  days_with_distance: 0,
  days_with_entries: 0,
  distance_m: null,
  duration_s: null,
  with_distance: 0,
};
const EMPTY_RUN_RANGE: ActivityTrendsRunRow = {
  count: 0,
  current: 0,
  day_number: null,
  days_with_entries: 0,
  days_with_value: 0,
  distance_m: null,
  observed_duration_s: null,
  pending: 0,
  stale: 0,
};

const NO_PERCENT = { count_percent_tenths: null, distance_percent_tenths: null, duration_percent_tenths: null };
// Both periods without an item: the statement still returns one row per period and the change row.
const EMPTY_ACTIVITY_COMPARISON = [
  { ...EMPTY_ACTIVITY_RANGE, ...NO_PERCENT, row_kind: 'current' },
  { ...EMPTY_ACTIVITY_RANGE, ...NO_PERCENT, row_kind: 'previous' },
  { ...EMPTY_ACTIVITY_RANGE, ...NO_PERCENT, days_with_distance: null, days_with_entries: null, row_kind: 'change', with_distance: null },
];
const EMPTY_RUN_COMPARISON = [
  { ...EMPTY_RUN_RANGE, ...NO_PERCENT, row_kind: 'current' },
  { ...EMPTY_RUN_RANGE, ...NO_PERCENT, row_kind: 'previous' },
  { ...EMPTY_RUN_RANGE, ...NO_PERCENT, current: null, days_with_entries: null, days_with_value: null, pending: null, row_kind: 'change', stale: null },
];

/** A pool whose one client answers the membership check, records every statement and returns the given rows. */
function recordingPool(rows: { activities?: ActivityTrendsActivityRow[]; runs?: ActivityTrendsRunRow[] } = {}) {
  const statements: Array<{ parameters: unknown[] | undefined; text: string }> = [];
  const client = {
    query: (text: string, parameters?: unknown[]) => {
      statements.push({ parameters, text });
      if (text.includes('FROM memberships')) return Promise.resolve({ rows: [{ allowed: true }] });
      if (text === activityTrendsActivitiesSql) return Promise.resolve({ rows: rows.activities ?? [EMPTY_ACTIVITY_RANGE] });
      if (text === activityTrendsRecordedRunsSql) return Promise.resolve({ rows: rows.runs ?? [EMPTY_RUN_RANGE] });
      if (text === activityTrendsActivitiesComparisonSql) return Promise.resolve({ rows: EMPTY_ACTIVITY_COMPARISON });
      if (text === activityTrendsRecordedRunsComparisonSql) return Promise.resolve({ rows: EMPTY_RUN_COMPARISON });
      if (text === 'COMMIT') return Promise.resolve({ command: 'COMMIT', rows: [] });
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pick<Pool, 'connect'>;
  return { pool, statements };
}

describe('activity trends statements', () => {
  it('name the organization and the owner, bound the range, and bucket by the given date starts', () => {
    for (const sql of [activityTrendsActivitiesSql, activityTrendsRecordedRunsSql]) {
      expect(sql).toMatch(/\.org_id = \$1/u);
      expect(sql).toMatch(/\.user_id = \$2/u);
      expect(sql).toMatch(/started_at >= \$4::timestamptz/u);
      expect(sql).toMatch(/started_at < \$5::timestamptz/u);
      expect(sql).toContain('UNION ALL');
      expect(sql).toMatch(/ORDER BY day_number NULLS LAST$/u);
      expect(sql).toMatch(/width_bucket\(\w+\.started_at, \$3::timestamptz\[\]\)/u);
      // The zone is never given to PostgreSQL: the service locates every date's start from the zone's rules.
      expect(sql).not.toMatch(/AT TIME ZONE|time_zone|interval '1 day'/u);
    }
  });

  it('round floating-point sums once per date, halves up, without round() or a numeric cast, and add the rounded dates', () => {
    for (const sql of [activityTrendsActivitiesSql, activityTrendsRecordedRunsSql]) {
      // round(double precision) rounds halves to even; ::numeric keeps 15 significant digits.
      expect(sql).not.toMatch(/\bround\(|::numeric/u);
      expect(sql).toContain('(floor(distance_sum) + CASE WHEN distance_sum - floor(distance_sum) >= 0.5 THEN 1 ELSE 0 END)::bigint');
      expect(sql).toContain('sum(distance_m)::text');
      expect(sql).toMatch(/FROM rounded\n UNION ALL|FROM rounded\nUNION ALL/u);
    }
  });

  it('filter activities by one source and one type, and select no free text or single row', () => {
    expect(activityTrendsActivitiesSql).toContain('activity.source = $6::text');
    expect(activityTrendsActivitiesSql).toContain('activity.type = $7::text');
    expect(activityTrendsActivitiesSql).not.toMatch(/notes|rpe|activity\.id|LIMIT|OFFSET/u);
  });

  it('read only the owner’s finished runs and take metrics from current summaries only', () => {
    expect(activityTrendsRecordedRunsSql).toContain("run.status = 'finished'");
    expect(activityTrendsRecordedRunsSql).toContain('found.org_id = $1 AND found.org_id = run.org_id AND found.run_id = run.id');
    // A lookup per run of the range (ADR-0089 plan evidence), never flattened into a join over every summary.
    expect(activityTrendsRecordedRunsSql).toMatch(/LEFT JOIN LATERAL \([\s\S]*OFFSET 0\) AS summary ON true/u);
    expect(activityTrendsRecordedRunsSql).not.toMatch(/run_shares|run_points|display_geom/u);
    for (const metric of ['observed_duration_s', 'distance_m']) {
      expect(activityTrendsRecordedRunsSql).toContain(`sum(summary.${metric}) FILTER (WHERE summary.source_revision = run.data_revision)`);
    }
  });
});

describe('activity trends interval', () => {
  it('gives every date its local midnight-to-midnight interval, 23 hours in spring and 25 in autumn (Warsaw)', () => {
    const spring = activityTrendsIntervalOf('2026-04-10', WARSAW);
    const short = spring.days.find((day) => day.localDate === '2026-03-29')!;
    expect(short).toEqual({ endsAt: '2026-03-29T22:00:00.000Z', localDate: '2026-03-29', startsAt: '2026-03-28T23:00:00.000Z' });
    const autumn = activityTrendsIntervalOf('2026-11-12', WARSAW);
    const long = autumn.days.find((day) => day.localDate === '2026-10-25')!;
    expect(long).toEqual({ endsAt: '2026-10-25T23:00:00.000Z', localDate: '2026-10-25', startsAt: '2026-10-24T22:00:00.000Z' });
    expect(autumn.days).toHaveLength(28);
    expect(autumn.startDate).toBe('2026-10-16');
    expect(autumn.startsAt).toBe('2026-10-15T22:00:00.000Z');
    expect(autumn.endsAt).toBe('2026-11-12T23:00:00.000Z');
    // The intervals tile the range.
    autumn.days.slice(1).forEach((day, index) => expect(day.startsAt).toBe(autumn.days[index]!.endsAt));
  });

  it('is cut short by 2000-01-01 and says so', () => {
    const interval = activityTrendsIntervalOf('2000-01-03', 'Pacific/Kiritimati');
    expect(interval.days.map((day) => day.localDate)).toEqual(['2000-01-01', '2000-01-02', '2000-01-03']);
    expect(interval.shortenedByLowerBound).toBe(true);
    // Kiritimati has been UTC+14 since 1995: its 2000-01-01 began at 10:00 UTC on 1999-12-31.
    expect(interval.startsAt).toBe('1999-12-31T10:00:00.000Z');
  });
});

describe('building activity trends', () => {
  const base = { computedAt: '2026-11-12T10:00:00.000Z', interval: activityTrendsIntervalOf('2026-11-12', WARSAW), timeZone: WARSAW, today: '2026-11-12' };
  const day = (values: Partial<ActivityTrendsActivityRow> & Pick<ActivityTrendsActivityRow, 'count' | 'day_number'>): ActivityTrendsActivityRow => ({
    days_with_distance: null,
    days_with_entries: null,
    distance_m: null,
    duration_s: null,
    with_distance: 0,
    ...values,
  });

  it('takes daily and range figures from the statement and keeps no entries, unknown distance and recorded zero apart', () => {
    const trends = buildActivityTrends({
      ...base,
      query: query(),
      rows: {
        activities: [
          day({ count: 3, day_number: 1, distance_m: '12345', duration_s: '9000', with_distance: 2 }),
          day({ count: 2, day_number: 27, duration_s: '5400' }),
          day({ count: 1, day_number: 28, distance_m: '0', duration_s: '600', with_distance: 1 }),
          { count: 6, day_number: null, days_with_distance: 2, days_with_entries: 3, distance_m: '12345', duration_s: '15000', with_distance: 3 },
        ],
      },
    });
    expect(trends.source).toBe('manual');
    if (trends.source !== 'manual') throw new Error('unreachable');
    expect(trends.days[0]).toMatchObject({ count: 3, distance: { totalM: 12_345, withValue: 2 }, enteredDuration: { totalS: 9_000, withValue: 3 }, localDate: '2026-10-16' });
    expect(trends.days[1]).toMatchObject({ count: 0, distance: { totalM: null, withValue: 0 }, enteredDuration: { totalS: null, withValue: 0 } });
    expect(trends.days[26]).toMatchObject({ count: 2, distance: { totalM: null, withValue: 0 }, enteredDuration: { totalS: 5_400, withValue: 2 } });
    expect(trends.days[27]).toMatchObject({ count: 1, distance: { totalM: 0, withValue: 1 }, localDate: '2026-11-12' });
    expect(trends.summary).toEqual({
      count: 6,
      daysWithEntries: 3,
      distance: { daysWithValue: 2, totalM: 12_345, withValue: 3 },
      enteredDuration: { daysWithValue: 3, totalS: 15_000, withValue: 6 },
    });
    expect(trends.applied).toEqual({ endDate: '2026-11-12', source: 'manual', timeZone: WARSAW, type: 'ride' });
    expect(trends.provenance).toMatchObject({ persisted: false, policyVersion: ACTIVITY_TRENDS_VERSION, snapshot: 'single_read_only_transaction' });
    expect(trends.range).toMatchObject({ days: 28, includesToday: true, shortenedByLowerBound: false, startDate: '2026-10-16' });
    expect(activityTrendsSchema.parse(trends)).toEqual(trends);
  });

  it('builds an empty range from the range row alone', () => {
    const trends = buildActivityTrends({ ...base, query: query(), rows: { activities: [EMPTY_ACTIVITY_RANGE] } });
    expect(trends.summary).toEqual({
      count: 0,
      daysWithEntries: 0,
      distance: { daysWithValue: 0, totalM: null, withValue: 0 },
      enteredDuration: { daysWithValue: 0, totalS: null, withValue: 0 },
    });
    expect(trends.days.every((entry) => entry.count === 0)).toBe(true);
  });

  it('names the GPX duration as elapsed', () => {
    const trends = buildActivityTrends({
      ...base,
      query: query({ source: 'gpx', type: 'hike' }),
      rows: {
        activities: [
          day({ count: 1, day_number: 5, distance_m: '10400', duration_s: '4000', with_distance: 1 }),
          { count: 1, day_number: null, days_with_distance: 1, days_with_entries: 1, distance_m: '10400', duration_s: '4000', with_distance: 1 },
        ],
      },
    });
    expect(trends.source).toBe('gpx');
    expect(trends.days[4]).toEqual(expect.objectContaining({ elapsedDuration: { totalS: 4_000, withValue: 1 } }));
    expect(Object.keys(trends.days[4]!)).not.toContain('enteredDuration');
    expect(trends.summary).toMatchObject({ elapsedDuration: { daysWithValue: 1, totalS: 4_000, withValue: 1 } });
  });

  it('counts pending and stale runs without metrics, from the statement’s rounded figures', () => {
    const trends = buildActivityTrends({
      ...base,
      query: query({ source: 'recorded_run', type: 'run' }),
      rows: {
        runs: [
          { ...EMPTY_RUN_RANGE, count: 3, current: 2, day_number: 10, days_with_entries: null, days_with_value: null, distance_m: '10001', observed_duration_s: '3599', pending: 1 },
          { ...EMPTY_RUN_RANGE, count: 2, day_number: 11, days_with_entries: null, days_with_value: null, pending: 1, stale: 1 },
          { count: 5, current: 2, day_number: null, days_with_entries: 2, days_with_value: 1, distance_m: '10001', observed_duration_s: '3599', pending: 2, stale: 1 },
        ],
      },
    });
    if (trends.source !== 'recorded_run') throw new Error('expected recorded-run trends');
    expect(trends.days[9]).toMatchObject({ count: 3, distance: { totalM: 10_001, withValue: 2 }, observedDuration: { totalS: 3_599, withValue: 2 }, summaries: { current: 2, pending: 1, stale: 0 } });
    expect(trends.days[10]).toMatchObject({ count: 2, distance: { totalM: null, withValue: 0 }, observedDuration: { totalS: null, withValue: 0 }, summaries: { current: 0, pending: 1, stale: 1 } });
    expect(trends.summary).toEqual({
      count: 5,
      daysWithEntries: 2,
      distance: { daysWithValue: 1, totalM: 10_001, withValue: 2 },
      observedDuration: { daysWithValue: 1, totalS: 3_599, withValue: 2 },
      summaries: { current: 2, pending: 2, stale: 1 },
    });
    expect(trends.applied.type).toBe('run');
  });

  it('refuses a range row that disagrees with the dates, and a missing or repeated range row', () => {
    const dates = [day({ count: 1, day_number: 3, duration_s: '60' })];
    const wrong = { ...EMPTY_ACTIVITY_RANGE, count: 1, days_with_entries: 1, duration_s: '61' };
    expect(() => buildActivityTrends({ ...base, query: query(), rows: { activities: [...dates, wrong] } })).toThrow(/summary is computed from the days/u);
    expect(() => buildActivityTrends({ ...base, query: query(), rows: { activities: dates } })).toThrow(/no range row/u);
    expect(() => buildActivityTrends({ ...base, query: query(), rows: { activities: [EMPTY_ACTIVITY_RANGE, EMPTY_ACTIVITY_RANGE] } })).toThrow(/more than one range row/u);
    // A total without any item that records it, or a missing total for recorded items, is a statement defect.
    expect(() => buildActivityTrends({ ...base, query: query(), rows: { activities: [{ ...EMPTY_ACTIVITY_RANGE, distance_m: '0' }] } })).toThrow(/for items that record none/u);
    expect(() =>
      buildActivityTrends({ ...base, query: query(), rows: { activities: [day({ count: 1, day_number: 3 }), { ...EMPTY_ACTIVITY_RANGE, count: 1, days_with_entries: 1 }] } }),
    ).toThrow(/no duration sum/u);
  });

  it('refuses a bucket outside the range or a repeated one instead of dropping it', () => {
    for (const day_number of [0, 29]) {
      expect(() =>
        buildActivityTrends({ ...base, query: query(), rows: { activities: [day({ count: 1, day_number, duration_s: '60' }), EMPTY_ACTIVITY_RANGE] } }),
      ).toThrow(/unexpected date bucket/u);
    }
    const row = day({ count: 1, day_number: 3, duration_s: '60' });
    expect(() => buildActivityTrends({ ...base, query: query(), rows: { activities: [row, row, EMPTY_ACTIVITY_RANGE] } })).toThrow(/unexpected date bucket/u);
  });

  it('keeps a date the zone skipped as an empty date and refuses a bucket for it (Pacific/Apia, 2011-12-30)', () => {
    const interval = activityTrendsIntervalOf('2012-01-05', 'Pacific/Apia');
    const skipped = interval.days.findIndex((entry) => entry.localDate === '2011-12-30');
    expect(interval.days[skipped]).toEqual({ endsAt: '2011-12-30T10:00:00.000Z', localDate: '2011-12-30', startsAt: '2011-12-30T10:00:00.000Z' });
    expect(interval.days[skipped + 1]).toEqual({ endsAt: '2011-12-31T10:00:00.000Z', localDate: '2011-12-31', startsAt: '2011-12-30T10:00:00.000Z' });
    const apia = { ...base, interval, timeZone: 'Pacific/Apia', today: '2026-11-12' };
    const trends = buildActivityTrends({
      ...apia,
      query: query({ endDate: '2012-01-05', timeZone: 'Pacific/Apia' }),
      rows: {
        activities: [
          day({ count: 1, day_number: skipped + 2, duration_s: '60' }),
          { ...EMPTY_ACTIVITY_RANGE, count: 1, days_with_entries: 1, duration_s: '60' },
        ],
      },
    });
    expect(trends.days).toHaveLength(28);
    expect(trends.days[skipped]).toMatchObject({ count: 0, distance: { totalM: null, withValue: 0 }, localDate: '2011-12-30' });
    expect(trends.days[skipped + 1]).toMatchObject({ count: 1, localDate: '2011-12-31' });
    expect(() =>
      buildActivityTrends({
        ...apia,
        query: query({ endDate: '2012-01-05', timeZone: 'Pacific/Apia' }),
        rows: { activities: [day({ count: 1, day_number: skipped + 1, duration_s: '60' }), { ...EMPTY_ACTIVITY_RANGE, count: 1, days_with_entries: 1, duration_s: '60' }] },
      }),
    ).toThrow(/unexpected date bucket/u);
  });
});

describe('activity trends service', () => {
  it('reads one aggregate statement after the membership check, with the date starts as bucket bounds', async () => {
    const { pool, statements } = recordingPool();
    const service = new ActivityTrendsService({ clock: clockAt('2026-11-12T10:00:00.000Z'), pool });
    const trends = await service.read({ userId: USER }, ORG, query({ timeZone: 'europe/warsaw' }));
    expect(trends.applied.timeZone).toBe(WARSAW);
    const aggregate = statements.filter((statement) => statement.text.includes('activity-trends:'));
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]!.text).toBe(activityTrendsActivitiesSql);
    const [org, user, starts, from, to, source, type] = aggregate[0]!.parameters!;
    expect([org, user, source, type]).toEqual([ORG, USER, 'manual', 'ride']);
    expect(starts).toHaveLength(28);
    expect((starts as string[])[0]).toBe(from);
    expect(to).toBe('2026-11-12T23:00:00.000Z');
    const membership = statements.findIndex((statement) => statement.text.includes('FROM memberships'));
    expect(membership).toBeGreaterThan(-1);
    expect(membership).toBeLessThan(statements.indexOf(aggregate[0]!));
    expect(statements.some((statement) => /REPEATABLE READ/u.test(statement.text) && /READ ONLY/u.test(statement.text))).toBe(true);
  });

  it('reads the recorded-run statement for recorded runs only', async () => {
    const { pool, statements } = recordingPool();
    const service = new ActivityTrendsService({ clock: clockAt('2026-11-12T10:00:00.000Z'), pool });
    await service.read({ userId: USER }, ORG, query({ source: 'recorded_run', type: 'run' }));
    expect(statements.filter((statement) => statement.text === activityTrendsRecordedRunsSql)).toHaveLength(1);
    expect(statements.some((statement) => statement.text === activityTrendsActivitiesSql)).toBe(false);
  });

  it('refuses an end date after today in the requested zone by the server clock, before any database work', async () => {
    const { pool, statements } = recordingPool();
    // 23:30 UTC on 11 November is already 12 November in Warsaw, still 11 November in UTC.
    const service = new ActivityTrendsService({ clock: clockAt('2026-11-11T23:30:00.000Z'), pool });
    await expect(service.read({ userId: USER }, ORG, query({ endDate: '2026-11-12' }))).resolves.toMatchObject({ range: { today: '2026-11-12' } });
    statements.length = 0;
    const error = await service.read({ userId: USER }, ORG, query({ endDate: '2026-11-12', timeZone: 'UTC' })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(400);
    expect((error as ApiError).code).toBe('INVALID_REQUEST');
    expect((error as ApiError).message).toContain('2026-11-11 in UTC');
    expect(statements).toHaveLength(0);
  });
});

describe('activity trends comparison window (ADR-0090)', () => {
  it('reads the 28 dates before the range and the range, at most 56 dates, tiling the window in the zone', () => {
    const window = activityTrendsComparisonWindowOf('2026-11-30', WARSAW);
    expect(window.starts).toHaveLength(56);
    expect(window.previousDays).toBe(28);
    expect(window.previous).toEqual({
      period: { days: 28, endDate: '2026-11-02', endsAt: '2026-11-02T23:00:00.000Z', shortenedByLowerBound: false, startDate: '2026-10-06', startsAt: '2026-10-05T22:00:00.000Z' },
      requestedEndDate: '2026-11-02',
      requestedStartDate: '2026-10-06',
    });
    // The previous period ends where the range starts; the window spans both.
    expect(window.previous.period!.endsAt).toBe(window.current.startsAt);
    expect(window.starts[28]).toBe(window.current.startsAt);
    expect(window.startsAt).toBe(window.starts[0]);
    expect(window.endsAt).toBe(window.current.endsAt);
    // The 25-hour date 2026-10-25 lies in the previous period: its bound and the next are 25 hours apart.
    const index = 25 - 6; // 2026-10-06 is the first bound
    expect(Date.parse(window.starts[index + 1]!) - Date.parse(window.starts[index]!)).toBe(25 * 3_600_000);
  });

  it('keeps a date the zone skipped in the previous period as a repeated bound (Pacific/Apia, 2011-12-30)', () => {
    const window = activityTrendsComparisonWindowOf('2012-01-28', 'Pacific/Apia');
    expect(window.previous.period).toMatchObject({ endDate: '2011-12-31', startDate: '2011-12-04' });
    const skipped = window.starts.indexOf('2011-12-30T10:00:00.000Z');
    expect(skipped).toBe(26); // 2011-12-30 is the 27th date of the previous period
    expect(window.starts[skipped + 1]).toBe('2011-12-30T10:00:00.000Z'); // 2011-12-31 starts at the same instant
    expect(window.starts[28]).toBe(window.current.startsAt);
  });

  it('reads fewer dates when 2000-01-01 cuts the previous period, and none of it when it is out of range', () => {
    const shortened = activityTrendsComparisonWindowOf('2000-02-10', 'UTC');
    expect(shortened.previousDays).toBe(13);
    expect(shortened.starts).toHaveLength(41);
    expect(shortened.startsAt).toBe('2000-01-01T00:00:00.000Z');
    const missing = activityTrendsComparisonWindowOf('2000-01-10', 'UTC');
    expect(missing.previousDays).toBe(0);
    expect(missing.previous.period).toBeNull();
    expect(missing.starts).toHaveLength(10);
    expect(missing.startsAt).toBe(missing.current.startsAt);
  });
});

describe('activity trends comparison statements', () => {
  const statements = [activityTrendsActivitiesComparisonSql, activityTrendsRecordedRunsComparisonSql];

  it('name the organization and the owner, bound the window and split it at the previous period’s last bucket', () => {
    for (const sql of statements) {
      expect(sql).toMatch(/\.org_id = \$1/u);
      expect(sql).toMatch(/\.user_id = \$2/u);
      expect(sql).toMatch(/started_at >= \$4::timestamptz/u);
      expect(sql).toMatch(/started_at < \$5::timestamptz/u);
      expect(sql).toMatch(/width_bucket\(\w+\.started_at, \$3::timestamptz\[\]\)/u);
      expect(sql).not.toMatch(/AT TIME ZONE|time_zone|interval '1 day'/u);
      expect(sql).toContain("'change'");
      expect(sql).toContain("CASE WHEN is_current THEN 'current' ELSE 'previous' END");
    }
    expect(activityTrendsActivitiesComparisonSql).toContain('bucket > $8::integer AS is_current');
    expect(activityTrendsActivitiesComparisonSql).toContain('activity.source = $6::text');
    expect(activityTrendsActivitiesComparisonSql).toContain('activity.type = $7::text');
    expect(activityTrendsRecordedRunsComparisonSql).toContain('bucket > $6::integer AS is_current');
    expect(activityTrendsRecordedRunsComparisonSql).toContain("run.status = 'finished'");
    expect(activityTrendsRecordedRunsComparisonSql).toMatch(/LEFT JOIN LATERAL \([\s\S]*OFFSET 0\) AS summary ON true/u);
    expect(activityTrendsRecordedRunsComparisonSql).not.toMatch(/run_shares|run_points|display_geom/u);
  });

  it('round each date once, halves up, add the rounded dates per period, and compute the percentage by integer division', () => {
    for (const sql of statements) {
      expect(sql).not.toMatch(/\bround\(/u);
      expect(sql).toContain('(floor(distance_sum) + CASE WHEN distance_sum - floor(distance_sum) >= 0.5 THEN 1 ELSE 0 END)::bigint');
      expect(sql).toContain('sum(rounded.distance_m) AS distance_m');
      // ::numeric appears only in the exact integer division of the percentage.
      expect(sql.match(/::numeric/gu)).toHaveLength(6);
      expect(sql).toContain('sign(cur.count - prev.count) * div(abs(cur.count - prev.count)::numeric * 2000 + prev.count, prev.count::numeric * 2)');
      expect(sql).toContain('CASE WHEN prev.count > 0 THEN');
    }
  });
});

describe('building a comparison', () => {
  const window = activityTrendsComparisonWindowOf('2026-11-11', WARSAW);
  const base = { computedAt: '2026-11-12T10:00:00.000Z', timeZone: WARSAW, today: '2026-11-12', window };
  const q = query({ compare: 'previous_period', endDate: '2026-11-11' });
  type Row = ActivityTrendsActivityComparisonRow;
  const none = { count_percent_tenths: null, distance_percent_tenths: null, duration_percent_tenths: null };
  const dayRow = (day_number: number, count: number, duration: string, distance: string | null, withDistance: number): Row => ({
    ...none,
    count,
    day_number,
    days_with_distance: null,
    days_with_entries: null,
    distance_m: distance,
    duration_s: duration,
    row_kind: 'day',
    with_distance: withDistance,
  });
  const periodRow = (kind: 'current' | 'previous', count: number, duration: string | null, distance: string | null, withDistance: number, days: number): Row => ({
    ...none,
    count,
    day_number: null,
    days_with_distance: distance === null ? 0 : days,
    days_with_entries: days,
    distance_m: distance,
    duration_s: duration,
    row_kind: kind,
    with_distance: withDistance,
  });
  const changeRow = (values: Partial<Row>): Row => ({
    ...none,
    count: null,
    day_number: null,
    days_with_distance: null,
    days_with_entries: null,
    distance_m: null,
    duration_s: null,
    row_kind: 'change',
    with_distance: null,
    ...values,
  });

  const comparable = (change: Partial<Row>): Row[] => [
    dayRow(3, 3, '5400', '30000', 3),
    periodRow('current', 3, '5400', '30000', 3, 1),
    periodRow('previous', 2, '3600', '24000', 2, 1),
    changeRow(change),
  ];
  const rightChange = { count: 1, count_percent_tenths: '500', distance_m: '6000', distance_percent_tenths: '250', duration_percent_tenths: '500', duration_s: '1800' };

  it('takes changes and percentages from the statement for comparable periods', () => {
    const trends = buildActivityTrendsComparison({ ...base, query: q, rows: { activities: comparable(rightChange) } });
    if (trends.source !== 'manual' || trends.comparison === undefined) throw new Error('expected a manual comparison');
    expect(trends.applied.compare).toBe('previous_period');
    expect(trends.summary.count).toBe(3);
    expect(trends.comparison.previous.summary).toMatchObject({ count: 2, enteredDuration: { totalS: 3_600, withValue: 2 } });
    expect(trends.comparison.metrics.enteredDuration).toEqual({
      change: { absolute: 1_800, percent: 50, percentUnavailableReason: null, status: 'available' },
      current: 5_400,
      previous: 3_600,
    });
    expect(trends.comparison.metrics.distance.change).toMatchObject({ absolute: 6_000, percent: 25 });
    expect(trends.comparison.policyVersion).toBe(ACTIVITY_TRENDS_COMPARISON_VERSION);
  });

  it('refuses a change or a percentage that disagrees with the contract instead of correcting it', () => {
    expect(() => buildActivityTrendsComparison({ ...base, query: q, rows: { activities: comparable({ ...rightChange, duration_s: '1801' }) } })).toThrow(/comparison/u);
    expect(() => buildActivityTrendsComparison({ ...base, query: q, rows: { activities: comparable({ ...rightChange, count_percent_tenths: '501' }) } })).toThrow(/comparison/u);
    expect(() => buildActivityTrendsComparison({ ...base, query: q, rows: { activities: comparable({ ...rightChange, distance_percent_tenths: null }) } })).toThrow(/no distance percentage/u);
    expect(() => buildActivityTrendsComparison({ ...base, query: q, rows: { activities: comparable({ ...rightChange, count: null }) } })).toThrow(/no count change/u);
    expect(() => buildActivityTrendsComparison({ ...base, query: q, rows: { activities: comparable({ ...rightChange, duration_s: '1.5' }) } })).toThrow(/safe integer/u);
  });

  it('refuses a missing or repeated period or change row', () => {
    const rows = comparable(rightChange);
    expect(() => buildActivityTrendsComparison({ ...base, query: q, rows: { activities: rows.filter((row) => row.row_kind !== 'previous') } })).toThrow(/0 previous rows/u);
    expect(() => buildActivityTrendsComparison({ ...base, query: q, rows: { activities: [...rows, rows.at(-1)!] } })).toThrow(/2 change rows/u);
  });

  it('suppresses every change while the range includes today, keeping both periods’ values', () => {
    const todayWindow = activityTrendsComparisonWindowOf('2026-11-12', WARSAW);
    const trends = buildActivityTrendsComparison({ ...base, query: { ...q, endDate: '2026-11-12' }, rows: { activities: comparable(rightChange) }, window: todayWindow });
    if (trends.source !== 'manual') throw new Error('expected manual');
    expect(trends.comparison?.periodReasons).toEqual(['current_period_in_progress']);
    expect(trends.comparison?.metrics.count).toEqual({ change: { reasons: ['current_period_in_progress'], status: 'unavailable' }, current: 3, previous: 2 });
  });

  it('keeps an absolute change for a zero baseline, and names partial coverage', () => {
    const trends = buildActivityTrendsComparison({
      ...base,
      query: q,
      rows: {
        activities: [
          dayRow(3, 2, '1200', '2000', 1),
          periodRow('current', 2, '1200', '2000', 1, 1),
          periodRow('previous', 1, '0', '0', 1, 1),
          changeRow({ count: 1, count_percent_tenths: '1000', distance_m: '2000', duration_percent_tenths: null, duration_s: '1200' }),
        ],
      },
    });
    if (trends.source !== 'manual') throw new Error('expected manual');
    expect(trends.comparison?.metrics.enteredDuration.change).toEqual({ absolute: 1_200, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' });
    expect(trends.comparison?.metrics.distance).toEqual({ change: { reasons: ['current_values_missing'], status: 'unavailable' }, current: 2_000, previous: 0 });
  });

  it('gives no previous figures when the previous period is out of range, and refuses items for it', () => {
    const early = activityTrendsComparisonWindowOf('2000-01-10', 'UTC');
    const rows: Row[] = [periodRow('current', 0, null, null, 0, 0), periodRow('previous', 0, null, null, 0, 0), changeRow({ count: 0 })];
    const trends = buildActivityTrendsComparison({ ...base, query: { ...q, endDate: '2000-01-10', timeZone: 'UTC' }, rows: { activities: rows }, timeZone: 'UTC', window: early });
    expect(trends.comparison?.previous).toEqual({ period: null, requestedEndDate: '1999-12-13', requestedStartDate: '1999-11-16', summary: null });
    expect(trends.comparison?.metrics.count).toEqual({
      change: { reasons: ['current_period_shortened', 'previous_period_out_of_range'], status: 'unavailable' },
      current: 0,
      previous: null,
    });
    const leaked = [periodRow('current', 0, null, null, 0, 0), periodRow('previous', 1, '60', null, 0, 1), changeRow({ count: -1 })];
    expect(() =>
      buildActivityTrendsComparison({ ...base, query: { ...q, endDate: '2000-01-10', timeZone: 'UTC' }, rows: { activities: leaked }, timeZone: 'UTC', window: early }),
    ).toThrow(/previous period that does not exist/u);
  });

  it('names pending and stale run summaries per period, and compares run counts whatever their summaries', () => {
    type RunRow = ActivityTrendsRunComparisonRow;
    const run = (values: Partial<RunRow> & Pick<RunRow, 'row_kind'>): RunRow => ({
      ...none,
      count: 0,
      current: 0,
      day_number: null,
      days_with_entries: null,
      days_with_value: null,
      distance_m: null,
      observed_duration_s: null,
      pending: 0,
      stale: 0,
      ...values,
    });
    const trends = buildActivityTrendsComparison({
      ...base,
      query: { ...q, source: 'recorded_run', type: 'run' },
      rows: {
        runs: [
          run({ count: 2, current: 1, day_number: 4, distance_m: '5000', observed_duration_s: '1800', pending: 1, row_kind: 'day' }),
          run({ count: 2, current: 1, days_with_entries: 1, days_with_value: 1, distance_m: '5000', observed_duration_s: '1800', pending: 1, row_kind: 'current' }),
          run({ count: 1, current: 0, days_with_entries: 1, days_with_value: 0, row_kind: 'previous', stale: 1 }),
          run({ count: 1, count_percent_tenths: '1000', current: null, pending: null, row_kind: 'change', stale: null }),
        ],
      },
    });
    if (trends.source !== 'recorded_run') throw new Error('expected recorded runs');
    expect(trends.comparison?.metrics.count.change).toEqual({ absolute: 1, percent: 100, percentUnavailableReason: null, status: 'available' });
    expect(trends.comparison?.metrics.observedDuration.change).toEqual({
      reasons: ['current_summaries_pending', 'previous_summaries_stale'],
      status: 'unavailable',
    });
    expect(trends.comparison?.previous.summary).toMatchObject({ count: 1, summaries: { current: 0, pending: 0, stale: 1 } });
  });
});

describe('activity trends service with a comparison', () => {
  it('reads one comparison statement over the window after the membership check, and no ordinary statement', async () => {
    const { pool, statements } = recordingPool();
    const service = new ActivityTrendsService({ clock: clockAt('2026-11-12T10:00:00.000Z'), pool });
    const trends = await service.read({ userId: USER }, ORG, query({ compare: 'previous_period', endDate: '2026-11-11' }));
    expect(trends.comparison?.previous.period).toMatchObject({ days: 28, endDate: '2026-10-14', startDate: '2026-09-17' });
    const aggregate = statements.filter((statement) => statement.text.includes('activity-trends:'));
    expect(aggregate.map((statement) => statement.text)).toEqual([activityTrendsActivitiesComparisonSql]);
    const [org, user, starts, from, to, source, type, previousDays] = aggregate[0]!.parameters!;
    expect([org, user, source, type, previousDays]).toEqual([ORG, USER, 'manual', 'ride', 28]);
    expect(starts).toHaveLength(56);
    expect((starts as string[])[0]).toBe(from);
    expect(from).toBe('2026-09-16T22:00:00.000Z'); // 2026-09-17 00:00 CEST
    expect(to).toBe('2026-11-11T23:00:00.000Z');
    expect(statements.findIndex((statement) => statement.text.includes('FROM memberships'))).toBeLessThan(statements.indexOf(aggregate[0]!));

    statements.length = 0;
    await service.read({ userId: USER }, ORG, query({ compare: 'previous_period', source: 'recorded_run', type: 'run' }));
    expect(statements.filter((statement) => statement.text.includes('activity-trends:')).map((statement) => statement.text)).toEqual([activityTrendsRecordedRunsComparisonSql]);
  });
});
