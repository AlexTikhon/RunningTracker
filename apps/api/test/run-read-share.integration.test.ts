import {
  apiErrorResponseSchema,
  runListResponseSchema,
  runShareResponseSchema,
  runViewSchema,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
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
const tombstoneRunId = 'a3400000-0000-4000-8000-000000000001';

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse('2030-09-22T10:00:00.000Z');
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date('2030-09-22T10:00:00.000Z');
  }
}

interface Authentication {
  cookie: string;
  csrfToken: string;
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
  let first: unknown;
  if (typeof header === 'string') {
    first = header;
  } else if (Array.isArray(header)) {
    first = header[0] as unknown;
  }
  if (typeof first !== 'string') {
    throw new Error('Expected a session cookie');
  }
  return first.split(';', 1)[0]!;
}

function csrfToken(response: request.Response): string {
  const csrf = objectBody(response).csrf;
  if (!csrf || typeof csrf !== 'object' || Array.isArray(csrf)) {
    throw new Error('Expected CSRF data');
  }
  const token = (csrf as Record<string, unknown>).token;
  if (typeof token !== 'string') {
    throw new Error('Expected a CSRF token');
  }
  return token;
}

describe('P03.4 run list/read and share endpoints', () => {
  let app: ReturnType<typeof createApp>;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const authentication = new Map<string, Authentication>();

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const allowedUsers = [
      ids.userDual,
      ids.userInactive,
      ids.userOrgA,
      ids.userOrgB,
      ids.userStranger,
    ];
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: allowedUsers.join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 6 });
    ownerPool = new Pool({
      application_name: 'running-tracker-p034-fixtures',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
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
      authentication.set(userId, {
        cookie: cookiePair(login),
        csrfToken: csrfToken(login),
      });
    }
  });

  beforeEach(async () => {
    const integration = loadIntegrationTestConfiguration();
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);
    await ownerPool.query('DELETE FROM run_tombstones WHERE run_id = $1', [tombstoneRunId]);
  });

  afterAll(async () => {
    if (ownerPool) {
      await ownerPool.query('DELETE FROM run_tombstones WHERE run_id = $1', [tombstoneRunId]);
    }
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function read(userId: string, path: string) {
    const auth = authentication.get(userId);
    if (!auth) throw new Error(`Missing authentication for ${userId}`);
    return request(app).get(path).set('Cookie', auth.cookie);
  }

  function mutate(userId: string, method: 'delete' | 'post' | 'put', path: string) {
    const auth = authentication.get(userId);
    if (!auth) throw new Error(`Missing authentication for ${userId}`);
    const pending =
      method === 'delete'
        ? request(app).delete(path)
        : method === 'post'
          ? request(app).post(path)
          : request(app).put(path);
    return pending
      .set('Cookie', auth.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, auth.csrfToken);
  }

  function sharePath(runId: string, userId: string): string {
    return `/api/orgs/${ids.orgA}/runs/${runId}/shares/${userId}`;
  }

  it('lists only currently visible runs with deterministic keyset pagination and no duplicates', async () => {
    const path = `/api/orgs/${ids.orgA}/runs?from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z&limit=2`;
    const firstResponse = await read(ids.userDual, path).expect(200);
    const first = runListResponseSchema.parse(objectBody(firstResponse));
    expect(first.items.map(({ runId }) => runId)).toEqual([
      ids.runFinishedBoth,
      ids.runFinishedHistory,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await read(
      ids.userDual,
      `${path}&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ).expect(200);
    const second = runListResponseSchema.parse(objectBody(secondResponse));
    expect(second.items.map(({ runId }) => runId)).toEqual([
      ids.runPaused,
      ids.runRecording,
    ]);
    expect(second.nextCursor).toBeNull();

    const runIds = [...first.items, ...second.items].map(({ runId }) => runId);
    expect(new Set(runIds).size).toBe(runIds.length);
    expect(runIds).not.toContain(ids.runRecordingHistoryOnly);
    expect(runIds).not.toContain(ids.runFinishedLiveOnly);

    const ownedResponse = await read(
      ids.userOrgA,
      `/api/orgs/${ids.orgA}/runs?from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z`,
    ).expect(200);
    expect(
      runListResponseSchema.parse(objectBody(ownedResponse)).items.map(({ runId }) => runId),
    ).toEqual([
      ids.runFinishedBoth,
      ids.runFinishedLiveOnly,
      ids.runFinishedHistory,
      ids.runRecording,
    ]);
  });

  it('validates list authentication, half-open ranges, limits, and opaque cursors', async () => {
    const base = `/api/orgs/${ids.orgA}/runs`;
    await request(app)
      .get(`${base}?from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z`)
      .expect(401);

    const empty = await read(
      ids.userDual,
      `${base}?from=2026-09-20T08:00:00.001Z&to=2026-09-20T08:00:00.002Z`,
    ).expect(200);
    expect(runListResponseSchema.parse(objectBody(empty))).toEqual({ items: [], nextCursor: null });

    await read(
      ids.userDual,
      `${base}?from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z&limit=101`,
    )
      .expect(400)
      .expect((response) =>
        expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe(
          'INVALID_REQUEST',
        ),
      );

    await read(
      ids.userDual,
      `${base}?from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z&cursor=not-a-cursor!`,
    )
      .expect(400)
      .expect((response) =>
        expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('INVALID_CURSOR'),
      );
  });

  it('reads owned and correctly granted runs while hiding private and missing runs', async () => {
    const owned = await read(
      ids.userOrgA,
      `/api/orgs/${ids.orgA}/runs/${ids.runRecording}`,
    ).expect(200);
    expect(runViewSchema.parse(objectBody(owned)).runId).toBe(ids.runRecording);

    const liveShared = await read(
      ids.userDual,
      `/api/orgs/${ids.orgA}/runs/${ids.runRecording}`,
    ).expect(200);
    expect(runViewSchema.parse(objectBody(liveShared)).status).toBe('recording');

    const historyShared = await read(
      ids.userDual,
      `/api/orgs/${ids.orgA}/runs/${ids.runFinishedHistory}`,
    ).expect(200);
    expect(runViewSchema.parse(objectBody(historyShared)).summary).not.toBeNull();

    for (const runId of [ids.runRecordingHistoryOnly, ids.runFinishedLiveOnly]) {
      const denied = await read(
        ids.userDual,
        `/api/orgs/${ids.orgA}/runs/${runId}`,
      ).expect(404);
      expect(apiErrorResponseSchema.parse(objectBody(denied)).error.code).toBe('RUN_NOT_FOUND');
    }

    const missing = await read(
      ids.userDual,
      `/api/orgs/${ids.orgA}/runs/a9999999-9999-4999-8999-999999999999`,
    ).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(missing)).error.code).toBe('RUN_NOT_FOUND');
    await read(ids.userDual, `/api/orgs/${ids.orgA}/runs/not-a-uuid`).expect(400);
  });

  it('returns a tombstone only to its owner and hides it from other members', async () => {
    await ownerPool.query(
      `INSERT INTO run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ids.orgA,
        tombstoneRunId,
        ids.userDual,
        '2026-09-20T10:00:00.000Z',
        '2026-10-20T10:00:00.000Z',
      ],
    );
    const owner = await read(
      ids.userDual,
      `/api/orgs/${ids.orgA}/runs/${tombstoneRunId}`,
    ).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(owner)).error.code).toBe('RUN_DELETED');

    const unrelated = await read(
      ids.userStranger,
      `/api/orgs/${ids.orgA}/runs/${tombstoneRunId}`,
    ).expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(unrelated)).error.code).toBe('RUN_NOT_FOUND');
  });

  it('upserts a share idempotently under concurrency and grants read without mutation rights', async () => {
    const path = sharePath(ids.runFinishedLiveOnly, ids.userStranger);
    const body = { canReadHistory: true, canReadLive: false };
    const responses = await Promise.all([
      mutate(ids.userOrgA, 'put', path).type('application/json').send(body),
      mutate(ids.userOrgA, 'put', path).type('application/json').send(body),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    for (const response of responses) {
      expect(runShareResponseSchema.parse(objectBody(response))).toEqual(body);
    }

    const count = await ownerPool.query<{ count: string }>(
      `SELECT count(*) FROM run_shares
       WHERE org_id = $1 AND run_id = $2 AND grantee_user_id = $3`,
      [ids.orgA, ids.runFinishedLiveOnly, ids.userStranger],
    );
    expect(count.rows[0]?.count).toBe('1');
    await read(
      ids.userStranger,
      `/api/orgs/${ids.orgA}/runs/${ids.runFinishedLiveOnly}`,
    ).expect(200);

    const mutation = await mutate(
      ids.userStranger,
      'post',
      `/api/orgs/${ids.orgA}/runs/${ids.runFinishedLiveOnly}/commands`,
    )
      .type('application/json')
      .send({
        commandId: 'c3400000-0000-4000-8000-000000000001',
        expectedControlRevision: '0',
        type: 'finish',
      })
      .expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(mutation)).error.code).toBe('RUN_NOT_FOUND');
  });

  it('lets only the owner manage shares and keeps revoke idempotent', async () => {
    const path = sharePath(ids.runFinishedHistory, ids.userStranger);
    const denied = await mutate(ids.userDual, 'put', path)
      .type('application/json')
      .send({ canReadHistory: true, canReadLive: true })
      .expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(denied)).error.code).toBe('RUN_NOT_FOUND');

    await mutate(ids.userOrgA, 'put', path)
      .type('application/json')
      .send({ canReadHistory: true, canReadLive: false })
      .expect(200);
    await read(ids.userStranger, `/api/orgs/${ids.orgA}/runs/${ids.runFinishedHistory}`).expect(200);
    await mutate(ids.userOrgA, 'delete', path).expect(204);
    await mutate(ids.userOrgA, 'delete', path).expect(204);
    await read(ids.userStranger, `/api/orgs/${ids.orgA}/runs/${ids.runFinishedHistory}`).expect(404);
  });

  it('supports schema-permitted self-shares and rejects recipients outside the organization', async () => {
    const self = await mutate(
      ids.userOrgA,
      'put',
      sharePath(ids.runFinishedHistory, ids.userOrgA),
    )
      .type('application/json')
      .send({ canReadHistory: true, canReadLive: true })
      .expect(200);
    expect(runShareResponseSchema.parse(objectBody(self))).toEqual({
      canReadHistory: true,
      canReadLive: true,
    });

    const invalidRecipient = await mutate(
      ids.userOrgA,
      'put',
      sharePath(ids.runFinishedHistory, ids.userOrgB),
    )
      .type('application/json')
      .send({ canReadHistory: true, canReadLive: false })
      .expect(400);
    expect(apiErrorResponseSchema.parse(objectBody(invalidRecipient)).error.code).toBe(
      'INVALID_REQUEST',
    );
  });

  it('persists dormant inactive-member shares but active-membership checks still deny access', async () => {
    const path = sharePath(ids.runFinishedHistory, ids.userInactive);
    await mutate(ids.userOrgA, 'put', path)
      .type('application/json')
      .send({ canReadHistory: true, canReadLive: false })
      .expect(200);

    const denied = await read(
      ids.userInactive,
      `/api/orgs/${ids.orgA}/runs/${ids.runFinishedHistory}`,
    ).expect(403);
    expect(apiErrorResponseSchema.parse(objectBody(denied)).error.code).toBe('ORG_ACCESS_DENIED');
  });

  it('handles missing and deleted owned runs without leaking them through share operations', async () => {
    const missing = await mutate(
      ids.userOrgA,
      'put',
      sharePath('a9999999-9999-4999-8999-999999999999', ids.userStranger),
    )
      .type('application/json')
      .send({ canReadHistory: true, canReadLive: false })
      .expect(404);
    expect(apiErrorResponseSchema.parse(objectBody(missing)).error.code).toBe('RUN_NOT_FOUND');

    await ownerPool.query(
      `INSERT INTO run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ids.orgA,
        tombstoneRunId,
        ids.userOrgA,
        '2026-09-20T10:00:00.000Z',
        '2026-10-20T10:00:00.000Z',
      ],
    );
    const deleted = await mutate(
      ids.userOrgA,
      'put',
      sharePath(tombstoneRunId, ids.userStranger),
    )
      .type('application/json')
      .send({ canReadHistory: true, canReadLive: false })
      .expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(deleted)).error.code).toBe('RUN_DELETED');
  });
});
