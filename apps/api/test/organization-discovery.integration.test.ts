import { randomUUID } from 'node:crypto';

import { organizationListResponseSchema } from '@running-tracker/contracts';
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
import { withUserTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const extraUserId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('organization discovery against PostgreSQL row-level security', () => {
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
      application_name: 'running-tracker-organization-discovery-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-organization-discovery-maintenance',
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

  async function organizationsOf(userId: string): Promise<string[]> {
    const cookie = `${sessionCookieName}=${sessionManager.create(userId).sessionToken}`;
    const response = await request(app).get('/api/organizations').set('Cookie', cookie);
    expect(response.status).toBe(200);
    return organizationListResponseSchema.parse(response.body).items.map((item) => item.organizationId);
  }

  it('is refused without a session', async () => {
    const response = await request(app).get('/api/organizations');

    expect(response.status).toBe(401);
  });

  it('lists the one organization of a member of one organization', async () => {
    await expect(organizationsOf(ids.userOrgB)).resolves.toEqual([ids.orgB]);
    await expect(organizationsOf(ids.userOrgA)).resolves.toEqual([ids.orgA]);
  });

  it('lists several organizations in a fixed order', async () => {
    const first = await organizationsOf(ids.userDual);
    const second = await organizationsOf(ids.userDual);

    expect(first).toEqual([ids.orgA, ids.orgB]);
    expect(second).toEqual(first);
    expect([...first].sort()).toEqual(first);
  });

  it('omits an inactive membership and follows a membership that is deactivated later', async () => {
    await expect(organizationsOf(ids.userInactive)).resolves.toEqual([]);

    await ownerPool.query('UPDATE memberships SET active = false WHERE user_id = $1 AND org_id = $2', [
      ids.userDual,
      ids.orgB,
    ]);

    await expect(organizationsOf(ids.userDual)).resolves.toEqual([ids.orgA]);
  });

  it("never shows another user's organization", async () => {
    await expect(organizationsOf(ids.userOrgB)).resolves.not.toContain(ids.orgA);
    await expect(organizationsOf(ids.userStranger)).resolves.not.toContain(ids.orgB);
    await expect(organizationsOf(ids.userOrgA)).resolves.not.toContain(ids.orgB);
  });

  it('answers a person with no membership at all with an empty list', async () => {
    await ownerPool.query("INSERT INTO users (id, external_identity) VALUES ($1, 'fixture-no-membership')", [
      extraUserId,
    ]);

    await expect(organizationsOf(extraUserId)).resolves.toEqual([]);
  });

  it('cannot be pointed at another user through the request', async () => {
    const cookie = `${sessionCookieName}=${sessionManager.create(ids.userOrgB).sessionToken}`;

    const response = await request(app)
      .get('/api/organizations')
      .query({ userId: ids.userDual })
      .set('Cookie', cookie);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(ids.orgA);
  });

  it('returns at most 100 organizations', async () => {
    const organizationIds = Array.from({ length: 101 }, () => randomUUID());
    await ownerPool.query("INSERT INTO users (id, external_identity) VALUES ($1, 'fixture-many-organizations')", [
      extraUserId,
    ]);
    await ownerPool.query('INSERT INTO organizations (id) SELECT unnest($1::uuid[])', [organizationIds]);
    await ownerPool.query(
      "INSERT INTO memberships (org_id, user_id, role, active) SELECT unnest($1::uuid[]), $2, 'runner', true",
      [organizationIds, extraUserId],
    );

    const listed = await organizationsOf(extraUserId);

    expect(listed).toHaveLength(100);
    expect(listed).toEqual([...organizationIds].sort().slice(0, 100));
  });

  describe('what the database function does and does not open up', () => {
    it('answers only for the identity the transaction was opened for', async () => {
      const asOrgBUser = await withUserTransaction(runtimePool, { userId: ids.userOrgB }, (client) =>
        client.query<{ organization_id: string }>(
          'SELECT app_private.list_current_user_organizations() AS organization_id',
        ),
      );
      expect(asOrgBUser.rows.map((row) => row.organization_id)).toEqual([ids.orgB]);
    });

    it('returns nothing when no identity was declared', async () => {
      const client = await runtimePool.connect();
      try {
        const result = await client.query('SELECT app_private.list_current_user_organizations()');
        expect(result.rows).toEqual([]);
      } finally {
        client.release();
      }
    });

    it('does not widen what the runtime role can read directly from the tables', async () => {
      const visible = await withUserTransaction(runtimePool, { userId: ids.userDual }, async (client) => {
        const memberships = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM memberships');
        const organizations = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM organizations');
        return { memberships: memberships.rows[0]?.count, organizations: organizations.rows[0]?.count };
      });

      expect(visible).toEqual({ memberships: 0, organizations: 0 });
    });

    it('is executable by the runtime role only and takes no argument', async () => {
      const privileges = await ownerPool.query<{ maintenance: boolean; pub: boolean; runtime: boolean }>(
        `SELECT has_function_privilege('running_tracker_runtime', 'app_private.list_current_user_organizations()', 'EXECUTE') AS runtime,
                has_function_privilege('running_tracker_maintenance', 'app_private.list_current_user_organizations()', 'EXECUTE') AS maintenance,
                has_function_privilege('public', 'app_private.list_current_user_organizations()', 'EXECUTE') AS pub`,
      );

      expect(privileges.rows[0]).toEqual({ maintenance: false, pub: false, runtime: true });
      await expect(
        maintenancePool.query('SELECT app_private.list_current_user_organizations()'),
      ).rejects.toThrow(/permission denied/u);
    });
  });
});
