import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activityHistoryResponseSchema,
  activityListResponseSchema,
  activityTrendsSchema,
  activityViewSchema,
  apiErrorResponseSchema,
  dailyOverviewSchema,
  gpxImportPreviewSchema,
  TCX_IMPORT_MAX_BYTES,
  tcxImportPreviewSchema,
  weeklyReviewSchema,
} from '@running-tracker/contracts';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readTcxActivity } from '../src/activities/tcx-activity.js';
import { confirmTcxImport } from '../src/activities/tcx-import-service.js';
import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { systemClock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { weekSourcesSql } from '../src/insights/weekly-insight-service.js';
import { createFileDeletionJournalSink } from '../src/maintenance/deletion-journal-sink.js';
import { runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { loadErasureLedger, reapplyErasures } from '../src/restore/reapply-erasures.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// ADR-0091 over HTTP with the real runtime role, session, Origin and CSRF checks; races, idempotency, erasure and every
// read model against the real database. The files are synthetic: no real person's activity, device or place.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-13T12:00:00.000Z';
const ZONE = 'Europe/Warsaw';
const TCX_TYPE = 'application/vnd.garmin.tcx+xml';
const GPX_TYPE = 'application/gpx+xml';
const TCD = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';
const MARKER = 'Marker Creator 41c2';

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse(now);
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(now);
  }
}

interface Authentication {
  cookie: string;
  csrfToken: string;
}

const activityId = (n: number) => `a9100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const importKey = (n: number) => `b9100000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface LapSpec {
  readonly distance: string;
  readonly start: string;
  readonly total: string;
}

/** A TCX v2 activity. `trackpoints` adds positions and heart rate, which never change the summary or fingerprint. */
function syntheticTcx(laps: readonly LapSpec[], options: { creator?: string; prefix?: boolean; trackpoints?: boolean } = {}): string {
  const p = options.prefix === true ? 't:' : '';
  const lapXml = laps
    .map(
      (lap) => `<${p}Lap StartTime="${lap.start}"><${p}TotalTimeSeconds>${lap.total}</${p}TotalTimeSeconds><${p}DistanceMeters>${lap.distance}</${p}DistanceMeters>
  <${p}Calories>80</${p}Calories><${p}Intensity>Active</${p}Intensity><${p}TriggerMethod>Manual</${p}TriggerMethod>${
    options.trackpoints === true
      ? `<${p}Track><${p}Trackpoint><${p}Time>${lap.start}</${p}Time><${p}Position><${p}LatitudeDegrees>0.5</${p}LatitudeDegrees><${p}LongitudeDegrees>20.25</${p}LongitudeDegrees></${p}Position><${p}HeartRateBpm><${p}Value>140</${p}Value></${p}HeartRateBpm></${p}Trackpoint></${p}Track>`
      : ''
  }</${p}Lap>`,
    )
    .join('\n');
  const root = options.prefix === true ? `<t:TrainingCenterDatabase xmlns:t="${TCD}">` : `<TrainingCenterDatabase xmlns="${TCD}">`;
  return `<?xml version="1.0" encoding="UTF-8"?>
${root}<${p}Activities><${p}Activity Sport="Other"><${p}Id>${laps[0]!.start}</${p}Id>
${lapXml}
<${p}Creator><${p}Name>${options.creator ?? MARKER}</${p}Name></${p}Creator></${p}Activity></${p}Activities></${p}TrainingCenterDatabase>`;
}

// A swim on Monday 2026-11-09 (Warsaw): laps report 1200.25 + 1199.75 = 2400 s exactly, 750.5 + 749.5 = 1500 m.
const SWIM_LAPS: LapSpec[] = [
  { distance: '750.5', start: '2026-11-09T06:00:00Z', total: '1200.25' },
  { distance: '749.5', start: '2026-11-09T06:20:30Z', total: '1199.75' },
];
const SWIM = syntheticTcx(SWIM_LAPS);
// Another outing: a ride whose single lap reports 3600.5 s (rounded half up to 3601) and 20000.4 m (20000).
const RIDE = syntheticTcx([{ distance: '20000.4', start: '2026-11-10T16:00:00Z', total: '3600.5' }]);

