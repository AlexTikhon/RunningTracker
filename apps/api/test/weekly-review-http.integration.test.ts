import { randomUUID } from 'node:crypto';

import {
  apiErrorResponseSchema,
  weeklyInsightAcceptedSchema,
  weeklyInsightViewSchema,
  weeklyReviewSchema,
  type WeeklyReview,
  type WeeklyReviewStatementCode,
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
import { FakeProvider } from '../src/insights/fake-provider.js';
import { WeeklyInsightService } from '../src/insights/weekly-insight-service.js';
import { createLogger } from '../src/observability/logger.js';
import { prepareTenantIsolationFixtures, tenantIsolationIds as ids } from './tenant-isolation-fixtures.js';

// The deterministic weekly review over HTTP, with the real runtime role, sessions and row-level security. The app is
// built with WEEKLY_INSIGHTS_PROVIDER=off (the default) unless a test says otherwise; no test here can reach a model.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-20T10:00:00.000Z';
const WEEK = '2026-11-02';
const ZONE = 'Europe/Warsaw';
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
const statement = (review: WeeklyReview, code: WeeklyReviewStatementCode) => review.statements.find((item) => item.code === code)?.text;
const codes = (review: WeeklyReview) => review.statements.map((item) => item.code);

describe('weekly review HTTP API (deterministic, no model)', () => {
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  let sessions: SessionManager;
  let app: ReturnType<typeof createApp>;
  let owner: Authentication;
  let stranger: Authentication;
  let grantee: Authentication;
  let outsider: Authentication;
  const services: WeeklyInsightService[] = [];

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userOrgA, ids.userStranger, ids.userDual, ids.userOrgB].join(','),
      SESSION_COOKIE_SECURE: 'false',
      WEEKLY_INSIGHTS_PROVIDER: 'off',
    });
    expect(config.WEEKLY_INSIGHTS).toBeUndefined();
    ownerPool = new Pool({ application_name: 'running-tracker-review-http-owner', connectionString: integration.migration.connectionString, max: 2 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    sessions = new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    app = createApp({ clock, config, logger: silent, pool: runtimePool, sessionManager: sessions });
    owner = await login(ids.userOrgA);
    stranger = await login(ids.userStranger);
    grantee = await login(ids.userDual);
    outsider = await login(ids.userOrgB);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM weekly_insights');
  });

  afterAll(async () => {
    for (const built of services) await built.stop();
    await ownerPool?.query('DELETE FROM weekly_insights').catch(() => undefined);
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await ownerPool?.query('DELETE FROM daily_metrics').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
    return { cookie: cookiePair(response), csrfToken: (response.body as { csrf: { token: string } }).csrf.token };
  }

  const reviewPath = (orgId: string) => `/api/orgs/${orgId}/weekly-review`;

  const get = (
    auth: Authentication | null,
    query: Record<string, string> = { timeZone: ZONE, weekStart: WEEK },
    options: { orgId?: string; target?: ReturnType<typeof createApp> } = {},
  ) => {
    const pending = request(options.target ?? app).get(reviewPath(options.orgId ?? ids.orgA)).query(query);
    return auth === null ? pending : pending.set('Cookie', auth.cookie);
  };

  async function readReview(auth: Authentication = owner, weekStart = WEEK, timeZone = ZONE): Promise<WeeklyReview> {
    const response = await get(auth, { timeZone, weekStart }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return weeklyReviewSchema.parse(response.body);
  }

  async function checkIn(
    localDate: string,
    values: { mood?: number; note?: string; sleepMinutes?: number; sleepQuality?: number; soreness?: number; weightKg?: number },
    options: { timeZone?: string; userId?: string } = {},
  ) {
    await ownerPool.query(
      `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, sleep_quality, mood, soreness, note)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ids.orgA,
        options.userId ?? ids.userOrgA,
        localDate,
        options.timeZone ?? ZONE,
        values.weightKg ?? null,
        values.sleepMinutes ?? null,
        values.sleepQuality ?? null,
        values.mood ?? null,
        values.soreness ?? null,
        values.note ?? null,
      ],
    );
  }

  async function activity(id: string, startedAt: string, values: { distanceM?: number | null; type?: string } = {}) {
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, notes)
       VALUES ($1, $2, $3, $4, $5::timestamptz, 1800, $6, 'SECRET-ACTIVITY-NOTE')`,
      [ids.orgA, id, ids.userOrgA, values.type ?? 'run', startedAt, values.distanceM === undefined ? 5000 : values.distanceM],
    );
  }

  const storedInsights = async () =>
    Number((await ownerPool.query<{ count: string }>('SELECT count(*)::text AS count FROM weekly_insights')).rows[0]!.count);

  it('works with generation off and no stored insight: 200, no-store, app-computed, nothing stored', async () => {
    await checkIn('2026-11-03', { mood: 4, sleepMinutes: 450, soreness: 2 });
    const review = await readReview();
    expect(review.provenance).toMatchObject({ persisted: false, snapshot: 'single_read_only_transaction', source: 'computed_by_app' });
    expect(review.provenance.computedAt).toBe(now);
    expect(review.week).toEqual({ end: '2026-11-08', inProgress: false, start: WEEK, timeZone: ZONE, timeZoneSource: 'check_ins', zonesOnCheckIns: [ZONE] });
    expect(review.facts.find((fact) => fact.id === 'sleep.average_minutes')?.text).toBe('Average sleep: 450 min');
    expect(statement(review, 'sleep_duration.values')).toBe('Recorded sleep duration: 7 h 30 min (Tuesday).');
    expect(await storedInsights()).toBe(0);
    // The insight endpoint still has nothing for the week: the review is not an insight.
    expect(errorCode(await request(app).get(`/api/orgs/${ids.orgA}/insights/weekly`).query({ weekStart: WEEK }).set('Cookie', owner.cookie).expect(404))).toBe(
      'WEEKLY_INSIGHT_NOT_FOUND',
    );
  });

  it('describes four days with values and sleep on three of them exactly, never as "every check-in day"', async () => {
    await checkIn('2026-11-02', { mood: 4, sleepMinutes: 400 });
    await checkIn('2026-11-04', { mood: 3, sleepMinutes: 380 });
    await checkIn('2026-11-06', { mood: 3, weightKg: 77.6 });
    await checkIn('2026-11-07', { mood: 4, sleepMinutes: 430 });
    await checkIn('2026-11-08', { note: 'SECRET-CHECKIN-NOTE' });
    await checkIn('2026-11-05', { sleepQuality: 2 });
    const review = await readReview();
    expect(review.coverage).toMatchObject({
      daysInWeek: 7,
      daysWithCheckInRecord: 6,
      daysWithCheckInValues: 5,
      metrics: { sleepDuration: { daysRecorded: 3 }, sleepQuality: { daysRecorded: 1 }, weight: { daysRecorded: 1 } },
      noteOnlyDays: 1,
      sleepQualityWithoutDurationDays: 1,
    });
    expect(statement(review, 'sleep_duration.coverage')).toBe('Sleep duration was recorded on 3 of 5 days with check-in values.');
    expect(statement(review, 'check_ins.note_only_days')).toBe('1 day has a check-in with only a note; it is not counted as a day with values.');
    expect(statement(review, 'weight.single_measurement')).toMatch(/A change needs at least two measurements\.$/u);
    expect(JSON.stringify(review)).not.toMatch(/every check-in day|SECRET/u);
  });

  it('reads the week in the zone of its check-ins and reports several zones', async () => {
    await checkIn('2026-11-03', { mood: 3 }, { timeZone: 'Asia/Tokyo' });
    await checkIn('2026-11-04', { mood: 3 }, { timeZone: 'Asia/Tokyo' });
    await checkIn('2026-11-05', { mood: 4 });
    const review = await readReview(owner, WEEK, 'America/New_York');
    expect(review.week).toMatchObject({ timeZone: 'Asia/Tokyo', timeZoneSource: 'check_ins', zonesOnCheckIns: ['Asia/Tokyo', ZONE] });
    expect(codes(review)).toContain('week.multiple_time_zones');
    const empty = await readReview(owner, '2026-11-09', 'America/New_York');
    expect(empty.week).toMatchObject({ timeZone: 'America/New_York', timeZoneSource: 'request' });
    expect(codes(empty)).toContain('week.time_zone_from_request');
  });

  it('isolates the review: another member, a grantee and another organization never see the owner\'s data', async () => {
    await checkIn('2026-11-03', { mood: 4, sleepMinutes: 450 });
    await activity(randomUUID(), '2026-11-04T07:00:00Z');
    const mine = await readReview(owner);
    expect(mine.coverage.daysWithCheckInValues).toBe(1);
    expect(mine.coverage.manualActivities.count).toBe(1);
    for (const other of [stranger, grantee]) {
      const theirs = await readReview(other);
      expect(theirs.coverage).toMatchObject({ daysWithCheckInRecord: 0, manualActivities: { count: 0 } });
      expect(theirs.week.timeZoneSource).toBe('request');
    }
    expect(errorCode(await get(outsider, undefined, { orgId: ids.orgA }).expect(403))).toBe('ORG_ACCESS_DENIED');
    expect(errorCode(await get(owner, undefined, { orgId: ids.orgB }).expect(403))).toBe('ORG_ACCESS_DENIED');
    const anonymous = await get(null).expect(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
  });

  it('counts only the person\'s own GPS runs, even those they can read through sharing', async () => {
    // userOrgA owns three finished runs on 2026-09-20 (their fixture summaries are not current for the runs' data, so
    // they carry no distance); userDual holds live and history grants on them.
    const ownerReview = await readReview(owner, '2026-09-14');
    expect(ownerReview.coverage.gpsRuns).toEqual({ count: 3, withCurrentDistance: 0, withoutCurrentDistance: 3 });
    const granteeReview = await readReview(grantee, '2026-09-14');
    expect(granteeReview.coverage.gpsRuns.count).toBe(0);
    expect(codes(granteeReview)).toContain('gps.none');
  });

  it('uses a GPS distance only from a current summary, and names a partial distance', async () => {
    const runId = randomUUID();
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, 'finished', '2026-11-05T07:00:00Z', '2026-11-05T07:00:00Z', '2026-11-05T07:40:00Z', 2, 0, 'available')`,
      [ids.orgA, runId, ids.userOrgA],
    );
    const summary = (sourceRevision: number) =>
      ownerPool.query(
        `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s,
                                    quality_stats, computed_at)
         VALUES ($1, $2, $3, 'it-v1', ST_GeomFromText('MULTILINESTRING((21.0 52.0, 21.001 52.001))', 4326), 5000, 2400,
                 jsonb_build_object('rawPointCount', 3, 'acceptedPointCount', 3, 'acceptedEdgeCount', 2, 'poorAccuracyPointCount', 0,
                   'seqGapCount', 0, 'segmentBreakCount', 0, 'nonpositiveTimeDeltaCount', 0, 'excessiveTimeGapCount', 0,
                   'excessiveSpeedCount', 0, 'insufficientData', false), now())
         ON CONFLICT (org_id, run_id) DO UPDATE SET source_revision = EXCLUDED.source_revision`,
        [ids.orgA, runId, sourceRevision],
      );
    try {
      await summary(1); // older than the run's data (revision 2): stale, so no distance
      const stale = await readReview();
      expect(statement(stale, 'gps.no_distance')).toBe('1 GPS run: 40 min in total. No current distance is available yet for this run.');
      expect(stale.facts.some((fact) => fact.id === 'gps.distance')).toBe(false);
      expect(stale.dataGaps.map((gap) => gap.code)).toContain('gps_distance_pending');

      await summary(2); // published for the current data
      const current = await readReview();
      expect(statement(current, 'gps.totals')).toBe('1 GPS run: 40 min, 5 km.');

      // A manual run in the same week: listed separately, never added, with the overlap notice.
      await activity(randomUUID(), '2026-11-05T07:00:00Z');
      const both = await readReview();
      expect(statement(both, 'manual.run')).toBe('1 manual run: 30 min, 5 km entered.');
      expect(statement(both, 'gps.totals')).toBe('1 GPS run: 40 min, 5 km.');
      expect(codes(both)).toContain('sources.manual_and_gps_runs_separate');
    } finally {
      await ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [ids.orgA, runId]);
    }
  });

  it('excludes a source on the next read after its deletion commits over HTTP', async () => {
    const activityId = randomUUID();
    await activity(activityId, '2026-11-05T07:00:00Z');
    await checkIn('2026-11-06', { mood: 4, sleepMinutes: 420 });
    await checkIn('2026-11-03', { mood: 2 });
    const before = await readReview();
    expect(before.coverage).toMatchObject({ daysWithCheckInValues: 2, manualActivities: { count: 1 } });

    const remove = (path: string) =>
      request(app).delete(path).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, owner.csrfToken).expect(204);
    await remove(`/api/orgs/${ids.orgA}/daily-metrics/2026-11-06`);
    await remove(`/api/orgs/${ids.orgA}/activities/${activityId}`);

    const after = await readReview();
    expect(after.coverage).toMatchObject({ daysWithCheckInValues: 1, manualActivities: { count: 0 }, metrics: { sleepDuration: { daysRecorded: 0 } } });
    expect(codes(after)).toEqual(expect.arrayContaining(['sleep_duration.not_recorded', 'manual.none']));
    expect(after.facts.some((fact) => fact.id.startsWith('sleep.'))).toBe(false);
    expect(JSON.stringify(after)).not.toMatch(/420|7 h/u);
  });

  it('stays usable when AI generation fails, and never calls the provider or stores anything itself', async () => {
    const provider = new FakeProvider({ mode: 'timeout' });
    const insights = new WeeklyInsightService({
      clock,
      logger: silent,
      pool: runtimePool,
      provider,
      settings: { attemptTimeoutMs: 1_000, maxAttempts: 1, maxOutputTokens: 800, maxPerPerson: 2, maxQueue: 16, totalBudgetMs: 3_000 },
    });
    services.push(insights);
    const withAi = createApp({ clock, config, logger: silent, pool: runtimePool, sessionManager: sessions, weeklyInsights: insights });
    await checkIn('2026-11-03', { mood: 4, sleepMinutes: 450 });

    // Reading the review first neither calls the model nor creates an insight row.
    weeklyReviewSchema.parse((await get(owner, undefined, { target: withAi }).expect(200)).body);
    expect(provider.calls).toHaveLength(0);
    expect(await storedInsights()).toBe(0);

    weeklyInsightAcceptedSchema.parse(
      (
        await request(withAi)
          .post(`/api/orgs/${ids.orgA}/insights/weekly`)
          .set('Cookie', owner.cookie)
          .set('Origin', allowedOrigin)
          .set(csrfHeaderName, owner.csrfToken)
          .type('application/json')
          .send({ timeZone: ZONE, weekStart: WEEK })
          .expect(202)
      ).body,
    );
    await insights.whenIdle();
    const failed = weeklyInsightViewSchema.parse(
      (await request(withAi).get(`/api/orgs/${ids.orgA}/insights/weekly`).query({ weekStart: WEEK }).set('Cookie', owner.cookie).expect(200)).body,
    );
    expect(failed).toMatchObject({ output: null, status: 'generation_failed' });
    const calls = provider.calls.length;

    const review = weeklyReviewSchema.parse((await get(owner, undefined, { target: withAi }).expect(200)).body);
    expect(statement(review, 'sleep_duration.values')).toBe('Recorded sleep duration: 7 h 30 min (Tuesday).');
    expect(provider.calls).toHaveLength(calls);
  });

  it('refuses an invalid query with 400 and no-store', async () => {
    for (const query of [
      { weekStart: WEEK },
      { timeZone: ZONE },
      { timeZone: ZONE, weekStart: '2026-11-03' },
      { timeZone: '+01:00', weekStart: WEEK },
      { timeZone: ZONE, weekStart: '1999-12-27' },
      { timeZone: ZONE, weekStart: '2026-11-23' }, // after today (2026-11-20)
      { extra: 'x', timeZone: ZONE, weekStart: WEEK },
    ]) {
      const refused = await get(owner, query).expect(400);
      expect(errorCode(refused)).toBe('INVALID_REQUEST');
      expect(refused.headers['cache-control']).toBe('no-store');
    }
  });
});
