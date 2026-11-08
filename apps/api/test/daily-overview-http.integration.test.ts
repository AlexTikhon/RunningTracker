import { randomUUID } from 'node:crypto';

import { apiErrorResponseSchema, dailyOverviewSchema, DAILY_OVERVIEW_VERSION, type DailyOverview } from '@running-tracker/contracts';
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

// The daily overview (Today, ADR-0082) over HTTP, with the real runtime role, sessions and row-level security.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-11-20T10:00:00.000Z'; // 11:00 in Warsaw, 2026-11-21 00:00 in Kiritimati (UTC+14)
const ZONE = 'Europe/Warsaw';
const DAY = '2026-11-05';
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

describe('daily overview HTTP API', () => {
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
    ownerPool = new Pool({ application_name: 'running-tracker-overview-http-owner', connectionString: integration.migration.connectionString, max: 2 });
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
    for (const table of ['activities', 'daily_metrics', 'daily_movement', 'erasure_ledger']) {
      await ownerPool?.query(`DELETE FROM ${table}`).catch(() => undefined);
    }
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app).post('/api/session').set('Origin', allowedOrigin).type('application/json').send({ userId }).expect(201);
    return { cookie: cookiePair(response), csrfToken: (response.body as { csrf: { token: string } }).csrf.token };
  }

  const overviewPath = (localDate: string, orgId: string = ids.orgA) => `/api/orgs/${orgId}/daily-overview/${localDate}`;

  const get = (
    auth: Authentication | null,
    localDate: string = DAY,
    query: Record<string, string> = { timeZone: ZONE },
    options: { orgId?: string; target?: ReturnType<typeof createApp> } = {},
  ) => {
    const pending = request(options.target ?? app).get(overviewPath(localDate, options.orgId)).query(query);
    return auth === null ? pending : pending.set('Cookie', auth.cookie);
  };

  async function read(localDate: string = DAY, timeZone: string = ZONE, auth: Authentication = owner, target?: ReturnType<typeof createApp>): Promise<DailyOverview> {
    const response = await get(auth, localDate, { timeZone }, target ? { target } : {}).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return dailyOverviewSchema.parse(response.body);
  }

  async function checkIn(
    localDate: string,
    values: { mood?: number; note?: string; sleepMinutes?: number; sleepQuality?: number; soreness?: number; weightKg?: number },
    options: { orgId?: string; timeZone?: string; userId?: string } = {},
  ) {
    await ownerPool.query(
      `INSERT INTO daily_metrics (org_id, user_id, local_date, time_zone, weight_kg, sleep_minutes, sleep_quality, mood, soreness, note)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10)`,
      [
        options.orgId ?? ids.orgA,
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

  const movement = (localDate: string, values: { energy?: string | null; orgId?: string; steps?: number | null; timeZone?: string; userId?: string }) =>
    ownerPool.query(
      `INSERT INTO daily_movement (org_id, user_id, local_date, time_zone, steps, active_energy_kcal) VALUES ($1, $2, $3::date, $4, $5, $6::numeric)`,
      [values.orgId ?? ids.orgA, values.userId ?? ids.userOrgA, localDate, values.timeZone ?? ZONE, values.steps ?? null, values.energy ?? null],
    );

  async function activity(startedAt: string, values: { durationS?: number; id?: string; orgId?: string; type?: string; userId?: string } = {}): Promise<string> {
    const id = values.id ?? randomUUID();
    await ownerPool.query(
      `INSERT INTO activities (org_id, id, user_id, type, started_at, duration_s, distance_m, notes)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, 5000, 'SECRET-ACTIVITY-NOTE')`,
      [values.orgId ?? ids.orgA, id, values.userId ?? ids.userOrgA, values.type ?? 'run', startedAt, values.durationS ?? 1800],
    );
    return id;
  }

  /** A run with data revision 2; `summary` is the revision its summary was computed for (null: no summary yet). */
  async function gpsRun(startedAt: string, options: { distanceM?: number; status?: 'finished' | 'recording'; summary?: number | null; userId?: string } = {}): Promise<string> {
    const runId = randomUUID();
    const finished = (options.status ?? 'finished') === 'finished';
    await ownerPool.query(
      `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6, 2, 0, 'available')`,
      [ids.orgA, runId, options.userId ?? ids.userOrgA, options.status ?? 'finished', startedAt, finished ? new Date(Date.parse(startedAt) + 2_400_000).toISOString() : null],
    );
    if (options.summary !== null && options.summary !== undefined) {
      await ownerPool.query(
        `INSERT INTO run_summaries (org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s, quality_stats, computed_at)
         VALUES ($1, $2, $3, 'it-v1', ST_GeomFromText('MULTILINESTRING((21.0 52.0, 21.001 52.001))', 4326), $4, 2400,
                 jsonb_build_object('rawPointCount', 3, 'acceptedPointCount', 3, 'acceptedEdgeCount', 2, 'poorAccuracyPointCount', 0,
                   'seqGapCount', 0, 'segmentBreakCount', 0, 'nonpositiveTimeDeltaCount', 0, 'excessiveTimeGapCount', 0,
                   'excessiveSpeedCount', 0, 'insufficientData', false), now())`,
        [ids.orgA, runId, options.summary, options.distanceM ?? 5000],
      );
    }
    return runId;
  }

  const mutate = (method: 'delete', path: string, auth: Authentication = owner) =>
    request(app)[method](path).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken);

  describe('records and their states', () => {
    it('answers an empty day: 200, no-store, nothing recorded, the requested zone and interval, app-computed provenance', async () => {
      const overview = await read();
      expect(overview).toEqual({
        checkIn: { recorded: false },
        day: { endsAt: '2026-11-05T23:00:00.000Z', inProgress: false, localDate: DAY, startsAt: '2026-11-04T23:00:00.000Z', timeZone: ZONE },
        gpsRuns: { count: 0, currentDistanceM: null, withCurrentDistance: 0, withoutCurrentDistance: 0 },
        manualActivities: { byType: [], count: 0, enteredDurationS: 0 },
        movement: { recorded: false },
        provenance: { computedAt: now, overviewVersion: DAILY_OVERVIEW_VERSION, persisted: false, snapshot: 'single_read_only_transaction', source: 'computed_by_app' },
      });
      expect((await read('2026-11-20')).day.inProgress).toBe(true);
    });

    it('counts a note-only check-in as a record without returning the note', async () => {
      await checkIn(DAY, { note: 'SECRET-CHECKIN-NOTE' });
      const response = await get(owner).expect(200);
      const overview = dailyOverviewSchema.parse(response.body);
      expect(overview.checkIn).toEqual({ hasNote: true, mood: null, recorded: true, sleepMinutes: null, sleepQuality: null, soreness: null, timeZone: ZONE, weightKg: null });
      expect(response.text).not.toContain('SECRET');
    });

    it('answers a movement-only day with recorded zeros as zeros and the check-in as not recorded', async () => {
      await movement(DAY, { energy: '0.0', steps: 0 });
      const overview = await read();
      expect(overview.checkIn).toEqual({ recorded: false });
      expect(overview.movement).toEqual({ activeEnergyKcal: 0, recorded: true, source: 'manual', steps: 0, timeZone: ZONE });
    });

    it('keeps a partially recorded day partial: values not recorded are null, never zero', async () => {
      await checkIn(DAY, { mood: 4, soreness: 0 });
      await movement(DAY, { energy: '412.5' });
      const overview = await read();
      expect(overview.checkIn).toEqual({ hasNote: false, mood: 4, recorded: true, sleepMinutes: null, sleepQuality: null, soreness: 0, timeZone: ZONE, weightKg: null });
      expect(overview.movement).toEqual({ activeEnergyKcal: 412.5, recorded: true, source: 'manual', steps: null, timeZone: ZONE });
    });

    it('returns every check-in value as stored', async () => {
      await checkIn(DAY, { mood: 3, sleepMinutes: 450, sleepQuality: 4, soreness: 7, weightKg: 72.35 });
      expect((await read()).checkIn).toEqual({ hasNote: false, mood: 3, recorded: true, sleepMinutes: 450, sleepQuality: 4, soreness: 7, timeZone: ZONE, weightKg: 72.35 });
    });
  });

  describe('daily semantics', () => {
    it('keeps check-in and movement on their stored date whatever zone they were saved in or the view uses', async () => {
      await checkIn(DAY, { mood: 3 }, { timeZone: 'Asia/Tokyo' });
      await movement(DAY, { steps: 1000, timeZone: 'Pacific/Kiritimati' });
      for (const view of ['America/New_York', 'Pacific/Pago_Pago', 'Asia/Tokyo', ZONE]) {
        const overview = await read(DAY, view);
        expect(overview.day.timeZone).toBe(view);
        expect(overview.checkIn).toMatchObject({ recorded: true, timeZone: 'Asia/Tokyo' });
        expect(overview.movement).toMatchObject({ recorded: true, steps: 1000, timeZone: 'Pacific/Kiritimati' });
        for (const neighbour of ['2026-11-04', '2026-11-06']) {
          const other = await read(neighbour, view);
          expect([other.checkIn.recorded, other.movement.recorded], `${neighbour} in ${view}`).toEqual([false, false]);
        }
      }
    });

    it('attributes activities and runs to the date they started on in the requested zone, at the midnight boundaries', async () => {
      await activity('2026-11-04T22:59:59.999Z'); // 23:59:59.999 on 4 Nov in Warsaw
      await activity('2026-11-04T23:00:00.000Z', { type: 'walk' }); // 00:00 on 5 Nov: included
      await activity('2026-11-05T22:59:59.999Z', { type: 'walk' }); // 23:59:59.999 on 5 Nov: included
      await activity('2026-11-05T23:00:00.000Z'); // 00:00 on 6 Nov
      await gpsRun('2026-11-04T23:00:00.000Z', { summary: 2 });
      await gpsRun('2026-11-05T23:00:00.000Z', { summary: 2 });
      const warsaw = await read();
      expect(warsaw.manualActivities).toEqual({ byType: [{ count: 2, enteredDurationS: 3600, type: 'walk' }], count: 2, enteredDurationS: 3600 });
      expect(warsaw.gpsRuns.count).toBe(1);
      // The same instants in New York (UTC-5): 5 Nov runs from 05:00Z to 05:00Z the next day.
      const newYork = await read(DAY, 'America/New_York');
      expect(newYork.day).toMatchObject({ endsAt: '2026-11-06T05:00:00.000Z', startsAt: '2026-11-05T05:00:00.000Z' });
      expect(newYork.manualActivities.count).toBe(2);
      expect(newYork.manualActivities.byType).toEqual([
        { count: 1, enteredDurationS: 1800, type: 'run' },
        { count: 1, enteredDurationS: 1800, type: 'walk' },
      ]);
      expect(newYork.gpsRuns.count).toBe(1);
    });

    it('counts an activity crossing midnight in full on the date it started, and not on the next', async () => {
      await activity('2026-11-05T22:30:00.000Z', { durationS: 10_800 }); // 23:30 to 02:30 in Warsaw
      expect((await read()).manualActivities).toEqual({ byType: [{ count: 1, enteredDurationS: 10_800, type: 'run' }], count: 1, enteredDurationS: 10_800 });
      expect((await read('2026-11-06')).manualActivities.count).toBe(0);
    });

    it('uses a 23-hour window on the Warsaw spring-forward date', async () => {
      await activity('2026-03-28T22:59:59.000Z'); // 23:59:59 CET on 28 March
      await activity('2026-03-28T23:00:00.000Z', { type: 'walk' }); // 00:00 CET on 29 March
      await activity('2026-03-29T01:00:00.000Z', { type: 'walk' }); // 03:00 CEST, just after the jump
      await activity('2026-03-29T21:59:59.000Z', { type: 'walk' }); // 23:59:59 CEST on 29 March
      await activity('2026-03-29T22:00:00.000Z'); // 00:00 CEST on 30 March
      const overview = await read('2026-03-29');
      expect(overview.day).toMatchObject({ endsAt: '2026-03-29T22:00:00.000Z', startsAt: '2026-03-28T23:00:00.000Z' });
      expect(overview.manualActivities.byType).toEqual([{ count: 3, enteredDurationS: 5400, type: 'walk' }]);
      expect((await read('2026-03-28')).manualActivities.byType).toEqual([{ count: 1, enteredDurationS: 1800, type: 'run' }]);
      expect((await read('2026-03-30')).manualActivities.byType).toEqual([{ count: 1, enteredDurationS: 1800, type: 'run' }]);
    });

    it('uses a 25-hour window on the Warsaw fall-back date, including both 02:00-03:00 hours', async () => {
      await activity('2026-10-24T21:59:59.000Z'); // 23:59:59 CEST on 24 October
      await activity('2026-10-24T22:00:00.000Z', { type: 'walk' }); // 00:00 CEST on 25 October
      await activity('2026-10-25T00:30:00.000Z', { type: 'walk' }); // 02:30 CEST, the first 02:30
      await activity('2026-10-25T01:30:00.000Z', { type: 'walk' }); // 02:30 CET, the repeated 02:30
      await activity('2026-10-25T22:59:59.000Z', { type: 'walk' }); // 23:59:59 CET on 25 October
      await activity('2026-10-25T23:00:00.000Z'); // 00:00 CET on 26 October
      await gpsRun('2026-10-25T01:30:00.000Z', { summary: 2 });
      const overview = await read('2026-10-25');
      expect(overview.day).toMatchObject({ endsAt: '2026-10-25T23:00:00.000Z', startsAt: '2026-10-24T22:00:00.000Z' });
      expect(Date.parse(overview.day.endsAt) - Date.parse(overview.day.startsAt)).toBe(25 * 3_600_000);
      expect(overview.manualActivities.byType).toEqual([{ count: 4, enteredDurationS: 7200, type: 'walk' }]);
      expect(overview.gpsRuns.count).toBe(1);
      expect((await read('2026-10-24')).manualActivities.count).toBe(1);
      expect((await read('2026-10-26')).manualActivities.count).toBe(1);
    });

    it('uses only finished runs and distances from current summaries, and names a partial total by its runs', async () => {
      await gpsRun('2026-11-05T07:00:00Z', { distanceM: 5012.4, summary: 2 }); // current
      await gpsRun('2026-11-05T09:00:00Z', { distanceM: 9999, summary: 1 }); // stale: older than the run's data
      await gpsRun('2026-11-05T11:00:00Z', { summary: null }); // no summary yet
      // Not finished: the fixture's recording run of the same person (one active run per person), moved into the day.
      await ownerPool.query(`UPDATE runs SET started_at = '2026-11-05T13:00:00Z', created_at = '2026-11-05T13:00:00Z' WHERE id = $1`, [ids.runRecording]);
      expect((await read()).gpsRuns).toEqual({ count: 3, currentDistanceM: 5012, withCurrentDistance: 1, withoutCurrentDistance: 2 });
      await ownerPool.query('UPDATE run_summaries SET source_revision = 1');
      expect((await read()).gpsRuns).toEqual({ count: 3, currentDistanceM: null, withCurrentDistance: 0, withoutCurrentDistance: 3 });
    });

    it('reports an overlapping manual run and GPS run separately and never adds movement to either', async () => {
      await activity('2026-11-05T07:00:00Z', { durationS: 2400 });
      await gpsRun('2026-11-05T07:00:00Z', { distanceM: 5000, summary: 2 });
      await movement(DAY, { energy: '300.0', steps: 6000 });
      const overview = await read();
      expect(overview.manualActivities).toEqual({ byType: [{ count: 1, enteredDurationS: 2400, type: 'run' }], count: 1, enteredDurationS: 2400 });
      expect(overview.gpsRuns).toEqual({ count: 1, currentDistanceM: 5000, withCurrentDistance: 1, withoutCurrentDistance: 0 });
      expect(overview.movement).toMatchObject({ activeEnergyKcal: 300, steps: 6000 });
    });
  });

  describe('access', () => {
    it("isolates the overview: another member, a run-sharing grantee and another organization never see the owner's data", async () => {
      const date = '2026-09-20'; // the fixture's runs: userOrgA owns three finished and one recording run; userDual holds grants on them
      await checkIn(date, { mood: 4 });
      await movement(date, { steps: 8042 });
      await activity('2026-09-20T07:00:00Z');
      await checkIn(date, { mood: 1 }, { userId: ids.userStranger });
      await movement(date, { steps: 12_000, orgId: ids.orgB, userId: ids.userOrgB });
      const mine = await read(date, 'UTC');
      expect(mine).toMatchObject({ checkIn: { mood: 4, recorded: true }, gpsRuns: { count: 3 }, manualActivities: { count: 1 }, movement: { steps: 8042 } });

      const theirs = await read(date, 'UTC', stranger);
      expect(theirs).toMatchObject({ checkIn: { mood: 1, recorded: true }, gpsRuns: { count: 0 }, manualActivities: { count: 0 }, movement: { recorded: false } });
      const granteeView = await read(date, 'UTC', grantee);
      expect(granteeView).toMatchObject({ checkIn: { recorded: false }, gpsRuns: { count: 0 }, manualActivities: { count: 0 }, movement: { recorded: false } });

      const outsiderOwn = dailyOverviewSchema.parse((await get(outsider, date, { timeZone: 'UTC' }, { orgId: ids.orgB }).expect(200)).body);
      expect(outsiderOwn.movement).toMatchObject({ recorded: true, steps: 12_000 });
      for (const [auth, orgId] of [
        [outsider, ids.orgA],
        [owner, ids.orgB],
      ] as const) {
        const denied = await get(auth, date, { timeZone: 'UTC' }, { orgId }).expect(403);
        expect(errorCode(denied)).toBe('ORG_ACCESS_DENIED');
        expect(denied.headers['cache-control']).toBe('no-store');
      }
      const anonymous = await get(null).expect(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
    });
  });

  describe('snapshot and freshness', () => {
    it('reads every source in one snapshot, even when writes commit between its two statements', async () => {
      await checkIn(DAY, { mood: 3 });
      await movement(DAY, { steps: 1000 });
      const kept = await activity('2026-11-05T07:00:00Z');
      let interleave: (() => Promise<void>) | null = null;
      const reached: string[] = [];
      const hooked = createApp({
        clock,
        config,
        logger: silent,
        pool: runtimePool,
        sessionManager: sessions,
        testOnlyDailyOverviewHooks: {
          afterDayRecordsRead: async () => {
            reached.push('after day records');
            await interleave?.();
          },
        },
      });
      interleave = async () => {
        // Committed on another connection after the day records were read and before the timestamped sources are.
        await ownerPool.query('DELETE FROM activities WHERE id = $1', [kept]);
        await activity('2026-11-05T09:00:00Z', { type: 'swim' });
        await gpsRun('2026-11-05T10:00:00Z', { summary: 2 });
        await ownerPool.query('DELETE FROM daily_metrics');
        await ownerPool.query('DELETE FROM daily_movement');
      };
      const during = await read(DAY, ZONE, owner, hooked);
      expect(reached).toEqual(['after day records']);
      expect(during).toMatchObject({
        checkIn: { mood: 3, recorded: true },
        gpsRuns: { count: 0 },
        manualActivities: { byType: [{ count: 1, type: 'run' }], count: 1 },
        movement: { recorded: true, steps: 1000 },
      });

      interleave = null;
      const next = await read(DAY, ZONE, owner, hooked);
      expect(next).toMatchObject({
        checkIn: { recorded: false },
        gpsRuns: { count: 1 },
        manualActivities: { byType: [{ count: 1, type: 'swim' }], count: 1 },
        movement: { recorded: false },
      });
    });

    it('excludes a check-in, a movement day and an activity on the next read after their deletion commits over HTTP', async () => {
      await checkIn(DAY, { mood: 4, sleepMinutes: 420 });
      await movement(DAY, { energy: '412.5', steps: 8042 });
      const activityId = await activity('2026-11-05T07:00:00Z');
      expect(await read()).toMatchObject({ checkIn: { recorded: true }, manualActivities: { count: 1 }, movement: { recorded: true } });

      await mutate('delete', `/api/orgs/${ids.orgA}/daily-metrics/${DAY}`).expect(204);
      await mutate('delete', `/api/orgs/${ids.orgA}/daily-movement/${DAY}`).expect(204);
      await mutate('delete', `/api/orgs/${ids.orgA}/activities/${activityId}`).expect(204);
      const response = await get(owner).expect(200);
      expect(dailyOverviewSchema.parse(response.body)).toMatchObject({ checkIn: { recorded: false }, manualActivities: { count: 0 }, movement: { recorded: false } });
      expect(response.text).not.toMatch(/8042|412\.5|420/u);
    });

    it('writes nothing: the row counts of every source and the erasure ledger are unchanged after reads', async () => {
      await checkIn(DAY, { mood: 4 });
      const counts = async () =>
        (
          await ownerPool.query<{ counts: string }>(
            `SELECT concat_ws(',', (SELECT count(*) FROM daily_metrics), (SELECT count(*) FROM daily_movement), (SELECT count(*) FROM activities),
                                   (SELECT count(*) FROM runs), (SELECT count(*) FROM run_summaries), (SELECT count(*) FROM erasure_ledger),
                                   (SELECT count(*) FROM weekly_insights)) AS counts`,
          )
        ).rows[0]!.counts;
      const before = await counts();
      await read();
      await read('2026-09-20', 'UTC');
      expect(await counts()).toBe(before);
    });
  });

  describe('validation', () => {
    it('accepts today in the requested zone and refuses a later date by the server clock in that zone', async () => {
      // At 2026-11-20T10:00Z it is already 21 November in Kiritimati, still 20 November in Warsaw.
      expect((await read('2026-11-21', 'Pacific/Kiritimati')).day).toMatchObject({ inProgress: true, localDate: '2026-11-21' });
      const refused = await get(owner, '2026-11-21', { timeZone: ZONE }).expect(400);
      expect(errorCode(refused)).toBe('INVALID_REQUEST');
      expect(refused.body).toMatchObject({ error: { message: 'The date cannot be after today (2026-11-20 in Europe/Warsaw)' } });
      expect(refused.headers['cache-control']).toBe('no-store');
    });

    it('accepts the lower bound and refuses invalid dates, zones, queries and organizations with 400 and no-store', async () => {
      expect((await read('2000-01-01')).day.localDate).toBe('2000-01-01');
      const cases: Array<[string, Record<string, string>, string?]> = [
        ['1999-12-31', { timeZone: ZONE }],
        ['2026-02-30', { timeZone: ZONE }],
        ['2026-11-5', { timeZone: ZONE }],
        ['today', { timeZone: ZONE }],
        [DAY, {}],
        [DAY, { timeZone: '+01:00' }],
        [DAY, { timeZone: 'Mars/Olympus_Mons' }],
        [DAY, { timeZone: ZONE, extra: 'x' }],
        [DAY, { timeZone: ZONE }, 'not-a-uuid'],
      ];
      for (const [localDate, query, orgId] of cases) {
        const refused = await get(owner, localDate, query, orgId ? { orgId } : {}).expect(400);
        expect(errorCode(refused), `${localDate} ${JSON.stringify(query)} ${orgId ?? ''}`).toBe('INVALID_REQUEST');
        expect(refused.headers['cache-control']).toBe('no-store');
      }
      const repeated = await request(app).get(`${overviewPath(DAY)}?timeZone=${ZONE}&timeZone=UTC`).set('Cookie', owner.cookie).expect(400);
      expect(repeated.headers['cache-control']).toBe('no-store');
    });

    it('marks even a malformed request body error as no-store', async () => {
      const malformed = await request(app).get(overviewPath(DAY)).query({ timeZone: ZONE }).set('Cookie', owner.cookie).type('application/json').send('{"broken"');
      expect(malformed.status).toBe(400);
      expect(malformed.headers['cache-control']).toBe('no-store');
    });
  });
});
