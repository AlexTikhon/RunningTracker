import {
  ARCHIVE_TRACK_MAX_BYTES,
  ARCHIVE_TRACK_MAX_VERTICES,
  apiErrorResponseSchema,
  archiveTrackResponseSchema,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

const runId = 'a6600000-0000-4000-8000-000000000001';
const origin = 'http://127.0.0.1:5173';
const now = '2026-11-01T12:00:00.000Z';
const geometry = {
  type: 'MultiLineString',
  coordinates: [[[179.9, 89], [180, 89]], [[-180, 89], [-179.9, 89]]],
};
const stats = {
  acceptedEdgeCount: 1, acceptedPointCount: 2, excessiveSpeedCount: 0,
  excessiveTimeGapCount: 0, insufficientData: false, nonpositiveTimeDeltaCount: 0,
  poorAccuracyPointCount: 0, rawPointCount: 2, segmentBreakCount: 0, seqGapCount: 0,
};
const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => Date.parse(now),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  utcNow: () => new Date(now),
};

describe('archive track under real runtime-role RLS', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let maintenancePool: Pool;
  const cookies = new Map<string, string>();

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const users = [ids.userOrgA, ids.userDual, ids.userInactive, ids.userStranger];
    const config = validateEnvironment({
      ALLOWED_ORIGINS: origin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: users.join(','),
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({ connectionString: integration.migration.connectionString, max: 2 });
    maintenancePool = new Pool({ connectionString: integration.maintenance.connectionString, max: 1 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 3 });
    app = createApp({
      clock, config, pool: runtimePool,
      sessionManager: new SessionManager({ clock, store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES), ttlMs: config.SESSION_TTL_MS }),
    });
    for (const userId of users) {
      const login = await request(app).post('/api/session').set('Origin', origin).send({ userId }).expect(201);
      const header: unknown = login.headers['set-cookie'];
      if (!Array.isArray(header) || typeof header[0] !== 'string') throw new Error('Expected a session cookie');
      cookies.set(userId, header[0].split(';', 1)[0]!);
    }
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision)
       VALUES ($1, $2, $3, 'finished', '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z', 1)`,
      [ids.orgA, runId, ids.userOrgA],
    );
    await ownerPool.query(
      `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s, quality_stats)
       VALUES ($1, $2, 1, 'v1', public.ST_SetSRID(public.ST_GeomFromGeoJSON($3), 4326), 130.5, 60.25, $4)`,
      [ids.orgA, runId, JSON.stringify(geometry), JSON.stringify(stats)],
    );
    await ownerPool.query(
      `INSERT INTO run_points (org_id, run_id, seq, segment_id, recorded_at, geom, accuracy_m, ingested_revision)
       SELECT $1, $2, n, 0, '2026-10-01T08:00:00Z'::timestamptz + n * interval '2 seconds',
              public.ST_SetSRID(public.ST_MakePoint(21 + n * 0.00001, 52), 4326), 3, 1
       FROM generate_series(1, 2) AS n`,
      [ids.orgA, runId],
    );
    await ownerPool.query(
      `INSERT INTO run_shares (org_id, run_id, grantee_user_id, can_read_history, can_read_live)
       VALUES ($1, $2, $3, true, false), ($1, $2, $4, true, false)`,
      [ids.orgA, runId, ids.userDual, ids.userInactive],
    );
  });

  afterAll(async () => {
    await Promise.all([runtimePool?.end(), ownerPool?.end(), maintenancePool?.end()]);
  });

  function track(userId: string = ids.userOrgA, orgId: string = ids.orgA, targetRunId = runId, query = 'mode=archive') {
    return request(app).get(`/api/orgs/${orgId}/runs/${targetRunId}/track?${query}`).set('Cookie', cookies.get(userId) ?? '');
  }

  async function expectError(answer: PromiseLike<request.Response>, status: number, code: string) {
    const response = await answer;
    expect(response.status).toBe(status);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe(code);
  }

  it.each([ids.userOrgA, ids.userDual])('returns a coherent published Feature to owner/history grantee %s', async (userId) => {
    const response = await track(userId).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.type).toBe('application/json');
    const feature = archiveTrackResponseSchema.parse(response.body);
    expect(feature.geometry).toEqual(geometry);
    expect(feature.properties).toEqual({
      algorithmVersion: 'v1', dataRevision: '1', distanceM: 130.5,
      finishedAt: '2026-10-01T09:00:00.000000Z', observedDurationS: 60.25,
      qualityStats: stats, rawState: 'available', runId, sourceRevision: '1',
      startedAt: '2026-10-01T08:00:00.000000Z', summaryState: 'ready',
    });
  });

  it('denies live-only permission and a coach role without a history share', async () => {
    await ownerPool.query('UPDATE run_shares SET can_read_history = false, can_read_live = true WHERE run_id = $1', [runId]);
    await expectError(track(ids.userDual), 404, 'RUN_NOT_FOUND');
    await expectError(track(ids.userStranger), 404, 'RUN_NOT_FOUND');
  });

  it('denies another tenant and inactive/missing memberships', async () => {
    await expectError(track(ids.userDual, ids.orgB), 404, 'RUN_NOT_FOUND');
    await expectError(track(ids.userOrgA, ids.orgB), 403, 'ORG_ACCESS_DENIED');
    await expectError(track(ids.userInactive), 403, 'ORG_ACCESS_DENIED');
  });

  it('requires a session and rejects invalid paths and queries', async () => {
    await expectError(request(app).get(`/api/orgs/${ids.orgA}/runs/${runId}/track?mode=archive`), 401, 'AUTH_REQUIRED');
    for (const query of ['', 'mode=live', 'mode=archive&extra=1', 'mode=archive&mode=archive']) {
      await expectError(track(ids.userOrgA, ids.orgA, runId, query), 400, 'INVALID_REQUEST');
    }
    await expectError(track(ids.userOrgA, ids.orgA, 'invalid'), 400, 'INVALID_REQUEST');
  });

  it('does not expose an active run as an archive track, even to its owner', async () => {
    await expectError(track(ids.userOrgA, ids.orgA, ids.runRecording), 404, 'RUN_NOT_FOUND');
    await expectError(track(ids.userDual, ids.orgA, ids.runRecordingHistoryOnly), 404, 'RUN_NOT_FOUND');
  });

  it('distinguishes a missing summary, a stale summary and a current empty track', async () => {
    await ownerPool.query('UPDATE runs SET data_revision = 2 WHERE id = $1', [runId]);
    const stale = archiveTrackResponseSchema.parse((await track().expect(200)).body);
    expect(stale.geometry).toBeNull();
    expect(stale.properties).toMatchObject({ summaryState: 'stale', dataRevision: '2', sourceRevision: '1', algorithmVersion: 'v1', distanceM: null, observedDurationS: null, qualityStats: null });
    await ownerPool.query('UPDATE run_summaries SET source_revision = 2, display_geom = NULL, distance_m = 0, observed_duration_s = 0, quality_stats = $2 WHERE run_id = $1', [runId, JSON.stringify({ ...stats, acceptedEdgeCount: 0, acceptedPointCount: 0, insufficientData: true })]);
    const empty = archiveTrackResponseSchema.parse((await track().expect(200)).body);
    expect(empty.geometry).toBeNull();
    expect(empty.properties).toMatchObject({ summaryState: 'ready', sourceRevision: '2', distanceM: 0, qualityStats: { insufficientData: true } });
    await ownerPool.query('DELETE FROM run_summaries WHERE run_id = $1', [runId]);
    const pending = archiveTrackResponseSchema.parse((await track().expect(200)).body);
    expect(pending.geometry).toBeNull();
    expect(pending.properties).toMatchObject({ summaryState: 'pending', sourceRevision: null, algorithmVersion: null, distanceM: null, qualityStats: null });
  });

  it('keeps archived geometry and metrics readable after a real maintenance raw purge', async () => {
    const before = archiveTrackResponseSchema.parse((await track().expect(200)).body);
    const purged = await maintenancePool.query<{ completed: boolean }>(
      'SELECT * FROM app_private.purge_run_raw_points_batch($1, $2, 1000, $3)', [ids.orgA, runId, now],
    );
    expect(purged.rows[0]?.completed).toBe(true);
    expect((await ownerPool.query('SELECT 1 FROM run_points WHERE run_id = $1', [runId])).rowCount).toBe(0);
    const after = archiveTrackResponseSchema.parse((await track().expect(200)).body);
    expect(after).toEqual({ ...before, properties: { ...before.properties, rawState: 'purged' } });
    await track(ids.userDual).expect(200);
  });

  it('retains published algorithm provenance when raw history can no longer be recomputed', async () => {
    await ownerPool.query("UPDATE runs SET raw_state = 'purged' WHERE id = $1", [runId]);
    await ownerPool.query("UPDATE run_summaries SET algorithm_version = 'historical-v0' WHERE run_id = $1", [runId]);
    expect(archiveTrackResponseSchema.parse((await track().expect(200)).body).properties).toMatchObject({ summaryState: 'ready', algorithmVersion: 'historical-v0' });
  });

  it('does not expose metrics from a publication until that transaction commits', async () => {
    await ownerPool.query('UPDATE runs SET data_revision = 2 WHERE id = $1', [runId]);
    const publisher = await maintenancePool.connect();
    try {
      await publisher.query('BEGIN');
      const publication = await publisher.query<{ published: boolean }>(
        `SELECT * FROM app_private.publish_run_summary($1, $2, 2, 'v1', public.ST_SetSRID(public.ST_GeomFromGeoJSON($3), 4326), 260, 120, $4, $5)`,
        [ids.orgA, runId, JSON.stringify(geometry), JSON.stringify(stats), now],
      );
      expect(publication.rows[0]?.published).toBe(true);
      const during = archiveTrackResponseSchema.parse((await track().expect(200)).body);
      expect(during.geometry).toBeNull();
      expect(during.properties).toMatchObject({ summaryState: 'stale', dataRevision: '2', sourceRevision: '1', distanceM: null });
      await publisher.query('COMMIT');
      const after = archiveTrackResponseSchema.parse((await track().expect(200)).body);
      expect(after.geometry).toEqual(geometry);
      expect(after.properties).toMatchObject({ summaryState: 'ready', dataRevision: '2', sourceRevision: '2', distanceM: 260, observedDurationS: 120 });
    } finally {
      await publisher.query('ROLLBACK');
      publisher.release();
    }
  });

  it('returns a complete old snapshot during deletion, then owner-only tombstone semantics', async () => {
    const deleter = await ownerPool.connect();
    try {
      await deleter.query('BEGIN');
      await deleter.query('SELECT * FROM app_private.delete_run_as_owner($1, $2, $3, $4)', [ids.orgA, runId, ids.userOrgA, now]);
      expect(archiveTrackResponseSchema.parse((await track().expect(200)).body).geometry).toEqual(geometry);
      await deleter.query('COMMIT');
      await expectError(track(), 410, 'RUN_DELETED');
      await expectError(track(ids.userDual), 404, 'RUN_NOT_FOUND');
    } finally {
      await deleter.query('ROLLBACK');
      deleter.release();
    }
  });

  it('removes access on committed share revocation without changing the owner read', async () => {
    await track(ids.userDual).expect(200);
    await ownerPool.query('DELETE FROM run_shares WHERE run_id = $1 AND grantee_user_id = $2', [runId, ids.userDual]);
    await expectError(track(ids.userDual), 404, 'RUN_NOT_FOUND');
    await track().expect(200);
  });

  it('bounds the entire Feature even when its geometry alone fits, and serves large tracks below the bound', async () => {
    const sample = await ownerPool.query<{ geometry: string }>(
      `SELECT public.ST_AsGeoJSON(public.ST_Multi(public.ST_MakeLine(point, point)), 15, 0) AS geometry
       FROM (SELECT public.ST_SetSRID(public.ST_MakePoint(123.12345678901234, 52.12345678901234), 4326) AS point) AS p`,
    );
    const text = sample.rows[0]!.geometry;
    const parsed = JSON.parse(text) as { coordinates: number[][][] };
    const pointBytes = Buffer.byteLength(JSON.stringify(parsed.coordinates[0]![0]), 'utf8') + 1;
    const vertices = 2 + Math.floor((ARCHIVE_TRACK_MAX_BYTES - Buffer.byteLength(text, 'utf8')) / pointBytes);
    const setVertices = (count: number) => ownerPool.query(
      `UPDATE run_summaries SET display_geom = (
         SELECT public.ST_Multi(public.ST_MakeLine(public.ST_SetSRID(public.ST_MakePoint(
           123.12345678901234, 52.12345678901234), 4326) ORDER BY n))
         FROM generate_series(1, $2::integer) AS n
       ) WHERE run_id = $1`, [runId, count],
    );
    await setVertices(vertices);
    const size = await ownerPool.query<{ bytes: number }>(
      'SELECT octet_length(public.ST_AsGeoJSON(display_geom, 15, 0)) AS bytes FROM run_summaries WHERE run_id = $1', [runId],
    );
    expect(size.rows[0]!.bytes).toBeLessThanOrEqual(ARCHIVE_TRACK_MAX_BYTES);
    expect(size.rows[0]!.bytes).toBeGreaterThan(ARCHIVE_TRACK_MAX_BYTES - pointBytes);
    await expectError(track(), 422, 'ARCHIVE_TRACK_TOO_COMPLEX');
    await setVertices(vertices - 100);
    const response = await track().expect(200);
    expect(Buffer.byteLength(response.text, 'utf8')).toBeLessThanOrEqual(ARCHIVE_TRACK_MAX_BYTES);
    expect(archiveTrackResponseSchema.parse(response.body).geometry?.coordinates[0]).toHaveLength(vertices - 100);
  });

  it.each([
    { vertices: ARCHIVE_TRACK_MAX_VERTICES + 1, noisy: false },
    { vertices: 40_000, noisy: true },
  ])('rejects excessive geometry without truncation ($vertices vertices, noisy=$noisy)', async ({ vertices, noisy }) => {
    await ownerPool.query(
      `UPDATE run_summaries SET display_geom = (
         SELECT public.ST_Multi(public.ST_MakeLine(public.ST_SetSRID(public.ST_MakePoint(
           CASE WHEN $3 THEN sin(n) * 100 ELSE 21 END,
           CASE WHEN $3 THEN cos(n) * 50 ELSE 52 END), 4326) ORDER BY n))
         FROM generate_series(1, $2::integer) AS n
       ) WHERE run_id = $1`, [runId, vertices, noisy],
    );
    const response = await track().expect(422);
    const error = apiErrorResponseSchema.parse(response.body).error;
    expect(error.code).toBe('ARCHIVE_TRACK_TOO_COMPLEX');
    expect(error.details).toEqual({ maxBytes: ARCHIVE_TRACK_MAX_BYTES, maxVertices: ARCHIVE_TRACK_MAX_VERTICES });
    expect(response.headers['cache-control']).toBe('private, no-store');
    // A stale oversized summary is not encoded or rejected: provenance still says why the track is unavailable.
    await ownerPool.query('UPDATE runs SET data_revision = 2 WHERE id = $1', [runId]);
    expect(archiveTrackResponseSchema.parse((await track().expect(200)).body).properties.summaryState).toBe('stale');
  });
});
