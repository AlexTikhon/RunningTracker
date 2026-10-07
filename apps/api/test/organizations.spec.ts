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
const otherUser = '22222222-2222-4222-8222-222222222222';
const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const config = validateEnvironment({
  ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
  LOCAL_AUTH_ENABLED: 'true',
  LOCAL_AUTH_USER_IDS: `${user},${otherUser}`,
  MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/test',
  SESSION_COOKIE_SECURE: 'false',
});

// A pool that records every statement and answers the discovery query with the given rows. It lets this file
// check what the route asks the database and with which identity, without a database.
function stubPool(rows: ReadonlyArray<{ organization_id: string }>) {
  const statements: Array<{ parameters: unknown[] | undefined; text: string }> = [];
  const client = {
    query: vi.fn((text: string, parameters?: unknown[]) => {
      statements.push({ parameters, text });
      const result: Partial<QueryResult> = { command: text === 'COMMIT' ? 'COMMIT' : 'SELECT', rows: [] };
      if (text.includes('list_current_user_organizations')) {
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

function appWith(rows: ReadonlyArray<{ organization_id: string }>) {
  const sessionManager = new SessionManager({
    clock: systemClock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    ttlMs: config.SESSION_TTL_MS,
  });
  const database = stubPool(rows);
  const app = createApp({ clock: systemClock, config, pool: database.pool, sessionManager });
  const cookieFor = (userId: string): string =>
    `${sessionCookieName}=${sessionManager.create(userId).sessionToken}`;
  return { app, cookieFor, database };
}

describe('GET /api/organizations', () => {
  it('requires a session and does not touch the database without one', async () => {
    const { app, database } = appWith([{ organization_id: orgA }]);

    const response = await request(app).get('/api/organizations');

    expect(response.status).toBe(401);
    expect((response.body as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('returns the identifiers the database function reports, in that order, uncached', async () => {
    const { app, cookieFor } = appWith([{ organization_id: orgA }, { organization_id: orgB }]);

    const response = await request(app).get('/api/organizations').set('Cookie', cookieFor(user));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ items: [{ organizationId: orgA }, { organizationId: orgB }] });
  });

  it('answers an empty membership list with an empty array, not an authorization error', async () => {
    const { app, cookieFor } = appWith([]);

    const response = await request(app).get('/api/organizations').set('Cookie', cookieFor(user));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
  });

  it("asks only about the session's own identity and sets no organization", async () => {
    const { app, cookieFor, database } = appWith([{ organization_id: orgA }]);

    await request(app).get('/api/organizations').set('Cookie', cookieFor(otherUser));

    expect(database.statements.map(({ text, parameters }) => [text, parameters])).toEqual([
      ['BEGIN', undefined],
      ["SELECT set_config('app.user_id', $1, true)", [otherUser]],
      ['SELECT app_private.list_current_user_organizations() AS organization_id', undefined],
      ['COMMIT', undefined],
    ]);
  });

  it('refuses any query parameter instead of ignoring it, so no other user can be asked about', async () => {
    const { app, cookieFor, database } = appWith([{ organization_id: orgA }]);

    const response = await request(app)
      .get('/api/organizations')
      .query({ userId: otherUser })
      .set('Cookie', cookieFor(user));

    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('fails closed when the database returns something outside the contract', async () => {
    const { app, cookieFor } = appWith([{ organization_id: 'not-a-uuid' }]);

    const response = await request(app).get('/api/organizations').set('Cookie', cookieFor(user));

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('not-a-uuid');
  });
});
