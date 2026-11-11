import { activityHistoryItemSchema } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../http/errors.js';
import {
  activityHistoryContext,
  decodeActivityHistoryCursor,
  encodeActivityHistoryCursor,
} from './activity-history-cursor.js';
import {
  ActivityHistoryService,
  activityHistoryDay,
  activityHistoryPageSql,
  mapActivityHistoryRow,
  type ActivityHistoryRow,
} from './activity-history-service.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '44444444-4444-4444-8444-444444444444';
const id = 'ad32e5d8-dd0d-4652-b26a-026033120c33';
const scope = { day: null, orgId, source: null, type: null, userId };

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'other';
  }
  return undefined;
}

describe('activity history cursor', () => {
  const context = activityHistoryContext(scope);
  const position = { context, id, kind: 'activity' as const, startedAt: '2026-10-05T06:00:00.123456Z' };

  it('round-trips a position and normalises the id to lower case', () => {
    expect(decodeActivityHistoryCursor(encodeActivityHistoryCursor(position), { context })).toEqual({ ...position, version: 1 });
    const upper = encodeActivityHistoryCursor({ ...position, id: id.toUpperCase() });
    expect(decodeActivityHistoryCursor(upper, { context }).id).toBe(id);
  });

  it('binds the context to the person, the organization and each filter', () => {
    const contexts = new Set([
      context,
      activityHistoryContext({ ...scope, userId: '11111111-1111-4111-8111-111111111111' }),
      activityHistoryContext({ ...scope, orgId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      activityHistoryContext({ ...scope, source: 'manual' }),
      activityHistoryContext({ ...scope, source: 'gpx' }),
      activityHistoryContext({ ...scope, source: 'recorded_run' }),
      activityHistoryContext({ ...scope, type: 'run' }),
      activityHistoryContext({ ...scope, source: 'manual', type: 'run' }),
    ]);
    expect(contexts.size).toBe(8);
    const cursor = encodeActivityHistoryCursor(position);
    expect(code(() => decodeActivityHistoryCursor(cursor, { context: activityHistoryContext({ ...scope, source: 'gpx' }) }))).toBe('INVALID_CURSOR');
  });

  it('binds the context to the day filter: its date and its zone (ADR-0088)', () => {
    const warsaw = { localDate: '2026-03-29', timeZone: 'Europe/Warsaw' };
    const contexts = new Set([
      context,
      activityHistoryContext({ ...scope, day: warsaw }),
      activityHistoryContext({ ...scope, day: { ...warsaw, localDate: '2026-03-30' } }),
      activityHistoryContext({ ...scope, day: { ...warsaw, timeZone: 'Europe/Berlin' } }),
      activityHistoryContext({ ...scope, day: { ...warsaw, timeZone: 'UTC' } }),
      activityHistoryContext({ ...scope, day: warsaw, source: 'recorded_run' }),
    ]);
    expect(contexts.size).toBe(6);
    const dayContext = activityHistoryContext({ ...scope, day: warsaw });
    const dayCursor = encodeActivityHistoryCursor({ ...position, context: dayContext });
    expect(decodeActivityHistoryCursor(dayCursor, { context: dayContext }).context).toBe(dayContext);
    // A day cursor is not a whole-history cursor, nor one of another date or zone, and the other way round.
    expect(code(() => decodeActivityHistoryCursor(dayCursor, { context }))).toBe('INVALID_CURSOR');
    expect(code(() => decodeActivityHistoryCursor(dayCursor, { context: activityHistoryContext({ ...scope, day: { ...warsaw, localDate: '2026-03-30' } }) }))).toBe('INVALID_CURSOR');
    expect(code(() => decodeActivityHistoryCursor(dayCursor, { context: activityHistoryContext({ ...scope, day: { ...warsaw, timeZone: 'Europe/Berlin' } }) }))).toBe('INVALID_CURSOR');
    expect(code(() => decodeActivityHistoryCursor(encodeActivityHistoryCursor(position), { context: dayContext }))).toBe('INVALID_CURSOR');
  });

  // A cursor issued before the day filter existed (ADR-0087) must keep working for the whole history: its digest was
  // computed over exactly these six elements.
  it('keeps the whole-history digest of ADR-0087, so older cursors stay valid without a day filter', async () => {
    const { createHash } = await import('node:crypto');
    const legacy = createHash('sha256')
      .update(JSON.stringify(['activity-history', 1, userId, orgId, '*', '*']))
      .digest('base64url');
    expect(context).toBe(legacy);
  });

  it('refuses malformed, tampered and impossible cursors', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    for (const cursor of [
      'not base64!',
      Buffer.from('{', 'utf8').toString('base64url'),
      encode({ ...position, version: 1, kind: 'meal' }),
      encode({ ...position, version: 2 }),
      encode({ ...position, version: 1, startedAt: '2026-10-05T06:00:00.123Z' }),
      encode({ ...position, version: 1, startedAt: '2026-13-45T06:00:00.000000Z' }),
      encode({ ...position, version: 1, context: 'x'.repeat(43) }),
      encode({ ...position, version: 1, extra: true }),
    ]) {
      expect(code(() => decodeActivityHistoryCursor(cursor, { context })), cursor).toBe('INVALID_CURSOR');
    }
  });

  // Date.parse normalises some impossible dates (February 30 becomes March 2) instead of refusing them; PostgreSQL
  // refuses them, so such a cursor must stop here and never reach the statement.
  it('refuses a correctly scoped cursor whose start is not a real instant PostgreSQL accepts', () => {
    for (const startedAt of [
      '2026-02-30T00:00:00.000000Z',
      '2025-02-29T00:00:00.000000Z',
      '2026-04-31T00:00:00.000000Z',
      '0000-01-01T00:00:00.000000Z',
      '2026-01-01T24:00:00.000000Z',
      '2026-01-01T23:60:00.000000Z',
      '2026-01-01T23:59:60.000000Z',
    ]) {
      const cursor = encodeActivityHistoryCursor({ ...position, startedAt });
      expect(code(() => decodeActivityHistoryCursor(cursor, { context })), startedAt).toBe('INVALID_CURSOR');
    }
  });

  it('keeps a valid leap day and its microseconds exactly as encoded', () => {
    for (const startedAt of ['2024-02-29T23:59:59.999999Z', '2026-10-05T06:00:00.000001Z']) {
      expect(decodeActivityHistoryCursor(encodeActivityHistoryCursor({ ...position, startedAt }), { context }).startedAt).toBe(startedAt);
    }
  });

  it('refuses an impossible cursor before acquiring a database connection', async () => {
    const connect = vi.fn(() => Promise.reject(new Error('must not connect')));
    const service = new ActivityHistoryService({ pool: { connect } });
    const cursor = encodeActivityHistoryCursor({ ...position, startedAt: '2026-02-30T00:00:00.000000Z' });
    await expect(service.read({ userId }, orgId, { cursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('activity history statement', () => {
  it('reads the three sources with a union of two owner-bound branches and a total order', () => {
    expect(activityHistoryPageSql).toContain('UNION ALL');
    expect(activityHistoryPageSql.match(/\.user_id = \$2/gu)).toHaveLength(2);
    expect(activityHistoryPageSql.match(/\.org_id = \$1/gu)).toHaveLength(2);
    expect(activityHistoryPageSql).toContain("run.status = 'finished'");
    expect(activityHistoryPageSql).toContain('ORDER BY entry.started_at DESC, entry.kind_rank DESC, entry.entry_id DESC');
    expect(activityHistoryPageSql).toContain('summary.source_revision = run.data_revision');
    // Nothing but the three source tables: no points, shares, geometry or writes.
    for (const forbidden of ['run_points', 'run_shares', 'display_geom', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(activityHistoryPageSql).not.toContain(forbidden);
    }
  });

  it('filters both branches by start time in a half-open day interval', () => {
    expect(activityHistoryPageSql).toContain('activity.started_at >= $9::timestamptz AND activity.started_at < $10::timestamptz');
    expect(activityHistoryPageSql).toContain('run.started_at >= $9::timestamptz AND run.started_at < $10::timestamptz');
    expect(activityHistoryPageSql).not.toMatch(/finished_at\s*[<>]/u);
  });
});

describe('activity history day filter', () => {
  it('is absent without both parameters', () => {
    expect(activityHistoryDay({})).toBeNull();
  });

  it('runs from local midnight to the next local midnight, not start plus 24 hours', () => {
    expect(activityHistoryDay({ localDate: '2026-11-11', timeZone: 'Europe/Warsaw' })).toEqual({
      endsAt: '2026-11-11T23:00:00.000Z', localDate: '2026-11-11', startsAt: '2026-11-10T23:00:00.000Z', timeZone: 'Europe/Warsaw',
    });
    // Spring forward: 23 hours.
    expect(activityHistoryDay({ localDate: '2026-03-29', timeZone: 'Europe/Warsaw' })).toMatchObject({
      endsAt: '2026-03-29T22:00:00.000Z', startsAt: '2026-03-28T23:00:00.000Z',
    });
    // Fall back: 25 hours, both 02:30s included.
    expect(activityHistoryDay({ localDate: '2026-10-25', timeZone: 'Europe/Warsaw' })).toMatchObject({
      endsAt: '2026-10-25T23:00:00.000Z', startsAt: '2026-10-24T22:00:00.000Z',
    });
    expect(activityHistoryDay({ localDate: '2026-10-25', timeZone: 'UTC' })).toMatchObject({
      endsAt: '2026-10-26T00:00:00.000Z', startsAt: '2026-10-25T00:00:00.000Z',
    });
  });

  it('names the zone in its canonical spelling, so the echo and the cursor scope agree', () => {
    expect(activityHistoryDay({ localDate: '2026-11-11', timeZone: 'europe/warsaw' })?.timeZone).toBe('Europe/Warsaw');
  });

  it('refuses a whole-history cursor sent with a day filter before acquiring a database connection', async () => {
    const connect = vi.fn(() => Promise.reject(new Error('must not connect')));
    const service = new ActivityHistoryService({ pool: { connect } });
    const cursor = encodeActivityHistoryCursor({
      context: activityHistoryContext(scope), id, kind: 'activity', startedAt: '2026-03-29T06:00:00.000000Z',
    });
    await expect(service.read({ userId }, orgId, { cursor, localDate: '2026-03-29', timeZone: 'Europe/Warsaw' }))
      .rejects.toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('activity history rows', () => {
  const base: ActivityHistoryRow = {
    distance_m: null,
    duration_s: null,
    entry_id: id,
    finished_at_us: null,
    kind_rank: 0,
    notes: null,
    observed_duration_s: null,
    quality_stats: null,
    rpe: null,
    source: 'manual',
    started_at_us: '2026-10-05T06:00:00.120000Z',
    summary_state: null,
    type: 'ride',
  };
  const stats = {
    acceptedEdgeCount: 2,
    acceptedPointCount: 3,
    excessiveSpeedCount: 0,
    excessiveTimeGapCount: 0,
    insufficientData: false,
    nonpositiveTimeDeltaCount: 0,
    poorAccuracyPointCount: 0,
    rawPointCount: 4,
    segmentBreakCount: 0,
    seqGapCount: 0,
  };

  it('names a manual duration entered and a GPX duration elapsed', () => {
    expect(mapActivityHistoryRow({ ...base, distance_m: 2_000, duration_s: 600, notes: 'n', rpe: 3 })).toEqual({
      activityId: id, distanceM: 2_000, enteredDurationS: 600, notes: 'n', rpe: 3, source: 'manual', startedAt: '2026-10-05T06:00:00.120Z', type: 'ride',
    });
    expect(mapActivityHistoryRow({ ...base, distance_m: 5_000, duration_s: 900, source: 'gpx', type: 'hike' })).toEqual({
      activityId: id, distanceM: 5_000, elapsedDurationS: 900, source: 'gpx', startedAt: '2026-10-05T06:00:00.120Z', type: 'hike',
    });
  });

  it('gives a recorded run metrics only from a current summary, with the derived GPS quality', () => {
    const run = { ...base, finished_at_us: '2026-10-05T07:00:00.000000Z', kind_rank: 1, source: 'recorded_run' as const, type: 'run' };
    const current = mapActivityHistoryRow({ ...run, distance_m: 5_000.5, observed_duration_s: 1_800, quality_stats: stats, summary_state: 'current' });
    expect(current).toEqual({
      captureSource: null,
      finishedAt: '2026-10-05T07:00:00.000Z',
      runId: id,
      source: 'recorded_run',
      startedAt: '2026-10-05T06:00:00.120Z',
      summary: { distanceM: 5_000.5, gpsQuality: 'poor', observedDurationS: 1_800, state: 'current' },
      type: 'run',
    });
    expect(activityHistoryItemSchema.parse(current)).toEqual(current);
    for (const state of ['pending', 'stale'] as const) {
      expect(mapActivityHistoryRow({ ...run, summary_state: state })).toMatchObject({ summary: { state } });
    }
  });
});
