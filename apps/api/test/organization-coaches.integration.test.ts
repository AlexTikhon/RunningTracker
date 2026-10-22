import { randomUUID } from 'node:crypto';

import { organizationCoachListResponseSchema } from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { sessionCookieName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

// In the fixtures, organization A has one active coach (userStranger) and organization B one (userDual, who is a
// runner in A). Every other membership is a runner, and userInactive is an inactive runner of A.
const extraCoachId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';

describe('coach discovery against PostgreSQL row-level security', () => {
  let app: ReturnType<typeof createApp>;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: ReturnType<typeof createDatabasePool>;
  let sessionManager: SessionManager;

  beforeAll(() => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    const config = validateEnvironment({
      ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: ids.userDual,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-coach-discovery-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-coach-discovery-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 1,
    });
    sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    app = createApp({ clock: systemClock, config, pool: runtimePool, sessionManager });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  function cookieFor(userId: string): string {
    return `${sessionCookieName}=${sessionManager.create(userId).sessionToken}`;
  }

  async function coachesSeenBy(userId: string, orgId: string): Promise<string[]> {
    const response = await request(app).get(`/api/orgs/${orgId}/coaches`).set('Cookie', cookieFor(userId));
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return organizationCoachListResponseSchema.parse(response.body).items.map((item) => item.userId);
  }

  async function addCoach(orgId: string, userId: string, active: boolean): Promise<void> {
    await ownerPool.query(
      "INSERT INTO users (id, external_identity) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [userId, `fixture-coach-${userId}`],
    );
    await ownerPool.query(
      "INSERT INTO memberships (org_id, user_id, role, active) VALUES ($1, $2, 'coach', $3)",
      [orgId, userId, active],
    );
  }

  it('is refused without a session', async () => {
    const response = await request(app).get(`/api/orgs/${ids.orgA}/coaches`);

    expect(response.status).toBe(401);
  });

  it("lists the active coaches of the caller's organization and nobody else", async () => {
    await expect(coachesSeenBy(ids.userOrgA, ids.orgA)).resolves.toEqual([ids.userStranger]);
    await expect(coachesSeenBy(ids.userOrgB, ids.orgB)).resolves.toEqual([ids.userDual]);
  });

  it('never lists runners, an inactive coach, or a coach of another organization', async () => {
    await addCoach(ids.orgA, extraCoachId, false);

    const listed = await coachesSeenBy(ids.userOrgA, ids.orgA);

    expect(listed).toEqual([ids.userStranger]);
    expect(listed).not.toContain(ids.userDual); // a runner in A, a coach in B
    expect(listed).not.toContain(ids.userInactive);
    expect(listed).not.toContain(extraCoachId);
  });

  it('follows a coach membership that is deactivated later', async () => {
    await ownerPool.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [
      ids.orgA,
      ids.userStranger,
    ]);

    await expect(coachesSeenBy(ids.userOrgA, ids.orgA)).resolves.toEqual([]);
  });

  it('does not list the caller, even when the caller is a coach', async () => {
    await expect(coachesSeenBy(ids.userDual, ids.orgB)).resolves.toEqual([]);
    await expect(coachesSeenBy(ids.userStranger, ids.orgA)).resolves.toEqual([]);
  });

  it('refuses a person without an active membership in the organization', async () => {
    for (const [userId, orgId] of [
      [ids.userOrgB, ids.orgA],
      [ids.userOrgA, ids.orgB],
      [ids.userInactive, ids.orgA],
    ] as const) {
      const response = await request(app).get(`/api/orgs/${orgId}/coaches`).set('Cookie', cookieFor(userId));
      expect(response.status).toBe(403);
      expect((response.body as { error: { code: string } }).error.code).toBe('ORG_ACCESS_DENIED');
      expect(JSON.stringify(response.body)).not.toContain(ids.userStranger);
    }
  });

  it('refuses any query parameter instead of ignoring it', async () => {
    const response = await request(app)
      .get(`/api/orgs/${ids.orgA}/coaches`)
      .query({ role: 'runner' })
      .set('Cookie', cookieFor(ids.userOrgA));

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(ids.userStranger);
  });

  it('returns at most 100 coaches in identifier order', async () => {
    const coachIds = Array.from({ length: 101 }, () => randomUUID());
    await ownerPool.query(
      "INSERT INTO users (id, external_identity) SELECT id, 'fixture-many-' || id FROM unnest($1::uuid[]) AS id",
      [coachIds],
    );
    await ownerPool.query(
      "INSERT INTO memberships (org_id, user_id, role, active) SELECT $1, unnest($2::uuid[]), 'coach', true",
      [ids.orgA, coachIds],
    );

    const listed = await coachesSeenBy(ids.userOrgA, ids.orgA);

    expect(listed).toHaveLength(100);
    expect(listed).toEqual([...coachIds, ids.userStranger].sort().slice(0, 100));
  });

  describe('what the database function does and does not open up', () => {
    async function asTenant(userId: string, orgId: string): Promise<string[]> {
      const result = await withTenantTransaction(runtimePool, { orgId, userId }, (client) =>
        client.query<{ user_id: string }>('SELECT app_private.list_current_org_coaches() AS user_id'),
      );
      return result.rows.map((row) => row.user_id);
    }

    it('answers nothing for an organization the identity is not an active member of', async () => {
      await expect(asTenant(ids.userOrgB, ids.orgA)).resolves.toEqual([]);
      await expect(asTenant(ids.userInactive, ids.orgA)).resolves.toEqual([]);
      await expect(asTenant(ids.userOrgA, ids.orgA)).resolves.toEqual([ids.userStranger]);
    });

    it('returns nothing when no identity or organization was declared', async () => {
      const client = await runtimePool.connect();
      try {
        const result = await client.query('SELECT app_private.list_current_org_coaches()');
        expect(result.rows).toEqual([]);
      } finally {
        client.release();
      }
    });

    it('does not widen what the runtime role can read directly from memberships', async () => {
      const visible = await withTenantTransaction(runtimePool, { orgId: ids.orgA, userId: ids.userOrgA }, (client) =>
        client.query<{ user_id: string }>('SELECT user_id FROM memberships ORDER BY user_id'),
      );

      expect(visible.rows.map((row) => row.user_id)).toEqual([ids.userOrgA]);
    });

    it('is executable by the runtime role only and takes no argument', async () => {
      const privileges = await ownerPool.query<{ maintenance: boolean; pub: boolean; runtime: boolean }>(
        `SELECT has_function_privilege('running_tracker_runtime', 'app_private.list_current_org_coaches()', 'EXECUTE') AS runtime,
                has_function_privilege('running_tracker_maintenance', 'app_private.list_current_org_coaches()', 'EXECUTE') AS maintenance,
                has_function_privilege('public', 'app_private.list_current_org_coaches()', 'EXECUTE') AS pub`,
      );

      expect(privileges.rows[0]).toEqual({ maintenance: false, pub: false, runtime: true });
      await expect(maintenancePool.query('SELECT app_private.list_current_org_coaches()')).rejects.toThrow(
        /permission denied/u,
      );
    });
  });
});
