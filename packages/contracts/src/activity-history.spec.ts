import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_HISTORY_PAGE_MAX,
  ACTIVITY_HISTORY_SOURCES,
  ACTIVITY_HISTORY_VERSION,
  activityHistoryCursorSchema,
  activityHistoryItemSchema,
  activityHistoryQuerySchema,
  activityHistoryResponseSchema,
  openApiDocument,
} from './index.js';

const activityId = 'ad32e5d8-dd0d-4652-b26a-026033120c33';
const runId = 'a0000000-0000-4000-8000-000000000003';
const manual = {
  activityId,
  distanceM: 20_000,
  enteredDurationS: 1_800,
  notes: 'Easy spin',
  rpe: 4,
  source: 'manual',
  startedAt: '2026-10-05T06:00:00.000Z',
  type: 'ride',
};
const gpx = {
  activityId,
  distanceM: 5_012,
  elapsedDurationS: 1_900,
  source: 'gpx',
  startedAt: '2026-10-05T06:00:00.000Z',
  type: 'hike',
};
const run = {
  captureSource: null,
  finishedAt: '2026-10-05T07:00:00.000Z',
  runId,
  source: 'recorded_run',
  startedAt: '2026-10-05T06:00:00.000Z',
  summary: { distanceM: 5_000.4, gpsQuality: 'good', observedDurationS: 1_750, state: 'current' },
  type: 'run',
};
const response = {
  applied: { source: null, type: null },
  items: [run, manual, gpx],
  nextCursor: null,
  provenance: { historyVersion: ACTIVITY_HISTORY_VERSION, persisted: false, snapshot: 'single_read_only_transaction' },
};

describe('activity history query', () => {
  it('accepts no parameters, each source, each type and a bounded limit', () => {
    expect(activityHistoryQuerySchema.parse({})).toEqual({});
    for (const source of ACTIVITY_HISTORY_SOURCES) {
      expect(activityHistoryQuerySchema.parse({ source }).source).toBe(source);
    }
    expect(activityHistoryQuerySchema.parse({ limit: '50', type: 'swim' })).toEqual({ limit: 50, type: 'swim' });
  });

  it('refuses unknown or repeated parameters, an owner, unknown sources and out-of-range limits', () => {
    for (const query of [
      { userId: activityId },
      { orgId: activityId },
      { source: 'import' },
      { source: ['manual', 'gpx'] },
      { type: ['run', 'ride'] },
      { type: 'yoga' },
      { limit: '0' },
      { limit: String(ACTIVITY_HISTORY_PAGE_MAX + 1) },
      { limit: '1.5' },
      { cursor: '' },
    ]) {
      expect(activityHistoryQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });
});

describe('activity history items', () => {
  it('accepts each source with its own duration name', () => {
    expect(activityHistoryResponseSchema.parse(response)).toEqual(response);
  });

  it('never lets one source carry another source’s duration', () => {
    expect(activityHistoryItemSchema.safeParse({ ...manual, elapsedDurationS: 1 }).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...gpx, enteredDurationS: 1 }).success).toBe(false);
    // Renaming the duration field is refused in both directions.
    const manualRenamed: Record<string, unknown> = { ...manual, elapsedDurationS: manual.enteredDurationS };
    delete manualRenamed.enteredDurationS;
    expect(activityHistoryItemSchema.safeParse(manualRenamed).success).toBe(false);
    const gpxRenamed: Record<string, unknown> = { ...gpx, enteredDurationS: gpx.elapsedDurationS };
    delete gpxRenamed.elapsedDurationS;
    expect(activityHistoryItemSchema.safeParse(gpxRenamed).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...gpx, notes: 'x' }).success).toBe(false);
  });

  it('carries recorded-run metrics only with a current summary; pending and stale carry none', () => {
    for (const state of ['pending', 'stale']) {
      expect(activityHistoryItemSchema.safeParse({ ...run, summary: { state } }).success).toBe(true);
      expect(activityHistoryItemSchema.safeParse({ ...run, summary: { distanceM: 0, state } }).success).toBe(false);
    }
    expect(activityHistoryItemSchema.safeParse({ ...run, summary: { state: 'current' } }).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...run, summary: { ...run.summary, distanceM: -1 } }).success).toBe(false);
  });

  it('keeps a recorded run a run with an unknown capture source', () => {
    expect(activityHistoryItemSchema.safeParse({ ...run, type: 'ride' }).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...run, captureSource: 'simulator' }).success).toBe(false);
    expect(activityHistoryItemSchema.safeParse({ ...run, captureSource: undefined }).success).toBe(false);
  });

  it('refuses an unknown source, a total or a persisted response', () => {
    expect(activityHistoryItemSchema.safeParse({ ...manual, source: 'healthkit' }).success).toBe(false);
    expect(activityHistoryResponseSchema.safeParse({ ...response, totalDistanceM: 1 }).success).toBe(false);
    expect(activityHistoryResponseSchema.safeParse({ ...response, provenance: { ...response.provenance, persisted: true } }).success).toBe(false);
  });
});

