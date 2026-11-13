import { randomUUID } from 'node:crypto';

import {
  ACTIVITY_TRENDS_COMPARISON_VERSION,
  ACTIVITY_TRENDS_VERSION,
  activityHistoryResponseSchema,
  activityTrendsSchema,
  apiErrorResponseSchema,
  dailyOverviewSchema,
  type ActivityHistoryItem,
  type ActivityTrends,
  type GpxActivityTrends,
  type ManualActivityTrends,
  type RecordedRunTrends,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment, type Environment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { createLogger } from '../src/observability/logger.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// Activity trends (ADR-0089) over HTTP, with the real runtime role, sessions and row-level security on PostgreSQL.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-12T10:00:00.000Z';
const WARSAW = 'Europe/Warsaw';
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

type Query = Record<string, string | string[]>;

describe('activity trends HTTP API', () => {
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
    ownerPool = new Pool({ application_name: 'running-tracker-activity-trends-owner', connectionString: integration.migration.connectionString, max: 2 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    // Before any fixture write: both connections reach the validated *_test database, as the expected roles.
    const identities = await Promise.all(
      [ownerPool, runtimePool].map((pool) =>
        pool.query<{ database_name: string; role_name: string }>('SELECT current_database() AS database_name, current_user AS role_name').then((result) => result.rows[0]!),
      ),
    );
    expect(identities).toEqual([
      { database_name: integration.migration.database, role_name: 'running_tracker_owner' },
      { database_name: integration.runtime.database, role_name: 'running_tracker_runtime' },
    ]);
    expect(integration.migration.database).toMatch(/_test$/u);
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

  const get = (auth: Authentication | null, query: Query, options: { orgId?: string; target?: ReturnType<typeof createApp> } = {}) => {
    const pending = request(options.target ?? app).get(`/api/orgs/${options.orgId ?? ids.orgA}/activity-trends`).query(query);
    return auth === null ? pending : pending.set('Cookie', auth.cookie);
  };

  async function read(query: Query, auth: Authentication = owner, options: { orgId?: string; target?: ReturnType<typeof createApp> } = {}): Promise<ActivityTrends> {
    const response = await get(auth, query, options).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return activityTrendsSchema.parse(response.body);
  }

  const manual = async (endDate: string, type = 'ride', timeZone = WARSAW, auth: Authentication = owner, orgId?: string) =>
    (await read({ endDate, source: 'manual', timeZone, type }, auth, orgId === undefined ? {} : { orgId })) as ManualActivityTrends;
  const gpx = async (endDate: string, type = 'ride', timeZone = WARSAW) => (await read({ endDate, source: 'gpx', timeZone, type })) as GpxActivityTrends;
  const runs = async (endDate: string, timeZone = WARSAW, auth: Authentication = owner, orgId?: string) =>
    (await read({ endDate, source: 'recorded_run', timeZone, type: 'run' }, auth, orgId === undefined ? {} : { orgId })) as RecordedRunTrends;

  /** The days with at least one item, as { localDate: count }. */
  const counts = (trends: ActivityTrends) => Object.fromEntries(trends.days.filter((day) => day.count > 0).map((day) => [day.localDate, day.count]));
  const dayOf = <Trends extends ActivityTrends>(trends: Trends, localDate: string): Trends['days'][number] => {
    const day = trends.days.find((candidate) => candidate.localDate === localDate);
    if (day === undefined) throw new Error(`No date ${localDate} in the range`);
    return day;
  };

  async function activity(
    startedAt: string,
    values: { distanceM?: number | null; durationS?: number; source?: 'gpx' | 'manual'; type?: string; userId?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const isGpx = values.source === 'gpx';
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, source, idempotency_key, import_fingerprint)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9::uuid, CASE WHEN $8 = 'gpx' THEN sha256(gen_random_uuid()::text::bytea) END)`,
      [
        ids.orgA,
        id,
        values.userId ?? ids.userOrgA,
        values.type ?? 'ride',
        startedAt,
        values.durationS ?? 1_800,
        values.distanceM === undefined ? 5_000 : values.distanceM,
        isGpx ? 'gpx' : 'manual',
        isGpx ? randomUUID() : null,
      ],
    );
    return id;
  }

  /** A finished run with data revision 2; `summary` is the revision its summary was computed for (null: none yet). */
  async function run(
    startedAt: string,
    options: { distanceM?: number; observedS?: number; orgId?: string; summary?: number | null; userId?: string } = {},
  ): Promise<string> {
    const runId = randomUUID();
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, 'finished', $4::timestamptz, $4::timestamptz, $5, 2, 0, 'available')`,
      [options.orgId ?? ids.orgA, runId, options.userId ?? ids.userOrgA, startedAt, new Date(Date.parse(startedAt) + 2_400_000).toISOString()],
    );
    if (options.summary !== null && options.summary !== undefined) {
      await ownerPool.query(
        `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s, quality_stats, computed_at)
         VALUES ($1, $2, $3, 'it-v1', ST_GeomFromText('MULTILINESTRING((21.0 52.0, 21.001 52.001))', 4326), $4, $5, $6::jsonb, now())`,
        [options.orgId ?? ids.orgA, runId, options.summary, options.distanceM ?? 5_000, options.observedS ?? 2_400, JSON.stringify(stats)],
      );
    }
    return runId;
  }

  const withoutFixtureRuns = () => ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND user_id = $2', [ids.orgA, ids.userOrgA]);

  const remove = (path: string) =>
    request(app).delete(path).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, owner.csrfToken);

  describe('ownership and organization isolation', () => {
    it('counts the owner’s finished runs and never the runs shared with a grantee, under real roles', async () => {
      // The fixture: three finished runs of the owner started 2026-09-20T08:00Z, with live and history grants for the
      // grantee, and a recording and a paused run that never count. Their summaries were made for revision 1.
      const grants = await ownerPool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM run_shares WHERE grantee_user_id = $1 AND org_id = $2 AND can_read_history',
        [ids.userDual, ids.orgA],
      );
      expect(grants.rows[0]!.count).toBeGreaterThan(0);
      const states = await ownerPool.query<{ current: number; pending: number; stale: number }>(
        `SELECT (count(*) FILTER (WHERE s.source_revision = r.data_revision))::integer AS current,
                (count(*) FILTER (WHERE s.run_id IS NULL))::integer AS pending,
                (count(*) FILTER (WHERE s.source_revision <> r.data_revision))::integer AS stale
           FROM runs r LEFT JOIN run_summaries s ON s.org_id = r.org_id AND s.run_id = r.id
          WHERE r.org_id = $1 AND r.user_id = $2 AND r.status = 'finished'`,
        [ids.orgA, ids.userOrgA],
      );
      const ownTrends = await runs('2026-09-30', 'UTC');
      expect(counts(ownTrends)).toEqual({ '2026-09-20': 3 });
      expect(dayOf(ownTrends, '2026-09-20').summaries).toEqual(states.rows[0]);

      const shared = await runs('2026-09-30', 'UTC', grantee);
      expect(shared.summary.count).toBe(0);
      expect(shared.days.every((day) => day.count === 0)).toBe(true);
      // Neither does a coach in the organization see the runner's figures, nor another organization.
      expect((await runs('2026-09-30', 'UTC', coach)).summary.count).toBe(0);
      expect((await runs('2026-09-30', 'UTC', grantee, ids.orgB)).summary.count).toBe(0);
      // The organization B runner counts their own two runs there.
      expect(counts(await runs('2026-09-30', 'UTC', outsider, ids.orgB))).toEqual({ '2026-09-20': 2 });
    });

    it('keeps activities owner-only: the grantee counts their own, never the owner’s', async () => {
      await activity('2026-11-01T08:00:00.000Z');
      await activity('2026-11-02T08:00:00.000Z', { userId: ids.userDual });
      expect(counts(await manual('2026-11-12'))).toEqual({ '2026-11-01': 1 });
      expect(counts(await manual('2026-11-12', 'ride', WARSAW, grantee))).toEqual({ '2026-11-02': 1 });
      expect((await manual('2026-11-12', 'ride', WARSAW, coach)).summary.count).toBe(0);
    });

    it('refuses a non-member, an inactive member and an anonymous request, without caching', async () => {
      const query = { endDate: '2026-11-12', source: 'manual', timeZone: WARSAW, type: 'ride' };
      const foreign = await get(outsider, query).expect(403);
      expect(errorCode(foreign)).toBe('ORG_ACCESS_DENIED');
      expect(foreign.headers['cache-control']).toBe('no-store');
      expect(errorCode(await get(inactive, query).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect((await get(null, query).expect(401)).headers['cache-control']).toBe('no-store');
    });
  });

  describe('local calendar dates', () => {
    it('attributes items to the date they started on in the requested zone, at midnight and across it', async () => {
      await activity('2026-11-10T22:59:59.999999Z'); // 10 Nov 23:59:59.999999 in Warsaw
      await activity('2026-11-10T23:00:00.000000Z'); // 11 Nov 00:00
      await activity('2026-11-11T22:30:00.000000Z', { durationS: 10_800 }); // 11 Nov 23:30, three hours past midnight
      await activity('2026-11-11T23:00:00.000000Z'); // 12 Nov 00:00
      const warsaw = await manual('2026-11-12');
      expect(counts(warsaw)).toEqual({ '2026-11-10': 1, '2026-11-11': 2, '2026-11-12': 1 });
      // The whole duration counts on the start date.
      expect(dayOf(warsaw, '2026-11-11').enteredDuration).toEqual({ totalS: 12_600, withValue: 2 });
      expect(dayOf(warsaw, '2026-11-11')).toMatchObject({ endsAt: '2026-11-11T23:00:00.000Z', startsAt: '2026-11-10T23:00:00.000Z' });
      // The same instants in UTC.
      expect(counts(await manual('2026-11-12', 'ride', 'UTC'))).toEqual({ '2026-11-10': 2, '2026-11-11': 2 });
      expect((await manual('2026-11-12', 'ride', 'europe/warsaw')).applied.timeZone).toBe(WARSAW);
    });

    it('reads the 25-hour Warsaw date 2026-10-25 with both 02:30s, and agrees with Today and the day history', async () => {
      await activity('2026-10-24T21:59:59.999999Z'); // 24 Oct 23:59:59 CEST
      await activity('2026-10-24T22:00:00.000000Z'); // 25 Oct 00:00 CEST
      await activity('2026-10-25T00:30:00.000000Z'); // 02:30 CEST
      await activity('2026-10-25T01:30:00.000000Z'); // 02:30 CET
      await activity('2026-10-25T22:59:59.999999Z'); // 25 Oct 23:59:59 CET
      await activity('2026-10-25T23:00:00.000000Z'); // 26 Oct 00:00 CET
      await activity('2026-10-25T12:00:00.000000Z', { type: 'run' }); // another type, never counted with rides
      const trends = await manual('2026-11-12');
      expect(counts(trends)).toEqual({ '2026-10-24': 1, '2026-10-25': 4, '2026-10-26': 1 });
      const long = dayOf(trends, '2026-10-25');
      expect(Date.parse(long.endsAt) - Date.parse(long.startsAt)).toBe(25 * 3_600_000);

      // Today counts manual activities of the date by the same rule (all types); the history lists the same items.
      const today = dailyOverviewSchema.parse(
        (await request(app).get(`/api/orgs/${ids.orgA}/daily-overview/2026-10-25`).query({ timeZone: WARSAW }).set('Cookie', owner.cookie).expect(200)).body,
      );
      const todayRides = today.manualActivities.byType.find((entry) => entry.type === 'ride');
      expect(todayRides).toEqual({ count: long.count, enteredDurationS: long.enteredDuration.totalS, type: 'ride' });
      const history = activityHistoryResponseSchema.parse(
        (
          await request(app)
            .get(`/api/orgs/${ids.orgA}/activity-history`)
            .query({ limit: '50', localDate: '2026-10-25', source: 'manual', timeZone: WARSAW, type: 'ride' })
            .set('Cookie', owner.cookie)
            .expect(200)
        ).body,
      );
      expect(history.items).toHaveLength(long.count);
    });

    it('reads the 23-hour Warsaw date 2026-03-29', async () => {
      await activity('2026-03-28T22:59:59.999999Z', { source: 'gpx' }); // 28 Mar 23:59:59 CET
      await activity('2026-03-28T23:00:00.000000Z', { source: 'gpx' }); // 29 Mar 00:00 CET
      await activity('2026-03-29T01:30:00.000000Z', { source: 'gpx' }); // 03:30 CEST, after the skipped hour
      await activity('2026-03-29T21:59:59.999999Z', { source: 'gpx' }); // 29 Mar 23:59:59 CEST
      await activity('2026-03-29T22:00:00.000000Z', { source: 'gpx' }); // 30 Mar 00:00 CEST
      const trends = await gpx('2026-04-10');
      expect(counts(trends)).toEqual({ '2026-03-28': 1, '2026-03-29': 3, '2026-03-30': 1 });
      const short = dayOf(trends, '2026-03-29');
      expect(short).toMatchObject({ endsAt: '2026-03-29T22:00:00.000Z', startsAt: '2026-03-28T23:00:00.000Z' });
      expect(short.elapsedDuration).toEqual({ totalS: 5_400, withValue: 3 });
      expect(Object.keys(short)).not.toContain('enteredDuration');
    });

    it('keeps the date Pacific/Apia skipped (2011-12-30) as an empty date and puts records around it on their own dates', async () => {
      await withoutFixtureRuns();
      // Apia moved from UTC-10 to UTC+14 after 29 December 2011: 23:59:59 on the 29th was followed by 00:00 on the 31st.
      const around = [
        '2011-12-29T10:00:00.000000Z', // 29 Dec 00:00 (UTC-10)
        '2011-12-30T09:59:59.999999Z', // 29 Dec 23:59:59.999999, the last instant before the skip
        '2011-12-30T10:00:00.000000Z', // 31 Dec 00:00 (UTC+14), the first instant after it
        '2011-12-30T10:00:00.000001Z', // 31 Dec 00:00:00.000001
        '2011-12-31T09:59:59.999999Z', // 31 Dec 23:59:59.999999
        '2011-12-31T10:00:00.000000Z', // 1 Jan 00:00
      ];
      for (const startedAt of around) await activity(startedAt, { distanceM: 1_000, durationS: 600 });
      await run('2011-12-30T09:59:59.999999Z', { summary: 2 });
      await run('2011-12-30T10:00:00.000000Z', { summary: 2 });

      const trends = await manual('2012-01-05', 'ride', 'Pacific/Apia');
      expect(trends.days).toHaveLength(28);
      expect(dayOf(trends, '2011-12-30')).toEqual({
        count: 0,
        distance: { totalM: null, withValue: 0 },
        endsAt: '2011-12-30T10:00:00.000Z',
        enteredDuration: { totalS: null, withValue: 0 },
        localDate: '2011-12-30',
        startsAt: '2011-12-30T10:00:00.000Z',
      });
      expect(dayOf(trends, '2011-12-31').startsAt).toBe('2011-12-30T10:00:00.000Z');
      expect(counts(trends)).toEqual({ '2011-12-29': 2, '2011-12-31': 3, '2012-01-01': 1 });
      // Neither lost nor counted twice: every inserted item once, as PostgreSQL's own zone rules group them.
      expect(trends.summary).toMatchObject({ count: 6, daysWithEntries: 3, distance: { daysWithValue: 3, totalM: 6_000, withValue: 6 } });
      const grouped = await ownerPool.query<{ count: number; local_date: string }>(
        `SELECT to_char((started_at AT TIME ZONE 'Pacific/Apia')::date, 'YYYY-MM-DD') AS local_date, count(*)::integer AS count
           FROM activities WHERE org_id = $1 AND user_id = $2 AND started_at >= $3 AND started_at < $4 GROUP BY 1 ORDER BY 1`,
        [ids.orgA, ids.userOrgA, trends.range.startsAt, trends.range.endsAt],
      );
      expect(Object.fromEntries(grouped.rows.map((row) => [row.local_date, row.count]))).toEqual(counts(trends));
      // Recorded runs use the same buckets.
      expect(counts(await runs('2012-01-05', 'Pacific/Apia'))).toEqual({ '2011-12-29': 1, '2011-12-31': 1 });
      // The skipped date can also end the range: its empty interval is the range's last.
      const ending = await manual('2011-12-30', 'ride', 'Pacific/Apia');
      expect(ending.range).toMatchObject({ endDate: '2011-12-30', endsAt: '2011-12-30T10:00:00.000Z' });
      expect(dayOf(ending, '2011-12-30').count).toBe(0);
      expect(counts(ending)).toEqual({ '2011-12-29': 2 });
    });

    it('excludes items just outside the range and discloses a range shortened by 2000-01-01', async () => {
      await activity('2026-10-15T21:59:59.999999Z'); // 15 Oct in Warsaw: the day before the range
      await activity('2026-10-15T22:00:00.000000Z'); // 16 Oct 00:00: the range's first instant
      await activity('2026-11-12T23:00:00.000000Z'); // 13 Nov: after the range (and after "today")
      const trends = await manual('2026-11-12');
      expect(trends.range).toMatchObject({ days: 28, endsAt: '2026-11-12T23:00:00.000Z', startDate: '2026-10-16', startsAt: '2026-10-15T22:00:00.000Z' });
      expect(counts(trends)).toEqual({ '2026-10-16': 1 });

      await activity('2000-01-03T12:00:00.000Z');
      const early = await manual('2000-01-10', 'ride', 'UTC');
      expect(early.range).toMatchObject({ days: 10, requestedDays: 28, shortenedByLowerBound: true, startDate: '2000-01-01' });
      expect(early.days).toHaveLength(10);
      expect(counts(early)).toEqual({ '2000-01-03': 1 });
    });
  });

  describe('metrics and coverage', () => {
    it('keeps no entries, unknown distance and a recorded zero apart, and names each source’s duration', async () => {
      await withoutFixtureRuns();
      await activity('2026-11-05T08:00:00.000Z', { distanceM: null, durationS: 1_200 });
      await activity('2026-11-05T09:00:00.000Z', { distanceM: 12_000.4, durationS: 2_400 });
      await activity('2026-11-06T08:00:00.000Z', { distanceM: 0, durationS: 60 });
      await activity('2026-11-07T08:00:00.000Z', { distanceM: null, durationS: 600 });
      await activity('2026-11-05T10:00:00.000Z', { distanceM: 9_999, durationS: 999, source: 'gpx' });
      await run('2026-11-05T11:00:00.000Z', { distanceM: 4_000, summary: 2 });
      await activity('2026-11-05T12:00:00.000Z', { distanceM: 9_999, durationS: 999, type: 'run' });

      const trends = await manual('2026-11-12');
      expect(dayOf(trends, '2026-11-05')).toMatchObject({ count: 2, distance: { totalM: 12_000, withValue: 1 }, enteredDuration: { totalS: 3_600, withValue: 2 } });
      expect(dayOf(trends, '2026-11-06')).toMatchObject({ count: 1, distance: { totalM: 0, withValue: 1 } });
      expect(dayOf(trends, '2026-11-07')).toMatchObject({ count: 1, distance: { totalM: null, withValue: 0 }, enteredDuration: { totalS: 600, withValue: 1 } });
      expect(dayOf(trends, '2026-11-08')).toMatchObject({ count: 0, distance: { totalM: null, withValue: 0 }, enteredDuration: { totalS: null, withValue: 0 } });
      expect(trends.summary).toEqual({
        count: 4,
        daysWithEntries: 3,
        distance: { daysWithValue: 2, totalM: 12_000, withValue: 2 },
        enteredDuration: { daysWithValue: 3, totalS: 4_260, withValue: 4 },
      });
      // Sources and types are never combined.
      expect((await gpx('2026-11-12')).summary).toMatchObject({ count: 1, elapsedDuration: { totalS: 999 } });
      expect((await runs('2026-11-12')).summary).toMatchObject({ count: 1, distance: { totalM: 4_000 }, observedDuration: { totalS: 2_400 } });
      expect((await manual('2026-11-12', 'run')).summary).toMatchObject({ count: 1, enteredDuration: { totalS: 999 } });
      expect(trends.applied).toEqual({ endDate: '2026-11-12', source: 'manual', timeZone: WARSAW, type: 'ride' });
      expect(trends.provenance).toMatchObject({ persisted: false, policyVersion: ACTIVITY_TRENDS_VERSION, snapshot: 'single_read_only_transaction' });
    });

    it('takes run metrics from current summaries only; pending and stale runs count without values', async () => {
      await withoutFixtureRuns();
      await run('2026-11-03T06:00:00.000Z', { distanceM: 5_012.25, observedS: 2_400.4, summary: 2 }); // current
      await run('2026-11-03T07:00:00.000Z', { distanceM: 8_000, summary: 1 }); // stale
      await run('2026-11-03T08:00:00.000Z', { summary: null }); // pending
      await run('2026-11-04T06:00:00.000Z', { distanceM: 7_000, summary: 1 }); // stale only
      const zero = await run('2026-11-05T06:00:00.000Z', { distanceM: 0, observedS: 0, summary: 2 }); // a recorded zero

      let trends = await runs('2026-11-12');
      expect(dayOf(trends, '2026-11-03')).toMatchObject({
        count: 3,
        distance: { totalM: 5_012, withValue: 1 },
        observedDuration: { totalS: 2_400, withValue: 1 },
        summaries: { current: 1, pending: 1, stale: 1 },
      });
      expect(dayOf(trends, '2026-11-04')).toMatchObject({ count: 1, distance: { totalM: null, withValue: 0 }, observedDuration: { totalS: null, withValue: 0 }, summaries: { stale: 1 } });
      expect(dayOf(trends, '2026-11-05')).toMatchObject({ count: 1, distance: { totalM: 0, withValue: 1 }, observedDuration: { totalS: 0, withValue: 1 } });
      expect(trends.summary).toMatchObject({ count: 5, summaries: { current: 2, pending: 1, stale: 2 }, distance: { daysWithValue: 2, totalM: 5_012, withValue: 2 } });

      // New data advances the run's revision: its summary is stale on the next read, and its values leave the figures.
      await ownerPool.query('UPDATE runs SET data_revision = 3 WHERE org_id = $1 AND id = $2', [ids.orgA, zero]);
      trends = await runs('2026-11-12');
      expect(dayOf(trends, '2026-11-05')).toMatchObject({ count: 1, distance: { totalM: null, withValue: 0 }, summaries: { current: 0, stale: 1 } });
    });

    it('rounds each date once, halves up, in PostgreSQL, and adds the rounded dates for the range', async () => {
      await withoutFixtureRuns();
      // Halves: ties-to-even (round(double precision)) would give 0 and 2; a numeric cast would read 1000.4999999999999
      // as 1000.5 (15 significant digits) and give 1001.
      await run('2026-11-02T06:00:00.000Z', { distanceM: 0.25, observedS: 0.25, summary: 2 });
      await run('2026-11-02T07:00:00.000Z', { distanceM: 0.25, observedS: 0.25, summary: 2 }); // 0.5 on 2 Nov
      await run('2026-11-03T06:00:00.000Z', { distanceM: 2.5, observedS: 3_599.5, summary: 2 });
      await run('2026-11-04T06:00:00.000Z', { distanceM: 1_000.4999999999999, observedS: 1_000.4999999999999, summary: 2 });
      await run('2026-11-04T07:00:00.000Z', { distanceM: 999, summary: 1 }); // stale: counted, no value
      await run('2026-11-05T06:00:00.000Z', { summary: null }); // pending only: the date has no value
      const trends = await runs('2026-11-12');
      expect(dayOf(trends, '2026-11-02')).toMatchObject({ distance: { totalM: 1, withValue: 2 }, observedDuration: { totalS: 1, withValue: 2 } });
      expect(dayOf(trends, '2026-11-03')).toMatchObject({ distance: { totalM: 3, withValue: 1 }, observedDuration: { totalS: 3_600, withValue: 1 } });
      expect(dayOf(trends, '2026-11-04')).toMatchObject({
        count: 2,
        distance: { totalM: 1_000, withValue: 1 },
        observedDuration: { totalS: 1_000, withValue: 1 },
        summaries: { current: 1, pending: 0, stale: 1 },
      });
      expect(dayOf(trends, '2026-11-05')).toMatchObject({ count: 1, distance: { totalM: null, withValue: 0 }, summaries: { pending: 1 } });
      // The range adds the rounded dates (1 + 3 + 1000), not the rounded sum of the raw values (1003.4999… → 1003).
      expect(trends.summary).toEqual({
        count: 6,
        daysWithEntries: 4,
        distance: { daysWithValue: 3, totalM: 1_004, withValue: 4 },
        observedDuration: { daysWithValue: 3, totalS: 4_601, withValue: 4 },
        summaries: { current: 4, pending: 1, stale: 1 },
      });

      // Manual distances (double precision) follow the same rule; durations are whole seconds and exact.
      await activity('2026-11-06T08:00:00.000Z', { distanceM: 0.5, durationS: 61 });
      await activity('2026-11-07T08:00:00.000Z', { distanceM: 2.5, durationS: 62 });
      await activity('2026-11-07T09:00:00.000Z', { distanceM: null, durationS: 63 }); // partial coverage
      const rides = await manual('2026-11-12');
      expect(dayOf(rides, '2026-11-06').distance).toEqual({ totalM: 1, withValue: 1 });
      expect(dayOf(rides, '2026-11-07')).toMatchObject({ count: 2, distance: { totalM: 3, withValue: 1 }, enteredDuration: { totalS: 125, withValue: 2 } });
      expect(rides.summary).toEqual({
        count: 3,
        daysWithEntries: 2,
        distance: { daysWithValue: 2, totalM: 4, withValue: 2 },
        enteredDuration: { daysWithValue: 2, totalS: 186, withValue: 3 },
      });

      // An empty range: the range row exists without any date row.
      const empty = await manual('2026-11-12', 'swim');
      expect(empty.summary).toEqual({
        count: 0,
        daysWithEntries: 0,
        distance: { daysWithValue: 0, totalM: null, withValue: 0 },
        enteredDuration: { daysWithValue: 0, totalS: null, withValue: 0 },
      });
      expect(empty.days.every((day) => day.count === 0 && day.distance.totalM === null)).toBe(true);
    });

    it('aggregates a fixture larger than one history page exactly, as the paged history and PostgreSQL agree', async () => {
      await withoutFixtureRuns();
      // 130 manual rides over the range (well beyond the history's page maximum of 50), with noise of other types,
      // sources and people, and one item on each side of the range.
      const base = Date.parse('2026-10-15T22:00:00.000Z');
      for (let index = 0; index < 130; index += 1) {
        // Every 5 hours and 1 second: 130 items over 27 days of the 28, several on most dates.
        await activity(new Date(base + index * 5 * 3_600_000 + index * 1_000).toISOString(), {
          distanceM: index % 4 === 0 ? null : 1_000 + index * 10.25,
          durationS: 600 + index,
        });
      }
      for (let index = 0; index < 20; index += 1) {
        await activity(new Date(base + index * 30 * 3_600_000 + 1).toISOString(), { type: 'walk' });
        await activity(new Date(base + index * 30 * 3_600_000 + 2).toISOString(), { source: 'gpx' });
        await activity(new Date(base + index * 30 * 3_600_000 + 3).toISOString(), { userId: ids.userDual });
      }
      await activity('2026-10-15T21:59:59.999999Z');

      const trends = await manual('2026-11-12');
      expect(trends.summary.count).toBe(130);

      // The same figures from PostgreSQL's own zone rules, as the owner role.
      const expected = await ownerPool.query<{ count: number; distance_m: number | null; duration_s: string; local_date: string; with_distance: number }>(
        `SELECT to_char((started_at AT TIME ZONE 'Europe/Warsaw')::date, 'YYYY-MM-DD') AS local_date, count(*)::integer AS count,
                sum(duration_s)::text AS duration_s, count(distance_m)::integer AS with_distance, sum(distance_m) AS distance_m
           FROM activities
          WHERE org_id = $1 AND user_id = $2 AND source = 'manual' AND type = 'ride'
            AND (started_at AT TIME ZONE 'Europe/Warsaw')::date BETWEEN '2026-10-16' AND '2026-11-12'
          GROUP BY 1 ORDER BY 1`,
        [ids.orgA, ids.userOrgA],
      );
      const byDate = new Map(expected.rows.map((row) => [row.local_date, row]));
      for (const day of trends.days) {
        const row = byDate.get(day.localDate);
        expect(day.count, day.localDate).toBe(row?.count ?? 0);
        expect(day.enteredDuration.totalS, day.localDate).toBe(row === undefined ? null : Number(row.duration_s));
        expect(day.distance, day.localDate).toEqual(
          row === undefined || row.with_distance === 0 ? { totalM: null, withValue: 0 } : { totalM: Math.round(row.distance_m!), withValue: row.with_distance },
        );
      }

      // The paged history of the same source and type holds exactly the counted items and durations.
      const items: ActivityHistoryItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const response = activityHistoryResponseSchema.parse(
          (
            await request(app)
              .get(`/api/orgs/${ids.orgA}/activity-history`)
              .query({ limit: '50', source: 'manual', type: 'ride', ...(cursor === null ? {} : { cursor }) })
              .set('Cookie', owner.cookie)
              .expect(200)
          ).body,
        );
        items.push(...response.items);
        cursor = response.nextCursor;
        if (cursor === null) break;
      }
      const inRange = items.filter((item) => item.startedAt >= trends.range.startsAt && item.startedAt < trends.range.endsAt);
      expect(items.length).toBeGreaterThan(50);
      expect(inRange).toHaveLength(trends.summary.count);
      expect(inRange.reduce((sum, item) => sum + (item.source === 'manual' ? item.enteredDurationS : 0), 0)).toBe(trends.summary.enteredDuration.totalS);
    }, 60_000);
  });

  describe('deletions and snapshots', () => {
    it('reflects deletions of a manual activity, a GPX import and a run on the next read', async () => {
      await withoutFixtureRuns();
      const manualId = await activity('2026-11-03T06:00:00.000Z');
      const gpxId = await activity('2026-11-03T07:00:00.000Z', { source: 'gpx' });
      const runId = await run('2026-11-03T08:00:00.000Z', { summary: 2 });
      expect((await manual('2026-11-12')).summary.count).toBe(1);
      expect((await gpx('2026-11-12')).summary.count).toBe(1);
      expect((await runs('2026-11-12')).summary.count).toBe(1);
      await remove(`/api/orgs/${ids.orgA}/activities/${manualId}`).expect(204);
      await remove(`/api/orgs/${ids.orgA}/activities/${gpxId}`).expect(204);
      await remove(`/api/orgs/${ids.orgA}/runs/${runId}`).expect(204);
      expect((await manual('2026-11-12')).summary).toMatchObject({ count: 0, enteredDuration: { totalS: null } });
      expect((await gpx('2026-11-12')).summary.count).toBe(0);
      expect((await runs('2026-11-12')).summary.count).toBe(0);
    });

    it('reads one snapshot: changes committed after the transaction began are not seen until the next read', async () => {
      await withoutFixtureRuns();
      await activity('2026-11-03T06:00:00.000Z', { durationS: 600 });
      const deleted = await activity('2026-11-04T06:00:00.000Z', { durationS: 900 });
      const deletedRun = await run('2026-11-04T07:00:00.000Z', { summary: 2 });
      const hooked = createApp({
        clock,
        config,
        logger: silent,
        pool: runtimePool,
        sessionManager: sessions,
        testOnlyActivityTrendsHooks: {
          beforeAggregateRead: async () => {
            await ownerPool.query('DELETE FROM activities WHERE id = $1', [deleted]);
            await ownerPool.query('DELETE FROM runs WHERE id = $1', [deletedRun]);
            await activity('2026-11-05T06:00:00.000Z', { durationS: 1_200 });
            await run('2026-11-05T07:00:00.000Z', { summary: 2 });
          },
        },
      });
      const during = (await read({ endDate: '2026-11-12', source: 'manual', timeZone: WARSAW, type: 'ride' }, owner, { target: hooked })) as ManualActivityTrends;
      expect(counts(during)).toEqual({ '2026-11-03': 1, '2026-11-04': 1 });
      expect(during.summary.enteredDuration.totalS).toBe(1_500);
      expect(counts(await manual('2026-11-12'))).toEqual({ '2026-11-03': 1, '2026-11-05': 1 });

      const duringRuns = (await read({ endDate: '2026-11-12', source: 'recorded_run', timeZone: WARSAW, type: 'run' }, owner, { target: hooked })) as RecordedRunTrends;
      // The hook ran again: the run inserted by the first read is visible, the one inserted during this read is not.
      expect(duringRuns.summary.count).toBe(1);
      expect((await runs('2026-11-12')).summary.count).toBe(2);
    });

    it('writes nothing', async () => {
      await activity('2026-11-03T06:00:00.000Z');
      const countRows = () =>
        ownerPool
          .query<{ counts: string }>(
            `SELECT concat_ws(',', (SELECT count(*) FROM activities), (SELECT count(*) FROM runs), (SELECT count(*) FROM run_summaries),
                    (SELECT count(*) FROM erasure_ledger), (SELECT count(*) FROM run_tombstones), (SELECT count(*) FROM weekly_insights)) AS counts`,
          )
          .then((result) => result.rows[0]!.counts);
      const before = await countRows();
      await manual('2026-11-12');
      await gpx('2026-11-12');
      await runs('2026-11-12');
      expect(await countRows()).toBe(before);
    });
  });

  describe('comparison with the previous period (ADR-0090)', () => {
    // A finished range: 2026-10-15..2026-11-11 in Warsaw; the previous period 2026-09-17..2026-10-14.
    const END = '2026-11-11';
    const compare = async (endDate: string, values: { auth?: Authentication; orgId?: string; source?: string; timeZone?: string; type?: string } = {}) =>
      read(
        { compare: 'previous_period', endDate, source: values.source ?? 'manual', timeZone: values.timeZone ?? WARSAW, type: values.type ?? (values.source === 'recorded_run' ? 'run' : 'ride') },
        values.auth ?? owner,
        values.orgId === undefined ? {} : { orgId: values.orgId },
      );
    const metricsOf = (trends: ActivityTrends) => {
      const metrics = trends.comparison!.metrics;
      const duration = 'enteredDuration' in metrics ? metrics.enteredDuration : 'elapsedDuration' in metrics ? metrics.elapsedDuration : metrics.observedDuration;
      return { count: metrics.count, distance: metrics.distance, duration };
    };
    const previousOf = (trends: ActivityTrends) => trends.comparison!.previous.summary!;

    it('compares the two periods from one read: the same figures as two ordinary reads, and no change for equal periods', async () => {
      await withoutFixtureRuns();
      for (const startedAt of ['2026-09-20T08:00:00.000Z', '2026-10-10T08:00:00.000Z', '2026-10-20T08:00:00.000Z', '2026-11-05T08:00:00.000Z']) {
        await activity(startedAt, { distanceM: 5_000.5, durationS: 1_800 });
      }
      const compared = await compare(END);
      const current = await manual(END);
      const previous = await manual('2026-10-14');
      // The range part is exactly the ordinary answer; the previous period is exactly the ordinary answer ending on E-28.
      expect(compared.days).toEqual(current.days);
      expect(compared.summary).toEqual(current.summary);
      expect(compared.applied).toEqual({ ...current.applied, compare: 'previous_period' });
      expect(previousOf(compared)).toEqual(previous.summary);
      expect(compared.comparison!.previous.period).toEqual({
        days: 28,
        endDate: '2026-10-14',
        endsAt: previous.range.endsAt,
        requestedDays: 28,
        shortenedByLowerBound: false,
        startDate: '2026-09-17',
        startsAt: previous.range.startsAt,
      });
      expect(compared.comparison!.previous.period!.endsAt).toBe(compared.range.startsAt);
      expect(compared.comparison).toMatchObject({ mode: 'previous_period', periodReasons: [], policyVersion: ACTIVITY_TRENDS_COMPARISON_VERSION });
      const equal = { absolute: 0, percent: 0, percentUnavailableReason: null, status: 'available' };
      expect(metricsOf(compared)).toEqual({
        count: { change: equal, current: 2, previous: 2 },
        distance: { change: equal, current: 10_002, previous: 10_002 },
        duration: { change: equal, current: 3_600, previous: 3_600 },
      });
      // Without `compare` the answer is the ordinary one, unchanged.
      expect('comparison' in current).toBe(false);
      expect('compare' in current.applied).toBe(false);
    });

    it('adds each period’s rounded dates and rounds the percentage halves away from zero, in PostgreSQL', async () => {
      await withoutFixtureRuns();
      // Previous: two dates of 199.5 m, each rounded up to 200 (the raw sum 399 would round to 399), and 200 s each.
      await activity('2026-09-20T08:00:00.000Z', { distanceM: 199.5, durationS: 200 });
      await activity('2026-09-21T08:00:00.000Z', { distanceM: 199.5, durationS: 200 });
      // Current: 449.4 m → 449 and 351 s.
      await activity('2026-10-20T08:00:00.000Z', { distanceM: 449.4, durationS: 351 });
      const compared = await compare(END);
      // 49 / 400 = +12.25 % → +12.3; -49 / 400 = -12.25 % → -12.3 (half to even would give ±12.2; 50/399 would give 12.5).
      expect(metricsOf(compared)).toEqual({
        count: { change: { absolute: -1, percent: -50, percentUnavailableReason: null, status: 'available' }, current: 1, previous: 2 },
        distance: { change: { absolute: 49, percent: 12.3, percentUnavailableReason: null, status: 'available' }, current: 449, previous: 400 },
        duration: { change: { absolute: -49, percent: -12.3, percentUnavailableReason: null, status: 'available' }, current: 351, previous: 400 },
      });
      expect(previousOf(compared)).toMatchObject({ distance: { daysWithValue: 2, totalM: 400, withValue: 2 } });
    });

    it('keeps empty periods, a zero baseline, a recorded zero and partial coverage apart', async () => {
      await withoutFixtureRuns();
      // Walks: a recorded zero distance before, 1 km now: the absolute change stands, the percentage has no baseline.
      await activity('2026-09-20T08:00:00.000Z', { distanceM: 0, durationS: 600, type: 'walk' });
      await activity('2026-10-20T08:00:00.000Z', { distanceM: 1_000, durationS: 600, type: 'walk' });
      // Runs: one of the previous entries has no distance.
      await activity('2026-09-20T09:00:00.000Z', { distanceM: null, durationS: 900, type: 'run' });
      await activity('2026-09-21T09:00:00.000Z', { distanceM: 3_000, durationS: 900, type: 'run' });
      await activity('2026-10-20T09:00:00.000Z', { distanceM: 3_000, durationS: 900, type: 'run' });
      // Hikes: logged only in the current period.
      await activity('2026-10-20T10:00:00.000Z', { distanceM: 8_000, durationS: 7_200, type: 'hike' });

      const swims = metricsOf(await compare(END, { type: 'swim' }));
      expect(swims.count).toEqual({ change: { absolute: 0, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' }, current: 0, previous: 0 });
      expect(swims.distance).toEqual({ change: { reasons: ['current_period_no_entries', 'previous_period_no_entries'], status: 'unavailable' }, current: null, previous: null });

      const walks = metricsOf(await compare(END, { type: 'walk' }));
      expect(walks.distance).toEqual({ change: { absolute: 1_000, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' }, current: 1_000, previous: 0 });
      expect(walks.duration.change).toEqual({ absolute: 0, percent: 0, percentUnavailableReason: null, status: 'available' });

      const runEntries = await compare(END, { type: 'run' });
      expect(metricsOf(runEntries).distance).toEqual({ change: { reasons: ['previous_values_missing'], status: 'unavailable' }, current: 3_000, previous: 3_000 });
      expect(metricsOf(runEntries).count.change).toEqual({ absolute: -1, percent: -50, percentUnavailableReason: null, status: 'available' });
      expect(previousOf(runEntries)).toMatchObject({ count: 2, distance: { totalM: 3_000, withValue: 1 } });

      const hikes = metricsOf(await compare(END, { type: 'hike' }));
      expect(hikes.count.change).toEqual({ absolute: 1, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' });
      expect(hikes.duration.change).toEqual({ reasons: ['previous_period_no_entries'], status: 'unavailable' });
    });

    it('takes run values from current summaries only: pending and stale runs block durations and distances, never counts', async () => {
      await withoutFixtureRuns();
      await run('2026-09-20T06:00:00.000Z', { distanceM: 5_000, observedS: 1_800, summary: 2 }); // previous, current
      await run('2026-09-21T06:00:00.000Z', { distanceM: 6_000, summary: 1 }); // previous, stale
      await run('2026-10-20T06:00:00.000Z', { distanceM: 5_500, observedS: 1_900, summary: 2 }); // range, current
      await run('2026-10-21T06:00:00.000Z', { summary: null }); // range, pending
      const compared = await compare(END, { source: 'recorded_run' });
      const metrics = metricsOf(compared);
      expect(metrics.count).toEqual({ change: { absolute: 0, percent: 0, percentUnavailableReason: null, status: 'available' }, current: 2, previous: 2 });
      expect(metrics.duration).toEqual({ change: { reasons: ['current_summaries_pending', 'previous_summaries_stale'], status: 'unavailable' }, current: 1_900, previous: 1_800 });
      expect(previousOf(compared)).toMatchObject({ summaries: { current: 1, pending: 0, stale: 1 } });
      expect(Object.keys(compared.comparison!.metrics).toSorted()).toEqual(['count', 'distance', 'observedDuration']);
    });

    it('keeps the ordinary figures of a range that includes today and suppresses every change', async () => {
      await withoutFixtureRuns();
      await activity('2026-09-20T08:00:00.000Z');
      await activity('2026-11-12T08:00:00.000Z');
      const compared = await compare('2026-11-12');
      expect(compared.range.includesToday).toBe(true);
      expect(compared.days).toEqual((await manual('2026-11-12')).days);
      expect(compared.comparison).toMatchObject({ current: { inProgress: true }, periodReasons: ['current_period_in_progress'] });
      expect(metricsOf(compared).count).toEqual({ change: { reasons: ['current_period_in_progress'], status: 'unavailable' }, current: 1, previous: 1 });
    });

    it('compares full periods only, at the 2000-01-01 boundary', async () => {
      await withoutFixtureRuns();
      for (const startedAt of ['2000-01-01T00:00:00.000Z', '2000-01-28T12:00:00.000Z', '2000-01-29T12:00:00.000Z']) await activity(startedAt);
      // 2000-02-25: the earliest end date with two full periods (2000-01-01..01-28 and 01-29..02-25).
      const full = await compare('2000-02-25', { timeZone: 'UTC' });
      expect(full.comparison!.previous.period).toMatchObject({ days: 28, shortenedByLowerBound: false, startDate: '2000-01-01', startsAt: '2000-01-01T00:00:00.000Z' });
      expect(metricsOf(full).count).toEqual({ change: { absolute: -1, percent: -50, percentUnavailableReason: null, status: 'available' }, current: 1, previous: 2 });
      // One date earlier, the previous period has 27 dates: its figures are given, its changes are not.
      const shortened = await compare('2000-02-24', { timeZone: 'UTC' });
      expect(shortened.comparison!.previous.period).toMatchObject({ days: 27, shortenedByLowerBound: true });
      expect(previousOf(shortened).count).toBe(1);
      expect(metricsOf(shortened).count).toEqual({ change: { reasons: ['previous_period_shortened'], status: 'unavailable' }, current: 2, previous: 1 });
      // A full range whose previous dates are all before 2000-01-01, and a range cut short itself.
      const outOfRange = await compare('2000-01-28', { timeZone: 'UTC' });
      expect(outOfRange.comparison!.previous).toEqual({ period: null, requestedEndDate: '1999-12-31', requestedStartDate: '1999-12-04', summary: null });
      expect(metricsOf(outOfRange).count).toEqual({ change: { reasons: ['previous_period_out_of_range'], status: 'unavailable' }, current: 2, previous: null });
      const early = await compare('2000-01-10', { timeZone: 'UTC' });
      expect(early.comparison!.periodReasons).toEqual(['current_period_shortened', 'previous_period_out_of_range']);
      expect(early.summary.count).toBe(1);
    });

    it('locates both periods in the zone across a daylight saving change and at their shared boundary', async () => {
      await withoutFixtureRuns();
      // E = 2026-04-30 in Warsaw: previous 2026-03-06..04-02 (with the 23-hour 2026-03-29), range 04-03..04-30.
      const instants = [
        '2026-03-05T22:59:59.999999Z', // 5 Mar 23:59:59 CET: before the previous period
        '2026-03-05T23:00:00.000000Z', // 6 Mar 00:00 CET: its first instant
        '2026-03-28T23:00:00.000000Z', // 29 Mar 00:00 CET
        '2026-03-29T21:59:59.999999Z', // 29 Mar 23:59:59 CEST
        '2026-04-02T21:59:59.999999Z', // 2 Apr 23:59:59 CEST: the previous period's last instant
        '2026-04-02T22:00:00.000000Z', // 3 Apr 00:00 CEST: the range's first instant
      ];
      for (const startedAt of instants) await activity(startedAt, { distanceM: 1_000, durationS: 600 });
      const compared = await compare('2026-04-30');
      expect(compared.comparison!.previous.period).toMatchObject({ endsAt: '2026-04-02T22:00:00.000Z', startsAt: '2026-03-05T23:00:00.000Z' });
      expect(compared.range.startsAt).toBe('2026-04-02T22:00:00.000Z');
      expect(previousOf(compared).count).toBe(4);
      expect(compared.summary.count).toBe(1);
      // The same previous figures as an ordinary read ending on E-28, which shows the 23-hour date with both items.
      const previous = await manual('2026-04-02');
      expect(previousOf(compared)).toEqual(previous.summary);
      const short = dayOf(previous, '2026-03-29');
      expect([short.count, Date.parse(short.endsAt) - Date.parse(short.startsAt)]).toEqual([2, 23 * 3_600_000]);
      // PostgreSQL's own zone rules agree on the previous period's count.
      const grouped = await ownerPool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM activities
          WHERE org_id = $1 AND user_id = $2 AND (started_at AT TIME ZONE 'Europe/Warsaw')::date BETWEEN '2026-03-06' AND '2026-04-02'`,
        [ids.orgA, ids.userOrgA],
      );
      expect(grouped.rows[0]!.count).toBe(4);
    });

    it('keeps a date the zone skipped in either period (Pacific/Apia, 2011-12-30)', async () => {
      await withoutFixtureRuns();
      await activity('2011-12-30T09:59:59.999999Z'); // 29 Dec 23:59:59.999999, the last instant before the skip
      await activity('2011-12-30T10:00:00.000000Z'); // 31 Dec 00:00, the first instant after it
      // E = 2012-01-26: the range starts on the skipped date, so the previous period ends where 2011-12-31 starts.
      const startsSkipped = await compare('2012-01-26', { timeZone: 'Pacific/Apia' });
      expect(startsSkipped.days[0]).toMatchObject({ count: 0, endsAt: '2011-12-30T10:00:00.000Z', localDate: '2011-12-30', startsAt: '2011-12-30T10:00:00.000Z' });
      expect(startsSkipped.comparison!.previous.period).toMatchObject({ endDate: '2011-12-29', endsAt: '2011-12-30T10:00:00.000Z' });
      expect([previousOf(startsSkipped).count, startsSkipped.summary.count]).toEqual([1, 1]);
      expect(counts(startsSkipped)).toEqual({ '2011-12-31': 1 });
      // E = 2012-01-28: the skipped date lies inside the previous period; both items belong to it, none is lost.
      const insidePrevious = await compare('2012-01-28', { timeZone: 'Pacific/Apia' });
      expect(insidePrevious.comparison!.previous.period).toMatchObject({ days: 28, endDate: '2011-12-31', startDate: '2011-12-04' });
      expect([previousOf(insidePrevious).count, insidePrevious.summary.count]).toEqual([2, 0]);
      expect(previousOf(insidePrevious).daysWithEntries).toBe(2);
    });

    it('reflects deletions in either period on the next read', async () => {
      await withoutFixtureRuns();
      const before = await activity('2026-09-20T08:00:00.000Z', { durationS: 600 });
      await activity('2026-10-20T08:00:00.000Z', { durationS: 600 });
      const runBefore = await run('2026-09-20T09:00:00.000Z', { summary: 2 });
      expect(metricsOf(await compare(END)).count).toMatchObject({ current: 1, previous: 1 });
      expect(metricsOf(await compare(END, { source: 'recorded_run' })).count.previous).toBe(1);
      await remove(`/api/orgs/${ids.orgA}/activities/${before}`).expect(204);
      await remove(`/api/orgs/${ids.orgA}/runs/${runBefore}`).expect(204);
      const after = await compare(END);
      expect(metricsOf(after).count).toEqual({ change: { absolute: 1, percent: null, percentUnavailableReason: 'zero_baseline', status: 'available' }, current: 1, previous: 0 });
      expect(metricsOf(after).duration.change).toEqual({ reasons: ['previous_period_no_entries'], status: 'unavailable' });
      expect(metricsOf(await compare(END, { source: 'recorded_run' })).count.previous).toBe(0);
    });

    it('reads both periods in one snapshot: writes committed after the transaction began reach neither period', async () => {
      await withoutFixtureRuns();
      const moving = await activity('2026-09-20T08:00:00.000Z', { durationS: 600 }); // previous
      const deleted = await activity('2026-10-20T08:00:00.000Z', { durationS: 900 }); // range
      const hooked = createApp({
        clock,
        config,
        logger: silent,
        pool: runtimePool,
        sessionManager: sessions,
        testOnlyActivityTrendsHooks: {
          beforeAggregateRead: async () => {
            // Committed after the snapshot: an item moves from the previous period into the range, an item of the range is
            // deleted, and a new item enters the previous period.
            await ownerPool.query('UPDATE activities SET started_at = $2 WHERE id = $1', [moving, '2026-10-21T08:00:00.000Z']);
            await ownerPool.query('DELETE FROM activities WHERE id = $1', [deleted]);
            await activity('2026-09-25T08:00:00.000Z', { durationS: 1_200 });
          },
        },
      });
      const during = await read({ compare: 'previous_period', endDate: END, source: 'manual', timeZone: WARSAW, type: 'ride' }, owner, { target: hooked });
      // Both periods are the state before the writes.
      expect([previousOf(during).count, metricsOf(during).duration.previous, during.summary.count, metricsOf(during).duration.current]).toEqual([1, 600, 1, 900]);
      const after = await compare(END);
      expect([previousOf(after).count, metricsOf(after).duration.previous, after.summary.count, metricsOf(after).duration.current]).toEqual([1, 1_200, 1, 600]);
    });

    it('never mixes snapshots under concurrent writes: the two periods always add up to the same totals', async () => {
      await withoutFixtureRuns();
      const PREVIOUS = '2026-09-20T08:00:00.000Z';
      const CURRENT = '2026-10-20T08:00:00.000Z';
      for (const [startedAt, durationS] of [
        ['2026-09-18T08:00:00.000Z', 100],
        ['2026-09-30T08:00:00.000Z', 200],
        ['2026-10-16T08:00:00.000Z', 300],
        ['2026-11-01T08:00:00.000Z', 400],
      ] as const) {
        await activity(startedAt, { durationS });
      }
      const mover = await activity(PREVIOUS, { durationS: 1_000 });
      // A writer moves one item between the periods as fast as it can, each move one committed UPDATE; readers compare
      // concurrently. Two reads of the periods in different snapshots would sometimes count the item twice or not at all.
      let stop = false;
      let moves = 0;
      const writer = (async () => {
        const client = await ownerPool.connect();
        try {
          while (!stop) {
            await client.query(
              'UPDATE activities SET started_at = CASE WHEN started_at = $2::timestamptz THEN $3::timestamptz ELSE $2::timestamptz END WHERE id = $1',
              [mover, PREVIOUS, CURRENT],
            );
            moves += 1;
          }
        } finally {
          client.release();
        }
      })();
      const splits = new Set<string>();
      let answers = 0;
      try {
        // At least 100 answers, more until both sides were seen (at most 400).
        for (let round = 0; round < 80 && (splits.size < 2 || round < 20); round += 1) {
          for (const trends of await Promise.all(Array.from({ length: 5 }, () => compare(END)))) {
            const metrics = metricsOf(trends);
            expect(metrics.count.previous! + metrics.count.current).toBe(5);
            expect(metrics.duration.previous! + metrics.duration.current!).toBe(2_000);
            // The change row agrees with the totals of the same answer.
            expect(metrics.count.change).toMatchObject({ absolute: metrics.count.current - metrics.count.previous! });
            splits.add(`${metrics.count.previous}/${metrics.count.current}`);
            answers += 1;
          }
        }
      } finally {
        stop = true;
        await writer;
      }
      // The race was real: the writer moved the item many times while the readers ran, and they saw it on both sides.
      expect(splits).toEqual(new Set(['3/2', '2/3']));
      expect(answers).toBeGreaterThanOrEqual(100);
      expect(moves).toBeGreaterThanOrEqual(20);
      console.info(`activity trends comparison race: ${answers} answers, ${moves} committed moves, splits ${[...splits].join(', ')}`);
    }, 60_000);

    it('stays owner-only and never counts a run shared with the caller, in either period', async () => {
      // The fixture's three finished runs of the owner (2026-09-20, shared with the grantee for history) lie in the
      // previous period of 2026-10-20; one more owner run lies in the range.
      await run('2026-10-01T08:00:00.000Z', { summary: 2 });
      const own = await compare('2026-10-20', { source: 'recorded_run', timeZone: 'UTC' });
      expect(metricsOf(own).count).toMatchObject({ current: 1, previous: 3 });
      for (const auth of [grantee, coach]) {
        const other = await compare('2026-10-20', { auth, source: 'recorded_run', timeZone: 'UTC' });
        expect(metricsOf(other).count).toMatchObject({ current: 0, previous: 0 });
      }
      expect(metricsOf(await compare('2026-10-20', { auth: outsider, orgId: ids.orgB, source: 'recorded_run', timeZone: 'UTC' })).count.previous).toBe(2);
      await activity('2026-09-20T08:00:00.000Z', { userId: ids.userDual });
      expect(metricsOf(await compare(END)).count.previous).toBe(0);
      expect(metricsOf(await compare(END, { auth: grantee })).count.previous).toBe(1);
      expect(errorCode(await get(outsider, { compare: 'previous_period', endDate: END, source: 'manual', timeZone: WARSAW, type: 'ride' }).expect(403))).toBe('ORG_ACCESS_DENIED');
    });

    it('refuses an unknown or repeated comparison mode', async () => {
      const valid = { endDate: END, source: 'manual', timeZone: WARSAW, type: 'ride' };
      for (const compareMode of ['', 'previous', 'previous_year', ['previous_period', 'previous_period']]) {
        const response = await get(owner, { ...valid, compare: compareMode }).expect(400);
        expect(errorCode(response), JSON.stringify(compareMode)).toBe('INVALID_REQUEST');
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  describe('validation', () => {
    const valid = { endDate: '2026-11-12', source: 'manual', timeZone: WARSAW, type: 'ride' };

    it('refuses missing, repeated, unknown and owner-like parameters, and a recorded run of another type', async () => {
      for (const query of [
        {},
        { endDate: valid.endDate, source: 'manual', timeZone: WARSAW },
        { endDate: valid.endDate, timeZone: WARSAW, type: 'ride' },
        { source: 'manual', timeZone: WARSAW, type: 'ride' },
        { endDate: valid.endDate, source: 'manual', type: 'ride' },
        { ...valid, source: ['manual', 'gpx'] },
        { ...valid, type: ['ride', 'run'] },
        { ...valid, endDate: ['2026-11-11', '2026-11-12'] },
        { ...valid, timeZone: [WARSAW, 'UTC'] },
        { ...valid, source: 'all' },
        { ...valid, type: 'yoga' },
        { ...valid, source: 'recorded_run', type: 'ride' },
        { ...valid, timeZone: '+01:00' },
        { ...valid, timeZone: 'Europe/Atlantis' },
        { ...valid, endDate: '2026-02-30' },
        { ...valid, endDate: '1999-12-31' },
        { ...valid, userId: ids.userOrgA },
        { ...valid, limit: '50' },
      ] as Query[]) {
        const response = await get(owner, query).expect(400);
        expect(errorCode(response), JSON.stringify(query)).toBe('INVALID_REQUEST');
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(errorCode(await get(owner, valid, { orgId: 'not-a-uuid' }).expect(400))).toBe('INVALID_REQUEST');
    });

    it('refuses an end date after today in the requested zone by the server clock', async () => {
      // 10:00 UTC on 12 November: still the 12th in Warsaw, already the 13th in Kiritimati (UTC+14).
      const future = await get(owner, { ...valid, endDate: '2026-11-13' }).expect(400);
      expect(errorCode(future)).toBe('INVALID_REQUEST');
      expect(JSON.stringify(future.body)).toContain('2026-11-12 in Europe/Warsaw');
      expect((await manual('2026-11-12')).range).toMatchObject({ includesToday: true, today: '2026-11-12' });
      expect((await manual('2026-11-13', 'ride', 'Pacific/Kiritimati')).range).toMatchObject({ includesToday: true, today: '2026-11-13' });
      expect(errorCode(await get(owner, { ...valid, endDate: '2026-11-13', timeZone: 'UTC' }).expect(400))).toBe('INVALID_REQUEST');
    });
  });
});
