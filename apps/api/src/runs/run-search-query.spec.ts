import { runSearchCursorSchema, type RunSearchSort } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../http/errors.js';
import {
  classifyGpsQuality,
  decodeRunSearchCursor,
  distanceToMetres,
  encodeRunSearchCursor,
  normalizeRunSearch,
  runSearchContext,
  RUN_SEARCH_DEFAULT_LIMIT,
  runSearchPageSql,
  runSearchPendingSql,
  type RunSearchContextInput,
} from './run-search-query.js';

const userId = '44444444-4444-4444-8444-444444444444';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'a0000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-15T12:00:00.000Z');

const contextInput: RunSearchContextInput = {
  from: '2026-09-30T22:00:00.000Z',
  maxDistanceM: 10_000,
  minDistanceM: 5_000,
  orgId,
  sort: 'newest',
  timeZone: 'Europe/Warsaw',
  to: '2026-10-31T23:00:00.000Z',
  userId,
};

describe('distance bounds in metres', () => {
  it.each([
    ['5', 'km', 5_000],
    ['0', 'km', 0],
    ['0.001', 'km', 1],
    ['12.345', 'km', 12_345],
    ['1', 'mi', 1_609.344],
    ['3.1', 'mi', 4_988.9664],
    ['0.1', 'mi', 160.9344],
    ['0.3', 'mi', 482.8032],
    ['0.7', 'mi', 1_126.5408],
    ['26.219', 'mi', 42_195.390336],
    ['100000', 'mi', 160_934_400],
  ] as const)('converts %s %s to exactly %d m', (value, unit, expected) => {
    expect(distanceToMetres(value, unit)).toBe(expected);
  });

  it('is the nearest double to the exact value where binary multiplication is one unit off', () => {
    // 0.017 * 1609.344 is 27.358848000000002 in binary floating point; the exact product is 27.358848.
    expect(0.017 * 1609.344).not.toBe(27.358848);
    expect(distanceToMetres('0.017', 'mi')).toBe(27.358848);
  });
});

describe('normalizing a search', () => {
  it('resolves the period with the injected clock and applies defaults', () => {
    const search = normalizeRunSearch({ preset: 'this-month', timeZone: 'Europe/Warsaw' }, now);
    expect(search.period.fromDate).toBe('2026-10-01');
    expect(search.period.toDate).toBe('2026-10-31');
    expect(search.sort).toBe('newest');
    expect(search.limit).toBe(RUN_SEARCH_DEFAULT_LIMIT);
    expect(search.minDistanceM).toBeNull();
    expect(search.maxDistanceM).toBeNull();
  });

  it('converts both bounds from the stated unit', () => {
    const search = normalizeRunSearch(
      {
        distanceUnit: 'mi',
        fromDate: '2026-10-01',
        maxDistance: '13.1',
        minDistance: '3.1',
        sort: 'longest',
        timeZone: 'UTC',
        toDate: '2026-10-31',
        limit: 10,
      },
      now,
    );
    expect(search.minDistanceM).toBe(4_988.9664);
    expect(search.maxDistanceM).toBe(21_082.4064);
    expect(search.sort).toBe('longest');
    expect(search.limit).toBe(10);
  });
});

describe('GPS quality shown for a finished run', () => {
  const stats = (raw: number, accepted: number, insufficient = false) => ({
    acceptedEdgeCount: Math.max(accepted - 1, 0),
    acceptedPointCount: accepted,
    excessiveSpeedCount: 0,
    excessiveTimeGapCount: 0,
    insufficientData: insufficient,
    nonpositiveTimeDeltaCount: 0,
    poorAccuracyPointCount: 0,
    rawPointCount: raw,
    segmentBreakCount: 0,
    seqGapCount: 0,
  });

  it('is insufficient when the summary says there was too little data', () => {
    expect(classifyGpsQuality(stats(5, 0, true))).toBe('insufficient');
  });

  it('is good while at least four in five measurements were used and poor below that', () => {
    expect(classifyGpsQuality(stats(100, 100))).toBe('good');
    expect(classifyGpsQuality(stats(100, 80))).toBe('good');
    expect(classifyGpsQuality(stats(100, 79))).toBe('poor');
    expect(classifyGpsQuality(stats(1_000, 800))).toBe('good');
    expect(classifyGpsQuality(stats(1_000, 799))).toBe('poor');
  });

  it('lets insufficient data win over the ratio', () => {
    expect(classifyGpsQuality(stats(100, 100, true))).toBe('insufficient');
  });
});

