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
  activityHistoryPageSql,
  mapActivityHistoryRow,
  type ActivityHistoryRow,
} from './activity-history-service.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '44444444-4444-4444-8444-444444444444';
const id = 'ad32e5d8-dd0d-4652-b26a-026033120c33';
const scope = { orgId, source: null, type: null, userId };

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
