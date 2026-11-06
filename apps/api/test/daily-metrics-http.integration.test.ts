import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiErrorResponseSchema,
  dailyMetricsListResponseSchema,
  dailyMetricsViewSchema,
  type DailyMetricsView,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock, type Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { putDailyMetrics } from '../src/daily-metrics/daily-metrics-service.js';
import { createDatabasePool } from '../src/database/database.js';
import { createFileDeletionJournalSink } from '../src/maintenance/deletion-journal-sink.js';
import { runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { loadErasureLedger, reapplyErasures } from '../src/restore/reapply-erasures.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0074 over HTTP, with the real runtime role, session, Origin and CSRF checks. The application's injected clock is
// set per test, so "today in the person's zone" is exact; the session manager keeps its own fixed clock.
const allowedOrigin = 'http://127.0.0.1:5173';
const defaultNow = '2026-10-06T10:00:00.000Z';
let now = defaultNow;

class SettableClock implements Clock {
  public constructor(private readonly read: () => string) {}

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse(this.read());
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.read());
  }
}

interface Authentication {
  cookie: string;
  csrfToken: string;
}

const full = {
  mood: 4,
  note: 'Slept well',
  sleepMinutes: 450,
  sleepQuality: 4,
  soreness: 2,
  timeZone: 'Europe/Warsaw',
  weightKg: 72.35,
};

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

function errorCode(response: request.Response): string {
  return apiErrorResponseSchema.parse(response.body).error.code;
}

