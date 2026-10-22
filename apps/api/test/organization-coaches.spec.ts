import request from 'supertest';
import type { PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { sessionCookieName } from '../src/auth/session-http.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { DatabasePool } from '../src/database/database.js';

const user = '11111111-1111-4111-8111-111111111111';
const coachA = '33333333-3333-4333-8333-333333333333';
const coachB = '44444444-4444-4444-8444-444444444444';
const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const config = validateEnvironment({
  ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
  LOCAL_AUTH_ENABLED: 'true',
  LOCAL_AUTH_USER_IDS: user,
  MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/test',
  SESSION_COOKIE_SECURE: 'false',
});

// A pool that records every statement, answers the membership check with `member` and the discovery query with
// the given rows.
function stubPool(rows: ReadonlyArray<{ user_id: string }>, member = true) {
  const statements: string[] = [];
  const client = {
    query: vi.fn((text: string) => {
      statements.push(text);
      const result: Partial<QueryResult> = { command: text === 'COMMIT' ? 'COMMIT' : 'SELECT', rows: [] };
      if (text.includes('FROM memberships')) {
        result.rows = [{ allowed: member }];
      } else if (text.includes('list_current_org_coaches')) {
        result.rows = [...rows];
      }
      return Promise.resolve(result);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const connect = vi.fn(() => Promise.resolve(client));
  const pool: DatabasePool = { connect };
  return { connect, pool, statements };
}

function appWith(rows: ReadonlyArray<{ user_id: string }>, member = true) {
  const sessionManager = new SessionManager({
    clock: systemClock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    ttlMs: config.SESSION_TTL_MS,
  });
  const database = stubPool(rows, member);
  const app = createApp({ clock: systemClock, config, pool: database.pool, sessionManager });
  const cookie = `${sessionCookieName}=${sessionManager.create(user).sessionToken}`;
  return { app, cookie, database };
}

describe('GET /api/orgs/:orgId/coaches', () => {
  it('requires a session and does not touch the database without one', async () => {
    const { app, database } = appWith([{ user_id: coachA }]);

    const response = await request(app).get(`/api/orgs/${orgA}/coaches`);

    expect(response.status).toBe(401);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('returns the identifiers the database function reports, in that order, uncached', async () => {
    const { app, cookie, database } = appWith([{ user_id: coachA }, { user_id: coachB }]);

    const response = await request(app).get(`/api/orgs/${orgA}/coaches`).set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ items: [{ userId: coachA }, { userId: coachB }] });
    // The membership is checked inside the same transaction before the function is asked.
    const membership = database.statements.findIndex((text) => text.includes('FROM memberships'));
    const discovery = database.statements.findIndex((text) => text.includes('list_current_org_coaches'));
    expect(membership).toBeGreaterThan(-1);
    expect(discovery).toBeGreaterThan(membership);
  });

  it('refuses a non-member before asking for coaches', async () => {
    const { app, cookie, database } = appWith([{ user_id: coachA }], false);

    const response = await request(app).get(`/api/orgs/${orgA}/coaches`).set('Cookie', cookie);

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('ORG_ACCESS_DENIED');
    expect(database.statements.some((text) => text.includes('list_current_org_coaches'))).toBe(false);
  });

  it('refuses any query parameter and a malformed organization without touching the database', async () => {
    const { app, cookie, database } = appWith([{ user_id: coachA }]);

    const withQuery = await request(app).get(`/api/orgs/${orgA}/coaches`).query({ role: 'runner' }).set('Cookie', cookie);
    const malformed = await request(app).get('/api/orgs/not-a-uuid/coaches').set('Cookie', cookie);

    expect(withQuery.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('fails closed when the database returns something outside the contract', async () => {
    const { app, cookie } = appWith([{ user_id: 'not-a-uuid' }]);

    const response = await request(app).get(`/api/orgs/${orgA}/coaches`).set('Cookie', cookie);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('not-a-uuid');
  });
});
