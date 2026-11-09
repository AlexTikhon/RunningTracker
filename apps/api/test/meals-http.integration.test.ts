import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apiErrorResponseSchema,
  mealAlreadySavedDetailsSchema,
  mealListResponseSchema,
  mealViewSchema,
  weeklyReviewSchema,
  type MealView,
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
import { createFileDeletionJournalSink } from '../src/maintenance/deletion-journal-sink.js';
import { runErasureLedgerExportOnce } from '../src/maintenance/run-erasure-ledger-export.js';
import { createMeal } from '../src/meals/meal-service.js';
import { loadErasureLedger, reapplyErasures } from '../src/restore/reapply-erasures.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0083 over HTTP, with the real runtime role, session, Origin and CSRF checks. The application's injected clock is
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

const keys = {
  a: '0a000000-0000-4000-8000-00000000000a',
  b: '0b000000-0000-4000-8000-00000000000b',
  c: '0c000000-0000-4000-8000-00000000000c',
  d: '0d000000-0000-4000-8000-00000000000d',
};
const lunch = {
  carbohydrateG: 60,
  energyKcal: 650.5,
  fatG: 0,
  idempotencyKey: keys.a,
  localDate: '2026-10-05',
  mealType: 'lunch',
  proteinG: 30.2,
  timeZone: 'Europe/Warsaw',
  title: 'Chicken and rice',
};
const titleOnly = { idempotencyKey: keys.b, localDate: '2026-10-05', mealType: 'snack', timeZone: 'Europe/Warsaw', title: 'Apple' };

const utcMicroseconds = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

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

