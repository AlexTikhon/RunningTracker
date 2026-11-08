import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiErrorResponseSchema,
  dailyMetricsViewSchema,
  dailyMovementListResponseSchema,
  dailyMovementViewSchema,
  type DailyMovementView,
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
import { createDatabasePool } from '../src/database/database.js';
import { putDailyMovement } from '../src/daily-movement/daily-movement-service.js';
import { createFileDeletionJournalSink } from '../src/maintenance/deletion-journal-sink.js';
import { runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { loadErasureLedger, reapplyErasures } from '../src/restore/reapply-erasures.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0078 over HTTP, with the real runtime role, session, Origin and CSRF checks. The application's injected clock is
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

const full = { activeEnergyKcal: 412.5, steps: 8_042, timeZone: 'Europe/Warsaw' };

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
}

function errorCode(response: request.Response): string {
  expect(response.headers['cache-control']).toBe('no-store');
  return apiErrorResponseSchema.parse(response.body).error.code;
}

describe('ADR-0078 daily movement HTTP API', () => {
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
      WEEKLY_INSIGHTS_PROVIDER: 'off',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-daily-movement-http-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-daily-movement-http-maintenance',
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
    await ownerPool?.query('DELETE FROM daily_movement').catch(() => undefined);
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
    `/api/orgs/${orgId}/daily-movement${localDate === undefined ? '' : `/${localDate}`}`;

  const put = (auth: Authentication, localDate: string, payload: unknown, orgId: string = ids.orgA) =>
    request(app)
      .put(path(orgId, localDate))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send(typeof payload === 'string' ? payload : (payload as object));

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

  const parseView = (response: request.Response): DailyMovementView => {
    expect(response.headers['cache-control']).toBe('no-store');
    return dailyMovementViewSchema.parse(response.body);
  };

  async function storedDays(): Promise<string[]> {
    const result = await ownerPool.query<{ local_date: string; user_id: string }>(
      `SELECT user_id, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM daily_movement ORDER BY org_id, user_id, local_date`,
    );
    return result.rows.map((row) => `${row.user_id.slice(0, 8)}@${row.local_date}`);
  }

  const ownerDay = (date: string) => `${ids.userOrgA.slice(0, 8)}@${date}`;

  const storedVersion = async (date: string, userId: string = ids.userOrgA) =>
    (
      await ownerPool.query<{ created_at: string; id: string; updated_at: string }>(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM daily_movement WHERE user_id = $1 AND local_date = $2`,
        [userId, date],
      )
    ).rows[0];

  describe('create and replace', () => {
    it('creates a day with 201, database timestamps and manual provenance, and reads it back with no-store', async () => {
      const view = parseView(await put(owner, '2026-10-05', full).expect(201));
      expect(view).toEqual({
        activeEnergyKcal: 412.5,
        createdAt: view.createdAt,
        localDate: '2026-10-05',
        source: 'manual',
        steps: 8_042,
        timeZone: 'Europe/Warsaw',
        updatedAt: view.updatedAt,
      });
      // From the database clock, not the injected clock.
      const database = await ownerPool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      expect(Math.abs(Date.parse(view.createdAt) - database.rows[0]!.now.getTime())).toBeLessThan(60_000);
      expect(view.createdAt).not.toBe(now);
      expect(parseView(await read(owner, '2026-10-05').expect(200))).toEqual(view);
    });

    it('replaces the whole day with 200: an omitted value is cleared, the identity, createdAt and zone stay, updatedAt moves', async () => {
      const created = parseView(await put(owner, '2026-10-05', full).expect(201));
      const before = await storedVersion('2026-10-05');
      const replaced = parseView(await put(owner, '2026-10-05', { steps: 9_000, timeZone: 'Europe/Warsaw' }).expect(200));
      expect(replaced).toEqual({ ...created, activeEnergyKcal: null, steps: 9_000, updatedAt: replaced.updatedAt });
      expect(Date.parse(replaced.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
      expect((await storedVersion('2026-10-05'))!.id).toBe(before!.id);
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
    });

    it('keeps a recorded zero apart from a missing value, in both directions', async () => {
      const zeroSteps = parseView(await put(owner, '2026-10-05', { steps: 0, timeZone: 'UTC' }).expect(201));
      expect(zeroSteps).toMatchObject({ activeEnergyKcal: null, steps: 0 });
      const zeroEnergy = parseView(await put(owner, '2026-10-05', { activeEnergyKcal: 0, steps: null, timeZone: 'UTC' }).expect(200));
      expect(zeroEnergy).toMatchObject({ activeEnergyKcal: 0, steps: null });
      const stored = await ownerPool.query<{ active_energy_kcal: string | null; steps: number | null }>(
        `SELECT steps, active_energy_kcal::text FROM daily_movement WHERE local_date = '2026-10-05'`,
      );
      expect(stored.rows).toEqual([{ active_energy_kcal: '0.0', steps: null }]);
      const listed = dailyMovementListResponseSchema.parse((await list(owner, { from: '2026-10-05', to: '2026-10-05' }).expect(200)).body);
      expect(listed.items[0]).toMatchObject({ activeEnergyKcal: 0, steps: null });
    });

    it('answers an exact retry with 200 and changes nothing, not even updatedAt (naturally idempotent)', async () => {
      const created = await put(owner, '2026-10-05', full).expect(201);
      const before = await storedVersion('2026-10-05');
      const retry = await put(owner, '2026-10-05', full).expect(200);
      expect(retry.body).toEqual(created.body);
      // Omitted and null are the same value; 412.50 and 412.5 are one number.
      expect((await put(owner, '2026-10-05', '{"steps":8042,"activeEnergyKcal":412.50,"timeZone":"Europe/Warsaw"}').expect(200)).body).toEqual(
        created.body,
      );
      const withNull = await put(owner, '2026-10-06', { activeEnergyKcal: null, steps: 10, timeZone: 'UTC' }).expect(201);
      expect((await put(owner, '2026-10-06', { steps: 10, timeZone: 'UTC' }).expect(200)).body).toEqual(withNull.body);
      expect(await storedVersion('2026-10-05')).toEqual(before);
    });

    it('keeps the zone of the first write when a later replacement is sent from another zone', async () => {
      await put(owner, '2026-10-05', { steps: 1, timeZone: 'Europe/Warsaw' }).expect(201);
      const later = parseView(await put(owner, '2026-10-05', { steps: 2, timeZone: 'America/New_York' }).expect(200));
      expect(later).toMatchObject({ steps: 2, timeZone: 'Europe/Warsaw' });
      const other = parseView(await put(owner, '2026-10-04', { steps: 3, timeZone: 'america/new_york' }).expect(201));
      expect(other.timeZone).toBe('America/New_York');
      expect(parseView(await read(owner, '2026-10-05').expect(200)).timeZone).toBe('Europe/Warsaw');
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
        const a = await putDailyMovement(first, session, ids.orgA, '2026-10-05', { steps: 1, timeZone: 'UTC' }, systemClock);
        expect(a.created).toBe(true);
        const racing = putDailyMovement(second, session, ids.orgA, '2026-10-05', { activeEnergyKcal: 5, timeZone: 'UTC' }, systemClock);
        // The second statement waits on the unique key until the first commits.
        let settled = false;
        void racing.then(() => (settled = true), () => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(settled).toBe(false);
        await first.query('COMMIT');
        const b = await racing;
        await second.query('COMMIT');
        expect(b.created).toBe(false);
        expect(b.view).toMatchObject({ activeEnergyKcal: 5, createdAt: a.view.createdAt, steps: null });
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
    });

    it('settles concurrent identical HTTP writes to one row and one creation', async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, () => put(owner, '2026-10-05', full)));
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(5);
      expect(new Set(responses.map((response) => (response.body as DailyMovementView).createdAt)).size).toBe(1);
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
    });
  });

  describe('values', () => {
    it('requires at least one non-null value', async () => {
      for (const payload of [{ timeZone: 'UTC' }, { activeEnergyKcal: null, steps: null, timeZone: 'UTC' }]) {
        expect(errorCode(await put(owner, '2026-10-05', payload).expect(400))).toBe('INVALID_REQUEST');
      }
      expect(await storedDays()).toEqual([]);
    });

    it('refuses invalid numbers, extra decimals, a source, an owner, unknown fields and a missing or invalid zone', async () => {
      for (const payload of [
        { steps: -1, timeZone: 'UTC' },
        { steps: 200_001, timeZone: 'UTC' },
        { steps: 10.5, timeZone: 'UTC' },
        { steps: '100', timeZone: 'UTC' },
        { activeEnergyKcal: -0.5, timeZone: 'UTC' },
        { activeEnergyKcal: 20_000.1, timeZone: 'UTC' },
        { activeEnergyKcal: 412.55, timeZone: 'UTC' },
        { activeEnergyKcal: '412.5', timeZone: 'UTC' },
        { steps: 100 },
        { steps: 100, timeZone: '+01:00' },
        { steps: 100, timeZone: 'Mars/Olympus' },
        { source: 'manual', steps: 100, timeZone: 'UTC' },
        { source: 'apple_health', steps: 100, timeZone: 'UTC' },
        { steps: 100, timeZone: 'UTC', userId: ids.userStranger },
        { orgId: ids.orgB, steps: 100, timeZone: 'UTC' },
        { localDate: '2026-10-04', steps: 100, timeZone: 'UTC' },
        { restingEnergyKcal: 1_500, steps: 100, timeZone: 'UTC' },
        [{ steps: 100, timeZone: 'UTC' }],
      ]) {
        expect(errorCode(await put(owner, '2026-10-05', payload).expect(400))).toBe('INVALID_REQUEST');
      }
      // JSON has no NaN or Infinity, but 1e309 parses to Infinity: refused too.
      for (const raw of ['{"steps":1e309,"timeZone":"UTC"}', '{"activeEnergyKcal":1e309,"timeZone":"UTC"}', '{"activeEnergyKcal":-1e309,"timeZone":"UTC"}']) {
        expect(errorCode(await put(owner, '2026-10-05', raw).expect(400))).toBe('INVALID_REQUEST');
      }
      expect(await storedDays()).toEqual([]);
    });

    it('accepts the inclusive bounds and stores active energy exactly', async () => {
      const low = parseView(await put(owner, '2026-10-04', { activeEnergyKcal: 0, steps: 0, timeZone: 'UTC' }).expect(201));
      expect(low).toMatchObject({ activeEnergyKcal: 0, steps: 0 });
      const high = parseView(await put(owner, '2026-10-05', { activeEnergyKcal: 20_000, steps: 200_000, timeZone: 'UTC' }).expect(201));
      expect(high).toMatchObject({ activeEnergyKcal: 20_000, steps: 200_000 });
      const tenth = parseView(await put(owner, '2026-10-03', { activeEnergyKcal: 0.1, timeZone: 'UTC' }).expect(201));
      expect(tenth.activeEnergyKcal).toBe(0.1);
    });

    it('refuses a non-JSON or malformed body, with no-store on the error', async () => {
      const textual = await request(app)
        .put(path(ids.orgA, '2026-10-05'))
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .type('text/plain')
        .send('steps=3');
      expect(textual.status).toBe(415);
      expect(errorCode(textual)).toBe('UNSUPPORTED_MEDIA_TYPE');
      // The JSON parser runs before the router: the no-store header is mounted ahead of it.
      expect(errorCode(await put(owner, '2026-10-05', '{"steps":').expect(400))).toBe('INVALID_REQUEST');
      expect(await storedDays()).toEqual([]);
    });
  });

  describe('the local date', () => {
    it('refuses malformed dates and dates before 2000-01-01 on every operation, and accepts 2000-01-01', async () => {
      for (const localDate of ['1999-12-31', '2026-02-29', '2026-02-30', '2026-10-5', 'today', '2026-13-01']) {
        expect(errorCode(await put(owner, localDate, { steps: 3, timeZone: 'UTC' }).expect(400))).toBe('INVALID_REQUEST');
        expect(errorCode(await read(owner, localDate).expect(400))).toBe('INVALID_REQUEST');
        expect(errorCode(await remove(owner, localDate).expect(400))).toBe('INVALID_REQUEST');
      }
      await put(owner, '2000-01-01', { steps: 3, timeZone: 'UTC' }).expect(201);
      await put(owner, '2024-02-29', { steps: 3, timeZone: 'UTC' }).expect(201);
    });

    it('refuses a date after today in the given zone by the injected clock, and accepts today', async () => {
      now = '2026-10-06T10:00:00.000Z';
      const refused = await put(owner, '2026-10-07', { steps: 3, timeZone: 'UTC' }).expect(400);
      expect(errorCode(refused)).toBe('INVALID_REQUEST');
      expect(apiErrorResponseSchema.parse(refused.body).error.message).toContain('2026-10-06');
      expect(errorCode(await put(owner, '2027-01-01', { steps: 3, timeZone: 'UTC' }).expect(400))).toBe('INVALID_REQUEST');
      expect(await storedDays()).toEqual([]);
      await put(owner, '2026-10-06', { steps: 3, timeZone: 'UTC' }).expect(201);
    });

    it('moves "today" at local midnight around the Warsaw spring-forward change (UTC+1 to UTC+2 on 29 March 2026)', async () => {
      now = '2026-03-28T22:59:59.999Z'; // 23:59:59.999 on 28 March in Warsaw (UTC+1)
      expect(errorCode(await put(owner, '2026-03-29', { steps: 1, timeZone: 'Europe/Warsaw' }).expect(400))).toBe('INVALID_REQUEST');
      now = '2026-03-28T23:00:00.000Z'; // 00:00 on 29 March, the 23-hour day
      await put(owner, '2026-03-29', { steps: 1, timeZone: 'Europe/Warsaw' }).expect(201);
      now = '2026-03-29T21:59:59.999Z'; // 23:59:59.999 on 29 March, now UTC+2
      expect(errorCode(await put(owner, '2026-03-30', { steps: 1, timeZone: 'Europe/Warsaw' }).expect(400))).toBe('INVALID_REQUEST');
      now = '2026-03-29T22:00:00.000Z';
      await put(owner, '2026-03-30', { steps: 1, timeZone: 'Europe/Warsaw' }).expect(201);
      expect(await storedDays()).toEqual([ownerDay('2026-03-29'), ownerDay('2026-03-30')]);
    });

    it('moves "today" at local midnight around the New York fall-back change (UTC-4 to UTC-5 on 1 November 2026)', async () => {
      now = '2026-11-01T03:59:59.999Z'; // 23:59:59.999 on 31 October in New York (UTC-4)
      expect(errorCode(await put(owner, '2026-11-01', { steps: 1, timeZone: 'America/New_York' }).expect(400))).toBe('INVALID_REQUEST');
      now = '2026-11-01T04:00:00.000Z'; // 00:00 on 1 November, the 25-hour day
      await put(owner, '2026-11-01', { steps: 1, timeZone: 'America/New_York' }).expect(201);
      now = '2026-11-02T04:59:59.999Z'; // 23:59:59.999 on 1 November, now UTC-5
      expect(errorCode(await put(owner, '2026-11-02', { steps: 1, timeZone: 'America/New_York' }).expect(400))).toBe('INVALID_REQUEST');
      now = '2026-11-02T05:00:00.000Z';
      await put(owner, '2026-11-02', { steps: 1, timeZone: 'America/New_York' }).expect(201);
    });

    it('decides "today" in the zone sent: the same instant is a different date at UTC+14 and UTC-11', async () => {
      now = '2026-10-06T10:30:00.000Z'; // 00:30 on 7 October at UTC+14, 23:30 on 5 October at UTC-11
      await put(owner, '2026-10-07', { steps: 1, timeZone: 'Pacific/Kiritimati' }).expect(201);
      expect(errorCode(await put(owner, '2026-10-06', { steps: 1, timeZone: 'Pacific/Pago_Pago' }).expect(400))).toBe('INVALID_REQUEST');
      await put(owner, '2026-10-05', { steps: 1, timeZone: 'Pacific/Pago_Pago' }).expect(201);
    });
  });

  describe('reading', () => {
    it('answers 404 DAILY_MOVEMENT_NOT_FOUND for a day without a record and refuses query parameters', async () => {
      expect(errorCode(await read(owner, '2026-10-05').expect(404))).toBe('DAILY_MOVEMENT_NOT_FOUND');
      await put(owner, '2026-10-05', full).expect(201);
      const withQuery = await request(app).get(`${path(ids.orgA, '2026-10-05')}?userId=${ids.userStranger}`).set('Cookie', owner.cookie).expect(400);
      expect(errorCode(withQuery)).toBe('INVALID_REQUEST');
    });

    it('lists only the days with a record in an inclusive range, ascending, with no-store', async () => {
      for (const date of ['2026-07-01', '2026-08-15', '2026-09-30', '2026-10-01']) {
        await put(owner, date, { steps: 3, timeZone: 'UTC' }).expect(201);
      }
      const response = await list(owner, { from: '2026-07-01', to: '2026-09-30' }).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const parsed = dailyMovementListResponseSchema.parse(response.body);
      expect(parsed.items.map((item) => item.localDate)).toEqual(['2026-07-01', '2026-08-15', '2026-09-30']);
      expect(parsed.items.every((item) => item.source === 'manual')).toBe(true);
      const empty = dailyMovementListResponseSchema.parse((await list(owner, { from: '2026-06-01', to: '2026-06-30' }).expect(200)).body);
      expect(empty.items).toEqual([]);
    });

    it('allows at most 92 days per request, like daily metrics, and refuses a reversed, open, malformed or extended range', async () => {
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
        { from: '2026-10-01', source: 'manual', to: '2026-10-05' },
      ]) {
        expect(errorCode(await list(owner, query).expect(400))).toBe('INVALID_REQUEST');
      }
    });

    it('requires a session for reads, with no-store on the refusal', async () => {
      expect(errorCode(await request(app).get(path(ids.orgA)).query({ from: '2026-10-01', to: '2026-10-05' }).expect(401))).toBe(
        'AUTH_REQUIRED',
      );
      expect(errorCode(await request(app).get(path(ids.orgA, '2026-10-05')).expect(401))).toBe('AUTH_REQUIRED');
    });
  });

  describe('cross-person isolation', () => {
    it('shows nothing of the owner to another member, a run-sharing grantee or another organization\'s member', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      const range = { from: '2026-10-01', to: '2026-10-06' };
      // userStranger: a coach member of org A without grants; userDual: holds history and live grants on the owner's runs.
      for (const auth of [coach, grantee]) {
        expect(dailyMovementListResponseSchema.parse((await list(auth, range).expect(200)).body).items).toEqual([]);
        expect(errorCode(await read(auth, '2026-10-05').expect(404))).toBe('DAILY_MOVEMENT_NOT_FOUND');
      }
      expect(dailyMovementListResponseSchema.parse((await list(grantee, range, ids.orgB).expect(200)).body).items).toEqual([]);
      expect(errorCode(await list(outsider, range).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await read(outsider, '2026-10-05').expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await put(outsider, '2026-10-05', full).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await remove(outsider, '2026-10-05').expect(403))).toBe('ORG_ACCESS_DENIED');
    });

    it("writes another member's PUT to their own day and never touches or deletes the owner's", async () => {
      const ownerView = (await put(owner, '2026-10-05', full).expect(201)).body as DailyMovementView;
      const coachView = parseView(await put(coach, '2026-10-05', { steps: 1, timeZone: 'UTC' }).expect(201));
      expect(coachView).toMatchObject({ activeEnergyKcal: null, steps: 1 });
      expect((await read(owner, '2026-10-05').expect(200)).body).toEqual(ownerView);
      await remove(coach, '2026-10-05').expect(204);
      await remove(grantee, '2026-10-05').expect(204);
      expect((await read(owner, '2026-10-05').expect(200)).body).toEqual(ownerView);
      expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
    });
  });

  describe('session, Origin and CSRF', () => {
    it('refuses a write or delete without a session, a known Origin or a valid CSRF token, and changes nothing', async () => {
      await put(owner, '2026-10-04', full).expect(201);
      const target = path(ids.orgA, '2026-10-05');
      expect(errorCode(await request(app).put(target).set('Origin', allowedOrigin).type('application/json').send(full).expect(401))).toBe(
        'AUTH_REQUIRED',
      );
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

  describe('separate from check-ins, insights and the weekly review', () => {
    it('leaves the check-in of the same day, its full-replacement contract and the weekly review as they are', async () => {
      const checkIn = { mood: 4, note: 'Fine', sleepMinutes: 420, sleepQuality: 3, soreness: 1, timeZone: 'UTC', weightKg: 70 };
      const day = dailyMetricsViewSchema.parse(
        (
          await request(app)
            .put(`/api/orgs/${ids.orgA}/daily-metrics/2026-10-05`)
            .set('Cookie', owner.cookie)
            .set('Origin', allowedOrigin)
            .set(csrfHeaderName, owner.csrfToken)
            .type('application/json')
            .send(checkIn)
            .expect(201)
        ).body,
      );
      const review = () =>
        request(app)
          .get(`/api/orgs/${ids.orgA}/weekly-review`)
          .query({ timeZone: 'UTC', weekStart: '2026-10-05' })
          .set('Cookie', owner.cookie)
          .expect(200)
          .then((response) => response.body as unknown);
      const reviewBefore = await review();
      const insightState = async () =>
        (
          await ownerPool.query<{ gates: string; insights: string }>(
            `SELECT (SELECT count(*) FROM weekly_insights)::text AS insights,
                    coalesce((SELECT string_agg(revision::text, ',') FROM weekly_insight_source_gates), '') AS gates`,
          )
        ).rows[0];
      const insightsBefore = await insightState();

      await put(owner, '2026-10-05', full).expect(201);
      await put(owner, '2026-10-05', { steps: 1, timeZone: 'UTC' }).expect(200);
      await put(owner, '2026-10-06', full).expect(201);
      await remove(owner, '2026-10-06').expect(204);

      const stillThere = await request(app).get(`/api/orgs/${ids.orgA}/daily-metrics/2026-10-05`).set('Cookie', owner.cookie).expect(200);
      expect(stillThere.body).toEqual(day);
      expect(stillThere.body).not.toHaveProperty('steps');
      expect(await review()).toEqual(reviewBefore);
      expect(await insightState()).toEqual(insightsBefore);

      // Deleting the check-in leaves the movement of that day.
      await request(app)
        .delete(`/api/orgs/${ids.orgA}/daily-metrics/2026-10-05`)
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .expect(204);
      expect(parseView(await read(owner, '2026-10-05').expect(200))).toMatchObject({ steps: 1 });
    });
  });

  describe('deleting, the erasure ledger and restore', () => {
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

    it('deletes with 204, records the exact version in the ledger, and answers repeats and future dates with 204', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      const version = await storedVersion('2026-10-05');
      const deleted = await remove(owner, '2026-10-05').expect(204);
      expect(deleted.headers['cache-control']).toBe('no-store');
      expect(errorCode(await read(owner, '2026-10-05').expect(404))).toBe('DAILY_MOVEMENT_NOT_FOUND');
      expect(await ledger()).toEqual([
        { entity_type: 'daily_movement', owner_user_id: ids.userOrgA, record_created_at: version!.created_at, record_id: version!.id },
      ]);
      await remove(owner, '2026-10-05').expect(204);
      await remove(owner, '2099-01-01').expect(204);
      expect(await ledger()).toHaveLength(1);
    });

    it('fails the delete with 500 and keeps the day when the ledger cannot be written (deletion and outbox are atomic)', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      await ownerPool.query('ALTER TABLE erasure_ledger ADD CONSTRAINT test_refuse_movement_http CHECK (false) NOT VALID');
      try {
        expect(errorCode(await remove(owner, '2026-10-05').expect(500))).toBe('INTERNAL_ERROR');
        expect(await storedDays()).toEqual([ownerDay('2026-10-05')]);
      } finally {
        await ownerPool.query('ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS test_refuse_movement_http');
      }
      expect(await ledger()).toEqual([]);
      await remove(owner, '2026-10-05').expect(204);
      expect(await storedDays()).toEqual([]);
    });

    it('exports erasures, and replaying them on a restored copy erases the exported deletions; a second replay is a no-op', async () => {
      await put(owner, '2026-10-03', full).expect(201);
      await put(owner, '2026-10-04', { steps: 2, timeZone: 'UTC' }).expect(201);
      await put(owner, '2026-10-05', { activeEnergyKcal: 0, timeZone: 'UTC' }).expect(201);
      // "The backup": every row as stored before the deletions.
      const backup = await ownerPool.query<{ local_date: string; row: string }>(
        `SELECT local_date::text AS local_date, row_to_json(movement)::text AS row FROM daily_movement AS movement ORDER BY local_date`,
      );
      const recreatedBefore = await storedVersion('2026-10-05');
      await remove(owner, '2026-10-03').expect(204);
      await remove(owner, '2026-10-05').expect(204);
      // Deleted and written again after the erasure: a new version.
      const rewritten = parseView(await put(owner, '2026-10-05', { steps: 5, timeZone: 'UTC' }).expect(201));
      const recreated = await storedVersion('2026-10-05');
      expect(recreated!.id).not.toBe(recreatedBefore!.id);
      expect(recreated!.created_at).not.toBe(recreatedBefore!.created_at);

      const directory = await mkdtemp(join(tmpdir(), 'rt-movement-erasure-'));
      directories.push(directory);
      await runErasureLedgerExportOnce(maintenancePool, createFileDeletionJournalSink(directory), systemClock);
      expect(await ledger()).toEqual([]);
      const journal = await loadErasureLedger(directory);
      expect(journal.entries.map((entry) => entry.entityType)).toEqual(['daily_movement', 'daily_movement']);

      // As after a restore: the backup's 2026-10-03 is back with its original identity; 2026-10-05 now holds the newer
      // version, which the backup cannot overwrite (it is the same natural key), so only the old 10-03 returns.
      const erasedRow = backup.rows.find((row) => row.local_date === '2026-10-03')!.row;
      await ownerPool.query(
        `INSERT INTO daily_movement (org_id, id, user_id, local_date, source, time_zone, steps, active_energy_kcal, created_at, updated_at)
         SELECT org_id, id, user_id, local_date, source, time_zone, steps, active_energy_kcal, created_at, updated_at
         FROM json_populate_record(NULL::daily_movement, $1::json)`,
        [erasedRow],
      );
      expect(await storedDays()).toEqual([ownerDay('2026-10-03'), ownerDay('2026-10-04'), ownerDay('2026-10-05')]);

      const first = await reapplyErasures(ownerPool, journal);
      expect(first.outcomes).toEqual({ absent: 1, erased: 1, skipped_different_record: 0 });
      expect(await storedDays()).toEqual([ownerDay('2026-10-04'), ownerDay('2026-10-05')]);
      expect(parseView(await read(owner, '2026-10-05').expect(200))).toEqual(rewritten);
      const second = await reapplyErasures(ownerPool, journal);
      expect(second.outcomes).toEqual({ absent: 2, erased: 0, skipped_different_record: 0 });
      expect(await storedDays()).toEqual([ownerDay('2026-10-04'), ownerDay('2026-10-05')]);
    });

    it('an old erasure cannot delete a recreated day even when a restored copy carries the old id with the new day', async () => {
      await put(owner, '2026-10-05', full).expect(201);
      const erased = (await storedVersion('2026-10-05'))!;
      await remove(owner, '2026-10-05').expect(204);
      const directory = await mkdtemp(join(tmpdir(), 'rt-movement-erasure-'));
      directories.push(directory);
      await runErasureLedgerExportOnce(maintenancePool, createFileDeletionJournalSink(directory), systemClock);
      const journal = await loadErasureLedger(directory);
      // A record under the erased id but created at another instant (the id reused) is a different version.
      await ownerPool.query(
        `INSERT INTO daily_movement (org_id, id, user_id, local_date, time_zone, steps, created_at)
         VALUES ($1, $2, $3, '2026-10-05', 'UTC', 9, $4::timestamptz + interval '1 microsecond')`,
        [ids.orgA, erased.id, ids.userOrgA, erased.created_at],
      );
      const outcome = await reapplyErasures(ownerPool, journal);
      expect(outcome.outcomes).toEqual({ absent: 0, erased: 0, skipped_different_record: 1 });
      expect(parseView(await read(owner, '2026-10-05').expect(200)).steps).toBe(9);
    });
  });
});
