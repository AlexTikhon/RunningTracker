import { randomUUID } from 'node:crypto';

import {
  ACTIVITY_HISTORY_VERSION,
  activityHistoryResponseSchema,
  apiErrorResponseSchema,
  type ActivityHistoryItem,
  type ActivityHistoryResponse,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { activityHistoryContext, encodeActivityHistoryCursor } from '../src/activity-history/activity-history-cursor.js';
import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment, type Environment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { createLogger } from '../src/observability/logger.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// The unified activity history (ADR-0087) over HTTP, with the real runtime role, sessions and row-level security.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-11T10:00:00.000Z';
const silent = createLogger({ clock: { utcNow: () => new Date(now) }, minLevel: 'error', write: () => undefined });

const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(now),
};

interface Authentication {
  cookie: string;
  csrfToken: string;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

const errorCode = (response: request.Response) => apiErrorResponseSchema.parse(response.body).error.code;
const itemId = (item: ActivityHistoryItem) => (item.source === 'recorded_run' ? item.runId : item.activityId);
const itemKey = (item: ActivityHistoryItem) => `${item.source}:${itemId(item)}`;

const stats = {
  acceptedEdgeCount: 2,
  acceptedPointCount: 3,
  excessiveSpeedCount: 0,
  excessiveTimeGapCount: 0,
  insufficientData: false,
  nonpositiveTimeDeltaCount: 0,
  poorAccuracyPointCount: 0,
  rawPointCount: 3,
  segmentBreakCount: 0,
  seqGapCount: 0,
};

describe('activity history HTTP API', () => {
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let sessions: SessionManager;
  let app: ReturnType<typeof createApp>;
  let owner: Authentication;
  let grantee: Authentication;
  let coach: Authentication;
  let outsider: Authentication;
  let inactive: Authentication;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userOrgA, ids.userStranger, ids.userDual, ids.userOrgB, ids.userInactive].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({ application_name: 'running-tracker-history-http-owner', connectionString: integration.migration.connectionString, max: 2 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    sessions = new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    app = createApp({ clock, config, logger: silent, pool: runtimePool, sessionManager: sessions });
    owner = await login(ids.userOrgA);
    grantee = await login(ids.userDual);
    coach = await login(ids.userStranger);
    outsider = await login(ids.userOrgB);
    inactive = await login(ids.userInactive);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
    return { cookie: cookiePair(response), csrfToken: (response.body as { csrf: { token: string } }).csrf.token };
  }

  const historyPath = (orgId: string = ids.orgA) => `/api/orgs/${orgId}/activity-history`;

  const get = (
    auth: Authentication | null,
    query: Record<string, string | string[]> = {},
    options: { orgId?: string; target?: ReturnType<typeof createApp> } = {},
  ) => {
    const pending = request(options.target ?? app).get(historyPath(options.orgId)).query(query);
    return auth === null ? pending : pending.set('Cookie', auth.cookie);
  };

  async function read(
    query: Record<string, string> = {},
    auth: Authentication = owner,
    options: { orgId?: string; target?: ReturnType<typeof createApp> } = {},
  ): Promise<ActivityHistoryResponse> {
    const response = await get(auth, query, options).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return activityHistoryResponseSchema.parse(response.body);
  }

  /** Every page, following nextCursor with the given page size, under the given filters. */
  async function readAll(query: Record<string, string> = {}, limit = 50, auth: Authentication = owner, orgId?: string): Promise<ActivityHistoryItem[]> {
    const items: ActivityHistoryItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const response: ActivityHistoryResponse = await read(
        { ...query, limit: String(limit), ...(cursor === null ? {} : { cursor }) },
        auth,
        orgId === undefined ? {} : { orgId },
      );
      expect(response.items.length).toBeLessThanOrEqual(limit);
      items.push(...response.items);
      cursor = response.nextCursor;
      if (cursor === null) return items;
    }
    throw new Error('The history did not end');
  }

  async function activity(
    startedAt: string,
    values: { distanceM?: number | null; durationS?: number; id?: string; notes?: string | null; orgId?: string; rpe?: number | null; source?: 'gpx' | 'manual'; type?: string; userId?: string } = {},
  ): Promise<string> {
    const id = values.id ?? randomUUID();
    const gpx = values.source === 'gpx';
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, rpe, notes, source, idempotency_key, import_fingerprint)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11::uuid,
               CASE WHEN $10 = 'gpx' THEN sha256(gen_random_uuid()::text::bytea) END)`,
      [
        values.orgId ?? ids.orgA,
        id,
        values.userId ?? ids.userOrgA,
        values.type ?? 'ride',
        startedAt,
        values.durationS ?? 1_800,
        values.distanceM === undefined ? 5_000 : values.distanceM,
        gpx ? null : values.rpe ?? null,
        gpx ? null : values.notes ?? null,
        gpx ? 'gpx' : 'manual',
        gpx ? randomUUID() : null,
      ],
    );
    return id;
  }

  /** A finished run with data revision 2; `summary` is the revision its summary was computed for (null: none yet). */
  async function run(
    startedAt: string,
    options: { distanceM?: number; id?: string; orgId?: string; status?: 'finished' | 'recording'; summary?: number | null; userId?: string } = {},
  ): Promise<string> {
    const runId = options.id ?? randomUUID();
    const finished = (options.status ?? 'finished') === 'finished';
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6, 2, 0, 'available')`,
      [
        options.orgId ?? ids.orgA,
        runId,
        options.userId ?? ids.userOrgA,
        options.status ?? 'finished',
        startedAt,
        finished ? new Date(Date.parse(startedAt) + 2_400_000).toISOString() : null,
      ],
    );
    if (options.summary !== null && options.summary !== undefined) {
      await ownerPool.query(
        `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s, quality_stats, computed_at)
         VALUES ($1, $2, $3, 'it-v1', ST_GeomFromText('MULTILINESTRING((21.0 52.0, 21.001 52.001))', 4326), $4, 2400, $5::jsonb, now())`,
        [options.orgId ?? ids.orgA, runId, options.summary, options.distanceM ?? 5_000, JSON.stringify(stats)],
      );
    }
    return runId;
  }

  const ownFixtureRuns = [ids.runFinishedHistory, ids.runFinishedLiveOnly, ids.runFinishedBoth];
  const withoutFixtureRuns = () => ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);

  const mutate = (path: string, auth: Authentication = owner) =>
    request(app).delete(path).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken);

  describe('ownership and organization isolation', () => {
    it('lists only the owner’s finished runs, never a recording run or another member’s', async () => {
      const response = await read();
      expect(response).toMatchObject({
        applied: { source: null, type: null },
        nextCursor: null,
        provenance: { historyVersion: ACTIVITY_HISTORY_VERSION, persisted: false, snapshot: 'single_read_only_transaction' },
      });
      expect(response.items.map(itemId).toSorted()).toEqual([...ownFixtureRuns].toSorted());
      expect(response.items.every((item) => item.source === 'recorded_run' && item.captureSource === null)).toBe(true);
    });

    it('never shows a grantee the runs shared with them, under any filter, while their own activities appear', async () => {
      // The grantee holds history and live grants on three of the owner's finished runs in this organization.
      const grants = await ownerPool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM run_shares WHERE grantee_user_id = $1 AND org_id = $2 AND can_read_history',
        [ids.userDual, ids.orgA],
      );
      expect(grants.rows[0]!.count).toBeGreaterThan(0);
      for (const query of [{}, { source: 'recorded_run' }, { type: 'run' }, { source: 'recorded_run', type: 'run' }]) {
        expect((await read(query, grantee)).items, JSON.stringify(query)).toEqual([]);
      }
      const own = await activity('2026-10-02T06:00:00.000Z', { userId: ids.userDual });
      expect((await read({}, grantee)).items.map(itemId)).toEqual([own]);
      // The owner's activities are invisible to the grantee as well.
      await activity('2026-10-03T06:00:00.000Z');
      expect((await read({}, grantee)).items.map(itemId)).toEqual([own]);
    });

    it('shows a coach in the organization nothing of the runner’s, and another organization nothing of this one', async () => {
      await activity('2026-10-02T06:00:00.000Z');
      expect((await read({}, coach)).items).toEqual([]);
      // userDual is a coach in organization B with a history grant on runOrgBShared; it never appears.
      expect((await read({}, grantee, { orgId: ids.orgB })).items).toEqual([]);
      const own = await activity('2026-10-02T07:00:00.000Z', { userId: ids.userDual });
      expect((await read({}, grantee, { orgId: ids.orgB })).items).toEqual([]);
      expect((await read({}, grantee)).items.map(itemId)).toEqual([own]);
      // The organization B runner sees their own two runs there and nothing of organization A.
      const orgB = await read({}, outsider, { orgId: ids.orgB });
      expect(orgB.items.map(itemId).toSorted()).toEqual([ids.runOrgBCoachHidden, ids.runOrgBShared].toSorted());
    });

    it('refuses a non-member, an inactive member and an anonymous request', async () => {
      const foreign = await get(outsider).expect(403);
      expect(errorCode(foreign)).toBe('ORG_ACCESS_DENIED');
      expect(foreign.headers['cache-control']).toBe('no-store');
      expect(errorCode(await get(inactive).expect(403))).toBe('ORG_ACCESS_DENIED');
      const anonymous = await get(null).expect(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
    });
  });

  describe('mixed sources, order and pagination', () => {
    const T = '2026-10-01T07:00:00.123456Z';

    async function seedTies(): Promise<{ expected: string[] }> {
      await withoutFixtureRuns();
      const shared = '00000000-0000-4000-8000-0000000000aa';
      const low = '00000000-0000-4000-8000-000000000001';
      const high = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      // At one microsecond: a manual activity and a run that share an id, a GPX import and a run with other ids.
      await activity(T, { id: shared, notes: 'tie', rpe: 5 });
      await activity(T, { id: high, source: 'gpx', type: 'hike' });
      await activity(T, { id: low });
      await run(T, { id: shared, summary: 2 });
      await run(T, { id: low, summary: null });
      // One microsecond on either side, and an older and a newer item.
      await activity('2026-10-01T07:00:00.123457Z', { id: randomUUID(), type: 'swim' });
      const before = await run('2026-10-01T07:00:00.123455Z', { summary: 1 });
      const newest = await activity('2026-10-05T07:00:00.000Z', { source: 'gpx' });
      const oldest = await activity('2026-09-01T07:00:00.000Z', { type: 'run' });
      const rows = await ownerPool.query<{ key: string }>(
        `SELECT key FROM (
           SELECT source || ':' || id AS key, started_at, 0 AS rank, id FROM activities WHERE org_id = $1 AND user_id = $2
           UNION ALL
           SELECT 'recorded_run:' || id, started_at, 1, id FROM runs WHERE org_id = $1 AND user_id = $2 AND status = 'finished'
         ) AS entry ORDER BY started_at DESC, rank DESC, id DESC`,
        [ids.orgA, ids.userOrgA],
      );
      const expected = rows.rows.map((row) => row.key);
      expect(expected[0]).toBe(`gpx:${newest}`);
      expect(expected.at(-1)).toBe(`manual:${oldest}`);
      expect(expected.indexOf(`recorded_run:${before}`)).toBe(expected.length - 2);
      return { expected };
    }

    it('orders by start, then a run before an activity, then id, also when an activity and a run share an id', async () => {
      const { expected } = await seedTies();
      const all = await read({ limit: '50' });
      expect(all.items.map(itemKey)).toEqual(expected);
      expect(all.nextCursor).toBeNull();
      const tied = all.items.filter((item) => item.startedAt === '2026-10-01T07:00:00.123456Z');
      expect(tied.map(itemKey)).toEqual([
        'recorded_run:00000000-0000-4000-8000-0000000000aa',
        'recorded_run:00000000-0000-4000-8000-000000000001',
        'gpx:ffffffff-ffff-4fff-8fff-ffffffffffff',
        'manual:00000000-0000-4000-8000-0000000000aa',
        'manual:00000000-0000-4000-8000-000000000001',
      ]);
    });

    it('pages through ties at every page size with nothing repeated or skipped', async () => {
      const { expected } = await seedTies();
      for (const limit of [1, 2, 3, 4, 5, 7, 9]) {
        expect((await readAll({}, limit)).map(itemKey), `limit ${limit}`).toEqual(expected);
      }
    });

    it('returns the default page of 20 and a cursor when more exist', async () => {
      await withoutFixtureRuns();
      for (let index = 0; index < 23; index += 1) {
        await activity(new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 60_000).toISOString());
      }
      const first = await read();
      expect(first.items).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      const second = await read({ cursor: first.nextCursor! });
      expect(second.items).toHaveLength(3);
      expect(second.nextCursor).toBeNull();
    });

    it('labels each source’s duration for what it is and never adds sources together', async () => {
      await withoutFixtureRuns();
      const manualId = await activity('2026-10-03T06:00:00.000Z', { distanceM: null, durationS: 3_600, notes: 'Hills', rpe: 7, type: 'run' });
      const gpxId = await activity('2026-10-02T06:00:00.000Z', { distanceM: 10_400, durationS: 4_000, source: 'gpx', type: 'run' });
      const runId = await run('2026-10-01T06:00:00.000Z', { distanceM: 5_012.25, summary: 2 });
      const response = await get(owner).expect(200);
      const body = activityHistoryResponseSchema.parse(response.body);
      expect(body.items).toEqual([
        { activityId: manualId, distanceM: null, enteredDurationS: 3_600, notes: 'Hills', rpe: 7, source: 'manual', startedAt: '2026-10-03T06:00:00.000Z', type: 'run' },
        { activityId: gpxId, distanceM: 10_400, elapsedDurationS: 4_000, source: 'gpx', startedAt: '2026-10-02T06:00:00.000Z', type: 'run' },
        {
          captureSource: null,
          finishedAt: '2026-10-01T06:40:00.000Z',
          runId,
          source: 'recorded_run',
          startedAt: '2026-10-01T06:00:00.000Z',
          summary: { distanceM: 5_012.25, gpsQuality: 'good', observedDurationS: 2_400, state: 'current' },
          type: 'run',
        },
      ]);
      expect(Object.keys(response.body as object).toSorted()).toEqual(['applied', 'items', 'nextCursor', 'provenance']);
    });
  });

  describe('filters', () => {
    async function seedSources() {
      await withoutFixtureRuns();
      return {
        gpxRide: await activity('2026-10-04T06:00:00.000Z', { source: 'gpx', type: 'ride' }),
        gpxRun: await activity('2026-10-05T06:00:00.000Z', { source: 'gpx', type: 'run' }),
        manualRide: await activity('2026-10-02T06:00:00.000Z', { type: 'ride' }),
        manualRun: await activity('2026-10-03T06:00:00.000Z', { type: 'run' }),
        recorded: await run('2026-10-01T06:00:00.000Z', { summary: null }),
        recordedOther: await run('2026-10-06T06:00:00.000Z', { summary: 2 }),
      };
    }

    it('filters by source and by type, alone and together, and echoes the filters', async () => {
      const seeded = await seedSources();
      const ids_ = async (query: Record<string, string>) => {
        const response = await read(query);
        expect(response.applied).toEqual({ day: null, source: query.source ?? null, type: query.type ?? null });
        return response.items.map(itemId);
      };
      expect(await ids_({ source: 'manual' })).toEqual([seeded.manualRun, seeded.manualRide]);
      expect(await ids_({ source: 'gpx' })).toEqual([seeded.gpxRun, seeded.gpxRide]);
      expect(await ids_({ source: 'recorded_run' })).toEqual([seeded.recordedOther, seeded.recorded]);
      expect(await ids_({ type: 'run' })).toEqual([seeded.recordedOther, seeded.gpxRun, seeded.manualRun, seeded.recorded]);
      expect(await ids_({ type: 'ride' })).toEqual([seeded.gpxRide, seeded.manualRide]);
      expect(await ids_({ source: 'manual', type: 'ride' })).toEqual([seeded.manualRide]);
      expect(await ids_({ source: 'recorded_run', type: 'ride' })).toEqual([]);
      expect(await ids_({ type: 'swim' })).toEqual([]);
    });

    it('paginates within a filter', async () => {
      const seeded = await seedSources();
      expect((await readAll({ type: 'run' }, 1)).map(itemId)).toEqual([seeded.recordedOther, seeded.gpxRun, seeded.manualRun, seeded.recorded]);
      expect((await readAll({ source: 'gpx' }, 1)).map(itemId)).toEqual([seeded.gpxRun, seeded.gpxRide]);
    });

    it('refuses a cursor from other filters, another person or another organization, and a tampered one', async () => {
      await seedSources();
      const manualCursor = (await read({ limit: '1', source: 'manual' })).nextCursor!;
      const unfilteredCursor = (await read({ limit: '1' })).nextCursor!;
      for (const [query, auth, orgId] of [
        [{ cursor: manualCursor, source: 'gpx' }, owner, undefined],
        [{ cursor: manualCursor }, owner, undefined],
        [{ cursor: manualCursor, source: 'manual', type: 'ride' }, owner, undefined],
        [{ cursor: unfilteredCursor, type: 'run' }, owner, undefined],
        [{ cursor: unfilteredCursor }, grantee, undefined],
        [{ cursor: unfilteredCursor }, grantee, ids.orgB],
        [{ cursor: `${unfilteredCursor.slice(0, -2)}AA` }, owner, undefined],
        [{ cursor: 'not-a-cursor' }, owner, undefined],
      ] as const) {
        const response = await get(auth, query, orgId === undefined ? {} : { orgId }).expect(400);
        expect(errorCode(response), JSON.stringify(query)).toBe('INVALID_CURSOR');
        expect(response.headers['cache-control']).toBe('no-store');
      }
      // The matching scope accepts it.
      await read({ cursor: manualCursor, source: 'manual' });
    });

    it('refuses a correctly scoped cursor with an impossible start before acquiring a database connection', async () => {
      await seedSources();
      const context = activityHistoryContext({ day: null, orgId: ids.orgA, source: null, type: null, userId: ids.userOrgA });
      const connect = vi.spyOn(runtimePool, 'connect');
      try {
        for (const startedAt of ['2026-02-30T00:00:00.000000Z', '2025-02-29T00:00:00.000000Z', '2026-04-31T00:00:00.000000Z', '0000-01-01T00:00:00.000000Z', '2026-01-01T24:00:00.000000Z']) {
          const cursor = encodeActivityHistoryCursor({ context, id: randomUUID(), kind: 'activity', startedAt });
          connect.mockClear();
          const response = await get(owner, { cursor }).expect(400);
          expect(errorCode(response), startedAt).toBe('INVALID_CURSOR');
          expect(response.headers['cache-control']).toBe('no-store');
          expect(connect, startedAt).not.toHaveBeenCalled();
        }
        // The same scope with a real leap day and microseconds is read from the database.
        connect.mockClear();
        const cursor = encodeActivityHistoryCursor({ context, id: randomUUID(), kind: 'activity', startedAt: '2024-02-29T23:59:59.999999Z' });
        expect((await read({ cursor })).items).toEqual([]);
        expect(connect).toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    });

    it('refuses repeated, unknown and invalid parameters', async () => {
      for (const query of [
        { source: ['manual', 'gpx'] },
        { type: ['run', 'ride'] },
        { source: 'import' },
        { type: 'yoga' },
        { limit: '51' },
        { limit: '0' },
        { userId: ids.userOrgA },
        { owner: 'me' },
      ]) {
        const response = await get(owner, query).expect(400);
        expect(errorCode(response), JSON.stringify(query)).toBe('INVALID_REQUEST');
      }
      expect(errorCode(await get(owner, {}, { orgId: 'not-a-uuid' }).expect(400))).toBe('INVALID_REQUEST');
    });
  });

  describe('local calendar day filter (ADR-0088)', () => {
    const warsaw = 'Europe/Warsaw';
    const day = (localDate: string, timeZone: string = warsaw) => ({ localDate, timeZone });
    const keys = (items: ActivityHistoryItem[]) => items.map(itemKey);

    it('keeps the items that started in [local midnight, next local midnight) and echoes the day and its interval', async () => {
      await withoutFixtureRuns();
      // 2026-11-11 in Warsaw (UTC+1): [2026-11-10T23:00Z, 2026-11-11T23:00Z).
      const beforeStart = await activity('2026-11-10T22:59:59.999999Z');
      const atStart = await activity('2026-11-10T23:00:00.000000Z', { source: 'gpx' });
      const runAtStart = await run('2026-11-10T23:00:00.000000Z', { summary: 2 });
      const lastMicro = await activity('2026-11-11T22:59:59.999999Z');
      const runLastMicro = await run('2026-11-11T22:59:59.999999Z', { summary: null });
      const atEnd = await activity('2026-11-11T23:00:00.000000Z');
      const runAtEnd = await run('2026-11-11T23:00:00.000000Z', { summary: 2 });

      const response = await read(day('2026-11-11'));
      expect(response.applied).toEqual({
        day: { endsAt: '2026-11-11T23:00:00.000Z', localDate: '2026-11-11', startsAt: '2026-11-10T23:00:00.000Z', timeZone: warsaw },
        source: null,
        type: null,
      });
      expect(keys(response.items)).toEqual([
        `recorded_run:${runLastMicro}`,
        `manual:${lastMicro}`,
        `recorded_run:${runAtStart}`,
        `gpx:${atStart}`,
      ]);
      // The neighbouring dates hold exactly the excluded edges.
      expect(keys((await read(day('2026-11-10'))).items)).toEqual([`manual:${beforeStart}`]);
      expect(keys((await read(day('2026-11-12'))).items)).toEqual([`recorded_run:${runAtEnd}`, `manual:${atEnd}`]);
      // The whole history is unchanged without the pair, with `day: null`.
      const all = await read();
      expect(all.applied.day).toBeNull();
      expect(all.items).toHaveLength(7);
    });

    it('counts an activity or a run that crosses midnight on the date it started only', async () => {
      await withoutFixtureRuns();
      // 23:30 Warsaw on 2026-11-11 for three hours, and a run from 23:50 that finishes 40 minutes later.
      const late = await activity('2026-11-11T22:30:00.000Z', { durationS: 10_800 });
      const lateRun = await run('2026-11-11T22:50:00.000Z', { summary: 2 });
      expect(keys((await read(day('2026-11-11'))).items)).toEqual([`recorded_run:${lateRun}`, `manual:${late}`]);
      expect((await read(day('2026-11-12'))).items).toEqual([]);
      // Read in UTC the same instants are still 2026-11-11: the zone decides, not the device or a fixed offset.
      expect(keys((await read(day('2026-11-11', 'UTC'))).items)).toEqual([`recorded_run:${lateRun}`, `manual:${late}`]);
    });

    it('reads the Warsaw spring-forward date 2026-03-29 as 23 hours', async () => {
      await withoutFixtureRuns();
      const previous = await activity('2026-03-28T22:59:59.999999Z');
      const first = await activity('2026-03-28T23:00:00.000000Z');
      // 03:30 CEST, after the skipped hour.
      const afterJump = await run('2026-03-29T01:30:00.000000Z', { summary: 2 });
      const last = await activity('2026-03-29T21:59:59.999999Z', { source: 'gpx' });
      const next = await run('2026-03-29T22:00:00.000000Z', { summary: 2 });
      const response = await read(day('2026-03-29'));
      expect(response.applied.day).toEqual({ endsAt: '2026-03-29T22:00:00.000Z', localDate: '2026-03-29', startsAt: '2026-03-28T23:00:00.000Z', timeZone: warsaw });
      expect(Date.parse(response.applied.day!.endsAt) - Date.parse(response.applied.day!.startsAt)).toBe(23 * 3_600_000);
      expect(keys(response.items)).toEqual([`gpx:${last}`, `recorded_run:${afterJump}`, `manual:${first}`]);
      expect(keys((await read(day('2026-03-28'))).items)).toEqual([`manual:${previous}`]);
      expect(keys((await read(day('2026-03-30'))).items)).toEqual([`recorded_run:${next}`]);
    });

    it('reads the Warsaw fall-back date 2026-10-25 as 25 hours, with both 02:30s', async () => {
      await withoutFixtureRuns();
      const previous = await activity('2026-10-24T21:59:59.999999Z');
      const first = await run('2026-10-24T22:00:00.000000Z', { summary: 2 });
      const firstHalfPastTwo = await activity('2026-10-25T00:30:00.000000Z'); // 02:30 CEST
      const secondHalfPastTwo = await activity('2026-10-25T01:30:00.000000Z', { source: 'gpx' }); // 02:30 CET
      const last = await activity('2026-10-25T22:59:59.999999Z');
      const next = await activity('2026-10-25T23:00:00.000000Z');
      const response = await read(day('2026-10-25'));
      expect(response.applied.day).toEqual({ endsAt: '2026-10-25T23:00:00.000Z', localDate: '2026-10-25', startsAt: '2026-10-24T22:00:00.000Z', timeZone: warsaw });
      expect(Date.parse(response.applied.day!.endsAt) - Date.parse(response.applied.day!.startsAt)).toBe(25 * 3_600_000);
      expect(keys(response.items)).toEqual([
        `manual:${last}`,
        `gpx:${secondHalfPastTwo}`,
        `manual:${firstHalfPastTwo}`,
        `recorded_run:${first}`,
      ]);
      expect(keys((await read(day('2026-10-24'))).items)).toEqual([`manual:${previous}`]);
      expect(keys((await read(day('2026-10-26'))).items)).toEqual([`manual:${next}`]);
    });

    it('pages a day through microsecond ties at every page size, nothing repeated, skipped or outside the day', async () => {
      await withoutFixtureRuns();
      const tie = '2026-11-11T22:59:59.999999Z';
      const shared = '00000000-0000-4000-8000-0000000000bb';
      await activity(tie, { id: shared });
      await run(tie, { id: shared, summary: 2 });
      await activity(tie, { source: 'gpx' });
      await run(tie, { summary: null });
      await activity('2026-11-11T22:59:59.999998Z');
      await run('2026-11-10T23:00:00.000001Z', { summary: 2 });
      await activity('2026-11-10T23:00:00.000000Z');
      // Outside the day by one microsecond on each side.
      const afterDay = await activity('2026-11-11T23:00:00.000000Z');
      const beforeDay = await run('2026-11-10T22:59:59.999999Z', { summary: 2 });

      // The whole history in its total order, minus the two items outside the day, is the day's expected order.
      const all = await readAll({}, 50);
      expect(all).toHaveLength(9);
      const outside = new Set([`manual:${afterDay}`, `recorded_run:${beforeDay}`]);
      const inDay = all.filter((item) => !outside.has(itemKey(item)));
      expect(inDay).toHaveLength(7);
      for (const limit of [1, 2, 3, 4, 6]) {
        expect(keys(await readAll(day('2026-11-11'), limit)), `limit ${limit}`).toEqual(keys(inDay));
      }
      // Combined with a source filter.
      expect(keys(await readAll({ ...day('2026-11-11'), source: 'recorded_run' }, 1))).toEqual(
        keys(inDay.filter((item) => item.source === 'recorded_run')),
      );
    });

    it('binds a cursor to its date and canonical zone; cursors never cross dates, zones or the whole history', async () => {
      await withoutFixtureRuns();
      for (let index = 0; index < 3; index += 1) {
        await activity(new Date(Date.parse('2026-11-11T08:00:00.000Z') + index * 60_000).toISOString());
        await activity(new Date(Date.parse('2026-11-12T08:00:00.000Z') + index * 60_000).toISOString());
      }
      const dayCursor = (await read({ ...day('2026-11-11'), limit: '1' })).nextCursor!;
      const wholeCursor = (await read({ limit: '1' })).nextCursor!;
      expect(dayCursor).not.toBeNull();
      for (const query of [
        { cursor: dayCursor },
        { cursor: dayCursor, ...day('2026-11-12') },
        // Berlin has Warsaw's offsets on this date, so the interval is the same; the zone is still another scope.
        { cursor: dayCursor, ...day('2026-11-11', 'Europe/Berlin') },
        { cursor: dayCursor, ...day('2026-11-11', 'UTC') },
        { cursor: dayCursor, ...day('2026-11-11'), source: 'manual' },
        { cursor: wholeCursor, ...day('2026-11-11') },
      ]) {
        const response = await get(owner, query).expect(400);
        expect(errorCode(response), JSON.stringify(query)).toBe('INVALID_CURSOR');
        expect(response.headers['cache-control']).toBe('no-store');
      }
      // Another person's day cursor is refused for the same date and zone.
      expect(errorCode(await get(grantee, { cursor: dayCursor, ...day('2026-11-11') }).expect(400))).toBe('INVALID_CURSOR');
      // The matching scope accepts it, also when the zone is spelled in another case: it is canonicalised first.
      expect((await read({ cursor: dayCursor, ...day('2026-11-11') })).items).toHaveLength(2);
      const canonical = await read({ cursor: dayCursor, ...day('2026-11-11', 'europe/warsaw') });
      expect(canonical.applied.day?.timeZone).toBe(warsaw);
      // A whole-history cursor of ADR-0087 (same digest) still works without a day filter.
      const legacy = encodeActivityHistoryCursor({
        context: activityHistoryContext({ day: null, orgId: ids.orgA, source: null, type: null, userId: ids.userOrgA }),
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        kind: 'run',
        startedAt: '2026-11-12T08:00:30.000000Z',
      });
      // Below it: 2026-11-12 08:00 and the three items of 2026-11-11.
      expect((await read({ cursor: legacy })).items).toHaveLength(4);
    });

    it('never adds runs shared with the caller to a day, while their own items of that day appear', async () => {
      const shared = await ownerPool.query<{ local_date: string }>(
        `SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS local_date FROM runs WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [ids.orgA, ownFixtureRuns],
      );
      const dates = [...new Set(shared.rows.map((row) => row.local_date))];
      expect(dates.length).toBeGreaterThan(0);
      for (const localDate of dates) {
        // The owner sees their own runs on that date; the grantee, who holds grants on them, sees none.
        expect((await read(day(localDate, 'UTC'))).items.some((item) => item.source === 'recorded_run'), localDate).toBe(true);
        for (const source of [undefined, 'recorded_run']) {
          const query = { ...day(localDate, 'UTC'), ...(source === undefined ? {} : { source }) };
          expect((await read(query, grantee)).items, JSON.stringify(query)).toEqual([]);
        }
      }
      const own = await activity(`${dates[0]}T12:00:00.000Z`, { userId: ids.userDual });
      expect((await read(day(dates[0]!, 'UTC'), grantee)).items.map(itemId)).toEqual([own]);
      // A coach in the organization sees nothing of the runner's day either.
      expect((await read(day(dates[0]!, 'UTC'), coach)).items).toEqual([]);
    });

    it('refuses half a pair, an impossible or out-of-range date and an unsupported zone with 400', async () => {
      for (const query of [
        { localDate: '2026-11-11' },
        { timeZone: warsaw },
        { localDate: '2026-02-30', timeZone: warsaw },
        { localDate: '2025-02-29', timeZone: warsaw },
        { localDate: '2026-11-31', timeZone: warsaw },
        { localDate: '1999-12-31', timeZone: warsaw },
        { localDate: '2026-11-11T00:00:00Z', timeZone: warsaw },
        { localDate: '11/11/2026', timeZone: warsaw },
        { localDate: '2026-11-11', timeZone: '+01:00' },
        { localDate: '2026-11-11', timeZone: 'CET+1' },
        { localDate: '2026-11-11', timeZone: 'Europe/Atlantis' },
        { localDate: '2026-11-11', timeZone: '' },
        { localDate: ['2026-11-11', '2026-11-12'], timeZone: warsaw },
        { localDate: '2026-11-11', timeZone: [warsaw, 'UTC'] },
      ]) {
        const response = await get(owner, query).expect(400);
        expect(errorCode(response), JSON.stringify(query)).toBe('INVALID_REQUEST');
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  describe('recorded-run summaries', () => {
    it('gives metrics only for a summary of the current data revision; missing is pending and older is stale', async () => {
      await withoutFixtureRuns();
      const current = await run('2026-10-03T06:00:00.000Z', { summary: 2 });
      const stale = await run('2026-10-02T06:00:00.000Z', { summary: 1 });
      const pending = await run('2026-10-01T06:00:00.000Z', { summary: null });
      const body = await read();
      const byId = new Map(body.items.map((item) => [itemId(item), item]));
      expect(byId.get(current)).toMatchObject({ summary: { distanceM: 5_000, observedDurationS: 2_400, state: 'current' } });
      expect(byId.get(stale)).toMatchObject({ summary: { state: 'stale' } });
      expect(byId.get(pending)).toMatchObject({ summary: { state: 'pending' } });
      for (const id of [stale, pending]) {
        expect(Object.keys((byId.get(id) as { summary: object }).summary)).toEqual(['state']);
      }
    });

    it('makes a current summary stale on the next read once new data advances the run’s revision', async () => {
      await withoutFixtureRuns();
      const runId = await run('2026-10-03T06:00:00.000Z', { summary: 2 });
      expect((await read()).items[0]).toMatchObject({ summary: { state: 'current' } });
      await ownerPool.query('UPDATE runs SET data_revision = 3 WHERE org_id = $1 AND id = $2', [ids.orgA, runId]);
      expect((await read()).items[0]).toEqual(expect.objectContaining({ runId, summary: { state: 'stale' } }));
    });
  });

  describe('deletions and snapshots', () => {
    it('reflects deletions of a manual activity, a GPX import and a run on the next read', async () => {
      await withoutFixtureRuns();
      const manualId = await activity('2026-10-03T06:00:00.000Z');
      const gpxId = await activity('2026-10-02T06:00:00.000Z', { source: 'gpx' });
      const runId = await run('2026-10-01T06:00:00.000Z', { summary: 2 });
      expect((await read()).items.map(itemId)).toEqual([manualId, gpxId, runId]);
      await mutate(`/api/orgs/${ids.orgA}/activities/${manualId}`).expect(204);
      expect((await read()).items.map(itemId)).toEqual([gpxId, runId]);
      await mutate(`/api/orgs/${ids.orgA}/activities/${gpxId}`).expect(204);
      expect((await read()).items.map(itemId)).toEqual([runId]);
      await mutate(`/api/orgs/${ids.orgA}/runs/${runId}`).expect(204);
      expect((await read()).items).toEqual([]);
    });

    it('reads one snapshot: changes committed after the transaction began are not seen until the next read', async () => {
      await withoutFixtureRuns();
      const kept = await activity('2026-10-03T06:00:00.000Z');
      const deleted = await activity('2026-10-02T06:00:00.000Z', { source: 'gpx' });
      const deletedRun = await run('2026-10-01T06:00:00.000Z', { summary: 2 });
      let added = '';
      const hooked = createApp({
        clock,
        config,
        logger: silent,
        pool: runtimePool,
        sessionManager: sessions,
        testOnlyActivityHistoryHooks: {
          beforePageRead: async () => {
            await ownerPool.query('DELETE FROM activities WHERE id = $1', [deleted]);
            await ownerPool.query('DELETE FROM runs WHERE id = $1', [deletedRun]);
            added = await activity('2026-10-04T06:00:00.000Z');
          },
        },
      });
      const during = await read({}, owner, { target: hooked });
      expect(during.items.map(itemId)).toEqual([kept, deleted, deletedRun]);
      expect((await read()).items.map(itemId)).toEqual([added, kept]);
    });

    it('writes nothing', async () => {
      await activity('2026-10-03T06:00:00.000Z');
      const counts = () =>
        ownerPool.query<{ counts: string }>(
          `SELECT concat_ws(',', (SELECT count(*) FROM activities), (SELECT count(*) FROM runs), (SELECT count(*) FROM run_summaries),
                  (SELECT count(*) FROM erasure_ledger), (SELECT count(*) FROM run_tombstones)) AS counts`,
        ).then((result) => result.rows[0]!.counts);
      const before = await counts();
      await readAll({}, 1);
      await read({ source: 'manual' }, owner);
      expect(await counts()).toBe(before);
    });
  });
});
