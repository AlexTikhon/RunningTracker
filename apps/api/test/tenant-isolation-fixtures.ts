import type { Pool } from 'pg';

import type { VerifiedIntegrationDatabaseConnection } from '../src/config/environment.js';

export const tenantIsolationIds = {
  orgA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  orgB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userDual: '11111111-1111-4111-8111-111111111111',
  userInactive: '33333333-3333-4333-8333-333333333333',
  userOrgA: '44444444-4444-4444-8444-444444444444',
  userOrgB: '22222222-2222-4222-8222-222222222222',
} as const;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Tenant fixture setup failed', { cause: error });
}

export async function prepareTenantIsolationFixtures(
  pool: Pick<Pool, 'connect'>,
  expectedOwner: VerifiedIntegrationDatabaseConnection,
): Promise<void> {
  const client = await pool.connect();
  let releaseError: Error | undefined;

  try {
    const identity = await client.query<{ database_name: string; role_name: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    const actual = identity.rows[0];

    if (
      actual?.database_name !== expectedOwner.database ||
      actual.role_name !== expectedOwner.user
    ) {
      throw new Error(
        'Tenant fixture owner connection does not match the validated database and role',
      );
    }

    await client.query('DELETE FROM memberships');
    await client.query('DELETE FROM organizations');
    await client.query('DELETE FROM users');
    await client.query(
      `INSERT INTO users (id, external_identity)
       VALUES
         ($1, 'fixture-dual'),
         ($2, 'fixture-org-b'),
         ($3, 'fixture-inactive'),
         ($4, 'fixture-org-a')`,
      [
        tenantIsolationIds.userDual,
        tenantIsolationIds.userOrgB,
        tenantIsolationIds.userInactive,
        tenantIsolationIds.userOrgA,
      ],
    );
    await client.query(
      'INSERT INTO organizations (id) VALUES ($1), ($2)',
      [tenantIsolationIds.orgA, tenantIsolationIds.orgB],
    );
    await client.query(
      `INSERT INTO memberships (org_id, user_id, role, active)
       VALUES
         ($1, $3, 'runner', true),
         ($2, $3, 'coach', true),
         ($2, $4, 'runner', true),
         ($1, $5, 'runner', false),
         ($1, $6, 'runner', true)`,
      [
        tenantIsolationIds.orgA,
        tenantIsolationIds.orgB,
        tenantIsolationIds.userDual,
        tenantIsolationIds.userOrgB,
        tenantIsolationIds.userInactive,
        tenantIsolationIds.userOrgA,
      ],
    );
  } catch (error) {
    releaseError = asError(error);
    throw error;
  } finally {
    client.release(releaseError);
  }
}