function syntheticGpx(): string {
  const points = [0, 1, 2, 3]
    .map((index) => `<trkpt lat="0" lon="${(20 + index * 0.0005).toFixed(6)}"><time>${new Date(Date.parse('2026-11-09T06:00:00Z') + index * 10_000).toISOString()}</time></trkpt>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Synthetic" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${points}</trkseg></trk></gpx>`;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

const errorOf = (response: request.Response) => apiErrorResponseSchema.parse(response.body).error;

describe('ADR-0091 TCX activity import', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let maintenancePool: Pool;
  let owner: Authentication;
  let coach: Authentication;
  let outsider: Authentication;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  const directories: string[] = [];

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    const config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userOrgA, ids.userStranger, ids.userOrgB].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({ application_name: 'running-tracker-tcx-import-owner', connectionString: integration.migration.connectionString, max: 2 });
    maintenancePool = new Pool({ application_name: 'running-tracker-tcx-import-maintenance', connectionString: integration.maintenance.connectionString, max: 1 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 8 });
    // The fixtures prove the server-reported database and role (a *_test database, the owner role) before writing; the
    // runtime and maintenance pools prove theirs before any request.
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    const identity = async (pool: Pool) => (await pool.query<{ database: string; role: string }>('SELECT current_database() AS database, current_user AS role')).rows[0];
    expect(await identity(runtimePool)).toEqual({ database: expect.stringMatching(/_test$/u) as unknown, role: 'running_tracker_runtime' });
    expect(await identity(maintenancePool)).toEqual({ database: expect.stringMatching(/_test$/u) as unknown, role: 'running_tracker_maintenance' });
    const clock = new FixedClock();
    app = createApp({
      clock,
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({ clock, store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES), ttlMs: config.SESSION_TTL_MS }),
    });
    owner = await login(ids.userOrgA);
    coach = await login(ids.userStranger);
    outsider = await login(ids.userOrgB);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    for (const directory of directories) await rm(directory, { force: true, recursive: true });
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
    return { cookie: cookiePair(response), csrfToken: (response.body as { csrf: { token: string } }).csrf.token };
  }

  const base = (orgId: string) => `/api/orgs/${orgId}/activities`;

  function upload(method: 'post' | 'put', url: string, auth: Authentication, file: string | Buffer, type = TCX_TYPE, query: Record<string, string> = {}) {
    return request(app)[method](url)
      .query(query)
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .set('Content-Type', type)
      .send(typeof file === 'string' ? Buffer.from(file, 'utf8') : file);
  }

  const preview = (auth: Authentication, file: string | Buffer, options: { orgId?: string; query?: Record<string, string>; type?: string } = {}) =>
    upload('post', `${base(options.orgId ?? ids.orgA)}/tcx-preview`, auth, file, options.type, options.query);

  const confirm = (
    auth: Authentication,
    id: string,
    file: string,
    query: Record<string, string> = { idempotencyKey: importKey(1), type: 'swim' },
    orgId: string = ids.orgA,
  ) => upload('put', `${base(orgId)}/${id}/tcx-import`, auth, file, TCX_TYPE, query);

  const confirmGpx = (auth: Authentication, id: string, query: Record<string, string>) =>
    upload('put', `${base(ids.orgA)}/${id}/gpx-import`, auth, syntheticGpx(), GPX_TYPE, query);

  const remove = (auth: Authentication, id: string) =>
    request(app).delete(`${base(ids.orgA)}/${id}`).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken);

  const createManual = (auth: Authentication, id: string, body: Record<string, unknown>) =>
    request(app).put(`${base(ids.orgA)}/${id}`).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken).type('application/json').send(body);

  interface StoredRow {
    distance_m: number | null;
    duration_s: number;
    fingerprint_bytes: number | null;
    id: string;
    idempotency_key: string | null;
    notes: string | null;
    org_id: string;
    rpe: number | null;
    source: string;
    started_at: string;
    type: string;
    user_id: string;
  }

  const storedRows = async (): Promise<StoredRow[]> =>
    (
      await ownerPool.query<StoredRow>(
        `SELECT org_id, id, user_id, type, source, distance_m, duration_s, rpe, notes, idempotency_key::text,
                octet_length(import_fingerprint) AS fingerprint_bytes,
                to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
         FROM activities ORDER BY org_id, id`,
      )
    ).rows;

  const writeState = async () =>
    (
      await ownerPool.query<{ state: unknown }>(
        `SELECT json_build_object(
           'activities', (SELECT coalesce(json_agg(row_to_json(activity) ORDER BY activity.org_id, activity.id), '[]'::json) FROM activities AS activity),
           'ledger', (SELECT count(*) FROM erasure_ledger),
           'gates', (SELECT coalesce(json_agg(json_build_object('o', gate.org_id, 'u', gate.user_id, 'r', gate.revision) ORDER BY gate.org_id, gate.user_id), '[]'::json)
                     FROM weekly_insight_source_gates AS gate)) AS state`,
      )
    ).rows[0]!.state;

  describe('preview', () => {
    it('answers the server-computed summary with no-store and writes nothing', async () => {
      const before = await writeState();
      const response = await preview(owner, SWIM).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(tcxImportPreviewSchema.parse(response.body)).toEqual({
        duplicateOf: null,
        summary: {
          distanceM: 1500,
          lapCount: 2,
          lapTotals: { distanceMeters: '1500', totalTimeSeconds: '2400' },
          metricsVersion: 'tcx-summary-1',
          reportedDurationS: 2400,
          startedAt: '2026-11-09T06:00:00.000Z',
        },
      });
      const ride = tcxImportPreviewSchema.parse((await preview(owner, RIDE).expect(200)).body).summary;
      expect([ride.lapTotals, ride.reportedDurationS, ride.distanceM]).toEqual([{ distanceMeters: '20000.4', totalTimeSeconds: '3600.5' }, 3601, 20000]);
      expect(await writeState()).toEqual(before);
    });

    it('names an existing TCX import of the same laps, also from a re-exported file, and never a GPX import or anyone else’s', async () => {
      const created = await confirm(owner, activityId(1), SWIM).expect(201);
      const before = await writeState();
      for (const reexported of [syntheticTcx(SWIM_LAPS, { creator: 'Another app', prefix: true, trackpoints: true }), SWIM.replace('>1200.25<', '>+1200.250<')]) {
        expect(tcxImportPreviewSchema.parse((await preview(owner, reexported).expect(200)).body).duplicateOf).toEqual({
          activityId: (created.body as { activityId: string }).activityId,
        });
      }
      expect(await writeState()).toEqual(before);
      expect(tcxImportPreviewSchema.parse((await preview(coach, SWIM).expect(200)).body).duplicateOf).toBeNull();
      // A GPX preview of the same outing never names the TCX import (no cross-format deduplication).
      const gpxPreview = await upload('post', `${base(ids.orgA)}/gpx-preview`, owner, syntheticGpx(), GPX_TYPE).expect(200);
      expect(gpxImportPreviewSchema.parse(gpxPreview.body).duplicateOf).toBeNull();
    });

    it('refuses a missing session, an unknown Origin or a missing CSRF token before reading the body', async () => {
      await request(app).post(`${base(ids.orgA)}/tcx-preview`).set('Origin', allowedOrigin).set('Content-Type', TCX_TYPE).send(SWIM).expect(401);
      await request(app)
        .post(`${base(ids.orgA)}/tcx-preview`)
        .set('Cookie', owner.cookie)
        .set('Origin', 'https://evil.example')
        .set(csrfHeaderName, owner.csrfToken)
        .set('Content-Type', TCX_TYPE)
        .send(SWIM)
        .expect(403);
      const noCsrf = await request(app).post(`${base(ids.orgA)}/tcx-preview`).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set('Content-Type', TCX_TYPE).send(SWIM);
      expect([noCsrf.status, errorOf(noCsrf).code]).toEqual([403, 'CSRF_DENIED']);
      // A request that announces far more than the limit and never sends its body is answered at once (401), not read.
      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const status = await new Promise<number>((resolve, reject) => {
          const pending = httpRequest(
            {
              headers: { 'Content-Length': String(TCX_IMPORT_MAX_BYTES * 4), 'Content-Type': TCX_TYPE, Origin: allowedOrigin },
              host: '127.0.0.1',
              method: 'POST',
              path: `${base(ids.orgA)}/tcx-preview`,
              port,
            },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
              pending.destroy();
            },
          );
          pending.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ECONNRESET') reject(error);
          });
          pending.flushHeaders();
        });
        expect(status).toBe(401);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('accepts only the TCX media type, without a content encoding; the GPX type is refused here and vice versa', async () => {
      for (const type of [GPX_TYPE, 'application/xml', 'text/xml', 'application/json', 'application/octet-stream', 'multipart/form-data; boundary=x']) {
        const response = await preview(owner, SWIM, { type });
        expect([type, response.status, errorOf(response).code]).toEqual([type, 415, 'UNSUPPORTED_MEDIA_TYPE']);
      }
      expect((await preview(owner, SWIM, { type: `${TCX_TYPE}; charset=utf-8` })).status).toBe(200);
      const onGpxRoute = await upload('post', `${base(ids.orgA)}/gpx-preview`, owner, SWIM, TCX_TYPE);
      expect([onGpxRoute.status, errorOf(onGpxRoute).code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
      const encoded = await request(app)
        .post(`${base(ids.orgA)}/tcx-preview`)
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .set('Content-Type', TCX_TYPE)
        .set('Content-Encoding', 'gzip')
        .send(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      expect([encoded.status, errorOf(encoded).code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    });

    it('reads a body of exactly the limit and refuses one byte more with 413, never truncating it', async () => {
      const atLimit = await preview(owner, Buffer.alloc(TCX_IMPORT_MAX_BYTES, 0x20));
      expect([atLimit.status, errorOf(atLimit).code, errorOf(atLimit).details]).toEqual([422, 'TCX_UNSUPPORTED', { reason: 'not_xml' }]);
      const over = await preview(owner, Buffer.concat([Buffer.from(SWIM), Buffer.alloc(TCX_IMPORT_MAX_BYTES + 1 - Buffer.byteLength(SWIM), 0x20)]));
      expect([over.status, errorOf(over).code, errorOf(over).details]).toEqual([413, 'TCX_FILE_TOO_LARGE', { maxBytes: TCX_IMPORT_MAX_BYTES }]);
      expect(over.headers['cache-control']).toBe('no-store');
    });

    it('explains an unsupported file with a stable reason, fetches nothing, and never echoes the file', async () => {
      const cases: [string, string][] = [
        [SWIM.replace('<TrainingCenterDatabase', '<!DOCTYPE x [<!ENTITY e SYSTEM "http://127.0.0.1:9/never">]><TrainingCenterDatabase'), 'declaration'],
        [SWIM.replace('</Activities>', '<MultiSportSession><Id>2026-11-09T06:00:00Z</Id></MultiSportSession></Activities>'), 'multisport'],
        [syntheticTcx([SWIM_LAPS[1]!, SWIM_LAPS[0]!]), 'lap_order'],
        [SWIM.replace('>1200.25<', `>-${MARKER}<`), 'number_invalid'],
        [SWIM.replace('StartTime="2026-11-09T06:00:00Z"', 'StartTime="2026-11-09T06:00:00"'), 'start_time_invalid'],
        [SWIM.replace(TCD, 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v1'), 'not_tcx_v2'],
        [syntheticGpx(), 'not_tcx'],
      ];
      for (const [file, reason] of cases) {
        const response = await preview(owner, file);
        expect([reason, response.status, errorOf(response).code, errorOf(response).details]).toEqual([reason, 422, 'TCX_UNSUPPORTED', { reason }]);
        expect(JSON.stringify(response.body)).not.toContain(MARKER);
        expect(JSON.stringify(response.body)).not.toContain('2026-11-09');
      }
    });

    it('refuses query parameters and an organization the person is not a member of', async () => {
      expect(errorOf(await preview(owner, SWIM, { query: { type: 'swim' } }).expect(400)).code).toBe('INVALID_REQUEST');
      await preview(owner, SWIM, { orgId: ids.orgB }).expect(403);
    });
  });

  describe('confirmation', () => {
    it('creates a summary-only activity with server-owned tcx provenance and the reported duration', async () => {
      const response = await confirm(owner, activityId(1), RIDE, { idempotencyKey: importKey(1), type: 'ride' }).expect(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const view = activityViewSchema.parse(response.body);
      expect(view).toMatchObject({ activityId: activityId(1), distanceM: 20000, durationS: 3601, notes: null, rpe: null, source: 'tcx', startedAt: '2026-11-10T16:00:00.000Z', type: 'ride' });
      expect(await storedRows()).toEqual([
        {
          distance_m: 20000,
          duration_s: 3601,
          fingerprint_bytes: 32,
          id: activityId(1),
          idempotency_key: importKey(1),
          notes: null,
          org_id: ids.orgA,
          rpe: null,
          source: 'tcx',
          started_at: '2026-11-10T16:00:00.000Z',
          type: 'ride',
          user_id: ids.userOrgA,
        },
      ]);
      // Nothing of the file but the summary: no column holds the creator, a lap, a position or the Sport.
      const row = (await ownerPool.query<Record<string, unknown>>('SELECT * FROM activities WHERE id = $1', [activityId(1)])).rows[0]!;
      expect(JSON.stringify(row)).not.toMatch(/Marker|Creator|Lap|Other|20\.25/u);
      // GET /activities and GET /activities/{id} return it with its source.
      const listed = activityListResponseSchema.parse((await request(app).get(base(ids.orgA)).set('Cookie', owner.cookie).expect(200)).body);
      expect(listed.items).toEqual([view]);
      expect(activityViewSchema.parse((await request(app).get(`${base(ids.orgA)}/${activityId(1)}`).set('Cookie', owner.cookie).expect(200)).body)).toEqual(view);
    });

    it('answers a retry of the same import with the stored activity, under the same or another id', async () => {
      const created = await confirm(owner, activityId(1), SWIM).expect(201);
      expect((await confirm(owner, activityId(1), SWIM).expect(200)).body).toEqual(created.body);
      expect((await confirm(owner, activityId(2), SWIM).expect(200)).body).toEqual(created.body);
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(1)]);
    });

    it('tells the person when the same attempt was already saved with another type, and saves nothing', async () => {
      await confirm(owner, activityId(1), SWIM).expect(201);
      const changed = await confirm(owner, activityId(2), SWIM, { idempotencyKey: importKey(1), type: 'other' }).expect(409);
      expect([errorOf(changed).code, errorOf(changed).details]).toEqual(['ACTIVITY_ALREADY_SAVED', { activityId: activityId(1) }]);
      expect(errorOf(await confirm(owner, activityId(1), SWIM, { idempotencyKey: importKey(1), type: 'other' }).expect(409)).code).toBe('ACTIVITY_CONFLICT');
      // The same key with another file: the attempt already saved something else.
      const otherFile = await confirm(owner, activityId(3), RIDE, { idempotencyKey: importKey(1), type: 'swim' }).expect(409);
      expect([errorOf(otherFile).code, errorOf(otherFile).details]).toEqual(['ACTIVITY_ALREADY_SAVED', { activityId: activityId(1) }]);
      expect((await storedRows()).map((row) => [row.id, row.type])).toEqual([[activityId(1), 'swim']]);
    });

    it('refuses a new import of laps this person already imported, also re-exported, naming the activity', async () => {
      await confirm(owner, activityId(1), SWIM).expect(201);
      for (const file of [SWIM, syntheticTcx(SWIM_LAPS, { creator: 'Another app', prefix: true, trackpoints: true })]) {
        const again = await confirm(owner, activityId(3), file, { idempotencyKey: importKey(3), type: 'other' }).expect(409);
        expect([errorOf(again).code, errorOf(again).details]).toEqual(['TCX_ALREADY_IMPORTED', { activityId: activityId(1) }]);
      }
      // Another split of the same totals is another activity: no repair, no guess.
      await confirm(owner, activityId(4), syntheticTcx([{ distance: '1500', start: '2026-11-09T06:00:00Z', total: '2400' }]), { idempotencyKey: importKey(4), type: 'swim' }).expect(201);
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(1), activityId(4)]);
    });

    it('recomputes everything from the uploaded file and accepts no total, time or source from the client', async () => {
      for (const extra of [{ distanceM: '1' }, { durationS: '1' }, { source: 'manual' }, { source: 'tcx' }, { startedAt: '2026-11-09T05:00:00Z' }, { reportedDurationS: '1' }]) {
        const response = await confirm(owner, activityId(1), SWIM, { idempotencyKey: importKey(1), type: 'swim', ...extra });
        expect([extra, response.status, errorOf(response).code]).toEqual([extra, 400, 'INVALID_REQUEST']);
      }
      for (const query of [{ idempotencyKey: importKey(1) }, { idempotencyKey: importKey(1), type: 'yoga' }, { idempotencyKey: 'nope', type: 'swim' }, { type: 'swim' }]) {
        expect((await confirm(owner, activityId(1), SWIM, query)).status).toBe(400);
      }
      const invalid = await confirm(owner, activityId(1), SWIM.replace('>750.5<', '>NaN<'));
      expect([invalid.status, errorOf(invalid).details]).toEqual([422, { reason: 'number_invalid' }]);
      expect(await storedRows()).toEqual([]);
    });

    it('keeps formats apart: no id takeover, no key reuse as a retry, and no cross-format duplicate', async () => {
      // A manual activity's id and a GPX import's id cannot be taken by a TCX confirmation.
      await createManual(owner, activityId(9), { durationS: 600, idempotencyKey: importKey(9), startedAt: '2026-11-09T10:00:00.000Z', type: 'walk' }).expect(201);
      expect(errorOf(await confirm(owner, activityId(9), SWIM).expect(409)).code).toBe('ACTIVITY_CONFLICT');
      await confirmGpx(owner, activityId(8), { idempotencyKey: importKey(8), type: 'swim' }).expect(201);
      expect(errorOf(await confirm(owner, activityId(8), SWIM, { idempotencyKey: importKey(8), type: 'swim' }).expect(409)).code).toBe('ACTIVITY_CONFLICT');
      // A GPX import's key under a new id is that earlier attempt, never a TCX retry: nothing is saved.
      const reusedKey = await confirm(owner, activityId(7), SWIM, { idempotencyKey: importKey(8), type: 'swim' }).expect(409);
      expect([errorOf(reusedKey).code, errorOf(reusedKey).details]).toEqual(['ACTIVITY_ALREADY_SAVED', { activityId: activityId(8) }]);
      // The same outing as GPX and as TCX is two records: no deduplication across formats.
      await confirm(owner, activityId(1), SWIM, { idempotencyKey: importKey(1), type: 'swim' }).expect(201);
      expect((await storedRows()).map((row) => [row.id, row.source])).toEqual([
        [activityId(1), 'tcx'],
        [activityId(8), 'gpx'],
        [activityId(9), 'manual'],
      ]);
      // The manual route still refuses a client-chosen source.
      expect((await createManual(owner, activityId(6), { durationS: 600, idempotencyKey: importKey(6), source: 'tcx', startedAt: '2026-11-09T10:00:00.000Z', type: 'walk' })).status).toBe(400);
    });

    it('refuses without a session, Origin or CSRF token, and stores nothing', async () => {
      const url = `${base(ids.orgA)}/${activityId(1)}/tcx-import?idempotencyKey=${importKey(1)}&type=swim`;
      await request(app).put(url).set('Origin', allowedOrigin).set('Content-Type', TCX_TYPE).send(SWIM).expect(401);
      await request(app).put(url).set('Cookie', owner.cookie).set('Origin', 'https://evil.example').set(csrfHeaderName, owner.csrfToken).set('Content-Type', TCX_TYPE).send(SWIM).expect(403);
      await request(app).put(url).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set('Content-Type', TCX_TYPE).send(SWIM).expect(403);
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('settles concurrent confirmations of one file under different attempts to one activity', async () => {
      const responses = await Promise.all([11, 12, 13, 14, 15, 16].map((n) => confirm(owner, activityId(n), SWIM, { idempotencyKey: importKey(n), type: 'swim' })));
      const created = responses.filter((response) => response.status === 201);
      expect(created).toHaveLength(1);
      const winner = (created[0]!.body as { activityId: string }).activityId;
      for (const response of responses.filter((candidate) => candidate.status !== 201)) {
        expect([response.status, errorOf(response).code, errorOf(response).details]).toEqual([409, 'TCX_ALREADY_IMPORTED', { activityId: winner }]);
      }
      expect((await storedRows()).map((row) => row.id)).toEqual([winner]);
    });

    it('settles concurrent retries of one attempt under different ids to one activity', async () => {
      const responses = await Promise.all([21, 22, 23, 24].map((n) => confirm(owner, activityId(n), SWIM, { idempotencyKey: importKey(20), type: 'swim' })));
      expect(responses.map((response) => response.status).toSorted()).toEqual([200, 200, 200, 201]);
      expect(new Set(responses.map((response) => JSON.stringify(response.body))).size).toBe(1);
      expect(await storedRows()).toHaveLength(1);
    });

    it('waits on the unique constraint in a real interleaving, then finds the winner (the constraint does the work)', async () => {
      const parsed = readTcxActivity(Buffer.from(SWIM), Date.parse(now));
      const session = { userId: ids.userOrgA };
      const begin = async (): Promise<PoolClient> => {
        const client = await runtimePool.connect();
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ids.userOrgA, ids.orgA]);
        return client;
      };
      const first = await begin();
      const second = await begin();
      try {
        const a = await confirmTcxImport(first, session, ids.orgA, activityId(31), { idempotencyKey: importKey(31), type: 'swim' }, parsed);
        expect(a.created).toBe(true);
        const racing = confirmTcxImport(second, session, ids.orgA, activityId(32), { idempotencyKey: importKey(32), type: 'other' }, parsed).then(
          () => 'saved',
          (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await first.query('COMMIT');
        expect(await racing).toMatchObject({ code: 'TCX_ALREADY_IMPORTED', details: { activityId: activityId(31) }, statusCode: 409 });
        await second.query('ROLLBACK');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(31)]);
    });

    it('settles a race on one idempotency key with different files to one saved attempt', async () => {
      const responses = await Promise.all([
        confirm(owner, activityId(41), SWIM, { idempotencyKey: importKey(40), type: 'swim' }),
        confirm(owner, activityId(42), RIDE, { idempotencyKey: importKey(40), type: 'swim' }),
      ]);
      const statuses = responses.map((response) => response.status).toSorted();
      expect(statuses).toEqual([201, 409]);
      const loser = responses.find((response) => response.status === 409)!;
      expect(errorOf(loser).code).toBe('ACTIVITY_ALREADY_SAVED');
      expect(await storedRows()).toHaveLength(1);
    });
  });

  describe('isolation', () => {
    it('scopes duplicates and visibility to the owner and organization', async () => {
      await confirm(owner, activityId(1), SWIM).expect(201);
      await confirm(coach, activityId(2), SWIM, { idempotencyKey: importKey(2), type: 'swim' }).expect(201);
      await confirm(outsider, activityId(3), SWIM, { idempotencyKey: importKey(3), type: 'swim' }, ids.orgB).expect(201);
      expect(activityListResponseSchema.parse((await request(app).get(base(ids.orgA)).set('Cookie', coach.cookie).expect(200)).body).items.map((item) => item.activityId)).toEqual([activityId(2)]);
      await request(app).get(`${base(ids.orgA)}/${activityId(1)}`).set('Cookie', coach.cookie).expect(404);
      expect(errorOf(await confirm(coach, activityId(1), RIDE, { idempotencyKey: importKey(4), type: 'ride' }).expect(404)).code).toBe('ACTIVITY_NOT_FOUND');
      expect(errorOf(await confirm(coach, activityId(5), SWIM, { idempotencyKey: importKey(5), type: 'swim' }).expect(409)).details).toEqual({ activityId: activityId(2) });
      // Another person's DELETE leaves the import alone.
      await remove(coach, activityId(1)).expect(204);
      expect((await storedRows()).map((row) => [row.id, row.user_id])).toEqual([
        [activityId(1), ids.userOrgA],
        [activityId(2), ids.userStranger],
        [activityId(3), ids.userOrgB],
      ]);
    });
  });

  describe('erasure', () => {
    it('records a deleted import without its content, keeps it absent after a restore and replay, and frees the file', async () => {
      await confirm(owner, activityId(1), SWIM).expect(201);
      const original = (await ownerPool.query<Record<string, unknown>>('SELECT *, created_at::text AS created_at FROM activities WHERE id = $1', [activityId(1)])).rows[0]!;
      const fingerprint = original.import_fingerprint as Buffer;
      await remove(owner, activityId(1)).expect(204);
      await remove(owner, activityId(1)).expect(204);

      const ledger = await ownerPool.query<Record<string, unknown>>('SELECT * FROM erasure_ledger');
      expect(ledger.rows).toHaveLength(1);
      expect(Object.keys(ledger.rows[0]!).toSorted()).toEqual(['entity_type', 'erased_at', 'ledger_seq', 'org_id', 'owner_user_id', 'record_created_at', 'record_id']);
      expect(ledger.rows[0]).toMatchObject({ entity_type: 'activity', record_id: activityId(1) });

      const directory = await mkdtemp(join(tmpdir(), 'rt-tcx-erasure-'));
      directories.push(directory);
      await runErasureLedgerExportOnce(maintenancePool, createFileDeletionJournalSink(directory), systemClock);
      const exported = (await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name), 'utf8')))).join('\n');
      expect(exported).toContain(activityId(1));
      for (const content of [fingerprint.toString('hex'), fingerprint.toString('base64'), 'tcx', 'swim', '2400', '1500']) expect(exported).not.toContain(content);

      // A restored older backup brings the import back exactly as it was; replaying the exported ledger erases it again.
      await ownerPool.query(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, idempotency_key, source, import_fingerprint, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [original.org_id, original.id, original.user_id, original.type, original.started_at, original.duration_s, original.distance_m, original.idempotency_key, original.source, original.import_fingerprint, original.created_at],
      );
      expect((await reapplyErasures(ownerPool, await loadErasureLedger(directory))).outcomes).toEqual({ absent: 0, erased: 1, skipped_different_record: 0 });
      expect(await storedRows()).toEqual([]);
      expect((await reapplyErasures(ownerPool, await loadErasureLedger(directory))).outcomes).toEqual({ absent: 1, erased: 0, skipped_different_record: 0 });

      // Deleting the import freed its laps: the same file imports again as a new record version, which the old entry spares.
      const again = await confirm(owner, activityId(1), SWIM, { idempotencyKey: importKey(5), type: 'swim' }).expect(201);
      expect(activityViewSchema.parse(again.body).source).toBe('tcx');
      expect((await reapplyErasures(ownerPool, await loadErasureLedger(directory))).outcomes).toEqual({ absent: 0, erased: 0, skipped_different_record: 1 });
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(1)]);
    });
  });

  describe('read models', () => {
    // Monday 2026-11-09 in Warsaw: a manual walk, a GPX import and a TCX swim; Tuesday a TCX ride. 2026-10-10: a TCX swim
    // in the previous period of trends ending 2026-11-12.
    async function seed(): Promise<void> {
      await createManual(owner, activityId(50), { durationS: 1_200, idempotencyKey: importKey(50), startedAt: '2026-11-09T17:00:00.000Z', type: 'walk' }).expect(201);
      await confirmGpx(owner, activityId(51), { idempotencyKey: importKey(51), type: 'swim' }).expect(201);
      await confirm(owner, activityId(52), SWIM, { idempotencyKey: importKey(52), type: 'swim' }).expect(201);
      await confirm(owner, activityId(53), RIDE, { idempotencyKey: importKey(53), type: 'ride' }).expect(201);
      await confirm(owner, activityId(54), syntheticTcx([{ distance: '1000', start: '2026-10-10T07:00:00Z', total: '1800' }]), { idempotencyKey: importKey(54), type: 'swim' }).expect(201);
      // Another member's TCX swim on the same day never counts for the owner.
      await confirm(coach, activityId(55), SWIM, { idempotencyKey: importKey(55), type: 'swim' }).expect(201);
    }

    const get = (url: string, query: Record<string, string>, auth = owner) => request(app).get(url).query(query).set('Cookie', auth.cookie).expect(200);

    it('lists TCX imports in the history with their reported duration, filtered by source, type and day', async () => {
      await seed();
      const all = activityHistoryResponseSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-history`, {})).body);
      expect(all.provenance.historyVersion).toBe('activity-history-3');
      // The tenant fixtures hold other records of this person too (runs, activities); these are the seeded ones.
      const seeded = new Set([50, 51, 52, 53, 54].map(activityId));
      const mine = all.items.filter((item) => item.source !== 'recorded_run' && seeded.has(item.activityId));
      expect(mine.map((item) => [item.source, item.type])).toEqual([
        ['tcx', 'ride'],
        ['manual', 'walk'],
        ['tcx', 'swim'],
        ['gpx', 'swim'],
        ['tcx', 'swim'],
      ]);
      const swim = all.items.find((item) => item.source === 'tcx' && item.startedAt === '2026-11-09T06:00:00.000Z');
      expect(swim).toEqual({ activityId: activityId(52), distanceM: 1500, reportedDurationS: 2400, source: 'tcx', startedAt: '2026-11-09T06:00:00.000Z', type: 'swim' });
      const onlyTcx = activityHistoryResponseSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-history`, { source: 'tcx' })).body);
      expect(onlyTcx.items.map((item) => item.source)).toEqual(['tcx', 'tcx', 'tcx']);
      const onlyGpx = activityHistoryResponseSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-history`, { source: 'gpx' })).body);
      expect(onlyGpx.items.map((item) => item.source)).toEqual(['gpx']);
      const day = activityHistoryResponseSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-history`, { localDate: '2026-11-09', source: 'tcx', timeZone: ZONE })).body);
      expect(day.items.map((item) => item.startedAt)).toEqual(['2026-11-09T06:00:00.000Z']);
      // The coach sees only the coach's own import.
      const coachView = activityHistoryResponseSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-history`, {}, coach)).body);
      expect(coachView.items.map((item) => item.source === 'recorded_run' ? item.runId : item.activityId)).toEqual([activityId(55)]);
    });

    it('shows TCX imports on Today apart from GPX imports and manual activities', async () => {
      await seed();
      const today = dailyOverviewSchema.parse((await get(`/api/orgs/${ids.orgA}/daily-overview/2026-11-09`, { timeZone: ZONE })).body);
      expect(today.provenance.overviewVersion).toBe('daily-overview-4');
      expect(today.tcxImportedActivities).toEqual({ byType: [{ count: 1, reportedDurationS: 2400, type: 'swim' }], count: 1, reportedDurationS: 2400, source: 'tcx' });
      expect(today.importedActivities).toMatchObject({ count: 1, source: 'gpx' });
      expect(today.manualActivities).toEqual({ byType: [{ count: 1, enteredDurationS: 1_200, type: 'walk' }], count: 1, enteredDurationS: 1_200 });
    });

    it('describes TCX imports in the weekly review on their own, outside every AI-shared part', async () => {
      await seed();
      const review = weeklyReviewSchema.parse((await get(`/api/orgs/${ids.orgA}/weekly-review`, { timeZone: ZONE, weekStart: '2026-11-09' })).body);
      expect(review.provenance.reviewVersion).toBe('weekly-review-4');
      expect(review.tcxImportedActivities).toEqual({
        byType: [
          { count: 1, distanceM: 20000, reportedDurationS: 3601, type: 'ride' },
          { count: 1, distanceM: 1500, reportedDurationS: 2400, type: 'swim' },
        ],
        count: 2,
        distanceM: 21500,
        reportedDurationS: 6001,
        source: 'tcx',
      });
      expect(review.importedActivities.count).toBe(1);
      expect(review.coverage.manualActivities).toEqual({ count: 1, withDistance: 0 });
      expect(review.statements.map((statement) => statement.code)).toContain('imported.tcx');
      expect(JSON.stringify([review.facts, review.dataGaps, review.coverage])).not.toMatch(/tcx|swim|ride|reportedDuration/iu);
      // The AI insight source statement reads manual activities only.
      expect(weekSourcesSql).toMatch(/activity\.source = 'manual'/u);
      expect(weekSourcesSql).not.toMatch(/tcx/u);
    });

    it('aggregates TCX activity trends under the reported duration, and compares them with the previous period', async () => {
      await seed();
      const trends = activityTrendsSchema.parse(
        (await get(`/api/orgs/${ids.orgA}/activity-trends`, { compare: 'previous_period', endDate: '2026-11-12', source: 'tcx', timeZone: ZONE, type: 'swim' })).body,
      );
      if (trends.source !== 'tcx') throw new Error('Expected a TCX answer');
      expect(trends.summary).toEqual({
        count: 1,
        daysWithEntries: 1,
        distance: { daysWithValue: 1, totalM: 1500, withValue: 1 },
        reportedDuration: { daysWithValue: 1, totalS: 2400, withValue: 1 },
      });
      expect(trends.days.find((day) => day.localDate === '2026-11-09')).toMatchObject({ count: 1, reportedDuration: { totalS: 2400, withValue: 1 } });
      expect(trends.comparison?.metrics).toMatchObject({
        count: { change: { absolute: 0, percent: 0, status: 'available' }, current: 1, previous: 1 },
        distance: { change: { absolute: 500, percent: 50, status: 'available' }, current: 1500, previous: 1000 },
        reportedDuration: { change: { absolute: 600, percent: 33.3, status: 'available' }, current: 2400, previous: 1800 },
      });
      // GPX trends for swims know nothing of TCX imports, and the other way round.
      const gpx = activityTrendsSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-trends`, { endDate: '2026-11-12', source: 'gpx', timeZone: ZONE, type: 'swim' })).body);
      expect(gpx.summary.count).toBe(1);
      expect('elapsedDuration' in gpx.summary && gpx.summary.elapsedDuration.totalS).toBe(30);
    });

    it('drops a deleted TCX import from every read model on the next read', async () => {
      await seed();
      await remove(owner, activityId(52)).expect(204);
      const today = dailyOverviewSchema.parse((await get(`/api/orgs/${ids.orgA}/daily-overview/2026-11-09`, { timeZone: ZONE })).body);
      expect(today.tcxImportedActivities.count).toBe(0);
      const history = activityHistoryResponseSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-history`, { source: 'tcx' })).body);
      expect(history.items.map((item) => (item.source === 'recorded_run' ? item.runId : item.activityId))).toEqual([activityId(53), activityId(54)]);
      const review = weeklyReviewSchema.parse((await get(`/api/orgs/${ids.orgA}/weekly-review`, { timeZone: ZONE, weekStart: '2026-11-09' })).body);
      expect(review.tcxImportedActivities.count).toBe(1);
      const trends = activityTrendsSchema.parse((await get(`/api/orgs/${ids.orgA}/activity-trends`, { endDate: '2026-11-12', source: 'tcx', timeZone: ZONE, type: 'swim' })).body);
      expect(trends.summary.count).toBe(0);
    });
  });
});
