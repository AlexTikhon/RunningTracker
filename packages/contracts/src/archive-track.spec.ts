import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_TRACK_MAX_VERTICES,
  archiveTrackQuerySchema,
  archiveTrackResponseSchema,
} from './http.js';

const provenance = {
  algorithmVersion: 'v1',
  sourceRevision: '5',
};
const scope = {
  dataRevision: '5',
  finishedAt: '2026-11-01T10:30:00.000Z',
  rawState: 'purged',
  runId: 'ad32e5d8-dd0d-4652-b26a-026033120c33',
  startedAt: '2026-11-01T10:00:00.000Z',
};
const qualityStats = {
  acceptedEdgeCount: 0, acceptedPointCount: 0, excessiveSpeedCount: 0,
  excessiveTimeGapCount: 0, insufficientData: true, nonpositiveTimeDeltaCount: 0,
  poorAccuracyPointCount: 0, rawPointCount: 1, segmentBreakCount: 0, seqGapCount: 0,
};
const ready = {
  geometry: null,
  properties: { ...scope, ...provenance, distanceM: 0, observedDurationS: 0, qualityStats, summaryState: 'ready' },
  type: 'Feature',
};
const pending = {
  geometry: null,
  properties: { ...scope, algorithmVersion: null, sourceRevision: null, distanceM: null,
    observedDurationS: null, qualityStats: null, summaryState: 'pending' },
  type: 'Feature',
};

describe('archive-track contracts', () => {
  it('requires exactly the archive mode', () => {
    expect(archiveTrackQuerySchema.safeParse({ mode: 'archive' }).success).toBe(true);
    for (const query of [{}, { mode: 'live' }, { mode: ['archive'] }, { mode: 'archive', limit: '10' }]) {
      expect(archiveTrackQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('distinguishes a current empty track from a pending summary', () => {
    expect(archiveTrackResponseSchema.parse(ready).properties.summaryState).toBe('ready');
    expect(archiveTrackResponseSchema.parse(pending).properties.summaryState).toBe('pending');
  });

  it('allows stale provenance but refuses old metrics or geometry', () => {
    const stale = { ...pending, properties: { ...pending.properties, ...provenance, sourceRevision: '4', summaryState: 'stale' } };
    expect(archiveTrackResponseSchema.safeParse(stale).success).toBe(true);
    expect(archiveTrackResponseSchema.safeParse({ ...stale, properties: { ...stale.properties, distanceM: 12 } }).success).toBe(false);
    expect(archiveTrackResponseSchema.safeParse({ ...stale, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] } }).success).toBe(false);
  });

  it('rejects inconsistent summary revisions without losing bigint precision', () => {
    const check = (summaryState: string, dataRevision: string, sourceRevision: string) =>
      archiveTrackResponseSchema.safeParse({ ...ready, properties: { ...ready.properties, dataRevision, sourceRevision, summaryState } }).success;
    expect(check('ready', '9007199254740993', '9007199254740992')).toBe(false);
    expect(check('ready', '9007199254740993', '9007199254740993')).toBe(true);
    expect(archiveTrackResponseSchema.safeParse({ ...pending, properties: { ...pending.properties, ...provenance, summaryState: 'stale' } }).success).toBe(false);
  });

  it('preserves separate chains at the antimeridian and polar coordinates', () => {
    const geometry = { type: 'MultiLineString', coordinates: [[[179.9, 89], [180, 89]], [[-180, 89], [-179.9, 89]]] };
    expect(archiveTrackResponseSchema.parse({ ...ready, geometry }).geometry).toEqual(geometry);
  });

  it.each([
    { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    { type: 'MultiLineString', coordinates: [] },
    { type: 'MultiLineString', coordinates: [[[0, 0]]] },
    { type: 'MultiLineString', coordinates: [[[181, 0], [1, 1]]] },
    { type: 'MultiLineString', coordinates: [[[0, Infinity], [1, 1]]] },
  ])('rejects invalid geometry $type $coordinates', (geometry) => {
    expect(archiveTrackResponseSchema.safeParse({ ...ready, geometry }).success).toBe(false);
  });

  it('bounds the total vertices across lines', () => {
    const coordinates = [Array.from({ length: ARCHIVE_TRACK_MAX_VERTICES }, () => [0, 0])];
    expect(archiveTrackResponseSchema.safeParse({ ...ready, geometry: { type: 'MultiLineString', coordinates } }).success).toBe(true);
    coordinates.push([[1, 1], [2, 2]]);
    expect(archiveTrackResponseSchema.safeParse({ ...ready, geometry: { type: 'MultiLineString', coordinates } }).success).toBe(false);
  });

  it('rejects unknown fields and reversed timestamps', () => {
    expect(archiveTrackResponseSchema.safeParse({ ...ready, extra: true }).success).toBe(false);
    expect(archiveTrackResponseSchema.safeParse({ ...ready, properties: { ...ready.properties, userId: scope.runId } }).success).toBe(false);
    expect(archiveTrackResponseSchema.safeParse({ ...ready, properties: { ...ready.properties, finishedAt: '2026-11-01T09:00:00.000Z' } }).success).toBe(false);
  });
});
