import { apiErrorResponseSchema, pointsResponseSchema } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const runIds = {
  empty: 'a4300000-0000-4000-8000-000000000001',
  history: 'a4300000-0000-4000-8000-000000000002',
  liveOnly: 'a4300000-0000-4000-8000-000000000003',
  otherHistory: 'a4300000-0000-4000-8000-000000000004',
  unavailable: 'a4300000-0000-4000-8000-000000000005',
} as const;

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse('2031-01-03T00:00:00.000Z');
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date('2031-01-03T00:00:00.000Z');
  }
}

interface Authentication {
  cookie: string;
}

function objectBody(response: request.Response): Record<string, unknown> {
  const body = response.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected an object response body');
  }
  return body as Record<string, unknown>;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  const value: unknown =
    typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (typeof value !== 'string') {
    throw new Error('Expected a session cookie');
  }
  return value.split(';', 1)[0]!;
}

describe('P04.3 raw point history', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const authentication = new Map<string, Authentication>();

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const allowedUsers = [ids.userDual, ids.userInactive, ids.userOrgA, ids.userStranger];
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: allowedUsers.join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    ownerPool = new Pool({
      application_name: 'running-tracker-p043-fixtures',
      connectionString: integration.migration.connectionString,
      max: 3,
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);

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
    for (const userId of allowedUsers) {
      const login = await request(app)
        .post('/api/session')
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ userId })
        .expect(201);
      authentication.set(userId, { cookie: cookiePair(login) });
    }
  });

  beforeEach(async () => {
    const integration = loadIntegrationTestConfiguration();
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await seedRawHistory();
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function read(userId: string, runId: string, query = '') {
    const auth = authentication.get(userId);
    if (!auth) throw new Error(`Missing authentication for ${userId}`);
    return request(app)
      .get(`/api/orgs/${ids.orgA}/runs/${runId}/points${query}`)
      .set('Cookie', auth.cookie);
  }

  async function seedRawHistory(): Promise<void> {
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES
         ($1, $2, $7, 'finished', $8, $8, $9, 3, 0, 'available'),
         ($1, $3, $7, 'recording', $8, $8, NULL, 0, 0, 'available'),
         ($1, $4, $7, 'finished', $8, $8, $9, 3, 0, 'available'),
         ($1, $5, $7, 'finished', $8, $8, $9, 0, 0, 'available'),
         ($1, $6, $7, 'finished', $8, $8, $9, 3, 0, 'purging')`,
      [
        ids.orgA,
        runIds.history,
        runIds.liveOnly,
        runIds.otherHistory,
        runIds.empty,
        runIds.unavailable,
        ids.userStranger,
        '2031-01-01T00:00:00.000Z',
        '2031-01-02T00:00:00.000Z',
      ],
    );
    await ownerPool.query(
      `INSERT INTO run_shares (
         org_id, run_id, grantee_user_id, can_read_history, can_read_live
       ) VALUES
         ($1, $2, $6, true, false),
         ($1, $3, $6, false, true),
         ($1, $4, $6, true, false),
         ($1, $5, $6, true, false)`,
      [
        ids.orgA,
        runIds.history,
        runIds.liveOnly,
        runIds.otherHistory,
        runIds.unavailable,
        ids.userDual,
      ],
    );
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES
         ($1, $2, 41, 0, '2031-01-01T10:00:00.001Z', $4,
          ST_SetSRID(ST_MakePoint(21.001, 52.001), 4326), 4.1, 1),
         ($1, $2, 43, 1, '2031-01-01T10:00:00.003Z', $4,
          ST_SetSRID(ST_MakePoint(21.003, 52.003), 4326), 4.3, 2),
         ($1, $2, 42, 0, '2031-01-01T10:00:00.002Z', $4,
          ST_SetSRID(ST_MakePoint(21.002, 52.002), 4326), 4.2, 3),
         ($1, $3, 1, 0, '2031-01-01T10:00:00.001Z', $4,
          ST_SetSRID(ST_MakePoint(21.1, 52.1), 4326), 5, 1),
         ($1, $5, 1, 0, '2031-01-01T10:00:00.001Z', $4,
          ST_SetSRID(ST_MakePoint(21.1, 52.1), 4326), 5, 1)`,
      [ids.orgA, runIds.history, runIds.liveOnly, '2031-01-01T10:01:00.000Z', runIds.unavailable],
    );
  }

  it('reads a stable revision in ascending seq order with bounded keyset pages', async () => {
    const firstResponse = await read(ids.userStranger, runIds.history, '?limit=2').expect(200);
    const first = pointsResponseSchema.parse(objectBody(firstResponse));
    expect(first).toMatchObject({
      dataRevision: '3',
      points: [
        {
          accuracyM: 4.1,
          latitude: 52.001,
          longitude: 21.001,
          recordedAt: '2031-01-01T10:00:00.001Z',
          segmentId: 0,
          seq: '41',
        },
        { seq: '42' },
      ],
    });
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await read(
      ids.userStranger,
      runIds.history,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(200);
    const second = pointsResponseSchema.parse(objectBody(secondResponse));
    expect(second).toEqual({
      dataRevision: '3',
      nextCursor: null,
      points: [
        {
          accuracyM: 4.3,
          latitude: 52.003,
          longitude: 21.003,
          recordedAt: '2031-01-01T10:00:00.003Z',
          segmentId: 1,
          seq: '43',
        },
      ],
    });
  });

  it('returns an empty page with the current revision', async () => {
    const response = await read(ids.userStranger, runIds.empty).expect(200);
    expect(pointsResponseSchema.parse(objectBody(response))).toEqual({
      dataRevision: '0',
      nextCursor: null,
      points: [],
    });
  });

  it('caps the default page at 1000 points and exposes the remaining keyset page', async () => {
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       )
       SELECT $1, $2, value, 0, $3, $3,
              ST_SetSRID(ST_MakePoint(21, 52), 4326), 5, 1
       FROM generate_series(1, 1001) AS value`,
      [ids.orgA, runIds.otherHistory, '2031-01-01T10:00:00.000Z'],
    );

    const firstResponse = await read(ids.userStranger, runIds.otherHistory).expect(200);
    const first = pointsResponseSchema.parse(objectBody(firstResponse));
    expect(first.points).toHaveLength(1_000);
    expect(first.points[0]?.seq).toBe('1');
    expect(first.points.at(-1)?.seq).toBe('1000');
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await read(
      ids.userStranger,
      runIds.otherHistory,
      `?cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(200);
    expect(pointsResponseSchema.parse(objectBody(secondResponse))).toMatchObject({
      dataRevision: '3',
      nextCursor: null,
      points: [{ seq: '1001' }],
    });
  });

  it('requires a restart when data_revision changes between pages', async () => {
    const firstResponse = await read(ids.userStranger, runIds.history, '?limit=1').expect(200);
    const first = pointsResponseSchema.parse(objectBody(firstResponse));
    await ownerPool.query(
      'UPDATE runs SET data_revision = data_revision + 1 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.history],
    );

    const conflict = await read(
      ids.userStranger,
      runIds.history,
      `?cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(conflict)).error.code).toBe(
      'HISTORY_REVISION_CHANGED',
    );
  });

  it('rejects malformed, foreign-run, and invalid-limit cursors without querying another page', async () => {
    const malformed = await read(ids.userStranger, runIds.history, '?cursor=not-a-cursor!').expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(malformed)).error.code).toBe('INVALID_CURSOR');

    const firstResponse = await read(ids.userStranger, runIds.history, '?limit=1').expect(200);
    const cursor = pointsResponseSchema.parse(objectBody(firstResponse)).nextCursor!;
    const foreign = await read(
      ids.userStranger,
      runIds.otherHistory,
      `?cursor=${encodeURIComponent(cursor)}`,
    ).expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(foreign)).error.code).toBe('INVALID_CURSOR');

    for (const query of ['?limit=0', '?limit=1001', '?limit=1&extra=true']) {
      const invalid = await read(ids.userStranger, runIds.history, query).expect(400);
      expect(apiErrorResponseSchema.parse(objectBody(invalid)).error.code).toBe('INVALID_REQUEST');
    }
  });

  it('allows owners and finished-run history grantees but not live-only or unrelated readers', async () => {
    await read(ids.userStranger, runIds.liveOnly).expect(200);
    await read(ids.userDual, runIds.history).expect(200);

    for (const [userId, runId] of [
      [ids.userDual, runIds.liveOnly],
      [ids.userOrgA, runIds.history],
    ] as const) {
      const denied = await read(userId, runId).expect(404);
      expect(apiErrorResponseSchema.parse(objectBody(denied)).error.code).toBe('RUN_NOT_FOUND');
    }
  });

  it('checks session and active membership before object history access', async () => {
    await request(app).get(`/api/orgs/${ids.orgA}/runs/${runIds.history}/points`).expect(401);
    const inactive = await read(ids.userInactive, runIds.history).expect(403);
    expect(apiErrorResponseSchema.parse(objectBody(inactive)).error.code).toBe(
      'ORG_ACCESS_DENIED',
    );
  });

  it('returns raw-history retention state only after history authorization', async () => {
    const owner = await read(ids.userStranger, runIds.unavailable).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(owner)).error.code).toBe(
      'RAW_HISTORY_UNAVAILABLE',
    );
    const grantee = await read(ids.userDual, runIds.unavailable).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(grantee)).error.code).toBe(
      'RAW_HISTORY_UNAVAILABLE',
    );
    const unrelated = await read(ids.userOrgA, runIds.unavailable).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(unrelated)).error.code).toBe('RUN_NOT_FOUND');
  });
});
