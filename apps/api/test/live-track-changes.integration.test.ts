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
  empty: 'a4720000-0000-4000-8000-000000000001',
  recording: 'a4720000-0000-4000-8000-000000000002',
  unavailable: 'a4720000-0000-4000-8000-000000000003',
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

describe('P07.2 revision-window live-track changes', () => {
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
      application_name: 'running-tracker-p072-fixtures',
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

  function readChanges(userId: string, runId: string, query = '') {
    const auth = authentication.get(userId);
    if (!auth) throw new Error(`Missing authentication for ${userId}`);
    return request(app)
      .get(`/api/orgs/${ids.orgA}/runs/${runId}/live-track/changes${query}`)
      .set('Cookie', auth.cookie);
  }

  function readSnapshot(userId: string, runId: string, query = '') {
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
         ($1, $2, $5, 'finished', $6, $6, $7, 0, 0, 'available'),
         ($1, $3, $5, 'recording', $6, $6, NULL, 2, 0, 'available'),
         ($1, $4, $5, 'finished', $6, $6, $7, 2, 0, 'purging')`,
      [
        ids.orgA,
        runIds.empty,
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
         ($1, $2, $5, true, false),
         ($1, $3, $5, false, true),
         ($1, $4, $5, true, false)`,
      [ids.orgA, runIds.empty, runIds.recording, runIds.unavailable, ids.userDual],
    );
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES
         ($1, $2, 10, 0, '2031-01-01T10:00:00.010Z', $3,
          ST_SetSRID(ST_MakePoint(21.010, 52.010), 4326), 4.1, 1),
         ($1, $2, 20, 0, '2031-01-01T10:00:00.020Z', $3,
          ST_SetSRID(ST_MakePoint(21.020, 52.020), 4326), 4.2, 2),
         ($1, $2, 30, 0, '2031-01-01T10:00:00.030Z', $3,
          ST_SetSRID(ST_MakePoint(21.030, 52.030), 4326), 4.3, 1),
         ($1, $2, 40, 0, '2031-01-01T10:00:00.040Z', $3,
          ST_SetSRID(ST_MakePoint(21.040, 52.040), 4326), 4.4, 2),
         ($1, $2, 50, 0, '2031-01-01T10:00:00.050Z', $3,
          ST_SetSRID(ST_MakePoint(21.050, 52.050), 4326), 4.5, 1),
         ($1, $4, 10, 0, '2031-01-01T10:00:00.010Z', $3,
          ST_SetSRID(ST_MakePoint(21.010, 52.010), 4326), 4.1, 1)`,
      [ids.orgA, runIds.recording, '2031-01-01T10:01:00.000Z', runIds.unavailable],
    );
  }

  it('returns new points plus immediate successors and keeps A/T fixed across pages', async () => {
    const first = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.recording, '?afterRevision=1&limit=2').expect(200),
      ),
    );
    expect(first).toMatchObject({
      algorithmVersion: 'v1',
      fromRevision: '1',
      toRevision: '2',
    });
    expect(first.upserts.map(({ seq }) => seq)).toEqual(['20', '30']);
    expect(first.upserts.every(({ connectFromPrevious }) => !connectFromPrevious)).toBe(true);
    expect(first.upserts.map(({ predecessorSeq }) => predecessorSeq)).toEqual(['10', '20']);
    expect(first.nextCursor).not.toBeNull();

    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES ($1, $2, 25, 0, $3, $4,
                 ST_SetSRID(ST_MakePoint(21.025, 52.025), 4326), 4.25, 3)`,
      [
        ids.orgA,
        runIds.recording,
        '2031-01-01T10:00:00.025Z',
        '2031-01-01T10:01:00.000Z',
      ],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 3 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.recording],
    );

    const continuationUrl = `?cursor=${encodeURIComponent(first.nextCursor!)}`;
    const second = liveTrackResponseSchema.parse(
      objectBody(await readChanges(ids.userDual, runIds.recording, continuationUrl).expect(200)),
    );
    expect(second).toMatchObject({
      fromRevision: '1',
      nextCursor: null,
      toRevision: '2',
    });
    expect(second.upserts.map(({ seq }) => seq)).toEqual(['40', '50']);
    expect(second.upserts.map(({ predecessorSeq }) => predecessorSeq)).toEqual(['30', '40']);

    const retry = liveTrackResponseSchema.parse(
      objectBody(await readChanges(ids.userDual, runIds.recording, continuationUrl).expect(200)),
    );
    expect(retry).toEqual(second);

    const fresh = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.recording, '?afterRevision=2').expect(200),
      ),
    );
    expect(fresh).toMatchObject({ fromRevision: '2', nextCursor: null, toRevision: '3' });
    expect(fresh.upserts.map(({ seq }) => seq)).toEqual(['25', '30']);
    expect(fresh.upserts.map(({ predecessorSeq }) => predecessorSeq)).toEqual(['20', '25']);
  });

  it('repairs both accepted edges around a late insertion across page boundaries', async () => {
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES
         ($1, $2, 1, 0, '2031-01-01T10:00:00.000Z', $3,
          ST_SetSRID(ST_MakePoint(21.00000, 52.00000), 4326), 5, 1),
         ($1, $2, 3, 0, '2031-01-01T10:00:02.000Z', $3,
          ST_SetSRID(ST_MakePoint(21.00002, 52.00000), 4326), 5, 1),
         ($1, $2, 2, 0, '2031-01-01T10:00:01.000Z', $3,
          ST_SetSRID(ST_MakePoint(21.00001, 52.00000), 4326), 5, 2)`,
      [ids.orgA, runIds.empty, '2031-01-01T10:01:00.000Z'],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 2 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.empty],
    );

    const first = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.empty, '?afterRevision=1&limit=1').expect(200),
      ),
    );
    expect(first.upserts).toMatchObject([
      { connectFromPrevious: true, predecessorSeq: '1', seq: '2' },
    ]);

    const second = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(
          ids.userDual,
          runIds.empty,
          `?cursor=${encodeURIComponent(first.nextCursor!)}`,
        ).expect(200),
      ),
    );
    expect(second.upserts).toMatchObject([
      { connectFromPrevious: true, predecessorSeq: '2', seq: '3' },
    ]);
  });

  it('returns an empty page when the client already has the target revision', async () => {
    const response = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.recording, '?afterRevision=2').expect(200),
      ),
    );
    expect(response).toEqual({
      algorithmVersion: 'v1',
      fromRevision: '2',
      nextCursor: null,
      toRevision: '2',
      upserts: [],
    });
  });

  it('deduplicates successors shared with consecutive and disjoint changed points', async () => {
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES ($1, $2, 21, 0, $3, $4,
                 ST_SetSRID(ST_MakePoint(21.021, 52.021), 4326), 4.21, 2)`,
      [
        ids.orgA,
        runIds.recording,
        '2031-01-01T10:00:00.021Z',
        '2031-01-01T10:01:00.000Z',
      ],
    );

    const response = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.recording, '?afterRevision=1').expect(200),
      ),
    );
    expect(response.upserts.map(({ seq }) => seq)).toEqual(['20', '21', '30', '40', '50']);
  });

  it('makes snapshot A plus changes through T set-equivalent to a fresh snapshot at T', async () => {
    await ownerPool.query(
      `DELETE FROM run_points
       WHERE org_id = $1 AND run_id = $2 AND ingested_revision = 2`,
      [ids.orgA, runIds.recording],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 1 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.recording],
    );
    const initial = liveTrackResponseSchema.parse(
      objectBody(await readSnapshot(ids.userDual, runIds.recording).expect(200)),
    );

    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES
         ($1, $2, 20, 0, '2031-01-01T10:00:00.020Z', $3,
          ST_SetSRID(ST_MakePoint(21.020, 52.020), 4326), 4.2, 2),
         ($1, $2, 40, 0, '2031-01-01T10:00:00.040Z', $3,
          ST_SetSRID(ST_MakePoint(21.040, 52.040), 4326), 4.4, 2)`,
      [ids.orgA, runIds.recording, '2031-01-01T10:01:00.000Z'],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 2 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.recording],
    );

    const changes = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.recording, '?afterRevision=1').expect(200),
      ),
    );
    const fresh = liveTrackResponseSchema.parse(
      objectBody(await readSnapshot(ids.userDual, runIds.recording).expect(200)),
    );
    const applied = new Map(initial.upserts.map((point) => [point.seq, point]));
    for (const point of changes.upserts) applied.set(point.seq, point);

    expect(
      [...applied.values()].sort((left, right) =>
        BigInt(left.seq) < BigInt(right.seq) ? -1 : 1,
      ),
    ).toEqual(fresh.upserts);
  });

  it('paginates bigint successors without converting sequence values to numbers', async () => {
    const changedSequence = '9007199254740992';
    const successorSequence = '9007199254740993';
    await ownerPool.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       ) VALUES
         ($1, $2, $3, 0, $5, $5, ST_SetSRID(ST_MakePoint(21, 52), 4326), 5, 2),
         ($1, $2, $4, 0, $5, $5, ST_SetSRID(ST_MakePoint(21, 52), 4326), 5, 1)`,
      [
        ids.orgA,
        runIds.empty,
        changedSequence,
        successorSequence,
        '2031-01-01T10:00:00.000Z',
      ],
    );
    await ownerPool.query(
      'UPDATE runs SET data_revision = 2 WHERE org_id = $1 AND id = $2',
      [ids.orgA, runIds.empty],
    );

    const first = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.empty, '?afterRevision=1&limit=1').expect(200),
      ),
    );
    expect(first.upserts.map(({ seq }) => seq)).toEqual([changedSequence]);
    const second = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(
          ids.userDual,
          runIds.empty,
          `?cursor=${encodeURIComponent(first.nextCursor!)}`,
        ).expect(200),
      ),
    );
    expect(second.upserts.map(({ seq }) => seq)).toEqual([successorSequence]);
  });

  it('rechecks current authorization and raw state on every continuation page', async () => {
    const first = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.recording, '?afterRevision=1&limit=1').expect(200),
      ),
    );
    await ownerPool.query(
      `UPDATE runs
       SET status = 'finished', finished_at = $3
       WHERE org_id = $1 AND id = $2`,
      [ids.orgA, runIds.recording, '2031-01-02T00:00:00.000Z'],
    );
    const denied = await readChanges(
      ids.userDual,
      runIds.recording,
      `?cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(denied)).error.code).toBe('RUN_NOT_FOUND');

    await ownerPool.query(
      `UPDATE run_shares
       SET can_read_history = true
       WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
      [ids.orgA, runIds.recording, ids.userDual],
    );
    await ownerPool.query(
      `UPDATE runs SET raw_state = 'purging' WHERE org_id = $1 AND id = $2`,
      [ids.orgA, runIds.recording],
    );
    const unavailable = await readChanges(
      ids.userDual,
      runIds.recording,
      `?cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(unavailable)).error.code).toBe(
      'RAW_HISTORY_UNAVAILABLE',
    );
  });

  it('rejects future revisions, malformed queries, foreign cursors, and cursor operation swaps', async () => {
    const future = await readChanges(
      ids.userDual,
      runIds.recording,
      '?afterRevision=3',
    ).expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(future)).error.code).toBe('INVALID_REQUEST');

    for (const query of [
      '',
      '?afterRevision=1&cursor=both',
      '?cursor=not-a-cursor!',
      '?afterRevision=1&limit=0',
      '?afterRevision=1&limit=1001',
      '?afterRevision=1&extra=true',
    ]) {
      const invalid = await readChanges(ids.userDual, runIds.recording, query).expect(400);
      expect(apiErrorResponseSchema.parse(objectBody(invalid)).error.code).toMatch(
        /INVALID_(?:REQUEST|CURSOR)/u,
      );
    }

    const changePage = liveTrackResponseSchema.parse(
      objectBody(
        await readChanges(ids.userDual, runIds.recording, '?afterRevision=1&limit=1').expect(200),
      ),
    );
    const foreign = await readChanges(
      ids.userDual,
      runIds.empty,
      `?cursor=${encodeURIComponent(changePage.nextCursor!)}`,
    ).expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(foreign)).error.code).toBe('INVALID_CURSOR');

    const snapshot = liveTrackResponseSchema.parse(
      objectBody(await readSnapshot(ids.userDual, runIds.recording, '?limit=1').expect(200)),
    );
    const wrongOperation = await readChanges(
      ids.userDual,
      runIds.recording,
      `?cursor=${encodeURIComponent(snapshot.nextCursor!)}`,
    ).expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(wrongOperation)).error.code).toBe(
      'INVALID_CURSOR',
    );
  });

  it('checks session, membership, and authorization before retention state', async () => {
    await request(app)
      .get(`/api/orgs/${ids.orgA}/runs/${runIds.recording}/live-track/changes?afterRevision=1`)
      .expect(401);
    const inactive = await readChanges(
      ids.userInactive,
      runIds.recording,
      '?afterRevision=1',
    ).expect(403);
    expect(apiErrorResponseSchema.parse(objectBody(inactive)).error.code).toBe(
      'ORG_ACCESS_DENIED',
    );

    const authorized = await readChanges(
      ids.userDual,
      runIds.unavailable,
      '?afterRevision=1',
    ).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(authorized)).error.code).toBe(
      'RAW_HISTORY_UNAVAILABLE',
    );
    const hidden = await readChanges(
      ids.userOrgA,
      runIds.unavailable,
      '?afterRevision=1',
    ).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(hidden)).error.code).toBe('RUN_NOT_FOUND');
  });
});
