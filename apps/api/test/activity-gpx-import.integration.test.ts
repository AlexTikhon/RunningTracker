import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activityViewSchema,
  apiErrorResponseSchema,
  dailyOverviewSchema,
  GPX_IMPORT_MAX_BYTES,
  gpxImportPreviewSchema,
  weeklyReviewSchema,
} from '@running-tracker/contracts';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readGpxActivity } from '../src/activities/gpx-activity.js';
import { confirmGpxImport } from '../src/activities/gpx-import-service.js';
import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { createFileDeletionJournalSink } from '../src/maintenance/deletion-journal-sink.js';
import { runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { loadErasureLedger, reapplyErasures } from '../src/restore/reapply-erasures.js';
import { systemClock } from '../src/clock.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0086 over HTTP with the real runtime role, session, Origin and CSRF checks; the race and the erasure path against
// the real database. The tracks are synthetic, on the equator: no real person's location or time.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-10T12:00:00.000Z';
const ZONE = 'Europe/Warsaw';
const T0 = Date.parse('2026-11-09T07:00:00Z');
const GPX_TYPE = 'application/gpx+xml';

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

const activityId = (n: number) => `a9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const importKey = (n: number) => `b9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** One track: `segments` of points every 10 s along the equator at about 5.6 m/s, with a 5-minute pause between. */
function syntheticGpx(options: { creator?: string; offsetS?: number; segments?: number; startLon?: number } = {}): string {
  const segments = options.segments ?? 2;
  let second = options.offsetS ?? 0;
  let lon = options.startLon ?? 20;
  const parts: string[] = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const points: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      points.push(`<trkpt lat="0" lon="${lon.toFixed(6)}"><time>${new Date(T0 + second * 1_000).toISOString()}</time></trkpt>`);
      lon += 0.0005;
      second += 10;
    }
    parts.push(`<trkseg>${points.join('')}</trkseg>`);
    second += 300;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${options.creator ?? 'Synthetic'}" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Synthetic</name>${parts.join('')}</trk></gpx>`;
}

const TRACK = syntheticGpx();
// The summary the server must compute for TRACK: 2 segments x 3 edges of 0.5 millidegrees; 8 points; first to last
// point = 3 x 10 s + 10 s + 300 s + 3 x 10 s = 370 s.
const TRACK_DISTANCE_M = Math.round(6 * ((6_378_137 * 0.0005 * Math.PI) / 180));

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

const errorOf = (response: request.Response) => apiErrorResponseSchema.parse(response.body).error;