describe('ADR-0074 daily metrics HTTP API', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let maintenancePool: Pool;
  let owner: Authentication;
  let coach: Authentication;
  let grantee: Authentication;
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
      LOCAL_AUTH_USER_IDS: [ids.userOrgA, ids.userStranger, ids.userDual, ids.userOrgB].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-daily-metrics-http-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-daily-metrics-http-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 1,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    const sessionClock = new SettableClock(() => defaultNow);
    app = createApp({
      clock: new SettableClock(() => now),
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock: sessionClock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      }),
    });
    owner = await login(ids.userOrgA);
    coach = await login(ids.userStranger);
    grantee = await login(ids.userDual);
    outsider = await login(ids.userOrgB);
  });

  beforeEach(async () => {
    now = defaultNow;
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM daily_metrics').catch(() => undefined);
    await ownerPool?.query('DELETE FROM erasure_ledger').catch(() => undefined);
    for (const directory of directories) await rm(directory, { force: true, recursive: true });
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  async function login(userId: string): Promise<Authentication> {
    const response = await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId })
      .expect(201);
    const csrf = (response.body as { csrf: { token: string } }).csrf;
    return { cookie: cookiePair(response), csrfToken: csrf.token };
  }

  const path = (orgId: string, localDate?: string) =>
    `/api/orgs/${orgId}/daily-metrics${localDate === undefined ? '' : `/${localDate}`}`;

  const put = (auth: Authentication, localDate: string, payload: unknown, orgId: string = ids.orgA) =>
    request(app)
      .put(path(orgId, localDate))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send(payload as object);

  const remove = (auth: Authentication, localDate: string, orgId: string = ids.orgA) =>
    request(app)
      .delete(path(orgId, localDate))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken);

  const read = (auth: Authentication, localDate: string, orgId: string = ids.orgA) =>
    request(app).get(path(orgId, localDate)).set('Cookie', auth.cookie);

  const list = (auth: Authentication, query: Record<string, string>, orgId: string = ids.orgA) =>
    request(app).get(path(orgId)).query(query).set('Cookie', auth.cookie);

  async function storedDays(): Promise<string[]> {
    const result = await ownerPool.query<{ local_date: string; user_id: string }>(
      `SELECT user_id, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM daily_metrics ORDER BY org_id, user_id, local_date`,
    );
    return result.rows.map((row) => `${row.user_id.slice(0, 8)}@${row.local_date}`);
  }

  const ownerDay = (date: string) => `${ids.userOrgA.slice(0, 8)}@${date}`;

  describe('create and replace', () => {
    it('creates a day with 201 and database timestamps, and reads it back with no-store', async () => {
      const created = await put(owner, '2026-10-05', full).expect(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const view = dailyMetricsViewSchema.parse(created.body);
      const { timeZone, ...values } = full;
      expect(view).toEqual({ ...values, createdAt: view.createdAt, localDate: '2026-10-05', timeZone, updatedAt: view.updatedAt });
      // From the database clock, not the injected clock.
      const database = await ownerPool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      expect(Math.abs(Date.parse(view.createdAt) - database.rows[0]!.now.getTime())).toBeLessThan(60_000);
      expect(view.createdAt).not.toBe(now);

      const fetched = await read(owner, '2026-10-05').expect(200);
      expect(fetched.headers['cache-control']).toBe('no-store');
      expect(fetched.body).toEqual(created.body);
    });

    it('replaces the whole day with 200: omitted fields are cleared, createdAt and the zone stay, updatedAt moves', async () => {
      const created = dailyMetricsViewSchema.parse((await put(owner, '2026-10-05', full).expect(201)).body);
      const replaced = dailyMetricsViewSchema.parse(
        (await put(owner, '2026-10-05', { mood: 2, timeZone: 'Europe/Warsaw', weightKg: 72.1 }).expect(200)).body,
      );
      expect(replaced).toEqual({
        createdAt: created.createdAt,
        localDate: '2026-10-05',
        mood: 2,
        note: null,
        sleepMinutes: null,
        sleepQuality: null,
        soreness: null,
        timeZone: 'Europe/Warsaw',
        updatedAt: replaced.updatedAt,
        weightKg: 72.1,
      });
      expect(Date.parse(replaced.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
    });

    it('answers an exact retry with 200 and changes nothing, not even updatedAt (naturally idempotent)', async () => {
      const created = await put(owner, '2026-10-05', full).expect(201);
      const retry = await put(owner, '2026-10-05', full).expect(200);
      expect(retry.body).toEqual(created.body);
      // Omitted and null are the same value; 72.35 and 72.350 are one number.
      const spelled = await put(owner, '2026-10-05', { ...full, weightKg: 72.35 }).expect(200);
      expect(spelled.body).toEqual(created.body);
    });

    it('keeps the zone of the first write when a later replacement is sent from another zone', async () => {
      await put(owner, '2026-10-05', { mood: 3, timeZone: 'Europe/Warsaw' }).expect(201);
      const later = dailyMetricsViewSchema.parse((await put(owner, '2026-10-05', { mood: 4, timeZone: 'America/New_York' }).expect(200)).body);
      expect(later).toMatchObject({ mood: 4, timeZone: 'Europe/Warsaw' });
      // A new day written from the new zone stores the new zone; the old day is not rewritten.
      const other = dailyMetricsViewSchema.parse((await put(owner, '2026-10-04', { mood: 1, timeZone: 'america/new_york' }).expect(201)).body);
      expect(other.timeZone).toBe('America/New_York');
      expect(dailyMetricsViewSchema.parse((await read(owner, '2026-10-05').expect(200)).body).timeZone).toBe('Europe/Warsaw');
    });

    it('settles two interleaved first writes of one day to a single row holding the later values', async () => {
      const session = { userId: ids.userOrgA };
      const begin = async () => {
        const client = await runtimePool.connect();
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ids.userOrgA, ids.orgA]);
        return client;
      };
      const first = await begin();
      const second = await begin();
      try {
        const a = await putDailyMetrics(first, session, ids.orgA, '2026-10-05', { mood: 1, timeZone: 'UTC' }, systemClock);
        expect(a.created).toBe(true);
        const racing = putDailyMetrics(second, session, ids.orgA, '2026-10-05', { mood: 5, timeZone: 'UTC' }, systemClock);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await first.query('COMMIT');
        const b = await racing;
        await second.query('COMMIT');
        expect(b.created).toBe(false);
        expect(b.view).toMatchObject({ createdAt: a.view.createdAt, mood: 5 });
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
    });
  });

  describe('values', () => {
    it('requires at least one non-null value, and accepts a single zero', async () => {
      for (const payload of [
        { timeZone: 'UTC' },
        { mood: null, note: null, sleepMinutes: null, sleepQuality: null, soreness: null, timeZone: 'UTC', weightKg: null },
      ]) {
        expect(errorCode(await put(owner, '2026-10-05', payload).expect(400))).toBe('INVALID_REQUEST');
      }
      expect(await storedDays()).toEqual([]);
      await put(owner, '2026-10-05', { soreness: 0, timeZone: 'UTC' }).expect(201);
      await put(owner, '2026-10-04', { sleepMinutes: 0, timeZone: 'UTC' }).expect(201);
    });

    it('refuses out-of-range values, extra decimals, unknown fields and a missing or invalid zone, and stores nothing', async () => {
      for (const payload of [
        { timeZone: 'UTC', weightKg: 19.99 },
        { timeZone: 'UTC', weightKg: 400.01 },
        { timeZone: 'UTC', weightKg: 72.355 },
        { sleepMinutes: 1_441, timeZone: 'UTC' },
        { sleepMinutes: -1, timeZone: 'UTC' },
        { sleepQuality: 0, timeZone: 'UTC' },
        { mood: 6, timeZone: 'UTC' },
        { soreness: 11, timeZone: 'UTC' },
        { mood: 2.5, timeZone: 'UTC' },
        { note: 'x'.repeat(501), timeZone: 'UTC' },
        { note: '', timeZone: 'UTC' },
        { mood: 3 },
        { mood: 3, timeZone: '+01:00' },
        { mood: 3, timeZone: 'Mars/Olympus' },
        { mood: 3, timeZone: 'UTC', userId: ids.userStranger },
        { mood: 3, timeZone: 'UTC', localDate: '2026-10-04' },
      ]) {
        expect(errorCode(await put(owner, '2026-10-05', payload).expect(400))).toBe('INVALID_REQUEST');
      }
      expect(await storedDays()).toEqual([]);
    });

    it('accepts the inclusive bounds and stores weight exactly', async () => {
      const low = dailyMetricsViewSchema.parse(
        (await put(owner, '2026-10-04', { mood: 1, note: 'x', sleepMinutes: 0, sleepQuality: 1, soreness: 0, timeZone: 'UTC', weightKg: 20 }).expect(201)).body,
      );
      expect(low.weightKg).toBe(20);
      const high = dailyMetricsViewSchema.parse(
        (await put(owner, '2026-10-05', { mood: 5, note: 'x'.repeat(500), sleepMinutes: 1_440, sleepQuality: 5, soreness: 10, timeZone: 'UTC', weightKg: 400 }).expect(201)).body,
      );
      expect(high.weightKg).toBe(400);
      const exact = await ownerPool.query<{ weight_kg: string }>(
        `SELECT weight_kg::text FROM daily_metrics WHERE local_date = '2026-10-04'`,
      );
      expect(exact.rows).toEqual([{ weight_kg: '20.00' }]);
    });

    it('refuses a non-JSON body', async () => {
      await request(app)
        .put(path(ids.orgA, '2026-10-05'))
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .type('text/plain')
        .send('mood=3')
        .expect(415);
      expect(await storedDays()).toEqual([]);
    });
  });

  describe('the local date', () => {
    it('refuses malformed dates and dates before 2000-01-01, and accepts 2000-01-01', async () => {
      for (const localDate of ['1999-12-31', '2026-02-30', '2026-10-5', 'today', '2026-13-01']) {
        expect(errorCode(await put(owner, localDate, { mood: 3, timeZone: 'UTC' }).expect(400))).toBe('INVALID_REQUEST');
        expect(errorCode(await read(owner, localDate).expect(400))).toBe('INVALID_REQUEST');
        expect(errorCode(await remove(owner, localDate).expect(400))).toBe('INVALID_REQUEST');
      }
      await put(owner, '2000-01-01', { mood: 3, timeZone: 'UTC' }).expect(201);
    });

    it('refuses a date after today in the given zone by the injected clock, and accepts today', async () => {
      now = '2026-10-06T10:00:00.000Z';
      const refused = await put(owner, '2026-10-07', { mood: 3, timeZone: 'UTC' }).expect(400);
      expect(errorCode(refused)).toBe('INVALID_REQUEST');
      expect(apiErrorResponseSchema.parse(refused.body).error.message).toContain('2026-10-06');
      expect(errorCode(await put(owner, '2027-01-01', { mood: 3, timeZone: 'UTC' }).expect(400))).toBe('INVALID_REQUEST');
      expect(await storedDays()).toEqual([]);
      await put(owner, '2026-10-06', { mood: 3, timeZone: 'UTC' }).expect(201);
    });

    it('decides "today" in the person\'s zone: just after midnight in Warsaw it is still the evening before in UTC', async () => {
      // 22:30 UTC on 15 July is 00:30 on 16 July in Warsaw (summer time, UTC+2).
      now = '2026-07-15T22:30:00.000Z';
      await put(owner, '2026-07-16', { mood: 3, timeZone: 'Europe/Warsaw' }).expect(201);
      expect(errorCode(await put(owner, '2026-07-16', { mood: 3, timeZone: 'UTC' }).expect(400))).toBe('INVALID_REQUEST');
      // The day already written stays as it was: the refused replacement changed nothing.
      expect(dailyMetricsViewSchema.parse((await read(owner, '2026-07-16').expect(200)).body).timeZone).toBe('Europe/Warsaw');
      await put(owner, '2026-07-15', { mood: 3, timeZone: 'UTC' }).expect(201);
    });

    it('refuses the next Warsaw date one millisecond before Warsaw midnight, late in the Warsaw evening', async () => {
      now = '2026-07-15T21:59:59.999Z'; // 23:59:59.999 on 15 July in Warsaw
      expect(errorCode(await put(owner, '2026-07-16', { mood: 3, timeZone: 'Europe/Warsaw' }).expect(400))).toBe('INVALID_REQUEST');
      await put(owner, '2026-07-15', { mood: 3, timeZone: 'Europe/Warsaw' }).expect(201);
      // In winter Warsaw is UTC+1: 23:00 UTC on 15 January is already 16 January there.
      now = '2026-01-15T23:00:00.000Z';
      await put(owner, '2026-01-16', { mood: 3, timeZone: 'Europe/Warsaw' }).expect(201);
      now = '2026-01-15T22:59:59.999Z';
      expect(errorCode(await put(owner, '2026-01-17', { mood: 3, timeZone: 'Europe/Warsaw' }).expect(400))).toBe('INVALID_REQUEST');
      expect(await storedDays()).toEqual([ownerDay('2026-01-16'), ownerDay('2026-07-15')]);
    });
  });

  describe('reading', () => {
    it('answers 404 DAILY_METRICS_NOT_FOUND for a day without a record and refuses query parameters', async () => {
      expect(errorCode(await read(owner, '2026-10-05').expect(404))).toBe('DAILY_METRICS_NOT_FOUND');
      await put(owner, '2026-10-05', full).expect(201);
      const withQuery = await request(app).get(`${path(ids.orgA, '2026-10-05')}?userId=${ids.userStranger}`).set('Cookie', owner.cookie).expect(400);
      expect(errorCode(withQuery)).toBe('INVALID_REQUEST');
    });

    it('lists only the days with a record in an inclusive range, ascending, with no-store', async () => {
      for (const date of ['2026-07-01', '2026-08-15', '2026-09-30', '2026-10-01']) {
        await put(owner, date, { mood: 3, timeZone: 'UTC' }).expect(201);
      }
      const response = await list(owner, { from: '2026-07-01', to: '2026-09-30' }).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const parsed = dailyMetricsListResponseSchema.parse(response.body);
      expect(parsed.items.map((item: DailyMetricsView) => item.localDate)).toEqual(['2026-07-01', '2026-08-15', '2026-09-30']);
      const single = dailyMetricsListResponseSchema.parse((await list(owner, { from: '2026-10-01', to: '2026-10-01' }).expect(200)).body);
      expect(single.items.map((item) => item.localDate)).toEqual(['2026-10-01']);
      const empty = dailyMetricsListResponseSchema.parse((await list(owner, { from: '2026-06-01', to: '2026-06-30' }).expect(200)).body);
      expect(empty.items).toEqual([]);
    });

    it('allows at most 92 days per request and refuses a reversed, open, malformed or extended range', async () => {
      await list(owner, { from: '2026-07-01', to: '2026-09-30' }).expect(200); // 92 days
      for (const query of [
        { from: '2026-07-01', to: '2026-10-01' }, // 93 days
        { from: '2026-10-06', to: '2026-10-05' },
        { from: '2026-10-01' },
        { to: '2026-10-01' },
        {},
        { from: '1999-12-31', to: '2000-01-01' },
        { from: '2026-10-1', to: '2026-10-05' },
        { from: '2026-10-01', to: '2026-10-05', userId: ids.userStranger },
      ]) {
        expect(errorCode(await list(owner, query).expect(400))).toBe('INVALID_REQUEST');
      }
    });

    it('requires a session for reads', async () => {
      await request(app).get(path(ids.orgA)).query({ from: '2026-10-01', to: '2026-10-05' }).expect(401);
      await request(app).get(path(ids.orgA, '2026-10-05')).expect(401);
    });
  });

  describe('cross-person isolation', () => {
    it('shows nothing of the owner to a coach, a grantee or another organization\'s member', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      const range = { from: '2026-10-01', to: '2026-10-06' };
      for (const auth of [coach, grantee]) {
        expect(dailyMetricsListResponseSchema.parse((await list(auth, range).expect(200)).body).items).toEqual([]);
        expect(errorCode(await read(auth, '2026-10-05').expect(404))).toBe('DAILY_METRICS_NOT_FOUND');
      }
      expect(dailyMetricsListResponseSchema.parse((await list(grantee, range, ids.orgB).expect(200)).body).items).toEqual([]);
      // Not a member of org A at all.
      expect(errorCode(await list(outsider, range).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await read(outsider, '2026-10-05').expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await put(outsider, '2026-10-05', full).expect(403))).toBe('ORG_ACCESS_DENIED');
    });

    it("writes another member's PUT to their own day and never touches the owner's", async () => {
      const ownerView = (await put(owner, '2026-10-05', full).expect(201)).body as DailyMetricsView;
      const coachView = dailyMetricsViewSchema.parse((await put(coach, '2026-10-05', { mood: 1, timeZone: 'UTC' }).expect(201)).body);
      expect(coachView).toMatchObject({ mood: 1, weightKg: null });
      expect((await read(owner, '2026-10-05').expect(200)).body).toEqual(ownerView);
      await remove(coach, '2026-10-05').expect(204);
      await remove(grantee, '2026-10-05').expect(204);
      expect((await read(owner, '2026-10-05').expect(200)).body).toEqual(ownerView);
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
      // Each person's list holds only their own day.
      const coachList = dailyMetricsListResponseSchema.parse((await list(coach, { from: '2026-10-05', to: '2026-10-05' }).expect(200)).body);
      expect(coachList.items).toEqual([]);
    });
  });

  describe('session, Origin and CSRF', () => {
    it('refuses a write or delete without a session, a known Origin or a valid CSRF token, and changes nothing', async () => {
      await put(owner, '2026-10-04', full).expect(201);
      const target = path(ids.orgA, '2026-10-05');
      await request(app).put(target).set('Origin', allowedOrigin).type('application/json').send(full).expect(401);
      expect(errorCode(await request(app).put(target).set('Cookie', owner.cookie).set(csrfHeaderName, owner.csrfToken).type('application/json').send(full).expect(403))).toBe('ORIGIN_DENIED');
      expect(errorCode(await request(app).put(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).type('application/json').send(full).expect(403))).toBe('CSRF_DENIED');
      expect(errorCode(await request(app).put(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, coach.csrfToken).type('application/json').send(full).expect(403))).toBe('CSRF_DENIED');
      const existing = path(ids.orgA, '2026-10-04');
      await request(app).delete(existing).set('Origin', allowedOrigin).expect(401);
      expect(errorCode(await request(app).delete(existing).set('Cookie', owner.cookie).set('Origin', 'http://evil.example').set(csrfHeaderName, owner.csrfToken).expect(403))).toBe('ORIGIN_DENIED');
      expect(errorCode(await request(app).delete(existing).set('Cookie', owner.cookie).set('Origin', allowedOrigin).expect(403))).toBe('CSRF_DENIED');
      expect(await storedDays()).toEqual([ownerDay('2026-10-04')]);
    });
  });

  describe('deleting and the erasure ledger', () => {
    interface LedgerRow {
      entity_type: string;
      owner_user_id: string;
      record_created_at: string;
      record_id: string;
    }
    const ledger = async () =>
      (
        await ownerPool.query<LedgerRow>(
          `SELECT entity_type, owner_user_id, record_id,
                  to_char(record_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS record_created_at
           FROM erasure_ledger ORDER BY ledger_seq`,
        )
      ).rows;
    const storedVersion = async (date: string) =>
      (
        await ownerPool.query<{ created_at: string; id: string }>(
          `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
           FROM daily_metrics WHERE user_id = $1 AND local_date = $2`,
          [ids.userOrgA, date],
        )
      ).rows[0];

    it('deletes with 204, records the exact version in the ledger, and answers repeats and future dates with 204', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      const version = await storedVersion('2026-10-05');
      await remove(owner, '2026-10-05').expect(204);
      expect(errorCode(await read(owner, '2026-10-05').expect(404))).toBe('DAILY_METRICS_NOT_FOUND');
      expect(await ledger()).toEqual([
        { entity_type: 'daily_metric', owner_user_id: ids.userOrgA, record_created_at: version!.created_at, record_id: version!.id },
      ]);
      await remove(owner, '2026-10-05').expect(204);
      await remove(owner, '2099-01-01').expect(204);
      expect(await ledger()).toHaveLength(1);
    });

    it('fails the delete with 500 and keeps the day when the ledger cannot be written', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      await ownerPool.query('ALTER TABLE erasure_ledger ADD CONSTRAINT test_refuse_daily_entry CHECK (false) NOT VALID');
      try {
        expect(errorCode(await remove(owner, '2026-10-05').expect(500))).toBe('INTERNAL_ERROR');
        expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
      } finally {
        await ownerPool.query('ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS test_refuse_daily_entry');
      }
      await remove(owner, '2026-10-05').expect(204);
      expect(await storedDays()).toEqual([]);
    });

    it('starts a day written again after a delete as a new version, which an old erasure leaves alone on replay', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      await put(owner, '2026-10-04', { mood: 2, timeZone: 'UTC' }).expect(201);
      const erasedVersion = await storedVersion('2026-10-05');
      await remove(owner, '2026-10-05').expect(204);
      await remove(owner, '2026-10-04').expect(204);
      const directory = await mkdtemp(join(tmpdir(), 'rt-daily-erasure-'));
      directories.push(directory);
      await runErasureLedgerExportOnce(maintenancePool, createFileDeletionJournalSink(directory), systemClock);
      const journal = await loadErasureLedger(directory);
      expect(journal.entries.map((entry) => entry.entityType)).toEqual(['daily_metric', 'daily_metric']);

      // As after a restore: 2026-10-04 is back exactly as erased; 2026-10-05 was written again after the erasure.
      await ownerPool.query(
        `INSERT INTO daily_metrics (org_id, id, user_id, local_date, time_zone, mood, created_at)
         VALUES ($1, $2, $3, '2026-10-04', 'UTC', 2, $4)`,
        [ids.orgA, journal.entries[1]!.recordId, ids.userOrgA, journal.entries[1]!.recordCreatedAt],
      );
      const rewritten = dailyMetricsViewSchema.parse((await put(owner, '2026-10-05', { mood: 5, timeZone: 'UTC' }).expect(201)).body);
      expect((await storedVersion('2026-10-05'))!.id).not.toBe(erasedVersion!.id);

      const first = await reapplyErasures(ownerPool, journal);
      expect(first.outcomes).toEqual({ absent: 1, erased: 1, skipped_different_record: 0 });
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
      expect((await read(owner, '2026-10-05').expect(200)).body).toEqual(rewritten);
      const second = await reapplyErasures(ownerPool, journal);
      expect(second.outcomes).toEqual({ absent: 2, erased: 0, skipped_different_record: 0 });
    });

    it('skips a record with the erased id but another creation instant or owner', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      const version = (await storedVersion('2026-10-05'))!;
      const outcome = (createdAt: string, ownerId: string) =>
        ownerPool
          .query<{ outcome: string }>(`SELECT app_private.reapply_erasure('daily_metric', $1, $2, $3, $4) AS outcome`, [
            ids.orgA,
            version.id,
            ownerId,
            createdAt,
          ])
          .then((result) => result.rows[0]?.outcome);
      await expect(outcome('2026-01-01T00:00:00.000000Z', ids.userOrgA)).resolves.toBe('skipped_different_record');
      await expect(outcome(version.created_at, ids.userStranger)).resolves.toBe('skipped_different_record');
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
      await expect(outcome(version.created_at, ids.userOrgA)).resolves.toBe('erased');
      expect(await storedDays()).toEqual([]);
    });
  });
});
