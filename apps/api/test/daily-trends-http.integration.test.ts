import { apiErrorResponseSchema, dailyTrendsSchema, DAILY_TRENDS_VERSION, type DailyTrendDay, type DailyTrends } from '@running-tracker/contracts';
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

// 28-day trends (ADR-0084) over HTTP, with the real runtime role, sessions and row-level security.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-20T10:00:00.000Z'; // 11:00 in Warsaw, 2026-11-21 00:00 in Kiritimati (UTC+14)
const ZONE = 'Europe/Warsaw';
const END = '2026-11-20'; // the range 2026-10-24..2026-11-20 contains the Warsaw fall-back date 2026-10-25
const START = '2026-10-24';
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
const dayOf = (trends: DailyTrends, localDate: string): DailyTrendDay => {
  const day = trends.days.find((entry) => entry.localDate === localDate);
  if (!day) throw new Error(`No ${localDate} in the range`);
  return day;
};
const noFood = { entriesWithEnergy: 0, loggedEntries: 0, recordedKcal: null };

describe('daily trends HTTP API', () => {
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let sessions: SessionManager;
  let app: ReturnType<typeof createApp>;
  let owner: Authentication;
  let stranger: Authentication;
  let grantee: Authentication;
  let outsider: Authentication;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [ids.userOrgA, ids.userStranger, ids.userDual, ids.userOrgB].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({ application_name: 'running-tracker-trends-http-owner', connectionString: integration.migration.connectionString, max: 2 });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    sessions = new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    app = createApp({ clock, config, logger: silent, pool: runtimePool, sessionManager: sessions });
    owner = await login(ids.userOrgA);
    stranger = await login(ids.userStranger);
    grantee = await login(ids.userDual);
    outsider = await login(ids.userOrgB);
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
  });

  afterAll(async () => {
    for (const table of ['daily_metrics', 'daily_movement', 'meals', 'erasure_ledger']) {
      await ownerPool?.query(`DELETE FROM ${table}`).catch(() => undefined);
    }
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
    return { cookie: cookiePair(response), csrfToken: (response.body as { csrf: { token: string } }).csrf.token };
  }

  const trendsPath = (orgId: string = ids.orgA) => `/api/orgs/${orgId}/daily-trends`;

  const get = (
    auth: Authentication | null,
    query: Record<string, string> = { endDate: END, timeZone: ZONE },
    options: { orgId?: string; target?: ReturnType<typeof createApp> } = {},
  ) => {
    const pending = request(options.target ?? app).get(trendsPath(options.orgId)).query(query);
    return auth === null ? pending : pending.set('Cookie', auth.cookie);
  };

  async function read(endDate: string = END, timeZone: string = ZONE, auth: Authentication = owner, target?: ReturnType<typeof createApp>): Promise<DailyTrends> {
    const response = await get(auth, { endDate, timeZone }, target ? { target } : {}).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return dailyTrendsSchema.parse(response.body);
  }

  const checkIn = (
    localDate: string,
    values: { mood?: number; note?: string; sleepMinutes?: number; weightKg?: string },
    options: { orgId?: string; timeZone?: string; userId?: string } = {},
  ) =>
    ownerPool.query(
      `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, mood, note)
       VALUES ($1, $2, $3::date, $4, $5::numeric, $6, $7, $8)`,
      [options.orgId ?? ids.orgA, options.userId ?? ids.userOrgA, localDate, options.timeZone ?? ZONE, values.weightKg ?? null, values.sleepMinutes ?? null, values.mood ?? null, values.note ?? null],
    );

  const movement = (localDate: string, values: { energy?: string | null; orgId?: string; steps?: number | null; timeZone?: string; userId?: string }) =>
    ownerPool.query(
      `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps, active_energy_kcal) VALUES ($1, $2, $3::date, $4, $5, $6::numeric)`,
      [values.orgId ?? ids.orgA, values.userId ?? ids.userOrgA, localDate, values.timeZone ?? ZONE, values.steps ?? null, values.energy ?? null],
    );

  /** A manual meal entry for a stored calendar date (ADR-0083); energy as numeric text, null for not recorded. */
  const meal = (localDate: string, values: { energy?: string | null; orgId?: string; protein?: string; timeZone?: string; title?: string; userId?: string } = {}) =>
    ownerPool
      .query<{ id: string }>(
        `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, energy_kcal, protein_g, idempotency_key, creation_digest)
         VALUES ($1, $2, $3::date, $4, 'lunch', $5, $6::numeric, $7::numeric, gen_random_uuid(), sha256(gen_random_uuid()::text::bytea))
         RETURNING id`,
        [values.orgId ?? ids.orgA, values.userId ?? ids.userOrgA, localDate, values.timeZone ?? ZONE, values.title ?? 'SECRET-MEAL-TITLE', values.energy ?? null, values.protein ?? null],
      )
      .then((result) => result.rows[0]!.id);

  const mutate = (method: 'delete' | 'put', path: string, body?: object, auth: Authentication = owner) => {
    const pending = request(app)[method](path).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken);
    return body === undefined ? pending : pending.type('application/json').send(body);
  };

  describe('series, missing values and coverage', () => {
    it('answers an empty range: 200, no-store, every date null, no totals, the actual range and app-computed provenance', async () => {
      const trends = await read();
      expect(trends.range).toEqual({
        days: 28,
        endDate: END,
        includesToday: true,
        requestedDays: 28,
        shortenedByLowerBound: false,
        startDate: START,
        timeZone: ZONE,
        today: END,
      });
      expect(trends.days).toHaveLength(28);
      expect(trends.days.every((day) => day.weightKg === null && day.sleepMinutes === null && day.steps === null)).toBe(true);
      expect(trends.days.every((day) => day.foodEnergy.loggedEntries === 0 && day.foodEnergy.recordedKcal === null)).toBe(true);
      expect(trends.summary).toEqual({
        foodEnergy: { daysWithEnergy: 0, daysWithEntries: 0, entriesWithEnergy: 0, loggedEntries: 0, recordedTotalKcal: null, source: 'manual' },
        sleep: { averageMinutes: null, daysRecorded: 0, recordedTotalMinutes: null },
        steps: { daysRecorded: 0, recordedTotal: null, source: 'manual' },
        weight: { changeKg: null, daysRecorded: 0, first: null, last: null },
      });
      expect(trends.provenance).toMatchObject({ persisted: false, snapshot: 'single_read_only_transaction', source: 'computed_by_app', trendsVersion: DAILY_TRENDS_VERSION });
    });

    it('keeps recorded zeros as values and averages and totals over recorded dates only, each series with its own coverage', async () => {
      await checkIn('2026-11-01', { sleepMinutes: 0 });
      await checkIn('2026-11-02', { sleepMinutes: 450 });
      await checkIn('2026-11-03', { mood: 4, note: 'PRIVATE-NOTE-TEXT' }); // no weight or sleep: no value for either series
      await movement('2026-11-01', { steps: 0 });
      await movement('2026-11-04', { steps: 0 });
      await movement('2026-11-05', { energy: '412.5' }); // active energy only: no step count
      await meal('2026-11-01', { energy: '0' });
      const response = await get(owner).expect(200);
      const trends = dailyTrendsSchema.parse(response.body);
      expect(dayOf(trends, '2026-11-01')).toEqual({ foodEnergy: { entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: 0 }, localDate: '2026-11-01', sleepMinutes: 0, steps: 0, weightKg: null });
      expect(dayOf(trends, '2026-11-03')).toEqual({ foodEnergy: noFood, localDate: '2026-11-03', sleepMinutes: null, steps: null, weightKg: null });
      expect(dayOf(trends, '2026-11-05').steps).toBeNull();
      // 0 and 450 over the 2 recorded dates, not over 28: 225 minutes.
      expect(trends.summary.sleep).toEqual({ averageMinutes: 225, daysRecorded: 2, recordedTotalMinutes: 450 });
      expect(trends.summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 0, source: 'manual' });
      expect(trends.summary.foodEnergy).toMatchObject({ daysWithEnergy: 1, entriesWithEnergy: 1, recordedTotalKcal: 0 });
      expect(trends.summary.weight.daysRecorded).toBe(0);
      expect(response.text).not.toMatch(/PRIVATE-NOTE-TEXT|412\.5|mood/u);
    });

    it('keeps the two food-energy coverage levels apart: a title-only day, partial entry coverage, and no titles returned', async () => {
      await meal('2026-11-10', { title: 'Apple' });
      await meal('2026-11-10', { title: 'Tea' }); // a title-only day: two entries, no energy
      await meal('2026-11-11', { energy: '350.5' });
      await meal('2026-11-11', { energy: '410.4' });
      await meal('2026-11-11', { protein: '20' }); // energy unknown for this entry
      const response = await get(owner).expect(200);
      const trends = dailyTrendsSchema.parse(response.body);
      expect(dayOf(trends, '2026-11-10').foodEnergy).toEqual({ entriesWithEnergy: 0, loggedEntries: 2, recordedKcal: null });
      expect(dayOf(trends, '2026-11-11').foodEnergy).toEqual({ entriesWithEnergy: 2, loggedEntries: 3, recordedKcal: 760.9 });
      expect(trends.summary.foodEnergy).toEqual({
        daysWithEnergy: 1,
        daysWithEntries: 2,
        entriesWithEnergy: 2,
        loggedEntries: 5,
        recordedTotalKcal: 760.9,
        source: 'manual',
      });
      expect(response.text).not.toMatch(/Apple|Tea|SECRET-MEAL-TITLE|protein/u);
    });

    it('adds food energy exactly: tenths that binary floating point cannot add exactly, per date and across dates', async () => {
      for (let index = 0; index < 10; index += 1) await meal('2026-11-12', { energy: '0.1' });
      await meal('2026-11-13', { energy: '0.1' });
      await meal('2026-11-14', { energy: '0.2' });
      await meal('2026-11-15', { energy: '19999.9' });
      await meal('2026-11-15', { energy: '19999.9' });
      const trends = await read();
      expect(dayOf(trends, '2026-11-12').foodEnergy).toEqual({ entriesWithEnergy: 10, loggedEntries: 10, recordedKcal: 1 });
      expect(dayOf(trends, '2026-11-15').foodEnergy.recordedKcal).toBe(39999.8);
      // 1 + 0.1 + 0.2 + 39,999.8 = 40,001.1 exactly (floating point would give 40001.100000000006 or similar).
      expect(trends.summary.foodEnergy.recordedTotalKcal).toBe(40001.1);
      expect(trends.summary.foodEnergy).toMatchObject({ daysWithEnergy: 4, entriesWithEnergy: 14, loggedEntries: 14 });
    });

    it('reports no weight change for a single measurement, and the exact first, last and change for several recorded dates', async () => {
      await checkIn('2026-11-05', { weightKg: '72.35' });
      expect((await read()).summary.weight).toEqual({ changeKg: null, daysRecorded: 1, first: null, last: null });

      await checkIn('2026-10-24', { weightKg: '90.00' });
      await checkIn('2026-11-19', { weightKg: '72.30' });
      expect((await read()).summary.weight).toEqual({
        changeKg: -17.7,
        daysRecorded: 3,
        first: { kg: 90, localDate: '2026-10-24' },
        last: { kg: 72.3, localDate: '2026-11-19' },
      });
    });
  });

  describe('range and attribution', () => {
    it('includes both end dates and nothing outside them', async () => {
      const endDate = '2026-11-10';
      await movement('2026-10-13', { steps: 1 }); // the day before the first date
      await movement('2026-10-14', { steps: 10 }); // the first date
      await movement('2026-11-10', { steps: 100 }); // the end date
      await movement('2026-11-11', { steps: 1000 }); // after the end date
      await meal('2026-11-11', { energy: '5' });
      await checkIn('2026-10-13', { weightKg: '70' });
      const trends = await read(endDate);
      expect(trends.range).toMatchObject({ days: 28, endDate, includesToday: false, startDate: '2026-10-14', today: END });
      expect(trends.days[0]).toMatchObject({ localDate: '2026-10-14', steps: 10 });
      expect(trends.days.at(-1)).toMatchObject({ localDate: endDate, steps: 100 });
      expect(trends.summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 110, source: 'manual' });
      expect(trends.summary.foodEnergy.loggedEntries).toBe(0);
      expect(trends.summary.weight.daysRecorded).toBe(0);
    });

    it('shortens the range at 2000-01-01 and uses the actual day count', async () => {
      await movement('2000-01-01', { steps: 0 });
      await checkIn('2000-01-10', { sleepMinutes: 480 });
      await movement('2000-01-11', { steps: 7 });
      const trends = await read('2000-01-10');
      expect(trends.range).toMatchObject({ days: 10, requestedDays: 28, shortenedByLowerBound: true, startDate: '2000-01-01' });
      expect(trends.days.map((day) => day.localDate)).toEqual(Array.from({ length: 10 }, (_, index) => `2000-01-${String(index + 1).padStart(2, '0')}`));
      expect(trends.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 0, source: 'manual' });
      expect(trends.summary.sleep.daysRecorded).toBe(1);
      expect((await read('2000-01-01')).range).toMatchObject({ days: 1, startDate: '2000-01-01' });
      expect((await read('2000-01-28')).range).toMatchObject({ days: 28, shortenedByLowerBound: false, startDate: '2000-01-01' });
    });

    it('keeps every record on its stored date whatever zone it was saved in or the trends are viewed in, across a DST change', async () => {
      // 2026-10-25 is the Warsaw fall-back date (25 hours); a record on it counts once, on that date.
      await checkIn('2026-10-25', { sleepMinutes: 500, weightKg: '71.5' }, { timeZone: 'Asia/Tokyo' });
      await movement('2026-10-25', { steps: 2500, timeZone: 'Pacific/Kiritimati' });
      await meal('2026-10-26', { energy: '600', timeZone: 'Pacific/Pago_Pago' });
      await movement('2026-10-24', { steps: 1, timeZone: 'Pacific/Kiritimati' });
      // At the test clock it is still 2026-11-19 in Pago Pago (UTC-11), so the shared end date is that one.
      for (const zone of ['Europe/Warsaw', 'UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Tokyo']) {
        const trends = await read('2026-11-19', zone);
        expect(trends.range.timeZone).toBe(zone);
        expect(trends.days.filter((day) => day.localDate === '2026-10-25')).toHaveLength(1);
        expect(dayOf(trends, '2026-10-24')).toMatchObject({ steps: 1 });
        expect(dayOf(trends, '2026-10-25')).toMatchObject({ sleepMinutes: 500, steps: 2500, weightKg: 71.5 });
        expect(dayOf(trends, '2026-10-26')).toMatchObject({ foodEnergy: { entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: 600 }, steps: null });
        expect(trends.summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 2501, source: 'manual' });
      }
    });

    it('decides "today" by the server clock in the requested zone and refuses a later end date', async () => {
      // At 2026-11-20T10:00Z it is already 21 November in Kiritimati, still 20 November in Warsaw.
      await movement('2026-11-21', { steps: 21, timeZone: 'Pacific/Kiritimati' });
      const kiritimati = await read('2026-11-21', 'Pacific/Kiritimati');
      expect(kiritimati.range).toMatchObject({ includesToday: true, startDate: '2026-10-25', today: '2026-11-21' });
      expect(kiritimati.days.at(-1)).toMatchObject({ localDate: '2026-11-21', steps: 21 });
      expect((await read(END, ZONE)).range).toMatchObject({ includesToday: true, today: END });
      const refused = await get(owner, { endDate: '2026-11-21', timeZone: ZONE }).expect(400);
      expect(errorCode(refused)).toBe('INVALID_REQUEST');
      expect(refused.body).toMatchObject({ error: { message: 'The end date cannot be after today (2026-11-20 in Europe/Warsaw)' } });
      expect(refused.headers['cache-control']).toBe('no-store');
    });
  });

  describe('access', () => {
    it("isolates the trends: another member, a run-sharing grantee and another organization never see the owner's data", async () => {
      const date = '2026-11-10';
      await checkIn(date, { sleepMinutes: 420, weightKg: '72' });
      await movement(date, { steps: 8042 });
      await meal(date, { energy: '700' });
      await checkIn(date, { weightKg: '60' }, { userId: ids.userStranger });
      await movement(date, { steps: 50, userId: ids.userStranger });
      await meal(date, { energy: '50', userId: ids.userStranger });
      await movement(date, { orgId: ids.orgB, steps: 12_000, userId: ids.userOrgB });
      await meal(date, { energy: '900', orgId: ids.orgB, userId: ids.userOrgB });
      // userDual is a member of the owner's organization and holds history and live grants on the owner's runs.
      await checkIn(date, { sleepMinutes: 300 }, { userId: ids.userDual });

      const mine = await read(END, 'UTC');
      expect(dayOf(mine, date)).toEqual({ foodEnergy: { entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: 700 }, localDate: date, sleepMinutes: 420, steps: 8042, weightKg: 72 });
      const theirs = await read(END, 'UTC', stranger);
      expect(dayOf(theirs, date)).toEqual({ foodEnergy: { entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: 50 }, localDate: date, sleepMinutes: null, steps: 50, weightKg: 60 });
      const granteeView = await read(END, 'UTC', grantee);
      expect(dayOf(granteeView, date)).toEqual({ foodEnergy: noFood, localDate: date, sleepMinutes: 300, steps: null, weightKg: null });
      expect(granteeView.summary.steps.daysRecorded).toBe(0);

      const outsiderOwn = dailyTrendsSchema.parse((await get(outsider, { endDate: END, timeZone: 'UTC' }, { orgId: ids.orgB }).expect(200)).body);
      expect(dayOf(outsiderOwn, date)).toMatchObject({ foodEnergy: { recordedKcal: 900 }, steps: 12_000, weightKg: null });
      for (const [auth, orgId] of [
        [outsider, ids.orgA],
        [owner, ids.orgB],
      ] as const) {
        const denied = await get(auth, { endDate: END, timeZone: 'UTC' }, { orgId }).expect(403);
        expect(errorCode(denied)).toBe('ORG_ACCESS_DENIED');
        expect(denied.headers['cache-control']).toBe('no-store');
      }
      const anonymous = await get(null).expect(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
    });
  });

  describe('snapshot and freshness', () => {
    it('reads every source in one snapshot, even when writes commit between its statements', async () => {
      await checkIn('2026-11-01', { weightKg: '70' });
      await checkIn('2026-11-02', { weightKg: '71' });
      await movement('2026-11-01', { steps: 1000 });
      const keptMeal = await meal('2026-11-01', { energy: '400' });
      let interleave: (() => Promise<void>) | null = null;
      const reached: string[] = [];
      const hooked = createApp({
        clock,
        config,
        logger: silent,
        pool: runtimePool,
        sessionManager: sessions,
        testOnlyDailyTrendsHooks: {
          afterCheckInsRead: async () => {
            reached.push('after check-ins');
            await interleave?.();
          },
        },
      });
      interleave = async () => {
        // Committed on another connection after the check-ins were read and before movement and meals are.
        await ownerPool.query('DELETE FROM daily_metrics');
        await ownerPool.query('DELETE FROM daily_movement');
        await movement('2026-11-03', { steps: 3000 });
        await ownerPool.query('DELETE FROM meals WHERE id = $1', [keptMeal]);
        await meal('2026-11-04', { energy: '100' });
        await meal('2026-11-04', {});
      };
      const during = await read(END, ZONE, owner, hooked);
      expect(reached).toEqual(['after check-ins']);
      expect(during.summary.weight).toMatchObject({ changeKg: 1, daysRecorded: 2 });
      expect(during.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 1000, source: 'manual' });
      expect(during.summary.foodEnergy).toMatchObject({ daysWithEntries: 1, entriesWithEnergy: 1, loggedEntries: 1, recordedTotalKcal: 400 });

      interleave = null;
      const next = await read(END, ZONE, owner, hooked);
      expect(next.summary.weight.daysRecorded).toBe(0);
      expect(next.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 3000, source: 'manual' });
      expect(dayOf(next, '2026-11-04').foodEnergy).toEqual({ entriesWithEnergy: 1, loggedEntries: 2, recordedKcal: 100 });
      expect(next.summary.foodEnergy).toMatchObject({ daysWithEntries: 1, loggedEntries: 2, recordedTotalKcal: 100 });
    });

    it('reflects edits and deletions made through the existing APIs on the next read of the same range', async () => {
      const date = '2026-11-10';
      await mutate('put', `/api/orgs/${ids.orgA}/daily-metrics/${date}`, { sleepMinutes: 420, timeZone: ZONE, weightKg: 72.4 }).expect(201);
      await mutate('put', `/api/orgs/${ids.orgA}/daily-movement/${date}`, { steps: 8042, timeZone: ZONE }).expect(201);
      const mealId = await meal(date, { energy: '777.7' });
      await meal(date, { energy: '100' });
      expect(dayOf(await read(), date)).toEqual({ foodEnergy: { entriesWithEnergy: 2, loggedEntries: 2, recordedKcal: 877.7 }, localDate: date, sleepMinutes: 420, steps: 8042, weightKg: 72.4 });

      await mutate('put', `/api/orgs/${ids.orgA}/daily-metrics/${date}`, { mood: 3, timeZone: ZONE }).expect(200);
      await mutate('put', `/api/orgs/${ids.orgA}/daily-movement/${date}`, { steps: 0, timeZone: ZONE }).expect(200);
      await mutate('put', `/api/orgs/${ids.orgA}/meals/${mealId}`, { mealType: 'dinner', title: 'Edited' }).expect(200);
      const edited = await read();
      expect(dayOf(edited, date)).toEqual({ foodEnergy: { entriesWithEnergy: 1, loggedEntries: 2, recordedKcal: 100 }, localDate: date, sleepMinutes: null, steps: 0, weightKg: null });
      expect(edited.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 0, source: 'manual' });

      await mutate('delete', `/api/orgs/${ids.orgA}/daily-metrics/${date}`).expect(204);
      await mutate('delete', `/api/orgs/${ids.orgA}/daily-movement/${date}`).expect(204);
      await mutate('delete', `/api/orgs/${ids.orgA}/meals/${mealId}`).expect(204);
      const response = await get(owner).expect(200);
      const deleted = dailyTrendsSchema.parse(response.body);
      expect(dayOf(deleted, date)).toEqual({ foodEnergy: { entriesWithEnergy: 1, loggedEntries: 1, recordedKcal: 100 }, localDate: date, sleepMinutes: null, steps: null, weightKg: null });
      expect(response.text).not.toMatch(/777\.7|8042|72\.4|Edited/u);
    });

    it('writes nothing: the row counts of every source, the erasure ledger and weekly insights are unchanged after reads', async () => {
      await checkIn('2026-11-10', { weightKg: '72' });
      await meal('2026-11-10', { energy: '1' });
      const counts = async () =>
        (
          await ownerPool.query<{ counts: string }>(
            `SELECT concat_ws(',', (SELECT count(*) FROM daily_metrics), (SELECT count(*) FROM daily_movement), (SELECT count(*) FROM meals),
                                   (SELECT count(*) FROM activities), (SELECT count(*) FROM erasure_ledger), (SELECT count(*) FROM weekly_insights)) AS counts`,
          )
        ).rows[0]!.counts;
      const before = await counts();
      await read();
      await read('2000-01-05', 'UTC');
      expect(await counts()).toBe(before);
    });
  });

  describe('validation', () => {
    it('refuses invalid, missing, repeated and unknown parameters and organizations with 400 and no-store', async () => {
      const cases: Array<[Record<string, string>, string?]> = [
        [{ endDate: '1999-12-31', timeZone: ZONE }],
        [{ endDate: '2026-02-30', timeZone: ZONE }],
        [{ endDate: '2026-11-5', timeZone: ZONE }],
        [{ endDate: 'today', timeZone: ZONE }],
        [{ timeZone: ZONE }],
        [{ endDate: END }],
        [{}],
        [{ endDate: END, timeZone: '+01:00' }],
        [{ endDate: END, timeZone: 'Mars/Olympus_Mons' }],
        [{ endDate: END, extra: 'x', timeZone: ZONE }],
        [{ days: '7', endDate: END, timeZone: ZONE }],
        [{ endDate: END, timeZone: ZONE }, 'not-a-uuid'],
      ];
      for (const [query, orgId] of cases) {
        const refused = await get(owner, query, orgId ? { orgId } : {}).expect(400);
        expect(errorCode(refused), `${JSON.stringify(query)} ${orgId ?? ''}`).toBe('INVALID_REQUEST');
        expect(refused.headers['cache-control']).toBe('no-store');
      }
      for (const query of [`endDate=${END}&endDate=2026-11-19&timeZone=${ZONE}`, `endDate=${END}&timeZone=${ZONE}&timeZone=UTC`]) {
        const repeated = await request(app).get(`${trendsPath()}?${query}`).set('Cookie', owner.cookie).expect(400);
        expect(errorCode(repeated)).toBe('INVALID_REQUEST');
        expect(repeated.headers['cache-control']).toBe('no-store');
      }
    });

    it('marks even a malformed request body error as no-store', async () => {
      const malformed = await request(app).get(trendsPath()).query({ endDate: END, timeZone: ZONE }).set('Cookie', owner.cookie).type('application/json').send('{"broken"');
      expect(malformed.status).toBe(400);
      expect(malformed.headers['cache-control']).toBe('no-store');
    });
  });
});
