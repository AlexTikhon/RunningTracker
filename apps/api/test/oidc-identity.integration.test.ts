import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseIdentityResolver } from '../src/auth/identity-resolver.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

describe('login identity resolution against PostgreSQL', () => {
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(() => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    ownerPool = new Pool({
      application_name: 'running-tracker-p121-owner',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p121-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 2,
    });
    runtimePool = new Pool({
      application_name: 'running-tracker-p121-runtime',
      connectionString: integration.runtime.connectionString,
      max: 2,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  it('resolves a provisioned identity to its user as the runtime role', async () => {
    const resolve = createDatabaseIdentityResolver(runtimePool);

    await expect(resolve('fixture-dual')).resolves.toBe(ids.userDual);
    await expect(resolve('fixture-stranger')).resolves.toBe(ids.userStranger);
  });

  it('resolves nothing for an unknown, blank, or differently cased identity', async () => {
    const resolve = createDatabaseIdentityResolver(runtimePool);

    await expect(resolve('fixture-unknown')).resolves.toBeUndefined();
    await expect(resolve('')).resolves.toBeUndefined();
    await expect(resolve('   ')).resolves.toBeUndefined();
    await expect(resolve('FIXTURE-DUAL')).resolves.toBeUndefined();
    await expect(resolve("fixture-dual' OR '1'='1")).resolves.toBeUndefined();
  });

  it('does not create users and does not widen what the runtime role can read', async () => {
    const resolve = createDatabaseIdentityResolver(runtimePool);
    const before = await ownerPool.query('SELECT count(*)::int AS count FROM users');

    await resolve('someone-new');

    const after = await ownerPool.query('SELECT count(*)::int AS count FROM users');
    expect(after.rows[0]).toEqual(before.rows[0]);
    const visible = await runtimePool.query('SELECT count(*)::int AS count FROM users');
    expect(visible.rows[0]).toEqual({ count: 0 });
  });

  it('is executable by the runtime role only', async () => {
    const privileges = await ownerPool.query<{ maintenance: boolean; pub: boolean; runtime: boolean }>(
      `SELECT has_function_privilege('running_tracker_runtime', 'app_private.resolve_login_user(text)', 'EXECUTE') AS runtime,
              has_function_privilege('running_tracker_maintenance', 'app_private.resolve_login_user(text)', 'EXECUTE') AS maintenance,
              has_function_privilege('public', 'app_private.resolve_login_user(text)', 'EXECUTE') AS pub`,
    );

    expect(privileges.rows[0]).toEqual({ maintenance: false, pub: false, runtime: true });
    await expect(
      maintenancePool.query("SELECT app_private.resolve_login_user('fixture-dual')"),
    ).rejects.toThrow(/permission denied/u);
  });
});
