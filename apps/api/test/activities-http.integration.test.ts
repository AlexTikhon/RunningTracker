import { activityListResponseSchema, activityViewSchema, apiErrorResponseSchema } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration, validateEnvironment } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// ADR-0072 over HTTP, with the real runtime role, session, Origin and CSRF checks.
const allowedOrigin = 'http://127.0.0.1:5173';
const now = '2026-10-06T00:00:00.000Z';

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

const activityId = (n: number) => `ad000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// One form session per activity id unless a test says otherwise (ADR-0073): retries of one id share one key.
const keyFor = (id: string) => `be${id.slice(2)}`;
const formKey = (n: number) => `bf000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const body = {
  distanceM: 20_000,
  durationS: 3_600,
  notes: 'Easy spin',
  rpe: 4,
  startedAt: '2026-10-05T06:00:00.000Z',
  type: 'ride',
};

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') {
    throw new Error('Expected a session cookie');
  }
  return value.split(';', 1)[0]!;
}

function errorCode(response: request.Response): string {
  return apiErrorResponseSchema.parse(response.body).error.code;
}

describe('ADR-0072 activities HTTP API', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let owner: Authentication;
  let coach: Authentication;
  let grantee: Authentication;
  let outsider: Authentication;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

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
      application_name: 'running-tracker-activities-http-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    const clock = new FixedClock();
    app = createApp({
      clock,
      config,
      pool: runtimePool,
      sessionManager: new SessionManager({
        clock,
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
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await ownerPool?.query('DELETE FROM activities').catch(() => undefined);
    await runtimePool?.end();
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

  const path = (orgId: string, id?: string) => `/api/orgs/${orgId}/activities${id === undefined ? '' : `/${id}`}`;

  function put(auth: Authentication, id: string, payload: unknown, orgId: string = ids.orgA) {
    const withKey =
      payload !== null && typeof payload === 'object' && !('idempotencyKey' in payload)
        ? { ...payload, idempotencyKey: keyFor(id) }
        : payload;
    return request(app)
      .put(path(orgId, id))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .type('application/json')
      .send(withKey as object);
  }

  function putRaw(auth: Authentication, id: string, raw: string) {
    return request(app)
      .put(path(ids.orgA, id))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken)
      .set('Content-Type', 'application/json')
      .send(raw);
  }

  function remove(auth: Authentication, id: string, orgId: string = ids.orgA) {
    return request(app)
      .delete(path(orgId, id))
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken);
  }

  function list(auth: Authentication, query: Record<string, string> = {}, orgId: string = ids.orgA) {
    return request(app).get(path(orgId)).query(query).set('Cookie', auth.cookie);
  }

  function read(auth: Authentication, id: string, orgId: string = ids.orgA) {
    return request(app).get(path(orgId, id)).set('Cookie', auth.cookie);
  }

  async function storedRows(): Promise<Array<{ id: string; notes: string | null; org_id: string; user_id: string }>> {
    const result = await ownerPool.query<{ id: string; notes: string | null; org_id: string; user_id: string }>(
      'SELECT org_id, id, user_id, notes FROM activities ORDER BY org_id, id',
    );
    return result.rows;
  }

  describe('idempotent create', () => {
    it('creates with 201, then answers an equal retry with 200 and the same stored activity', async () => {
      const created = await put(owner, activityId(1), body).expect(201);
      const view = activityViewSchema.parse(created.body);
      // createdAt comes from the database clock (migration 0029, ADR-0074), not the injected clock (fixed a month back).
      expect(view).toEqual({ ...body, activityId: activityId(1), createdAt: view.createdAt, source: 'manual' });
      expect(view.createdAt).not.toBe(now);
      const database = await ownerPool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      expect(Math.abs(Date.parse(view.createdAt) - database.rows[0]!.now.getTime())).toBeLessThan(60_000);

      const replay = await put(owner, activityId(1), body).expect(200);
      expect(replay.body).toEqual(created.body);
      expect(await storedRows()).toHaveLength(1);
    });

    it('treats omitted and null optional fields, and one instant spelled differently, as the same payload', async () => {
      const minimal = { durationS: 600, startedAt: '2026-10-05T06:00:00Z', type: 'strength' };
      const created = await put(owner, activityId(2), minimal).expect(201);
      expect(created.body).toMatchObject({ distanceM: null, notes: null, rpe: null, startedAt: '2026-10-05T06:00:00.000Z' });
      await put(owner, activityId(2), { ...minimal, distanceM: null, notes: null, rpe: null }).expect(200);
      await put(owner, activityId(2), { ...minimal, startedAt: '2026-10-05T06:00:00.000000Z' }).expect(200);
    });

    it('keeps microsecond precision of the start and returns it with at least millisecond digits', async () => {
      const created = await put(owner, activityId(3), { ...body, startedAt: '2026-10-05T06:00:00.123456Z' }).expect(201);
      expect(created.body).toMatchObject({ startedAt: '2026-10-05T06:00:00.123456Z' });
      await put(owner, activityId(3), { ...body, startedAt: '2026-10-05T06:00:00.123456Z' }).expect(200);
      expect(errorCode(await put(owner, activityId(3), { ...body, startedAt: '2026-10-05T06:00:00.123Z' }).expect(409))).toBe(
        'ACTIVITY_CONFLICT',
      );
    });

    it('answers 409 ACTIVITY_CONFLICT for a retry whose payload differs in any field, and changes nothing', async () => {
      await put(owner, activityId(4), body).expect(201);
      for (const change of [
        { type: 'run' },
        { startedAt: '2026-10-05T06:00:01.000Z' },
        { durationS: 3_601 },
        { distanceM: 20_000.5 },
        { distanceM: null },
        { rpe: 5 },
        { rpe: null },
        { notes: 'Easy spin.' },
        { notes: null },
      ]) {
        const response = await put(owner, activityId(4), { ...body, ...change }).expect(409);
        expect(errorCode(response)).toBe('ACTIVITY_CONFLICT');
      }
      const stored = await read(owner, activityId(4)).expect(200);
      expect(stored.body).toMatchObject(body);
    });

    it('settles concurrent identical requests to one row: one 201 and the rest 200', async () => {
      const responses = await Promise.all(Array.from({ length: 5 }, () => put(owner, activityId(5), body)));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await storedRows()).toHaveLength(1);
    });

    it('answers 404 for another member\'s id, whatever the payload, and leaves their activity unchanged', async () => {
      await put(owner, activityId(6), body).expect(201);
      for (const auth of [coach, grantee]) {
        expect(errorCode(await put(auth, activityId(6), body).expect(404))).toBe('ACTIVITY_NOT_FOUND');
        expect(errorCode(await put(auth, activityId(6), { ...body, notes: 'mine now' }).expect(404))).toBe('ACTIVITY_NOT_FOUND');
      }
      expect(await storedRows()).toEqual([{ id: activityId(6), notes: 'Easy spin', org_id: ids.orgA, user_id: ids.userOrgA }]);
    });

    it('scopes the id to the organization: the same id in another organization is a different activity', async () => {
      await put(owner, activityId(7), body).expect(201);
      await put(outsider, activityId(7), { ...body, notes: 'other org' }, ids.orgB).expect(201);
      expect((await storedRows()).map((row) => [row.org_id, row.user_id])).toEqual([
        [ids.orgA, ids.userOrgA],
        [ids.orgB, ids.userOrgB],
      ]);
    });

    it('refuses an organization the person is not an active member of', async () => {
      expect(errorCode(await put(outsider, activityId(8), body, ids.orgA).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(errorCode(await list(outsider, {}, ids.orgA).expect(403))).toBe('ORG_ACCESS_DENIED');
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('idempotency key per form session (ADR-0073)', () => {
    async function count(where = 'TRUE', values: unknown[] = []): Promise<number> {
      const result = await ownerPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM activities WHERE ${where}`, values);
      return Number(result.rows[0]!.n);
    }

    it('creates with a new key and stores the key with the activity, not in the answer', async () => {
      const created = await put(owner, activityId(200), { ...body, idempotencyKey: formKey(1) }).expect(201);
      expect(created.body).not.toHaveProperty('idempotencyKey');
      const stored = await ownerPool.query<{ idempotency_key: string }>('SELECT idempotency_key FROM activities WHERE id = $1', [activityId(200)]);
      expect(stored.rows).toEqual([{ idempotency_key: formKey(1) }]);
    });

    it('answers a retry with the same key and payload with the existing activity, under the same or a new id', async () => {
      const created = await put(owner, activityId(201), { ...body, idempotencyKey: formKey(2) }).expect(201);
      const sameId = await put(owner, activityId(201), { ...body, idempotencyKey: formKey(2) }).expect(200);
      expect(sameId.body).toEqual(created.body);
      // The client lost the id it used (or chose a new one) but the form session is the same: no second activity.
      const newId = await put(owner, activityId(202), { ...body, idempotencyKey: formKey(2) }).expect(200);
      expect(newId.body).toEqual(created.body);
      expect(await count()).toBe(1);
      expect(errorCode(await read(owner, activityId(202)).expect(404))).toBe('ACTIVITY_NOT_FOUND');
    });

    it('answers the same key with different details with 409 ACTIVITY_ALREADY_SAVED naming the saved activity, and saves nothing', async () => {
      await put(owner, activityId(203), { ...body, idempotencyKey: formKey(3) }).expect(201);
      for (const change of [{ notes: 'Edited after the unknown outcome' }, { durationS: 3_700 }, { type: 'run' }]) {
        const response = await put(owner, activityId(204), { ...body, ...change, idempotencyKey: formKey(3) }).expect(409);
        const error = apiErrorResponseSchema.parse(response.body).error;
        expect(error.code).toBe('ACTIVITY_ALREADY_SAVED');
        expect(error.details).toEqual({ activityId: activityId(203) });
        expect(error.message).toMatch(/already saved/iu);
      }
      expect(await count()).toBe(1);
      expect((await read(owner, activityId(203)).expect(200)).body).toMatchObject({ notes: body.notes });
    });

    it('keeps id-bound conflicts as before: the same id with another key is ACTIVITY_CONFLICT', async () => {
      await put(owner, activityId(205), { ...body, idempotencyKey: formKey(5) }).expect(201);
      expect(errorCode(await put(owner, activityId(205), { ...body, idempotencyKey: formKey(6) }).expect(409))).toBe('ACTIVITY_CONFLICT');
      expect(await count()).toBe(1);
    });

    it('isolates keys per owner and per organization', async () => {
      // Another member of org A, and the owner of an activity in org B, may use the very same key.
      await put(owner, activityId(206), { ...body, idempotencyKey: formKey(7) }).expect(201);
      await put(coach, activityId(207), { ...body, idempotencyKey: formKey(7) }).expect(201);
      await put(grantee, activityId(208), { ...body, idempotencyKey: formKey(7) }).expect(201);
      // The grantee is also a member of org B: the same person's key is independent per organization.
      await put(grantee, activityId(209), { ...body, idempotencyKey: formKey(7) }, ids.orgB).expect(201);
      expect(await count('idempotency_key = $1', [formKey(7)])).toBe(4);
      // Nobody learns about another owner's activity through a key collision.
      const coachRetry = await put(coach, activityId(210), { ...body, notes: 'different', idempotencyKey: formKey(7) }).expect(409);
      expect(apiErrorResponseSchema.parse(coachRetry.body).error.details).toEqual({ activityId: activityId(207) });
    });

    it('frees a key when its activity is deleted', async () => {
      await put(owner, activityId(211), { ...body, idempotencyKey: formKey(8) }).expect(201);
      await remove(owner, activityId(211)).expect(204);
      await put(owner, activityId(212), { ...body, notes: 'saved again', idempotencyKey: formKey(8) }).expect(201);
    });

    it('settles concurrent saves of one form session under different ids to a single activity', async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          put(owner, activityId(220 + index), { ...body, idempotencyKey: formKey(9) }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(await count('idempotency_key = $1', [formKey(9)])).toBe(1);
      const ids200 = new Set(responses.map((response) => (response.body as { activityId: string }).activityId));
      expect(ids200.size).toBe(1);
    });
  });

  describe('validation', () => {
    it.each([
      ['an unknown type', { ...body, type: 'yoga' }],
      ['a negative distance', { ...body, distanceM: -1 }],
      ['a distance above 1000 km', { ...body, distanceM: 1_000_000.5 }],
      ['a distance written as the string NaN', { ...body, distanceM: 'NaN' }],
      ['an RPE of 0', { ...body, rpe: 0 }],
      ['an RPE of 11', { ...body, rpe: 11 }],
      ['a fractional RPE', { ...body, rpe: 2.5 }],
      ['a zero duration', { ...body, durationS: 0 }],
      ['a duration above 48 hours', { ...body, durationS: 172_801 }],
      ['a fractional duration', { ...body, durationS: 1.5 }],
      ['notes longer than 1000 characters', { ...body, notes: 'x'.repeat(1_001) }],
      ['empty notes', { ...body, notes: '' }],
      ['notes containing NUL', { ...body, notes: 'a\u0000b' }],
      ['an unknown field', { ...body, heartRate: 150 }],
      ['an owner field', { ...body, userId: ids.userStranger }],
      ['a source field', { ...body, source: 'manual' }],
      ['a missing type', { durationS: 60, startedAt: body.startedAt }],
      ['a start before 2000', { ...body, startedAt: '1999-12-31T23:59:59.999Z' }],
      ['a start with an offset', { ...body, startedAt: '2026-10-05T08:00:00+02:00' }],
      ['a start more than 24 hours after server time', { ...body, startedAt: '2026-10-07T00:00:00.001Z' }],
    ])('refuses %s with 400 INVALID_REQUEST and stores nothing', async (_label, payload) => {
      const response = await put(owner, activityId(20), payload).expect(400);
      expect(errorCode(response)).toBe('INVALID_REQUEST');
      expect(await storedRows()).toEqual([]);
    });

    it('accepts a start exactly 24 hours after server time', async () => {
      await put(owner, activityId(21), { ...body, startedAt: '2026-10-07T00:00:00.000Z' }).expect(201);
    });

    it('refuses a missing or malformed idempotency key', async () => {
      // `body` carries no key: sent raw, nothing adds one.
      expect(errorCode(await putRaw(owner, activityId(24), JSON.stringify(body)).expect(400))).toBe('INVALID_REQUEST');
      expect(errorCode(await put(owner, activityId(24), { ...body, idempotencyKey: 'form-1' }).expect(400))).toBe('INVALID_REQUEST');
      expect(await storedRows()).toEqual([]);
    });

    it('refuses a distance that JSON turns into Infinity, and a literal NaN that is not JSON at all', async () => {
      const key = keyFor(activityId(22));
      const infinite = await putRaw(owner, activityId(22), `{"type":"run","startedAt":"2026-10-05T06:00:00.000Z","durationS":60,"idempotencyKey":"${key}","distanceM":1e400}`).expect(400);
      expect(errorCode(infinite)).toBe('INVALID_REQUEST');
      const nan = await putRaw(owner, activityId(22), `{"type":"run","startedAt":"2026-10-05T06:00:00.000Z","durationS":60,"idempotencyKey":"${key}","distanceM":NaN}`).expect(400);
      expect(errorCode(nan)).toBe('INVALID_REQUEST');
      expect(await storedRows()).toEqual([]);
    });

    it('refuses a non-JSON body and malformed ids', async () => {
      await request(app)
        .put(path(ids.orgA, activityId(23)))
        .set('Cookie', owner.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, owner.csrfToken)
        .type('text/plain')
        .send('type=run')
        .expect(415);
      expect(errorCode(await put(owner, 'not-a-uuid', body).expect(400))).toBe('INVALID_REQUEST');
      expect(errorCode(await read(owner, 'not-a-uuid').expect(400))).toBe('INVALID_REQUEST');
      expect(errorCode(await remove(owner, 'not-a-uuid').expect(400))).toBe('INVALID_REQUEST');
    });
  });

  describe('session, Origin and CSRF', () => {
    it('refuses a create without a session, a known Origin or a valid CSRF token, and stores nothing', async () => {
      const target = path(ids.orgA, activityId(30));
      await request(app).put(target).set('Origin', allowedOrigin).type('application/json').send(body).expect(401);
      const noOrigin = await request(app).put(target).set('Cookie', owner.cookie).set(csrfHeaderName, owner.csrfToken).type('application/json').send(body).expect(403);
      expect(errorCode(noOrigin)).toBe('ORIGIN_DENIED');
      const foreignOrigin = await request(app).put(target).set('Cookie', owner.cookie).set('Origin', 'http://evil.example').set(csrfHeaderName, owner.csrfToken).type('application/json').send(body).expect(403);
      expect(errorCode(foreignOrigin)).toBe('ORIGIN_DENIED');
      const noCsrf = await request(app).put(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).type('application/json').send(body).expect(403);
      expect(errorCode(noCsrf)).toBe('CSRF_DENIED');
      const otherSessionToken = await request(app).put(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, coach.csrfToken).type('application/json').send(body).expect(403);
      expect(errorCode(otherSessionToken)).toBe('CSRF_DENIED');
      expect(await storedRows()).toEqual([]);
    });

    it('refuses a delete without a session, a known Origin or a valid CSRF token, and deletes nothing', async () => {
      await put(owner, activityId(31), body).expect(201);
      const target = path(ids.orgA, activityId(31));
      await request(app).delete(target).set('Origin', allowedOrigin).expect(401);
      expect(errorCode(await request(app).delete(target).set('Cookie', owner.cookie).set(csrfHeaderName, owner.csrfToken).expect(403))).toBe('ORIGIN_DENIED');
      expect(errorCode(await request(app).delete(target).set('Cookie', owner.cookie).set('Origin', 'null').set(csrfHeaderName, owner.csrfToken).expect(403))).toBe('ORIGIN_DENIED');
      expect(errorCode(await request(app).delete(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).expect(403))).toBe('CSRF_DENIED');
      expect(errorCode(await request(app).delete(target).set('Cookie', owner.cookie).set('Origin', allowedOrigin).set(csrfHeaderName, 'x'.repeat(43)).expect(403))).toBe('CSRF_DENIED');
      expect(await storedRows()).toHaveLength(1);
    });

    it('requires a session for reads', async () => {
      await request(app).get(path(ids.orgA)).expect(401);
      await request(app).get(path(ids.orgA, activityId(32))).expect(401);
    });
  });

  describe('reading', () => {
    it('reads one owned activity with no-store, and answers 404 for anyone else or an unknown id', async () => {
      await put(owner, activityId(40), body).expect(201);
      const own = await read(owner, activityId(40)).expect(200);
      expect(own.headers['cache-control']).toBe('no-store');
      expect(activityViewSchema.parse(own.body).activityId).toBe(activityId(40));
      for (const auth of [coach, grantee]) {
        expect(errorCode(await read(auth, activityId(40)).expect(404))).toBe('ACTIVITY_NOT_FOUND');
      }
      expect(errorCode(await read(owner, activityId(41)).expect(404))).toBe('ACTIVITY_NOT_FOUND');
    });

    it('pages the person\'s own activities newest first, ties by id, without gaps or repeats', async () => {
      // Seven activities, two pairs sharing a start. Expected order: start DESC, then id DESC.
      const starts = [
        '2026-10-01T06:00:00.000Z',
        '2026-10-03T06:00:00.000Z',
        '2026-10-03T06:00:00.000Z',
        '2026-10-02T06:00:00.000Z',
        '2026-10-04T06:00:00.000001Z',
        '2026-10-04T06:00:00.000Z',
        '2026-10-04T06:00:00.000Z',
      ];
      for (const [index, startedAt] of starts.entries()) {
        await put(owner, activityId(50 + index), { ...body, startedAt }).expect(201);
      }
      await put(coach, activityId(70), body).expect(201);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const response: request.Response = await list(owner, cursor === null ? { limit: '3' } : { cursor, limit: '3' }).expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const page = activityListResponseSchema.parse(response.body);
        seen.push(...page.items.map((item) => item.activityId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual([
        activityId(54),
        activityId(56),
        activityId(55),
        activityId(52),
        activityId(51),
        activityId(53),
        activityId(50),
      ]);
      const all = activityListResponseSchema.parse((await list(owner).expect(200)).body);
      expect(all.items).toHaveLength(7);
      expect(all.nextCursor).toBeNull();
    });

    it('lists nothing of anyone else for a coach, a grantee or another organization\'s coach', async () => {
      await put(owner, activityId(80), body).expect(201);
      await put(outsider, activityId(81), body, ids.orgB).expect(201);
      expect((await list(coach).expect(200)).body).toEqual({ items: [], nextCursor: null });
      expect((await list(grantee).expect(200)).body).toEqual({ items: [], nextCursor: null });
      expect((await list(grantee, {}, ids.orgB).expect(200)).body).toEqual({ items: [], nextCursor: null });
    });

    it('refuses an out-of-range limit and unknown parameters', async () => {
      for (const query of [{ limit: '0' }, { limit: '51' }, { limit: 'ten' }, { userId: ids.userStranger }, { type: 'run' }]) {
        expect(errorCode(await list(owner, query).expect(400))).toBe('INVALID_REQUEST');
      }
      expect(errorCode(await read(owner, activityId(1)).query({ x: '1' }).expect(400))).toBe('INVALID_REQUEST');
    });

    it('refuses a tampered cursor, another person\'s cursor and a cursor from another organization', async () => {
      for (let index = 0; index < 3; index += 1) {
        await put(owner, activityId(90 + index), { ...body, startedAt: `2026-10-0${index + 1}T06:00:00.000Z` }).expect(201);
        await put(grantee, activityId(95 + index), { ...body, startedAt: `2026-10-0${index + 1}T06:00:00.000Z` }).expect(201);
      }
      const ownerCursor = activityListResponseSchema.parse((await list(owner, { limit: '1' }).expect(200)).body).nextCursor!;
      const granteeCursor = activityListResponseSchema.parse((await list(grantee, { limit: '1' }).expect(200)).body).nextCursor!;
      expect(ownerCursor).not.toBeNull();

      const decoded = JSON.parse(Buffer.from(ownerCursor, 'base64url').toString('utf8')) as Record<string, unknown>;
      const reencode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
      for (const cursor of [
        `${ownerCursor.slice(0, -2)}!!`,
        reencode({ ...decoded, context: 'A'.repeat(43) }),
        reencode({ ...decoded, version: 2 }),
        reencode({ ...decoded, extra: 1 }),
      ]) {
        expect(errorCode(await list(owner, { cursor }).expect(400))).toBe('INVALID_CURSOR');
      }
      // Another person replaying the owner's position, and the owner replaying theirs.
      expect(errorCode(await list(grantee, { cursor: ownerCursor }).expect(400))).toBe('INVALID_CURSOR');
      expect(errorCode(await list(coach, { cursor: ownerCursor }).expect(400))).toBe('INVALID_CURSOR');
      expect(errorCode(await list(owner, { cursor: granteeCursor }).expect(400))).toBe('INVALID_CURSOR');
      // The grantee is a member of both organizations: their org-A cursor is refused in org B.
      expect(errorCode(await list(grantee, { cursor: granteeCursor }, ids.orgB).expect(400))).toBe('INVALID_CURSOR');
      // The cursor still works for its own scope.
      await list(owner, { cursor: ownerCursor }).expect(200);
    });
  });

  describe('deleting', () => {
    it('deletes an owned activity with 204, and answers a repeat with 204 too', async () => {
      await put(owner, activityId(100), body).expect(201);
      await remove(owner, activityId(100)).expect(204);
      expect(await storedRows()).toEqual([]);
      await remove(owner, activityId(100)).expect(204);
      expect(errorCode(await read(owner, activityId(100)).expect(404))).toBe('ACTIVITY_NOT_FOUND');
    });

    it('answers 204 for an id that never existed', async () => {
      await remove(owner, activityId(101)).expect(204);
    });

    it('answers 204 to anyone else, and leaves the owner\'s activity in place', async () => {
      await put(owner, activityId(102), body).expect(201);
      await put(outsider, activityId(103), body, ids.orgB).expect(201);
      await remove(coach, activityId(102)).expect(204);
      await remove(grantee, activityId(102)).expect(204);
      await remove(grantee, activityId(103), ids.orgB).expect(204);
      expect((await storedRows()).map((row) => row.id)).toEqual([activityId(102), activityId(103)]);
      await read(owner, activityId(102)).expect(200);
    });

    it('lets a recreated id start fresh after a delete (no tombstone, ADR-0072)', async () => {
      await put(owner, activityId(104), body).expect(201);
      await remove(owner, activityId(104)).expect(204);
      await put(owner, activityId(104), { ...body, type: 'run' }).expect(201);
    });
  });

  it('never writes to runs or their shares', async () => {
    const before = await ownerPool.query<{ runs: string; shares: string }>(
      'SELECT (SELECT count(*) FROM runs)::text AS runs, (SELECT count(*) FROM run_shares)::text AS shares',
    );
    await put(owner, activityId(110), { ...body, type: 'run' }).expect(201);
    await remove(owner, activityId(110)).expect(204);
    const after = await ownerPool.query<{ runs: string; shares: string }>(
      'SELECT (SELECT count(*) FROM runs)::text AS runs, (SELECT count(*) FROM run_shares)::text AS shares',
    );
    expect(after.rows).toEqual(before.rows);
  });
});
