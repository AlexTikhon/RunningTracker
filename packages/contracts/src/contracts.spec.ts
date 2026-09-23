import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  apiErrorResponseSchema,
  archiveMetadataQuerySchema,
  archiveRunListQuerySchema,
  ingestPointsRequestSchema,
  liveStateSchema,
  liveTrackChangesQuerySchema,
  nearbyQuerySchema,
  openApiDocument,
  pointInputSchema,
  qualityStatsSchema,
  revisionSchema,
  runCommandRequestSchema,
  runListQuerySchema,
  runViewSchema,
  seqSchema,
  sessionResponseSchema,
  timestampSchema,
  trackPageSchema,
  uuidSchema,
} from './index.js';
import type { ApiErrorResponse, SessionResponse } from './index.js';

const userId = '9ea333f2-b02f-4a9e-85f9-af3a6016f677';
const runId = 'ad32e5d8-dd0d-4652-b26a-026033120c33';
const commandId = 'bd1de331-79b7-4942-92e4-0ac29d43c42d';
const timestamp = '2026-09-22T10:00:00.123Z';

const point = {
  accuracyM: 4.5,
  latitude: 52.2297,
  longitude: 21.0122,
  recordedAt: timestamp,
  segmentId: 0,
  seq: '1',
};

describe('shared model contracts', () => {
  it('accepts complete run and track payloads', () => {
    expect(
      runViewSchema.safeParse({
        controlRevision: '2',
        dataRevision: '9',
        finishedAt: null,
        rawState: 'available',
        runId,
        startedAt: timestamp,
        status: 'recording',
        summary: null,
      }).success,
    ).toBe(true);
    expect(
      trackPageSchema.safeParse({
        algorithmVersion: 'track-v1',
        fromRevision: null,
        nextCursor: null,
        toRevision: '9',
        upserts: [
          {
            accuracyM: 4.5,
            connectFromPrevious: false,
            coordinates: [21.0122, 52.2297],
            predecessorSeq: null,
            recordedAt: timestamp,
            segmentId: 0,
            seq: '1',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects unknown keys at top-level and nested object boundaries', () => {
    expect(pointInputSchema.safeParse({ ...point, extra: true }).success).toBe(false);
    expect(
      runViewSchema.safeParse({
        controlRevision: '0',
        dataRevision: '0',
        finishedAt: null,
        rawState: 'available',
        runId,
        startedAt: timestamp,
        status: 'recording',
        summary: null,
        unexpected: 'field',
      }).success,
    ).toBe(false);
  });

  it('enforces run lifecycle invariants already defined by the SDD', () => {
    const base = {
      controlRevision: '2',
      dataRevision: '9',
      rawState: 'available',
      runId,
      startedAt: timestamp,
      summary: null,
    };
    expect(
      runViewSchema.safeParse({ ...base, finishedAt: timestamp, status: 'finished' }).success,
    ).toBe(true);
    expect(
      runViewSchema.safeParse({ ...base, finishedAt: null, status: 'finished' }).success,
    ).toBe(false);
    expect(
      runViewSchema.safeParse({ ...base, finishedAt: null, rawState: 'purged', status: 'paused' })
        .success,
    ).toBe(false);
  });

  it('requires the complete nonnegative QualityStats shape', () => {
    const qualityStats = {
      acceptedEdgeCount: 1,
      acceptedPointCount: 2,
      excessiveSpeedCount: 0,
      excessiveTimeGapCount: 0,
      insufficientData: false,
      nonpositiveTimeDeltaCount: 0,
      poorAccuracyPointCount: 1,
      rawPointCount: 3,
      segmentBreakCount: 0,
      seqGapCount: 0,
    };
    expect(qualityStatsSchema.safeParse(qualityStats).success).toBe(true);
    expect(qualityStatsSchema.safeParse({ ...qualityStats, rawPointCount: -1 }).success).toBe(false);
    expect(qualityStatsSchema.safeParse({ ...qualityStats, extra: 0 }).success).toBe(false);
  });

  it('enforces UUID and UTC timestamp serialization', () => {
    expect(uuidSchema.safeParse(userId).success).toBe(true);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(timestampSchema.safeParse(timestamp).success).toBe(true);
    expect(timestampSchema.safeParse('2026-09-22T12:00:00+02:00').success).toBe(false);
    expect(timestampSchema.safeParse('2026-09-22').success).toBe(false);
  });

  it('enforces PostgreSQL bigint domains as decimal strings', () => {
    expect(revisionSchema.safeParse('0').success).toBe(true);
    expect(revisionSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(revisionSchema.safeParse('9223372036854775808').success).toBe(false);
    expect(revisionSchema.safeParse(1).success).toBe(false);
    expect(seqSchema.safeParse('1').success).toBe(true);
    expect(seqSchema.safeParse('0').success).toBe(false);
    expect(seqSchema.safeParse('-1').success).toBe(false);
  });

  it('enforces the complete canonical PointInput value domain', () => {
    expect(pointInputSchema.safeParse(point).success).toBe(true);
    for (const invalid of [
      { ...point, seq: '0' },
      { ...point, segmentId: -1 },
      { ...point, segmentId: 2_147_483_648 },
      { ...point, recordedAt: 'not-a-timestamp' },
      { ...point, longitude: Number.NaN },
      { ...point, longitude: Number.POSITIVE_INFINITY },
      { ...point, longitude: 180.000_001 },
      { ...point, latitude: -90.000_001 },
      { ...point, accuracyM: -0.01 },
      { ...point, accuracyM: Number.POSITIVE_INFINITY },
    ]) {
      expect(pointInputSchema.safeParse(invalid).success).toBe(false);
    }
    for (const missing of ['accuracyM', 'latitude', 'longitude', 'recordedAt', 'segmentId', 'seq']) {
      const candidate: Record<string, unknown> = { ...point };
      delete candidate[missing];
      expect(pointInputSchema.safeParse(candidate).success).toBe(false);
      expect(pointInputSchema.safeParse({ ...point, [missing]: null }).success).toBe(false);
    }
    expect(pointInputSchema.safeParse({ ...point, latitude: -90, longitude: 180 }).success).toBe(true);
    expect(pointInputSchema.safeParse({ ...point, latitude: 90, longitude: -180 }).success).toBe(true);
  });
});

describe('ordinary HTTP contracts', () => {
  it('accepts only the specified command types and string revisions', () => {
    const base = { commandId, expectedControlRevision: '4' };
    for (const type of ['pause', 'resume', 'finish']) {
      expect(runCommandRequestSchema.safeParse({ ...base, type }).success).toBe(true);
    }
    expect(runCommandRequestSchema.safeParse({ ...base, type: 'cancel' }).success).toBe(false);
    expect(
      runCommandRequestSchema.safeParse({ ...base, expectedControlRevision: 4, type: 'pause' })
        .success,
    ).toBe(false);
  });

  it('bounds point batches and canonicalizes D01-equivalent spellings', () => {
    expect(ingestPointsRequestSchema.safeParse({ points: [point] }).success).toBe(true);
    expect(ingestPointsRequestSchema.safeParse({ points: [] }).success).toBe(false);
    expect(
      ingestPointsRequestSchema.safeParse({ points: Array.from({ length: 100 }, () => point) })
        .success,
    ).toBe(true);
    expect(
      ingestPointsRequestSchema.safeParse({ points: Array.from({ length: 101 }, () => point) })
        .success,
    ).toBe(false);
    const canonical = pointInputSchema.parse({
      ...point,
      accuracyM: -0,
      latitude: -0,
      longitude: -0,
      recordedAt: '2026-09-22T10:00:00Z',
      seq: '0001',
    });
    expect(canonical).toEqual({
      ...point,
      accuracyM: 0,
      latitude: 0,
      longitude: 0,
      recordedAt: '2026-09-22T10:00:00.000Z',
    });
    expect(Object.is(canonical.longitude, -0)).toBe(false);
    expect(
      pointInputSchema.parse({ ...point, recordedAt: '2026-09-22T10:00:00.123499Z' })
        .recordedAt,
    ).toBe('2026-09-22T10:00:00.123Z');
    expect(
      pointInputSchema.parse({ ...point, recordedAt: '2026-09-22T10:00:00.123500Z' })
        .recordedAt,
    ).toBe('2026-09-22T10:00:00.124Z');
    expect(
      pointInputSchema.parse({ ...point, recordedAt: '2026-09-22T10:00:00.999500Z' })
        .recordedAt,
    ).toBe('2026-09-22T10:00:01.000Z');
  });

  it('validates pagination, mutually exclusive change cursors, ranges, bbox, and nearby inputs', () => {
    const range = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
    expect(runListQuerySchema.parse({ ...range, limit: '100' }).limit).toBe(100);
    expect(runListQuerySchema.safeParse({ ...range, limit: '101' }).success).toBe(false);
    expect(runListQuerySchema.safeParse({ ...range, limit: 10 }).success).toBe(false);
    expect(runListQuerySchema.safeParse({ from: range.to, to: range.from }).success).toBe(false);
    expect(liveTrackChangesQuerySchema.safeParse({ afterRevision: '4', limit: '1000' }).success).toBe(true);
    expect(liveTrackChangesQuerySchema.safeParse({ cursor: 'signed-cursor' }).success).toBe(true);
    expect(liveTrackChangesQuerySchema.safeParse({ afterRevision: '4', cursor: 'both' }).success).toBe(false);
    expect(liveTrackChangesQuerySchema.safeParse({}).success).toBe(false);
    expect(archiveRunListQuerySchema.safeParse({ ...range, bbox: '170,-10,-170,10' }).success).toBe(true);
    expect(archiveRunListQuerySchema.safeParse({ ...range, bbox: '0,-91,1,20' }).success).toBe(false);
    expect(
      archiveMetadataQuerySchema.safeParse({
        from: '2025-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(nearbyQuerySchema.parse({ latitude: '52.2', longitude: '21.0', radiusM: '5000' })).toEqual({
      latitude: 52.2,
      longitude: 21,
      radiusM: 5000,
    });
    expect(nearbyQuerySchema.safeParse({ latitude: '', longitude: '21', radiusM: '1' }).success).toBe(false);
    expect(nearbyQuerySchema.safeParse({ latitude: '52', longitude: '21', radiusM: '5001' }).success).toBe(false);
  });

  it('keeps the P03.1 public Session and ApiError shapes compatible', () => {
    const session: SessionResponse = {
      csrf: { headerName: 'x-csrf-token', token: 'a'.repeat(43) },
      expiresAt: timestamp,
      identity: { userId },
    };
    const apiError: ApiErrorResponse = {
      error: {
        code: 'INVALID_REQUEST',
        details: { fields: [{ message: 'Required', path: ['userId'] }] },
        message: 'The request is invalid',
        requestId: runId,
      },
    };
    expect(sessionResponseSchema.parse(session)).toEqual(session);
    expect(apiErrorResponseSchema.parse(apiError)).toEqual(apiError);
  });
});

describe('SSE and API specification', () => {
  it('validates strict live.state payloads and connection-local sequences', () => {
    const liveState = {
      algorithmVersion: 'track-v1',
      runs: [
        {
          dataRevision: '9',
          position: {
            accuracyM: 4.5,
            coordinates: [21.0122, 52.2297],
            quality: 'confirmed',
            recordedAt: timestamp,
            seq: '8',
          },
          runId,
          status: 'recording',
        },
      ],
      sequence: 0,
      serverTime: timestamp,
      streamId: userId,
    };
    expect(liveStateSchema.safeParse(liveState).success).toBe(true);
    expect(liveStateSchema.safeParse({ ...liveState, sequence: '0' }).success).toBe(false);
    expect(liveStateSchema.safeParse({ ...liveState, sequence: -1 }).success).toBe(false);
    expect(liveStateSchema.safeParse({ ...liveState, extra: true }).success).toBe(false);
    expect(
      liveStateSchema.safeParse({
        ...liveState,
        runs: [{ ...liveState.runs[0], status: 'finished' }],
      }).success,
    ).toBe(false);
  });

  it('publishes a generated OpenAPI 3.1 document for ordinary HTTP only', () => {
    expect(openApiDocument.openapi).toBe('3.1.0');
    expect(openApiDocument.paths['/api/orgs/{orgId}/runs/{runId}']).toBeDefined();
    expect(openApiDocument.paths['/api/orgs/{orgId}/archive/metadata']).toBeDefined();
    expect('/api/orgs/{orgId}/live' in openApiDocument.paths).toBe(false);

    const generatedArtifact = JSON.parse(
      readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(generatedArtifact).toEqual(openApiDocument);
  });
});