describe('ADR-0086 GPX activity import', () => {
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
    ownerPool = new Pool({ application_name: 'running-tracker-gpx-import-owner', connectionString: integration.migration.connectionString, max: 2 });
    maintenancePool = new Pool({ application_name: 'running-tracker-gpx-import-maintenance', connectionString: integration.maintenance.connectionString, max: 1 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 8 });
    // The fixtures prove the server-reported database and role (a *_test database, the owner role) before writing.
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    const runtimeIdentity = await runtimePool.query<{ database: string; role: string }>('SELECT current_database() AS database, current_user AS role');
    expect(runtimeIdentity.rows[0]).toEqual({ database: expect.stringMatching(/_test$/u) as unknown, role: 'running_tracker_runtime' });
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

  function preview(auth: Authentication, file: string | Buffer, options: { orgId?: string; query?: Record<string, string>; type?: string } = {}) {
    return request(app)
      .post(`${base(options.orgId ?? ids.orgA)}/gpx-preview`)
      .query(options.query ?? {})
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .set('Content-Type', options.type ?? GPX_TYPE)
      .send(typeof file === 'string' ? Buffer.from(file, 'utf8') : file);
  }

  function confirm(
    auth: Authentication,
    id: string,
    file: string,
    query: Record<string, string> = { idempotencyKey: importKey(1), type: 'ride' },
    orgId: string = ids.orgA,
  ) {
    return request(app)
      .put(`${base(orgId)}/${id}/gpx-import`)
      .query(query)
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .set('Content-Type', GPX_TYPE)
      .send(Buffer.from(file, 'utf8'));
  }

  const remove = (auth: Authentication, id: string) =>
    request(app).delete(`${base(ids.orgA)}/${id}`).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken);

  interface StoredRow {
    distance_m: number | null;
    duration_s: number;
    fingerprint_bytes: number | null;
    id: string;
    idempotency_key: string | null;
    notes: string | null;
    rpe: number | null;
    source: string;
    started_at: string;
    type: string;
    user_id: string;
  }

  const storedRows = async (): Promise<StoredRow[]> =>
    (
      await ownerPool.query<StoredRow>(
        `SELECT id, user_id, type, source, distance_m, duration_s, rpe, notes, idempotency_key::text,
                octet_length(import_fingerprint) AS fingerprint_bytes,
                to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
         FROM activities ORDER BY org_id, id`,
      )
    ).rows;

  /** Everything the import could touch: rows, the erasure outbox and the weekly insight source gates. */
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
      const response = await preview(owner, TRACK).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(gpxImportPreviewSchema.parse(response.body)).toEqual({
        duplicateOf: null,
        summary: {
          distanceM: TRACK_DISTANCE_M,
          elapsedDurationS: 370,
          endedAt: '2026-11-09T07:06:10.000Z',
          metricsVersion: 'gpx-summary-1',
          pointCount: 8,
          segmentCount: 2,
          startedAt: '2026-11-09T07:00:00.000Z',
        },
      });
      expect(await writeState()).toEqual(before);
    });

    it('names an existing import of the same track, also from a re-exported file, still writing nothing', async () => {
      const created = await confirm(owner, activityId(1), TRACK).expect(201);
      const before = await writeState();
      const reexported = syntheticGpx({ creator: 'Another app' }).replace('<name>Synthetic</name>', '<name>Renamed</name>');
      const response = await preview(owner, reexported).expect(200);
      expect(gpxImportPreviewSchema.parse(response.body).duplicateOf).toEqual({ activityId: (created.body as { activityId: string }).activityId });
      expect(await writeState()).toEqual(before);
      // Another person's import of the same track is not theirs to know about.
      expect(gpxImportPreviewSchema.parse((await preview(coach, TRACK).expect(200)).body).duplicateOf).toBeNull();
    });

    it('refuses a missing session, an unknown Origin or a missing CSRF token before reading the body', async () => {
      await request(app).post(`${base(ids.orgA)}/gpx-preview`).set('Origin', allowedOrigin).set('Content-Type', GPX_TYPE).send(TRACK).expect(401);
      await request(app)
        .post(`${base(ids.orgA)}/gpx-preview`)
        .set('Cookie', owner.cookie)
        .set('Origin', 'https://evil.example')
        .set(csrfHeaderName, owner.csrfToken)
        .set('Content-Type', GPX_TYPE)
        .send(TRACK)
        .expect(403);
      const noCsrf = await request(app).post(`${base(ids.orgA)}/gpx-preview`).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set('Content-Type', GPX_TYPE).send(TRACK);
      expect([noCsrf.status, errorOf(noCsrf).code]).toEqual([403, 'CSRF_DENIED']);
      // A request that announces far more than the limit and never sends its body: the session is checked first, so it
      // is answered 401 at once (no 413, and no wait for a body that would never be read).
      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const status = await new Promise<number>((resolve, reject) => {
          const pending = httpRequest(
            {
              headers: { 'Content-Length': String(GPX_IMPORT_MAX_BYTES * 4), 'Content-Type': GPX_TYPE, Origin: allowedOrigin },
              host: '127.0.0.1',
              method: 'POST',
              path: `${base(ids.orgA)}/gpx-preview`,
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

    it('accepts only the GPX media type, without a content encoding', async () => {
      for (const type of ['application/json', 'text/plain', 'application/xml', 'multipart/form-data; boundary=x']) {
        const response = await preview(owner, TRACK, { type });
        expect([type, response.status, errorOf(response).code]).toEqual([type, 415, 'UNSUPPORTED_MEDIA_TYPE']);
      }
      expect((await preview(owner, TRACK, { type: 'application/gpx+xml; charset=utf-8' })).status).toBe(200);
      const encoded = await request(app)
        .post(`${base(ids.orgA)}/gpx-preview`)
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .set('Content-Type', GPX_TYPE)
        .set('Content-Encoding', 'gzip')
        .send(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      expect([encoded.status, errorOf(encoded).code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    });

    it('reads a body of exactly the limit and refuses one byte more with 413, never truncating it', async () => {
      // Exactly the limit is read and judged (it is not a GPX file); one byte more is refused before parsing.
      const atLimit = await preview(owner, Buffer.alloc(GPX_IMPORT_MAX_BYTES, 0x20));
      expect([atLimit.status, errorOf(atLimit).code, errorOf(atLimit).details]).toEqual([422, 'GPX_UNSUPPORTED', { reason: 'not_xml' }]);
      const over = await preview(owner, Buffer.concat([Buffer.from(TRACK), Buffer.alloc(GPX_IMPORT_MAX_BYTES + 1 - Buffer.byteLength(TRACK), 0x20)]));
      expect([over.status, errorOf(over).code, errorOf(over).details]).toEqual([413, 'GPX_FILE_TOO_LARGE', { maxBytes: GPX_IMPORT_MAX_BYTES }]);
      expect(over.headers['cache-control']).toBe('no-store');
    });

    it('explains an unsupported file with a stable reason, and refuses DTDs without fetching anything', async () => {
      const cases: [string, string][] = [
        [TRACK.replace('<gpx', '<!DOCTYPE gpx [<!ENTITY t SYSTEM "http://127.0.0.1:9/never">]><gpx'), 'declaration'],
        [TRACK.replace('http://www.topografix.com/GPX/1/1', 'http://www.topografix.com/GPX/1/0'), 'not_gpx_1_1'],
        [TRACK.replace(/<time>[^<]*<\/time>/u, ''), 'time_missing'],
        [TRACK.replace('</trk>', '</trk><trk><trkseg><trkpt lat="1" lon="1"><time>2026-11-09T09:00:00Z</time></trkpt></trkseg></trk>'), 'track_count'],
        ['not a gpx file', 'malformed_xml'],
      ];
      for (const [file, reason] of cases) {
        const response = await preview(owner, file);
        expect([reason, response.status, errorOf(response).code, errorOf(response).details]).toEqual([reason, 422, 'GPX_UNSUPPORTED', { reason }]);
      }
    });

    it('refuses query parameters and an organization the person is not a member of', async () => {
      expect(errorOf(await preview(owner, TRACK, { query: { type: 'run' } }).expect(400)).code).toBe('INVALID_REQUEST');
      await preview(owner, TRACK, { orgId: ids.orgB }).expect(403);
    });
  });

  describe('confirmation', () => {
    it('creates a summary-only activity with server-owned gpx provenance and server-computed values', async () => {
      const response = await confirm(owner, activityId(1), TRACK).expect(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const view = activityViewSchema.parse(response.body);
      expect(view).toMatchObject({
        activityId: activityId(1),
        distanceM: TRACK_DISTANCE_M,
        durationS: 370,
        notes: null,
        rpe: null,
        source: 'gpx',
        startedAt: '2026-11-09T07:00:00.000Z',
        type: 'ride',
      });
      expect(await storedRows()).toEqual([
        {
          distance_m: TRACK_DISTANCE_M,
          duration_s: 370,
          fingerprint_bytes: 32,
          id: activityId(1),
          idempotency_key: importKey(1),
          notes: null,
          rpe: null,
          source: 'gpx',
          started_at: '2026-11-09T07:00:00.000Z',
          type: 'ride',
          user_id: ids.userOrgA,
        },
      ]);
      // Listed and read like any activity of the person's.
      const listed = await request(app).get(base(ids.orgA)).set('Cookie', owner.cookie).expect(200);
      expect((listed.body as { items: unknown[] }).items).toEqual([view]);
    });

    it('answers a retry of the same import with the stored activity, under the same or another id', async () => {
      const created = await confirm(owner, activityId(1), TRACK).expect(201);
      const retried = await confirm(owner, activityId(1), TRACK).expect(200);
      expect(retried.body).toEqual(created.body);
      const otherId = await confirm(owner, activityId(2), TRACK).expect(200);
      expect(otherId.body).toEqual(created.body);
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(1)]);
    });

    it('tells the person when the same attempt was already saved with another type, and saves nothing', async () => {
      await confirm(owner, activityId(1), TRACK).expect(201);
      const changed = await confirm(owner, activityId(2), TRACK, { idempotencyKey: importKey(1), type: 'run' }).expect(409);
      expect([errorOf(changed).code, errorOf(changed).details]).toEqual(['ACTIVITY_ALREADY_SAVED', { activityId: activityId(1) }]);
      const sameId = await confirm(owner, activityId(1), TRACK, { idempotencyKey: importKey(1), type: 'run' }).expect(409);
      expect(errorOf(sameId).code).toBe('ACTIVITY_CONFLICT');
      expect((await storedRows()).map((row) => [row.id, row.type])).toEqual([[activityId(1), 'ride']]);
    });

    it('refuses a new import of a track this person already imported, also re-exported, naming the activity', async () => {
      await confirm(owner, activityId(1), TRACK).expect(201);
      for (const file of [TRACK, syntheticGpx({ creator: 'Another app' })]) {
        const again = await confirm(owner, activityId(3), file, { idempotencyKey: importKey(3), type: 'run' }).expect(409);
        expect([errorOf(again).code, errorOf(again).details]).toEqual(['GPX_ALREADY_IMPORTED', { activityId: activityId(1) }]);
      }
      // A different track is a different activity.
      await confirm(owner, activityId(4), syntheticGpx({ offsetS: 7_200 }), { idempotencyKey: importKey(4), type: 'run' }).expect(201);
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(1), activityId(4)]);
    });

    it('recomputes everything from the uploaded file and accepts no total, time or source from the client', async () => {
      for (const extra of [{ distanceM: '1' }, { durationS: '1' }, { source: 'manual' }, { startedAt: '2026-11-09T06:00:00Z' }, { source: 'gpx' }]) {
        const response = await confirm(owner, activityId(1), TRACK, { idempotencyKey: importKey(1), type: 'ride', ...extra });
        expect([extra, response.status, errorOf(response).code]).toEqual([extra, 400, 'INVALID_REQUEST']);
      }
      for (const query of [{ idempotencyKey: importKey(1) }, { idempotencyKey: importKey(1), type: 'yoga' }, { idempotencyKey: 'nope', type: 'ride' }, { type: 'ride' }]) {
        expect((await confirm(owner, activityId(1), TRACK, query)).status).toBe(400);
      }
      const invalidFile = await confirm(owner, activityId(1), TRACK.replace('lat="0"', 'lat="91"'));
      expect([invalidFile.status, errorOf(invalidFile).details]).toEqual([422, { reason: 'coordinates' }]);
      expect(await storedRows()).toEqual([]);
    });

    it('keeps the manual create route manual: a client-selected source is refused', async () => {
      const manual = {
        durationS: 600,
        idempotencyKey: importKey(9),
        startedAt: '2026-11-09T10:00:00.000Z',
        type: 'walk',
      };
      const refused = await request(app)
        .put(`${base(ids.orgA)}/${activityId(9)}`)
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .type('application/json')
        .send({ ...manual, source: 'gpx' });
      expect([refused.status, errorOf(refused).code]).toEqual([400, 'INVALID_REQUEST']);
      await request(app)
        .put(`${base(ids.orgA)}/${activityId(9)}`)
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .type('application/json')
        .send(manual)
        .expect(201);
      // A GPX confirmation cannot take over the manual activity's id.
      expect(errorOf(await confirm(owner, activityId(9), TRACK).expect(409)).code).toBe('ACTIVITY_CONFLICT');
      expect((await storedRows()).map((row) => [row.id, row.source, row.fingerprint_bytes])).toEqual([[activityId(9), 'manual', null]]);
    });

    it('refuses without a session, Origin or CSRF token, and stores nothing', async () => {
      const url = `${base(ids.orgA)}/${activityId(1)}/gpx-import?idempotencyKey=${importKey(1)}&type=ride`;
      await request(app).put(url).set('Origin', allowedOrigin).set('Content-Type', GPX_TYPE).send(TRACK).expect(401);
      await request(app).put(url).set('Cookie', owner.cookie).set('Origin', 'https://evil.example').set(csrfHeaderName, owner.csrfToken).set('Content-Type', GPX_TYPE).send(TRACK).expect(403);
      await request(app).put(url).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set('Content-Type', GPX_TYPE).send(TRACK).expect(403);
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('settles concurrent confirmations of one track under different attempts to one activity', async () => {
      const responses = await Promise.all(
        [11, 12, 13, 14, 15, 16].map((n) => confirm(owner, activityId(n), TRACK, { idempotencyKey: importKey(n), type: 'ride' })),
      );
      const created = responses.filter((response) => response.status === 201);
      expect(created).toHaveLength(1);
      const winner = (created[0]!.body as { activityId: string }).activityId;
      for (const response of responses.filter((candidate) => candidate.status !== 201)) {
        expect([response.status, errorOf(response).code, errorOf(response).details]).toEqual([409, 'GPX_ALREADY_IMPORTED', { activityId: winner }]);
      }
      expect((await storedRows()).map((row) => row.id)).toEqual([winner]);
    });

    it('settles concurrent retries of one attempt under different ids to one activity', async () => {
      const responses = await Promise.all([21, 22, 23, 24].map((n) => confirm(owner, activityId(n), TRACK, { idempotencyKey: importKey(20), type: 'ride' })));
      expect(responses.map((response) => response.status).toSorted()).toEqual([200, 200, 200, 201]);
      const bodies = new Set(responses.map((response) => JSON.stringify(response.body)));
      expect(bodies.size).toBe(1);
      expect(await storedRows()).toHaveLength(1);
    });

    it('waits on the unique constraint in a real interleaving, then finds the winner (the constraint does the work)', async () => {
      // A has inserted the track but not committed when B confirms the same track under another attempt. B's reads
      // cannot see A's row; only the unique constraint makes B's insert wait for A and then insert nothing.
      const parsed = readGpxActivity(Buffer.from(TRACK), Date.parse(now));
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
        const a = await confirmGpxImport(first, session, ids.orgA, activityId(31), { idempotencyKey: importKey(31), type: 'ride' }, parsed);
        expect(a.created).toBe(true);
        const racing = confirmGpxImport(second, session, ids.orgA, activityId(32), { idempotencyKey: importKey(32), type: 'run' }, parsed).then(
          () => 'saved',
          (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await first.query('COMMIT');
        expect(await racing).toMatchObject({ code: 'GPX_ALREADY_IMPORTED', details: { activityId: activityId(31) }, statusCode: 409 });
        await second.query('ROLLBACK');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(31)]);
    });
  });

  describe('isolation', () => {
    it('scopes duplicates and visibility to the owner and organization', async () => {
      await confirm(owner, activityId(1), TRACK).expect(201);
      // Another member of the organization and a member of another organization import the same file: their own rows.
      await confirm(coach, activityId(2), TRACK, { idempotencyKey: importKey(2), type: 'walk' }).expect(201);
      await confirm(outsider, activityId(3), TRACK, { idempotencyKey: importKey(3), type: 'run' }, ids.orgB).expect(201);
      // Nobody sees anyone else's import.
      expect(((await request(app).get(base(ids.orgA)).set('Cookie', coach.cookie).expect(200)).body as { items: { activityId: string }[] }).items.map((item) => item.activityId)).toEqual([activityId(2)]);
      await request(app).get(`${base(ids.orgA)}/${activityId(1)}`).set('Cookie', coach.cookie).expect(404);
      // Another member's id is answered like a missing activity, and nothing of theirs changes.
      const otherTrack = syntheticGpx({ offsetS: 9_000 });
      expect(errorOf(await confirm(coach, activityId(1), otherTrack, { idempotencyKey: importKey(4), type: 'walk' }).expect(404)).code).toBe('ACTIVITY_NOT_FOUND');
      // The coach's own duplicate is detected against the coach's rows only.
      const coachAgain = await confirm(coach, activityId(5), TRACK, { idempotencyKey: importKey(5), type: 'walk' }).expect(409);
      expect(errorOf(coachAgain).details).toEqual({ activityId: activityId(2) });
      expect((await storedRows()).map((row) => [row.id, row.user_id, row.type])).toEqual([
        [activityId(1), ids.userOrgA, 'ride'],
        [activityId(2), ids.userStranger, 'walk'],
        [activityId(3), ids.userOrgB, 'run'],
      ]);
    });
  });

  describe('erasure', () => {
    it('records a deleted import in the erasure ledger without its content, replays it after a restore, and frees the track', async () => {
      await confirm(owner, activityId(1), TRACK).expect(201);
      // created_at as text: it identifies the record version to the microsecond, which a JavaScript Date would truncate.
      const original = (
        await ownerPool.query<Record<string, unknown>>('SELECT *, created_at::text AS created_at FROM activities WHERE id = $1', [activityId(1)])
      ).rows[0]!;
      const fingerprintHex = (original.import_fingerprint as Buffer).toString('hex');
      await remove(owner, activityId(1)).expect(204);

      const ledger = await ownerPool.query<Record<string, unknown>>('SELECT * FROM erasure_ledger');
      expect(ledger.rows).toHaveLength(1);
      expect(Object.keys(ledger.rows[0]!).toSorted()).toEqual(['entity_type', 'erased_at', 'ledger_seq', 'org_id', 'owner_user_id', 'record_created_at', 'record_id']);
      expect(ledger.rows[0]).toMatchObject({ entity_type: 'activity', record_id: activityId(1) });

      const directory = await mkdtemp(join(tmpdir(), 'rt-gpx-erasure-'));
      directories.push(directory);
      await runErasureLedgerExportOnce(maintenancePool, createFileDeletionJournalSink(directory), systemClock);
      const exported = (await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name), 'utf8')))).join('\n');
      expect(exported).toContain(activityId(1));
      for (const content of [fingerprintHex, (original.import_fingerprint as Buffer).toString('base64'), 'gpx', 'ride', String(TRACK_DISTANCE_M)]) {
        expect(exported).not.toContain(content);
      }

      // A restored backup brings the import back exactly as it was; replaying the exported ledger erases it again.
      await ownerPool.query(
        `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, idempotency_key, source, import_fingerprint, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [original.org_id, original.id, original.user_id, original.type, original.started_at, original.duration_s, original.distance_m, original.idempotency_key, original.source, original.import_fingerprint, original.created_at],
      );
      const outcome = await reapplyErasures(ownerPool, await loadErasureLedger(directory));
      expect(outcome.outcomes).toEqual({ absent: 0, erased: 1, skipped_different_record: 0 });
      expect(await storedRows()).toEqual([]);

      // Deleting the import freed its track: the same file can be imported again, as a new record version.
      const again = await confirm(owner, activityId(1), TRACK, { idempotencyKey: importKey(5), type: 'ride' }).expect(201);
      expect(activityViewSchema.parse(again.body).source).toBe('gpx');
      // The old ledger entry names the old record version and leaves the new one alone.
      expect((await reapplyErasures(ownerPool, await loadErasureLedger(directory))).outcomes).toEqual({ absent: 0, erased: 0, skipped_different_record: 1 });
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(1)]);
    });

    it('advances the weekly insight source gate on import and deletion, as for any activity', async () => {
      const revision = async () =>
        (await ownerPool.query<{ revision: string }>('SELECT revision::text FROM weekly_insight_source_gates WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA])).rows[0]?.revision ?? '0';
      const before = Number(await revision());
      await confirm(owner, activityId(1), TRACK).expect(201);
      const afterImport = Number(await revision());
      expect(afterImport).toBeGreaterThan(before);
      await remove(owner, activityId(1)).expect(204);
      expect(Number(await revision())).toBeGreaterThan(afterImport);
    });
  });

  describe('views', () => {
    it('shows an import apart from manual activities on Today and in the weekly review, and never as an AI fact', async () => {
      await confirm(owner, activityId(1), TRACK).expect(201);
      await request(app)
        .put(`${base(ids.orgA)}/${activityId(2)}`)
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .type('application/json')
        .send({ durationS: 1_200, idempotencyKey: importKey(2), startedAt: '2026-11-09T17:00:00.000Z', type: 'walk' })
        .expect(201);

      const today = dailyOverviewSchema.parse(
        (await request(app).get(`/api/orgs/${ids.orgA}/daily-overview/2026-11-09`).query({ timeZone: ZONE }).set('Cookie', owner.cookie).expect(200)).body,
      );
      expect(today.manualActivities).toEqual({ byType: [{ count: 1, enteredDurationS: 1_200, type: 'walk' }], count: 1, enteredDurationS: 1_200 });
      expect(today.importedActivities).toEqual({ byType: [{ count: 1, elapsedDurationS: 370, type: 'ride' }], count: 1, elapsedDurationS: 370, source: 'gpx' });
      expect(today.provenance.overviewVersion).toBe('daily-overview-3');

      const review = weeklyReviewSchema.parse(
        (await request(app).get(`/api/orgs/${ids.orgA}/weekly-review`).query({ timeZone: ZONE, weekStart: '2026-11-09' }).set('Cookie', owner.cookie).expect(200)).body,
      );
      expect(review.coverage.manualActivities).toEqual({ count: 1, withDistance: 0 });
      expect(review.importedActivities).toEqual({
        byType: [{ count: 1, distanceM: TRACK_DISTANCE_M, elapsedDurationS: 370, type: 'ride' }],
        count: 1,
        distanceM: TRACK_DISTANCE_M,
        elapsedDurationS: 370,
        source: 'gpx',
      });
      expect(review.statements.map((statement) => statement.code)).toContain('imported.gpx');
      expect(review.statements.find((statement) => statement.code === 'manual.total')?.text).toMatch(/^1 manual activity/u);
      // The AI-shared parts know nothing of the import.
      expect(JSON.stringify([review.facts, review.dataGaps, review.coverage])).not.toMatch(/ride|gpx|import/iu);
    });
  });
});
