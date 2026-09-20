import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  TenantTransactionRolledBackError,
  withTenantTransaction,
} from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

describe('P02A tenant isolation', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const config = loadIntegrationTestConfiguration();
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-test-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-test-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });

    await prepareTenantIsolationFixtures(ownerPool, config.migration);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  it('exposes only the current identity, organization, and active membership', async () => {
    const result = await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userOrgA },
      async (client) => {
        const users = await client.query<{ id: string }>('SELECT id FROM users');
        const organizations = await client.query<{ id: string }>('SELECT id FROM organizations');
        const memberships = await client.query<{ org_id: string; user_id: string }>(
          'SELECT org_id, user_id FROM memberships',
        );
        return { memberships: memberships.rows, organizations: organizations.rows, users: users.rows };
      },
    );

    expect(result).toEqual({
      memberships: [{ org_id: ids.orgA, user_id: ids.userOrgA }],
      organizations: [{ id: ids.orgA }],
      users: [{ id: ids.userOrgA }],
    });
  });

  it('switches one user between memberships without cross-organization reads', async () => {
    const readOrganization = (orgId: string) =>
      withTenantTransaction(runtimePool, { orgId, userId: ids.userDual }, async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM organizations');
        return result.rows.map(({ id }) => id);
      });

    await expect(readOrganization(ids.orgA)).resolves.toEqual([ids.orgA]);
    await expect(readOrganization(ids.orgB)).resolves.toEqual([ids.orgB]);
  });

  it('fails closed for missing, malformed, absent, and inactive membership contexts', async () => {
    const missingContext = await runtimePool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM organizations',
    );
    expect(missingContext.rows[0]?.count).toBe('0');

    const malformedClient = await runtimePool.connect();
    try {
      await malformedClient.query('BEGIN');
      await malformedClient.query("SELECT set_config('app.user_id', 'invalid', true)");
      await malformedClient.query("SELECT set_config('app.org_id', 'invalid', true)");
      const malformed = await malformedClient.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM organizations',
      );
      expect(malformed.rows[0]?.count).toBe('0');
      await malformedClient.query('ROLLBACK');
    } finally {
      malformedClient.release();
    }

    for (const userId of [ids.userOrgB, ids.userInactive]) {
      const count = await withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId },
        async (client) => {
          const result = await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM organizations',
          );
          return result.rows[0]?.count;
        },
      );
      expect(count).toBe('0');
    }
  });

  it('enforces identity constraints and retains principals for inactive membership', async () => {
    await expect(
      ownerPool.query(
        `INSERT INTO organizations (id, archive_revision)
         VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', -1)`,
      ),
    ).rejects.toThrow(/organizations_archive_revision_nonnegative/u);
    await expect(
      ownerPool.query(
        `INSERT INTO users (id, external_identity)
         VALUES ('55555555-5555-4555-8555-555555555555', 'fixture-org-a')`,
      ),
    ).rejects.toThrow(/users_external_identity_unique/u);
    await expect(
      ownerPool.query(
        `INSERT INTO memberships (org_id, user_id, role)
         VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1, 'runner')`,
        [ids.userOrgA],
      ),
    ).rejects.toThrow(/memberships_organization_fk/u);
    await expect(
      ownerPool.query(
        `INSERT INTO memberships (org_id, user_id, role)
         VALUES ($1, $2, 'administrator')`,
        [ids.orgA, ids.userOrgB],
      ),
    ).rejects.toThrow(/memberships_role_known/u);

    const retained = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM memberships AS membership
       JOIN users AS app_user ON app_user.id = membership.user_id
       JOIN organizations AS organization ON organization.id = membership.org_id
       WHERE membership.user_id = $1 AND membership.org_id = $2 AND NOT membership.active`,
      [ids.userInactive, ids.orgA],
    );
    expect(retained.rows[0]?.count).toBe('1');
  });

  it('denies INSERT, UPDATE, and DELETE to the runtime role', async () => {
    const statements = [
      `INSERT INTO organizations (id) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc')`,
      'UPDATE organizations SET archive_revision = archive_revision + 1',
      'DELETE FROM memberships',
    ];

    for (const statement of statements) {
      await expect(
        withTenantTransaction(
          runtimePool,
          { orgId: ids.orgA, userId: ids.userOrgA },
          (client) => client.query(statement),
        ),
      ).rejects.toThrow(/permission denied/u);
    }
  });

  it('commits successful callbacks and rolls back failed callbacks', async () => {
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        async (client) => {
          const result = await client.query<{ visible: boolean }>(
            'SELECT app_private.has_active_membership() AS visible',
          );
          return result.rows[0]?.visible;
        },
      ),
    ).resolves.toBe(true);

    const callbackError = new Error('deliberate callback failure');
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        () => Promise.reject(callbackError),
      ),
    ).rejects.toBe(callbackError);
    await expect(runtimePool.query('SELECT 1')).resolves.toBeDefined();
  });

  it('rejects a value returned after the callback catches an aborted-transaction error', async () => {
    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        async (client) => {
          try {
            await client.query('SELECT 1 / 0');
          } catch {
            // Simulates application code swallowing an SQL error without a savepoint recovery.
          }
          return 'must not be returned';
        },
      ),
    ).rejects.toBeInstanceOf(TenantTransactionRolledBackError);
  });

  it('does not retain context when one physical connection is reused', async () => {
    const firstPid = await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userOrgA },
      async (client) => {
        const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return result.rows[0]?.pid;
      },
    );

    const between = await runtimePool.query<{ org_id: string; pid: number; user_id: string }>(
      `SELECT pg_backend_pid() AS pid,
              current_setting('app.user_id', true) AS user_id,
              current_setting('app.org_id', true) AS org_id`,
    );
    expect(between.rows[0]).toEqual({ org_id: '', pid: firstPid, user_id: '' });

    const second = await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgB, userId: ids.userOrgB },
      async (client) => {
        const result = await client.query<{ id: string; pid: number }>(
          'SELECT id, pg_backend_pid() AS pid FROM organizations',
        );
        return result.rows[0];
      },
    );
    expect(second).toEqual({ id: ids.orgB, pid: firstPid });
  });

  it('keeps concurrent transaction contexts independent', async () => {
    const readContext = (orgId: string, userId: string) =>
      withTenantTransaction(runtimePool, { orgId, userId }, async (client) => {
        await client.query('SELECT pg_sleep(0.05)');
        const result = await client.query<{ org_id: string; user_id: string }>(
          `SELECT current_setting('app.org_id', true) AS org_id,
                  current_setting('app.user_id', true) AS user_id`,
        );
        return result.rows[0];
      });

    await expect(
      Promise.all([
        readContext(ids.orgA, ids.userOrgA),
        readContext(ids.orgB, ids.userOrgB),
      ]),
    ).resolves.toEqual([
      { org_id: ids.orgA, user_id: ids.userOrgA },
      { org_id: ids.orgB, user_id: ids.userOrgB },
    ]);
  });

  it('keeps runtime non-owner, non-superuser, without BYPASSRLS or DDL', async () => {
    const role = await runtimePool.query<{
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolsuper: false,
    });

    const owner = await runtimePool.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner
       FROM pg_class
       WHERE oid = 'public.organizations'::regclass`,
    );
    expect(owner.rows[0]?.owner).toBe('running_tracker_owner');

    await expect(runtimePool.query('CREATE TABLE runtime_must_not_create (id integer)')).rejects.toThrow(
      /permission denied/u,
    );
    await expect(runtimePool.query('ALTER TABLE organizations DISABLE ROW LEVEL SECURITY')).rejects.toThrow(
      /must be owner|permission denied/u,
    );
    await expect(runtimePool.query('SELECT * FROM schema_migrations')).rejects.toThrow(
      /permission denied/u,
    );
  });

  it('keeps the maintenance role separate and without P02A table access', async () => {
    const role = await maintenancePool.query<{
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    expect(role.rows[0]).toEqual({
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolsuper: false,
    });
    await expect(maintenancePool.query('SELECT * FROM organizations')).rejects.toThrow(
      /permission denied/u,
    );
    await expect(maintenancePool.query('CREATE TABLE maintenance_must_not_create (id integer)')).rejects.toThrow(
      /permission denied/u,
    );
  });
});