describe('ADR-0083 meal log HTTP API', () => {
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
    ownerPool = new Pool({ application_name: 'running-tracker-meals-http-owner', connectionString: integration.migration.connectionString, max: 2 });
    maintenancePool = new Pool({
      application_name: 'running-tracker-meals-http-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 1,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    app = createApp({
      clock: new SettableClock(() => now),
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock: new SettableClock(() => defaultNow),
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
    await ownerPool?.query('DELETE FROM meals').catch(() => undefined);
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

  const path = (orgId: string, mealId?: string) => `/api/orgs/${orgId}/meals${mealId === undefined ? '' : `/${mealId}`}`;

  const create = (auth: Authentication, payload: unknown, orgId: string = ids.orgA) =>
    request(app)
      .post(path(orgId))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send(typeof payload === 'string' ? payload : (payload as object));

  const replace = (auth: Authentication, mealId: string, payload: unknown, orgId: string = ids.orgA) =>
    request(app)
      .put(path(orgId, mealId))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send(typeof payload === 'string' ? payload : (payload as object));

  const remove = (auth: Authentication, mealId: string, orgId: string = ids.orgA) =>
    request(app).delete(path(orgId, mealId)).set('Cookie', auth.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, auth.csrfToken);

  const read = (auth: Authentication, mealId: string, orgId: string = ids.orgA) => request(app).get(path(orgId, mealId)).set('Cookie', auth.cookie);

  const list = (auth: Authentication, query: Record<string, string>, orgId: string = ids.orgA) =>
    request(app).get(path(orgId)).query(query).set('Cookie', auth.cookie);

  const parseView = (response: request.Response): MealView => {
    expect(response.headers['cache-control']).toBe('no-store');
    return mealViewSchema.parse(response.body);
  };

  const storedTitles = async () =>
    (await ownerPool.query<{ title: string; user_id: string }>('SELECT user_id, title FROM meals ORDER BY user_id, created_at, id')).rows.map(
      (row) => `${row.user_id.slice(0, 8)}:${row.title}`,
    );
  const own = (title: string) => `${ids.userOrgA.slice(0, 8)}:${title}`;

  const storedVersion = async (mealId: string) =>
    (
      await ownerPool.query<{ created_at: string; id: string; updated_at: string }>(
        `SELECT id, ${utcMicroseconds('created_at')} AS created_at, ${utcMicroseconds('updated_at')} AS updated_at
         FROM meals WHERE id = $1`,
        [mealId],
      )
    ).rows[0];

  // Each returned instant against its own stored column, compared by PostgreSQL at full (microsecond) precision. On
  // creation created_at and updated_at are two independent clock_timestamp() defaults (migration 0039): they may differ
  // by microseconds, and nothing promises they are equal, so a new entry's two instants are not expected to be equal.
  const expectStoredInstants = async (view: MealView) => {
    const stored = await ownerPool.query<{ created_at: string; created_matches: boolean; updated_at: string; updated_matches: boolean }>(
      `SELECT ${utcMicroseconds('created_at')} AS created_at, created_at = $2::timestamptz AS created_matches,
              ${utcMicroseconds('updated_at')} AS updated_at, updated_at = $3::timestamptz AS updated_matches
       FROM meals WHERE id = $1`,
      [view.mealId, view.createdAt, view.updatedAt],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ created_matches: true, updated_matches: true });
  };

  // True when the first instant is strictly before the second, compared by PostgreSQL at full precision.
  const isBefore = async (earlier: string, later: string) =>
    (await ownerPool.query<{ before: boolean }>('SELECT $1::timestamptz < $2::timestamptz AS before', [earlier, later])).rows[0]!.before;

  describe('create', () => {
    it('creates a title-only entry with 201: a database id and timestamps, manual provenance, every value unknown, no-store', async () => {
      const view = parseView(await create(owner, titleOnly).expect(201));
      expect(view).toEqual({
        carbohydrateG: null,
        createdAt: view.createdAt,
        energyKcal: null,
        fatG: null,
        localDate: '2026-10-05',
        mealId: view.mealId,
        mealType: 'snack',
        proteinG: null,
        source: 'manual',
        timeZone: 'Europe/Warsaw',
        title: 'Apple',
        updatedAt: view.updatedAt,
      });
      await expectStoredInstants(view);
      // The database clock, not the application's injected clock (fixed at defaultNow).
      const database = await ownerPool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      for (const instant of [view.createdAt, view.updatedAt]) {
        expect(Math.abs(Date.parse(instant) - database.rows[0]!.now.getTime())).toBeLessThan(60_000);
      }
      expect(parseView(await read(owner, view.mealId).expect(200))).toEqual(view);
    });

    it('returns created_at and updated_at each from its own column at microsecond precision, even within one millisecond', async () => {
      // Deterministic: two valid, distinct instants one microsecond apart inside the same millisecond, seeded through the
      // owner connection (the BEFORE UPDATE trigger does not touch an INSERT). A view mapping updatedAt from created_at,
      // or rounding either instant to milliseconds, cannot return both exactly.
      const createdAt = '2026-10-05T08:00:00.123456Z';
      const updatedAt = '2026-10-05T08:00:00.123457Z';
      const seeded = await ownerPool.query<{ id: string }>(
        `INSERT INTO meals (org_id, user_id, local_date, time_zone, meal_type, title, idempotency_key, creation_digest, created_at, updated_at)
         VALUES ($1, $2, '2026-10-05', 'Europe/Warsaw', 'snack', 'Seeded', $3, sha256('seeded'::bytea), $4::timestamptz, $5::timestamptz)
         RETURNING id`,
        [ids.orgA, ids.userOrgA, keys.c, createdAt, updatedAt],
      );
      const mealId = seeded.rows[0]!.id;
      const view = parseView(await read(owner, mealId).expect(200));
      expect(view).toMatchObject({ createdAt, mealId, updatedAt });
      await expectStoredInstants(view);
      expect(await isBefore(view.createdAt, view.updatedAt)).toBe(true);
      const listed = mealListResponseSchema.parse((await list(owner, { localDate: '2026-10-05' }).expect(200)).body);
      expect(listed.items.find((item) => item.mealId === mealId)).toEqual(view);
    });

    it('stores the four values as sent and keeps a recorded zero apart from an unknown value', async () => {
      const view = parseView(await create(owner, lunch).expect(201));
      expect(view).toMatchObject({ carbohydrateG: 60, energyKcal: 650.5, fatG: 0, proteinG: 30.2 });
      const zeros = parseView(await create(owner, { ...titleOnly, energyKcal: 0, title: 'Water' }).expect(201));
      expect(zeros).toMatchObject({ carbohydrateG: null, energyKcal: 0, fatG: null, proteinG: null });
      const stored = await ownerPool.query(
        `SELECT title, energy_kcal::text, protein_g::text, carbohydrate_g::text, fat_g::text FROM meals ORDER BY title`,
      );
      expect(stored.rows).toEqual([
        { carbohydrate_g: '60', energy_kcal: '650.5', fat_g: '0', protein_g: '30.2', title: 'Chicken and rice' },
        { carbohydrate_g: null, energy_kcal: '0', fat_g: null, protein_g: null, title: 'Water' },
      ]);
    });

    it('stores the canonical zone of the first write', async () => {
      const view = parseView(await create(owner, { ...titleOnly, timeZone: 'europe/warsaw' }).expect(201));
      expect(view.timeZone).toBe('Europe/Warsaw');
    });

    it('refuses invalid values, extra decimals, unknown fields, an id, an owner or a source, and stores nothing', async () => {
      for (const payload of [
        { ...lunch, energyKcal: -0.1 },
        { ...lunch, energyKcal: 20_000.1 },
        { ...lunch, energyKcal: 650.55 },
        { ...lunch, proteinG: 2_000.1 },
        { ...lunch, carbohydrateG: '60' },
        { ...lunch, fatG: 0.05 },
        { ...lunch, title: '' },
        { ...lunch, title: '   ' },
        { ...lunch, title: 'x'.repeat(121) },
        { ...lunch, title: 'a\u0000b' },
        { ...lunch, mealType: 'brunch' },
        { ...lunch, idempotencyKey: 'not-a-uuid' },
        { ...lunch, timeZone: '+01:00' },
        { ...lunch, mealId: keys.c },
        { ...lunch, source: 'manual' },
        { ...lunch, userId: ids.userStranger },
        { ...lunch, orgId: ids.orgB },
        { ...lunch, servings: 2 },
        { ...lunch, energyKcalPer100g: 100 },
        [lunch],
      ]) {
        expect(errorCode(await create(owner, payload).expect(400))).toBe('INVALID_REQUEST');
      }
      for (const field of ['idempotencyKey', 'localDate', 'mealType', 'timeZone', 'title'] as const) {
        const missing: Record<string, unknown> = { ...lunch };
        delete missing[field];
        expect(errorCode(await create(owner, missing).expect(400))).toBe('INVALID_REQUEST');
      }
      for (const raw of [
        `{"energyKcal":1e309,"idempotencyKey":"${keys.a}","localDate":"2026-10-05","mealType":"lunch","timeZone":"UTC","title":"x"}`,
        `{"fatG":-1e309,"idempotencyKey":"${keys.a}","localDate":"2026-10-05","mealType":"lunch","timeZone":"UTC","title":"x"}`,
      ]) {
        expect(errorCode(await create(owner, raw).expect(400))).toBe('INVALID_REQUEST');
      }
      expect(errorCode(await create(owner, lunch).query({ userId: ids.userStranger }).expect(400))).toBe('INVALID_REQUEST');
      expect(await storedTitles()).toEqual([]);
    });

    it('refuses a non-JSON or malformed body, with no-store on the error', async () => {
      const textual = await request(app)
        .post(path(ids.orgA))
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .type('text/plain')
        .send('title=x');
      expect(textual.status).toBe(415);
      expect(errorCode(textual)).toBe('UNSUPPORTED_MEDIA_TYPE');
      // The JSON parser runs before the router: the no-store header is mounted ahead of it.
      expect(errorCode(await create(owner, '{"title":').expect(400))).toBe('INVALID_REQUEST');
      expect(await storedTitles()).toEqual([]);
    });
  });

  describe('idempotent creation per form session', () => {
    it('answers the same key with the same request with 200 and the original entry, however the request is spelled', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      expect(parseView(await create(owner, lunch).expect(200))).toEqual(created);
      // 650.50 is 650.5, omitted and null are the same unknown value, the zone's spelling is one zone, field order is free.
      const respelled = `{"title":"Chicken and rice","proteinG":30.20,"mealType":"lunch","localDate":"2026-10-05","idempotencyKey":"${keys.a.toUpperCase()}","fatG":-0,"energyKcal":650.50,"carbohydrateG":6e1,"timeZone":"europe/warsaw"}`;
      expect(parseView(await create(owner, respelled).expect(200))).toEqual(created);
      const plain = parseView(await create(owner, titleOnly).expect(201));
      expect(parseView(await create(owner, { ...titleOnly, energyKcal: null, fatG: null }).expect(200))).toEqual(plain);
      expect(await storedTitles()).toEqual([own('Chicken and rice'), own('Apple')]);
    });

    it('answers the same key with a different request with 409 MEAL_ALREADY_SAVED naming the entry, and stores nothing', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      for (const changed of [
        { ...lunch, energyKcal: 700 },
        { ...lunch, energyKcal: null },
        { ...lunch, title: 'Chicken and rice ' },
        { ...lunch, mealType: 'dinner' },
        { ...lunch, localDate: '2026-10-04' },
        { ...lunch, timeZone: 'UTC' },
      ]) {
        const refused = await create(owner, changed).expect(409);
        expect(errorCode(refused)).toBe('MEAL_ALREADY_SAVED');
        expect(mealAlreadySavedDetailsSchema.parse(apiErrorResponseSchema.parse(refused.body).error.details)).toEqual({ mealId: created.mealId });
      }
      expect(await storedTitles()).toEqual([own('Chicken and rice')]);
      expect(parseView(await read(owner, created.mealId).expect(200))).toEqual(created);
    });

    it('compares a retry with the original request, not the current values: after an edit, the original retry returns the entry', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      const edited = parseView(await replace(owner, created.mealId, { energyKcal: 500, mealType: 'dinner', title: 'Leftovers' }).expect(200));
      const retried = parseView(await create(owner, lunch).expect(200));
      expect(retried).toEqual(edited);
      // A request equal to the edited values is not the original request.
      expect(errorCode(await create(owner, { ...lunch, energyKcal: 500, mealType: 'dinner', title: 'Leftovers' }).expect(409))).toBe('MEAL_ALREADY_SAVED');
      expect(await storedTitles()).toEqual([own('Leftovers')]);
    });

    it('creates a second entry for a new key with the same details (a genuinely new entry), and keeps keys per person', async () => {
      const first = parseView(await create(owner, lunch).expect(201));
      const second = parseView(await create(owner, { ...lunch, idempotencyKey: keys.c }).expect(201));
      expect(second.mealId).not.toBe(first.mealId);
      // Another person's form session may use the same key: their own key space, and nothing is revealed.
      const theirs = parseView(await create(coach, lunch).expect(201));
      expect(theirs.mealId).not.toBe(first.mealId);
      expect(await storedTitles()).toHaveLength(3);
    });

    it('frees the key when the entry is deleted: the same form session creates a new entry with a new id', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      await remove(owner, created.mealId).expect(204);
      const again = parseView(await create(owner, lunch).expect(201));
      expect(again.mealId).not.toBe(created.mealId);
      expect(again.createdAt).not.toBe(created.createdAt);
    });

    it('settles two interleaved creations of one form session to one entry: the second waits, then returns the first', async () => {
      const session = { userId: ids.userOrgA };
      const begin = async () => {
        const client = await runtimePool.connect();
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ids.userOrgA, ids.orgA]);
        return client;
      };
      const parsed = { ...lunch, mealType: 'lunch' as const };
      const first = await begin();
      const second = await begin();
      try {
        const a = await createMeal(first, session, ids.orgA, parsed, systemClock);
        expect(a.created).toBe(true);
        const racing = createMeal(second, session, ids.orgA, parsed, systemClock);
        let settled = false;
        void racing.then(
          () => (settled = true),
          () => (settled = true),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(settled).toBe(false);
        await first.query('COMMIT');
        const b = await racing;
        await second.query('COMMIT');
        expect(b).toEqual({ created: false, view: a.view });
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
      expect(await storedTitles()).toEqual([own('Chicken and rice')]);
    });

    it('settles concurrent identical HTTP creations to one entry and one 201', async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, () => create(owner, lunch)));
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(5);
      expect(new Set(responses.map((response) => (response.body as MealView).mealId)).size).toBe(1);
      expect(await storedTitles()).toEqual([own('Chicken and rice')]);
    });
  });

  describe('replace the editable fields', () => {
    it('replaces type, title and values: an omitted value is cleared; the id, date, zone and createdAt stay; updatedAt moves', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      const replaced = parseView(await replace(owner, created.mealId, { fatG: 1.5, mealType: 'dinner', title: 'Rice only' }).expect(200));
      expect(replaced).toEqual({
        ...created,
        carbohydrateG: null,
        energyKcal: null,
        fatG: 1.5,
        mealType: 'dinner',
        proteinG: null,
        title: 'Rice only',
        updatedAt: replaced.updatedAt,
      });
      // createdAt (equal to the creation's, above) is still the stored created_at, and updatedAt is the stored updated_at
      // the edit's trigger wrote, later than the creation's at full precision.
      await expectStoredInstants(replaced);
      expect(await isBefore(created.updatedAt, replaced.updatedAt)).toBe(true);
    });

    it('answers an exact retry with 200 and changes nothing, not even updatedAt', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      const body = { carbohydrateG: 10, energyKcal: 99.9, mealType: 'snack', title: 'Bar' };
      const first = parseView(await replace(owner, created.mealId, body).expect(200));
      await expectStoredInstants(first);
      const before = await storedVersion(created.mealId);
      expect(parseView(await replace(owner, created.mealId, body).expect(200))).toEqual(first);
      // 99.90 is 99.9; omitted and null are the same.
      expect(
        parseView(await replace(owner, created.mealId, '{"title":"Bar","mealType":"snack","energyKcal":99.90,"carbohydrateG":10,"fatG":null}').expect(200)),
      ).toEqual(first);
      expect(await storedVersion(created.mealId)).toEqual(before);
    });

    it('refuses a change of date, zone, id, key or source, invalid values and a missing type or title', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      for (const payload of [
        { localDate: '2026-10-04', mealType: 'lunch', title: 'x' },
        { mealType: 'lunch', timeZone: 'UTC', title: 'x' },
        { mealId: keys.c, mealType: 'lunch', title: 'x' },
        { idempotencyKey: keys.c, mealType: 'lunch', title: 'x' },
        { mealType: 'lunch', source: 'manual', title: 'x' },
        { createdAt: created.createdAt, mealType: 'lunch', title: 'x' },
        { energyKcal: 1.05, mealType: 'lunch', title: 'x' },
        { mealType: 'lunch' },
        { title: 'x' },
      ]) {
        expect(errorCode(await replace(owner, created.mealId, payload).expect(400))).toBe('INVALID_REQUEST');
      }
      expect(parseView(await read(owner, created.mealId).expect(200))).toEqual(created);
    });

    it("answers 404 MEAL_NOT_FOUND for an unknown entry and for anyone else's, and changes nothing", async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      expect(errorCode(await replace(owner, keys.d, { mealType: 'lunch', title: 'x' }).expect(404))).toBe('MEAL_NOT_FOUND');
      for (const auth of [coach, grantee]) {
        expect(errorCode(await replace(auth, created.mealId, { mealType: 'lunch', title: 'Taken' }).expect(404))).toBe('MEAL_NOT_FOUND');
      }
      expect(errorCode(await replace(outsider, created.mealId, { mealType: 'lunch', title: 'Taken' }).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(parseView(await read(owner, created.mealId).expect(200))).toEqual(created);
    });
  });

  describe('the local date', () => {
    it('refuses a date before 2000-01-01 or malformed, and accepts 2000-01-01', async () => {
      for (const localDate of ['1999-12-31', '2026-02-29', '2026-10-5', 'today']) {
        expect(errorCode(await create(owner, { ...titleOnly, localDate }).expect(400))).toBe('INVALID_REQUEST');
        expect(errorCode(await list(owner, { localDate }).expect(400))).toBe('INVALID_REQUEST');
      }
      await create(owner, { ...titleOnly, localDate: '2000-01-01' }).expect(201);
    });

    it('refuses a date after today in the given zone by the injected clock, naming today, and accepts today', async () => {
      now = '2026-10-06T10:00:00.000Z';
      const refused = await create(owner, { ...titleOnly, localDate: '2026-10-07', timeZone: 'UTC' }).expect(400);
      expect(errorCode(refused)).toBe('INVALID_REQUEST');
      expect(apiErrorResponseSchema.parse(refused.body).error.message).toContain('2026-10-06');
      expect(await storedTitles()).toEqual([]);
      await create(owner, { ...titleOnly, localDate: '2026-10-06', timeZone: 'UTC' }).expect(201);
    });

    it('decides "today" in the zone sent: the same instant is a different date at UTC+14 and UTC-11', async () => {
      now = '2026-10-06T10:30:00.000Z'; // 00:30 on 7 October at UTC+14, 23:30 on 5 October at UTC-11
      await create(owner, { ...titleOnly, localDate: '2026-10-07', timeZone: 'Pacific/Kiritimati' }).expect(201);
      expect(errorCode(await create(owner, { ...titleOnly, idempotencyKey: keys.c, localDate: '2026-10-06', timeZone: 'Pacific/Pago_Pago' }).expect(400))).toBe(
        'INVALID_REQUEST',
      );
      await create(owner, { ...titleOnly, idempotencyKey: keys.d, localDate: '2026-10-05', timeZone: 'Pacific/Pago_Pago' }).expect(201);
    });

    it('moves "today" at local midnight around the Warsaw spring-forward change', async () => {
      now = '2026-03-28T22:59:59.999Z'; // 23:59:59.999 on 28 March in Warsaw (UTC+1)
      expect(errorCode(await create(owner, { ...titleOnly, localDate: '2026-03-29' }).expect(400))).toBe('INVALID_REQUEST');
      now = '2026-03-28T23:00:00.000Z'; // 00:00 on 29 March
      await create(owner, { ...titleOnly, localDate: '2026-03-29' }).expect(201);
    });

    it('keeps the date and the zone of the first write when the entry is edited later from another zone', async () => {
      const created = parseView(await create(owner, { ...titleOnly, timeZone: 'Asia/Tokyo' }).expect(201));
      const edited = parseView(await replace(owner, created.mealId, { mealType: 'snack', title: 'Pear' }).expect(200));
      expect(edited).toMatchObject({ localDate: '2026-10-05', timeZone: 'Asia/Tokyo', title: 'Pear' });
    });
  });

  describe('reading and listing', () => {
    it('answers 404 MEAL_NOT_FOUND for an unknown id, 400 for a malformed one, and refuses query parameters', async () => {
      expect(errorCode(await read(owner, keys.d).expect(404))).toBe('MEAL_NOT_FOUND');
      expect(errorCode(await read(owner, 'not-a-uuid').expect(400))).toBe('INVALID_REQUEST');
      const created = parseView(await create(owner, lunch).expect(201));
      expect(errorCode(await read(owner, created.mealId).query({ userId: ids.userStranger }).expect(400))).toBe('INVALID_REQUEST');
    });

    it('lists one date in the order the entries were logged, in bounded pages, with a cursor bound to that date', async () => {
      const titles = ['One', 'Two', 'Three', 'Four', 'Five'];
      for (const [index, title] of titles.entries()) {
        await create(owner, { ...titleOnly, idempotencyKey: `0e000000-0000-4000-8000-00000000000${index}`, title }).expect(201);
      }
      await create(owner, { ...titleOnly, idempotencyKey: keys.c, localDate: '2026-10-04', title: 'Other day' }).expect(201);
      const seen: string[] = [];
      let cursor: string | null = null;
      let firstCursor: string | null = null;
      do {
        const query: Record<string, string> = { limit: '2', localDate: '2026-10-05', ...(cursor === null ? {} : { cursor }) };
        const response = await list(owner, query).expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const page = mealListResponseSchema.parse(response.body);
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.title));
        cursor = page.nextCursor;
        firstCursor ??= cursor;
      } while (cursor !== null);
      expect(seen).toEqual(titles);
      // A cursor of one date is refused for another date and for another person.
      expect(errorCode(await list(owner, { cursor: firstCursor!, localDate: '2026-10-04' }).expect(400))).toBe('INVALID_CURSOR');
      expect(errorCode(await list(coach, { cursor: firstCursor!, localDate: '2026-10-05' }).expect(400))).toBe('INVALID_CURSOR');
      expect(errorCode(await list(owner, { cursor: 'garbage!', localDate: '2026-10-05' }).expect(400))).toBe('INVALID_CURSOR');
      const defaultPage = mealListResponseSchema.parse((await list(owner, { localDate: '2026-10-05' }).expect(200)).body);
      expect(defaultPage).toMatchObject({ nextCursor: null });
      expect(defaultPage.items).toHaveLength(5);
      const empty = mealListResponseSchema.parse((await list(owner, { localDate: '2026-10-03' }).expect(200)).body);
      expect(empty).toEqual({ items: [], nextCursor: null });
    });

    it('requires the date and bounds the page size; refuses extra parameters', async () => {
      for (const query of [
        {},
        { localDate: '2026-10-05', limit: '0' },
        { localDate: '2026-10-05', limit: '51' },
        { localDate: '2026-10-05', userId: ids.userStranger },
        { from: '2026-10-01', to: '2026-10-05' },
      ]) {
        expect(errorCode(await list(owner, query).expect(400))).toBe('INVALID_REQUEST');
      }
      await list(owner, { limit: '50', localDate: '2026-10-05' }).expect(200);
    });

    it('requires a session for reads, with no-store on the refusal', async () => {
      expect(errorCode(await request(app).get(path(ids.orgA)).query({ localDate: '2026-10-05' }).expect(401))).toBe('AUTH_REQUIRED');
      expect(errorCode(await request(app).get(path(ids.orgA, keys.a)).expect(401))).toBe('AUTH_REQUIRED');
    });
  });

  describe('cross-person isolation', () => {
    it("shows nothing of the owner to another member, a run-sharing grantee or another organization's member", async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      for (const auth of [coach, grantee]) {
        expect(mealListResponseSchema.parse((await list(auth, { localDate: '2026-10-05' }).expect(200)).body).items).toEqual([]);
        expect(errorCode(await read(auth, created.mealId).expect(404))).toBe('MEAL_NOT_FOUND');
      }
      expect(mealListResponseSchema.parse((await list(grantee, { localDate: '2026-10-05' }, ids.orgB).expect(200)).body).items).toEqual([]);
      expect(errorCode(await list(outsider, { localDate: '2026-10-05' }).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await read(outsider, created.mealId).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await create(outsider, lunch).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await remove(outsider, created.mealId).expect(403))).toBe('ORG_ACCESS_DENIED');
    });

    it("never deletes the owner's entry for another member or a grantee (204 alike, nothing changed)", async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      await remove(coach, created.mealId).expect(204);
      await remove(grantee, created.mealId).expect(204);
      expect(parseView(await read(owner, created.mealId).expect(200))).toEqual(created);
    });
  });

  describe('session, Origin and CSRF', () => {
    it('refuses a create, a replacement or a delete without a session, a known Origin or a valid CSRF token, and changes nothing', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      const body = { mealType: 'lunch', title: 'Changed' };
      const target = path(ids.orgA, created.mealId);
      expect(errorCode(await request(app).post(path(ids.orgA)).set('Origin', allowedOrigin).type('application/json').send(titleOnly).expect(401))).toBe('AUTH_REQUIRED');
      expect(errorCode(await request(app).post(path(ids.orgA)).set('Cookie', owner.cookie).set(csrfHeaderName, owner.csrfToken).type('application/json').send(titleOnly).expect(403))).toBe('ORIGIN_DENIED');
      expect(errorCode(await request(app).post(path(ids.orgA)).set('Cookie', owner.cookie).set('Origin', allowedOrigin).type('application/json').send(titleOnly).expect(403))).toBe('CSRF_DENIED');
      expect(errorCode(await request(app).put(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, coach.csrfToken).type('application/json').send(body).expect(403))).toBe('CSRF_DENIED');
      expect(errorCode(await request(app).put(target).set('Cookie', owner.cookie).set('Origin', 'http://evil.example').set(csrfHeaderName, owner.csrfToken).type('application/json').send(body).expect(403))).toBe('ORIGIN_DENIED');
      await request(app).delete(target).set('Origin', allowedOrigin).expect(401);
      expect(errorCode(await request(app).delete(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).expect(403))).toBe('CSRF_DENIED');
      expect(parseView(await read(owner, created.mealId).expect(200))).toEqual(created);
      expect(await storedTitles()).toEqual([own('Chicken and rice')]);
    });
  });

  describe('not an insight or weekly review source', () => {
    it('creating, editing and deleting entries changes no weekly insight, no source gate and nothing in the weekly review', async () => {
      const review = () =>
        request(app)
          .get(`/api/orgs/${ids.orgA}/weekly-review`)
          .query({ timeZone: 'UTC', weekStart: '2026-10-05' })
          .set('Cookie', owner.cookie)
          .expect(200)
          .then((response) => {
            const parsed = weeklyReviewSchema.parse(response.body);
            return { ...parsed, provenance: { ...parsed.provenance, computedAt: 'ignored' } };
          });
      const insightState = async () =>
        (
          await ownerPool.query<{ gates: string; insights: string }>(
            `SELECT (SELECT count(*) FROM weekly_insights)::text AS insights,
                    coalesce((SELECT string_agg(revision::text, ',' ORDER BY user_id) FROM weekly_insight_source_gates), '') AS gates`,
          )
        ).rows[0];
      const reviewBefore = await review();
      const insightsBefore = await insightState();
      const created = parseView(await create(owner, lunch).expect(201));
      await replace(owner, created.mealId, { energyKcal: 1, mealType: 'snack', title: 'x' }).expect(200);
      const second = parseView(await create(owner, titleOnly).expect(201));
      await remove(owner, second.mealId).expect(204);
      expect(await review()).toEqual(reviewBefore);
      expect(await insightState()).toEqual(insightsBefore);
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

    it('deletes with 204, records the exact version in the ledger, and answers repeats and unknown ids with 204', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      const version = (await storedVersion(created.mealId))!;
      const deleted = await remove(owner, created.mealId).expect(204);
      expect(deleted.headers['cache-control']).toBe('no-store');
      expect(errorCode(await read(owner, created.mealId).expect(404))).toBe('MEAL_NOT_FOUND');
      expect(await ledger()).toEqual([{ entity_type: 'meal', owner_user_id: ids.userOrgA, record_created_at: version.created_at, record_id: version.id }]);
      await remove(owner, created.mealId).expect(204);
      await remove(owner, keys.d).expect(204);
      expect(errorCode(await remove(owner, 'not-a-uuid').expect(400))).toBe('INVALID_REQUEST');
      expect(await ledger()).toHaveLength(1);
    });

    it('fails the delete with 500 and keeps the entry when the ledger cannot be written (deletion and outbox are atomic)', async () => {
      const created = parseView(await create(owner, lunch).expect(201));
      await ownerPool.query('ALTER TABLE erasure_ledger ADD CONSTRAINT test_refuse_meal_http CHECK (false) NOT VALID');
      try {
        expect(errorCode(await remove(owner, created.mealId).expect(500))).toBe('INTERNAL_ERROR');
        expect(await storedTitles()).toEqual([own('Chicken and rice')]);
      } finally {
        await ownerPool.query('ALTER TABLE erasure_ledger DROP CONSTRAINT IF EXISTS test_refuse_meal_http');
      }
      expect(await ledger()).toEqual([]);
      await remove(owner, created.mealId).expect(204);
      expect(await storedTitles()).toEqual([]);
    });

    it('exports identifiers only; replay on a restored copy erases the deletion, keeps the survivor and the recreated entry; twice is a no-op', async () => {
      // D is deleted and logged again from the same form session BEFORE the backup: the backup holds the new version R.
      const original = parseView(await create(owner, lunch).expect(201));
      const survivor = parseView(await create(owner, { ...titleOnly, title: 'Survivor' }).expect(201));
      const later = parseView(await create(owner, { ...titleOnly, idempotencyKey: keys.c, title: 'Deleted after backup' }).expect(201));
      await remove(owner, original.mealId).expect(204);
      const recreated = parseView(await create(owner, lunch).expect(201));
      expect(recreated.mealId).not.toBe(original.mealId);
      // "The backup": every row as stored now (S, X and R).
      const backup = await ownerPool.query<{ id: string; row: string }>('SELECT id, row_to_json(meal)::text AS row FROM meals AS meal ORDER BY id');
      // X is deleted AFTER the backup.
      await remove(owner, later.mealId).expect(204);

      const directory = await mkdtemp(join(tmpdir(), 'rt-meal-erasure-'));
      directories.push(directory);
      await runErasureLedgerExportOnce(maintenancePool, createFileDeletionJournalSink(directory), systemClock);
      expect(await ledger()).toEqual([]);
      const journal = await loadErasureLedger(directory);
      expect(journal.entries.map((entry) => [entry.entityType, entry.recordId])).toEqual([
        ['meal', original.mealId],
        ['meal', later.mealId],
      ]);
      // The exported file holds identifiers and the version only: no title, type or value.
      const files = (await readdir(directory)).filter((name) => name.startsWith('erasure-ledger-'));
      const exported = (await Promise.all(files.map((name) => readFile(join(directory, name), 'utf8')))).join('');
      for (const content of ['Chicken', 'rice', 'lunch', 'snack', 'Deleted', '650.5', '30.2', 'Europe/Warsaw']) expect(exported).not.toContain(content);

      // As after a restore of that backup: X is back with its original identity (S and R never left).
      await ownerPool.query('INSERT INTO meals SELECT * FROM json_populate_record(NULL::meals, $1::json)', [
        backup.rows.find((row) => row.id === later.mealId)!.row,
      ]);
      const state = async () => (await ownerPool.query<{ id: string; row: string }>('SELECT id, row_to_json(meal)::text AS row FROM meals AS meal ORDER BY id')).rows;
      expect(await state()).toEqual(backup.rows);

      const first = await reapplyErasures(ownerPool, journal);
      // X erased again; D's older erasure finds no row with its id and leaves the recreated R alone.
      expect(first.outcomes).toEqual({ absent: 1, erased: 1, skipped_different_record: 0 });
      expect(errorCode(await read(owner, later.mealId).expect(404))).toBe('MEAL_NOT_FOUND');
      expect(parseView(await read(owner, recreated.mealId).expect(200))).toEqual(recreated);
      expect(parseView(await read(owner, survivor.mealId).expect(200))).toEqual(survivor);
      const afterFirst = await state();
      expect(afterFirst).toEqual(backup.rows.filter((row) => row.id !== later.mealId));

      const second = await reapplyErasures(ownerPool, journal);
      expect(second.outcomes).toEqual({ absent: 2, erased: 0, skipped_different_record: 0 });
      expect(await state()).toEqual(afterFirst);
    });
  });
});
