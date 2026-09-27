import { apiErrorResponseSchema, liveTrackResponseSchema } from '@running-tracker/contracts';
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
  empty: 'a4700000-0000-4000-8000-000000000001',
  finished: 'a4700000-0000-4000-8000-000000000002',
  finishedLiveOnly: 'a4700000-0000-4000-8000-000000000003',
  recording: 'a4700000-0000-4000-8000-000000000004',
  unavailable: 'a4700000-0000-4000-8000-000000000005',
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

describe('P07.1 initial live-track snapshot', () => {
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
      application_name: 'running-tracker-p071-fixtures',
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
    await seedLiveTracks();
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function read(userId: string, runId: string, query = '') {
    const auth = authentication.get(userId);
    if (!auth) throw new Error(`Missing authentication for ${userId}`);
    return request(app)
      .get(`/api/orgs/${ids.orgA}/runs/${runId}/live-track${query}`)
      .set('Cookie', auth.cookie);
  }

  async function seedLiveTracks(): Promise<void> {
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES
         ($1, $2, $7, 'finished', $8, $8, $9, 0, 0, 'available'),
         ($1, $3, $7, 'finished', $8, $8, $9, 1, 0, 'available'),
         ($1, $4, $7, 'finished', $8, $8, $9, 0, 0, 'available'),
         ($1, $5, $7, 'recording', $8, $8, NULL, 2, 0, 'available'),
         ($1, $6, $7, 'finished', $8, $8, $9, 1, 0, 'purging')`,
      [
        ids.orgA,
        runIds.empty,
        runIds.finished,
        runIds.finishedLiveOnly,
        runIds.recording,
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
         ($1, $3, $6, true, false),
         ($1, $4, $6, false, true),
         ($1, $5, $6, false, true),
         ($1, $7, $6, true, false)`,
      [
        ids.orgA,
        runIds.empty,
        runIds.finished,
        runIds.finishedLiveOnly,
        runIds.recording,
        ids.userDual,
        runIds.unavailable,
      ],
    );
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES
         ($1, $2, 1, 0, '2031-01-01T10:00:00.001Z', $4,
          ST_SetSRID(ST_MakePoint(21.001, 52.001), 4326), 4.1, 1),
         ($1, $2, 3, 0, '2031-01-01T10:00:00.003Z', $4,
          ST_SetSRID(ST_MakePoint(21.003, 52.003), 4326), 4.3, 2),
         ($1, $3, 9, 1, '2031-01-01T10:00:00.009Z', $4,
          ST_SetSRID(ST_MakePoint(21.009, 52.009), 4326), 4.9, 1),
         ($1, $5, 1, 0, '2031-01-01T10:00:00.001Z', $4,
          ST_SetSRID(ST_MakePoint(21.001, 52.001), 4326), 4.1, 1)`,
      [
        ids.orgA,
        runIds.recording,
        runIds.finished,
        '2031-01-01T10:01:00.000Z',
        runIds.unavailable,
      ],
    );
  }

  it('keeps the first revision fixed across bigint-sequence pages while newer points arrive', async () => {
    const firstResponse = await read(ids.userDual, runIds.recording, '?limit=1').expect(200);
    const first = liveTrackResponseSchema.parse(objectBody(firstResponse));
    expect(first).toMatchObject({
      algorithmVersion: 'v1',
      fromRevision: null,
      toRevision: '2',
      upserts: [
        {
          accuracyM: 4.1,
          connectFromPrevious: false,
          coordinates: [21.001, 52.001],
          predecessorSeq: null,
          recordedAt: '2031-01-01T10:00:00.001Z',
          segmentId: 0,
          seq: '1',
        },
      ],
    });
    expect(first.nextCursor).not.toBeNull();

    const fixtureClient = await ownerPool.connect();
    try {
      await fixtureClient.query('BEGIN');
      await fixtureClient.query(
        `INSERT INTO run_points (
           org_id, run_id, seq, segment_id, recorded_at, received_at,
           geom, accuracy_m, ingested_revision
         ) VALUES ($1, $2, 2, 0, $3, $4,
                   ST_SetSRID(ST_MakePoint(21.002, 52.002), 4326), 4.2, 3)`,
        [
          ids.orgA,
          runIds.recording,
          '2031-01-01T10:00:00.002Z',
          '2031-01-01T10:01:00.000Z',
        ],
      );
      await fixtureClient.query(
        'UPDATE runs SET data_revision = 3 WHERE org_id = $1 AND id = $2',
        [ids.orgA, runIds.recording],
      );
      await fixtureClient.query('COMMIT');
    } catch (error) {
      await fixtureClient.query('ROLLBACK');
      throw error;
    } finally {
      fixtureClient.release();
    }

    const secondResponse = await read(
      ids.userDual,
      runIds.recording,
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(200);
    expect(liveTrackResponseSchema.parse(objectBody(secondResponse))).toEqual({
      algorithmVersion: 'v1',
      fromRevision: null,
      nextCursor: null,
      toRevision: '2',
      upserts: [
        {
          accuracyM: 4.3,
          connectFromPrevious: false,
          coordinates: [21.003, 52.003],
          predecessorSeq: '1',
          recordedAt: '2031-01-01T10:00:00.003Z',
          segmentId: 0,
          seq: '3',
        },
      ],
    });

    const fresh = liveTrackResponseSchema.parse(
      objectBody(await read(ids.userDual, runIds.recording).expect(200)),
    );
    expect(fresh.toRevision).toBe('3');
    expect(fresh.upserts.map(({ seq }) => seq)).toEqual(['1', '2', '3']);
    expect(fresh.upserts.map(({ predecessorSeq }) => predecessorSeq)).toEqual([
      null,
      '1',
      '2',
    ]);
  });

  it('evaluates accepted and rejected edges with the shared revision-bound algorithm', async () => {
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES
         ($1, $2, 1, 0, '2031-01-01T10:00:00.000Z', $3,
          ST_SetSRID(ST_MakePoint(21.00000, 52.00000), 4326), 5, 1),
         ($1, $2, 2, 0, '2031-01-01T10:00:01.000Z', $3,
          ST_SetSRID(ST_MakePoint(21.00001, 52.00000), 4326), 5, 1),
         ($1, $2, 3, 1, '2031-01-01T10:00:02.000Z', $3,
          ST_SetSRID(ST_MakePoint(21.00002, 52.00000), 4326), 5, 1),
         ($1, $2, 4, 1, '2031-01-01T10:00:03.000Z', $3,
          ST_SetSRID(ST_MakePoint(21.00003, 52.00000), 4326), 31, 1)`,
      [ids.orgA, runIds.empty, '2031-01-01T10:01:00.000Z'],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 1 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.empty],
    );

    const response = liveTrackResponseSchema.parse(
      objectBody(await read(ids.userDual, runIds.empty).expect(200)),
    );
    expect(response.upserts.map(({ predecessorSeq }) => predecessorSeq)).toEqual([
      null,
      '1',
      '2',
      '3',
    ]);
    expect(response.upserts.map(({ connectFromPrevious }) => connectFromPrevious)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it('returns an empty snapshot with the current revision and algorithm version', async () => {
    const response = await read(ids.userDual, runIds.empty).expect(200);
    expect(liveTrackResponseSchema.parse(objectBody(response))).toEqual({
      algorithmVersion: 'v1',
      fromRevision: null,
      nextCursor: null,
      toRevision: '0',
      upserts: [],
    });
  });

  it('paginates sequences above the JavaScript safe-integer range without numeric conversion', async () => {
    const highSequence = '9007199254740993';
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES ($1, $2, $3, 1, $4, $5,
                 ST_SetSRID(ST_MakePoint(21.01, 52.01), 4326), 5, 2)`,
      [
        ids.orgA,
        runIds.finished,
        highSequence,
        '2031-01-01T10:00:01.000Z',
        '2031-01-01T10:01:00.000Z',
      ],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 2 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.finished],
    );

    const first = liveTrackResponseSchema.parse(
      objectBody(await read(ids.userDual, runIds.finished, '?limit=1').expect(200)),
    );
    expect(first.upserts.map(({ seq }) => seq)).toEqual(['9']);
    const second = liveTrackResponseSchema.parse(
      objectBody(
        await read(
          ids.userDual,
          runIds.finished,
          `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
        ).expect(200),
      ),
    );
    expect(second).toMatchObject({ nextCursor: null, toRevision: '2' });
    expect(second.upserts.map(({ seq }) => seq)).toEqual([highSequence]);
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
      [ids.orgA, runIds.empty, '2031-01-01T10:00:00.000Z'],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 1 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.empty],
    );

    const first = liveTrackResponseSchema.parse(
      objectBody(await read(ids.userDual, runIds.empty).expect(200)),
    );
    expect(first.upserts).toHaveLength(1_000);
    expect(first.upserts[0]?.seq).toBe('1');
    expect(first.upserts.at(-1)?.seq).toBe('1000');
    expect(first.nextCursor).not.toBeNull();

    const second = liveTrackResponseSchema.parse(
      objectBody(
        await read(
          ids.userDual,
          runIds.empty,
          `?cursor=${encodeURIComponent(first.nextCursor!)}`,
        ).expect(200),
      ),
    );
    expect(second).toMatchObject({ nextCursor: null, toRevision: '1' });
    expect(second.upserts.map(({ seq }) => seq)).toEqual(['1001']);
  });

  it('applies live grants to active runs and history grants to finished runs', async () => {
    await read(ids.userStranger, runIds.recording).expect(200);
    await read(ids.userDual, runIds.recording).expect(200);
    await read(ids.userDual, runIds.finished).expect(200);

    for (const [userId, runId] of [
      [ids.userDual, runIds.finishedLiveOnly],
      [ids.userOrgA, runIds.recording],
    ] as const) {
      const denied = await read(userId, runId).expect(404);
      expect(apiErrorResponseSchema.parse(objectBody(denied)).error.code).toBe('RUN_NOT_FOUND');
    }
  });

  it('checks session, membership, and authorization before retention state', async () => {
    await request(app)
      .get(`/api/orgs/${ids.orgA}/runs/${runIds.recording}/live-track`)
      .expect(401);
    const inactive = await read(ids.userInactive, runIds.recording).expect(403);
    expect(apiErrorResponseSchema.parse(objectBody(inactive)).error.code).toBe(
      'ORG_ACCESS_DENIED',
    );

    const authorized = await read(ids.userStranger, runIds.unavailable).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(authorized)).error.code).toBe(
      'RAW_HISTORY_UNAVAILABLE',
    );
    const hidden = await read(ids.userOrgA, runIds.unavailable).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(hidden)).error.code).toBe('RUN_NOT_FOUND');
  });

  it('rejects malformed, foreign-run, and invalid-limit cursors', async () => {
    const malformed = await read(
      ids.userDual,
      runIds.recording,
      '?cursor=not-a-cursor!',
    ).expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(malformed)).error.code).toBe('INVALID_CURSOR');

    const first = liveTrackResponseSchema.parse(
      objectBody(await read(ids.userDual, runIds.recording, '?limit=1').expect(200)),
    );
    const foreign = await read(
      ids.userDual,
      runIds.finished,
      `?cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(foreign)).error.code).toBe('INVALID_CURSOR');

    for (const query of ['?limit=0', '?limit=1001', '?limit=1&extra=true']) {
      const invalid = await read(ids.userDual, runIds.recording, query).expect(400);
      expect(apiErrorResponseSchema.parse(objectBody(invalid)).error.code).toBe('INVALID_REQUEST');
    }
  });
});