describe('activity history cursor', () => {
  const cursor = { context: 'a'.repeat(43), id: activityId, kind: 'activity', startedAt: '2026-10-05T06:00:00.123456Z', version: 1 };

  it('accepts a microsecond position with a kind and a 43-character context', () => {
    expect(activityHistoryCursorSchema.parse(cursor)).toEqual(cursor);
  });

  it('refuses a millisecond position, another kind or version, a short context and extra fields', () => {
    for (const changed of [
      { startedAt: '2026-10-05T06:00:00.123Z' },
      { kind: 'meal' },
      { version: 2 },
      { context: 'short' },
      { userId: activityId },
    ]) {
      expect(activityHistoryCursorSchema.safeParse({ ...cursor, ...changed }).success, JSON.stringify(changed)).toBe(false);
    }
  });

  it('accepts real leap days and nonzero microseconds, unchanged', () => {
    for (const startedAt of [
      '2024-02-29T00:00:00.000000Z',
      '2000-02-29T12:34:56.000001Z',
      '0001-01-01T00:00:00.000000Z',
      '9999-12-31T23:59:59.999999Z',
      '2026-10-05T06:00:00.987654Z',
    ]) {
      expect(activityHistoryCursorSchema.parse({ ...cursor, startedAt }).startedAt, startedAt).toBe(startedAt);
    }
  });

  it('refuses impossible dates, year 0000, invalid clock values and other spellings', () => {
    for (const startedAt of [
      '2026-02-30T00:00:00.000000Z',
      '2025-02-29T00:00:00.000000Z',
      '1900-02-29T00:00:00.000000Z',
      '2026-04-31T00:00:00.000000Z',
      '2026-13-01T00:00:00.000000Z',
      '2026-00-10T00:00:00.000000Z',
      '2026-01-00T00:00:00.000000Z',
      '0000-01-01T00:00:00.000000Z',
      '2026-01-01T24:00:00.000000Z',
      '2026-01-01T23:60:00.000000Z',
      '2026-01-01T23:59:60.000000Z',
      '2026-01-01T23:59:59Z',
      '2026-01-01T23:59:59.1234567Z',
      '2026-01-01T23:59:59.123456z',
      '2026-01-01T23:59:59.123456+00:00',
      '2026-01-01 23:59:59.123456Z',
      '+02026-01-01T23:59:59.123456Z',
    ]) {
      expect(activityHistoryCursorSchema.safeParse({ ...cursor, startedAt }).success, startedAt).toBe(false);
    }
  });
});

describe('activity history OpenAPI', () => {
  it('documents the route, its filters and its response', () => {
    const operation = openApiDocument.paths['/api/orgs/{orgId}/activity-history'].get;
    expect(operation.parameters).toEqual([
      { $ref: '#/components/parameters/OrgId' },
      { $ref: '#/components/parameters/HistorySource' },
      { $ref: '#/components/parameters/HistoryType' },
      { $ref: '#/components/parameters/Limit50' },
      { $ref: '#/components/parameters/Cursor' },
    ]);
    expect(openApiDocument.components.parameters.HistorySource.schema.enum).toEqual([...ACTIVITY_HISTORY_SOURCES]);
    expect(openApiDocument.components.schemas.ActivityHistoryResponse).toBeDefined();
    expect(operation.description).toContain('UNION ALL');
    expect(operation.description).toContain('INVALID_CURSOR');
  });
});