describe('the query context', () => {
  const digest = (patch: Partial<RunSearchContextInput> = {}) => runSearchContext({ ...contextInput, ...patch });

  it('is a stable 43-character digest', () => {
    expect(digest()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(digest()).toBe(digest());
  });

  it.each([
    ['person', { userId: '55555555-5555-4555-8555-555555555555' }],
    ['organization', { orgId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['time zone', { timeZone: 'UTC' }],
    ['period start', { from: '2026-10-01T00:00:00.000Z' }],
    ['period end', { to: '2026-11-01T00:00:00.000Z' }],
    ['minimum', { minDistanceM: 5_001 }],
    ['maximum', { maxDistanceM: 10_001 }],
    ['absent minimum', { minDistanceM: null }],
    ['sort', { sort: 'longest' as RunSearchSort }],
  ])('changes with the %s', (_label, patch) => {
    expect(digest(patch)).not.toBe(digest());
  });
});

describe('the cursor', () => {
  const context = runSearchContext(contextInput);
  const position = {
    distanceKey: null,
    runId,
    startedAt: '2026-10-05T06:00:00.123456Z',
  };

  it('round-trips a position for the query it came from', () => {
    const cursor = encodeRunSearchCursor({ ...position, context, sort: 'newest' });
    expect(cursor.length).toBeLessThanOrEqual(4_096);
    expect(decodeRunSearchCursor(cursor, { context, sort: 'newest' })).toEqual({
      ...position,
      context,
      sort: 'newest',
      version: 1,
    });
  });

  it('keeps the distance key for a distance sort', () => {
    const cursor = encodeRunSearchCursor({ ...position, context, distanceKey: '5012.4', sort: 'longest' });
    expect(decodeRunSearchCursor(cursor, { context, sort: 'longest' }).distanceKey).toBe('5012.4');
  });

  function refusal(cursor: string, expected: { context: string; sort: RunSearchSort }): ApiError {
    try {
      decodeRunSearchCursor(cursor, expected);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    }
    throw new Error('The cursor was accepted');
  }

  it('is refused with INVALID_CURSOR when it belongs to another query', () => {
    const cursor = encodeRunSearchCursor({ ...position, context, sort: 'newest' });
    const other = runSearchContext({ ...contextInput, minDistanceM: 1 });
    const error = refusal(cursor, { context: other, sort: 'newest' });
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('INVALID_CURSOR');
  });

  it('is refused when the sort differs even if the context were reused', () => {
    const cursor = encodeRunSearchCursor({ ...position, context, sort: 'newest' });
    expect(refusal(cursor, { context, sort: 'longest' }).code).toBe('INVALID_CURSOR');
  });

  it.each([
    ['not base64url', 'not a cursor!'],
    ['not JSON', Buffer.from('{oops', 'utf8').toString('base64url')],
    ['an array', Buffer.from('[]', 'utf8').toString('base64url')],
    ['an unknown field', Buffer.from(JSON.stringify({ ...position, context, extra: 1, sort: 'newest', version: 1 })).toString('base64url')],
    ['an old version', Buffer.from(JSON.stringify({ ...position, context, sort: 'newest', version: 0 })).toString('base64url')],
    ['a run list cursor', Buffer.from(JSON.stringify({ runId, startedAt: '2026-10-05T06:00:00.000Z' })).toString('base64url')],
  ])('is refused when it is %s', (_label, cursor) => {
    expect(refusal(cursor, { context, sort: 'newest' }).code).toBe('INVALID_CURSOR');
  });

  it('is described by the shared contract', () => {
    const cursor = encodeRunSearchCursor({ ...position, context, sort: 'newest' });
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    expect(runSearchCursorSchema.safeParse(decoded).success).toBe(true);
  });
});

describe('the SQL variants', () => {
  const sorts: RunSearchSort[] = ['newest', 'longest', 'shortest'];

  it.each(sorts)('%s filters by owner, finished status and a current summary', (sort) => {
    const sql = runSearchPageSql(sort);
    expect(sql).toContain('run.org_id = $1');
    expect(sql).toContain('run.user_id = $2');
    expect(sql).toContain("run.status = 'finished'");
    expect(sql).toContain('summary.source_revision = run.data_revision');
    expect(sql).toContain('run.started_at >= $3::timestamptz');
    expect(sql).toContain('run.started_at < $4::timestamptz');
    expect(sql).toMatch(/LIMIT \$\d+/u);
  });

  it.each(sorts)('%s ends its ordering with the run id so the order is total', (sort) => {
    expect(runSearchPageSql(sort)).toMatch(/ORDER BY[^;]*run\.id DESC\s+LIMIT/u);
  });

  it('orders each sort by its own key first', () => {
    expect(runSearchPageSql('newest')).toMatch(/ORDER BY run\.started_at DESC, run\.id DESC/u);
    expect(runSearchPageSql('longest')).toMatch(/ORDER BY summary\.distance_m DESC, run\.started_at DESC, run\.id DESC/u);
    expect(runSearchPageSql('shortest')).toMatch(/ORDER BY summary\.distance_m ASC, run\.started_at DESC, run\.id DESC/u);
  });

  it.each(sorts)('%s never reads raw GPS points', (sort) => {
    expect(runSearchPageSql(sort)).not.toContain('run_points');
    expect(runSearchPendingSql).not.toContain('run_points');
  });

  it('refuses a sort outside the allowlist instead of interpolating it', () => {
    expect(() => runSearchPageSql('newest; DROP TABLE runs' as RunSearchSort)).toThrow();
    expect(() => runSearchPageSql('constructor' as RunSearchSort)).toThrow();
  });

  it('counts pending runs for the same owner and period but ignores the distance filter and the cursor', () => {
    expect(runSearchPendingSql).toContain('run.user_id = $2');
    expect(runSearchPendingSql).toContain("run.status = 'finished'");
    expect(runSearchPendingSql).toContain('run.started_at >= $3::timestamptz');
    expect(runSearchPendingSql).toContain('run.started_at < $4::timestamptz');
    expect(runSearchPendingSql).toContain('summary.source_revision <> run.data_revision');
    expect(runSearchPendingSql).not.toContain('distance_m');
  });
});
