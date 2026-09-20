import type { Pool } from 'pg';

import type { VerifiedIntegrationDatabaseConnection } from '../src/config/environment.js';

export const tenantIsolationIds = {
  orgA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  orgB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userDual: '11111111-1111-4111-8111-111111111111',
  userInactive: '33333333-3333-4333-8333-333333333333',
  userOrgA: '44444444-4444-4444-8444-444444444444',
  userOrgB: '22222222-2222-4222-8222-222222222222',
  userPausedOwner: '55555555-5555-4555-8555-555555555555',
  userStranger: '66666666-6666-4666-8666-666666666666',
  userHistoryActiveOwner: '77777777-7777-4777-8777-777777777777',
  runRecording: 'a0000000-0000-4000-8000-000000000001',
  runPaused: 'a0000000-0000-4000-8000-000000000002',
  runFinishedHistory: 'a0000000-0000-4000-8000-000000000003',
  runRecordingHistoryOnly: 'a0000000-0000-4000-8000-000000000004',
  runFinishedLiveOnly: 'a0000000-0000-4000-8000-000000000005',
  runFinishedBoth: 'a0000000-0000-4000-8000-000000000006',
  runOrgBCoachHidden: 'b0000000-0000-4000-8000-000000000001',
  runOrgBShared: 'b0000000-0000-4000-8000-000000000002',
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

    await client.query('DELETE FROM run_shares');
    await client.query('DELETE FROM runs');
    await client.query('DELETE FROM memberships');
    await client.query('DELETE FROM organizations');
    await client.query('DELETE FROM users');
    await client.query(
      `INSERT INTO users (id, external_identity)
       VALUES
         ($1, 'fixture-dual'),
         ($2, 'fixture-org-b'),
         ($3, 'fixture-inactive'),
         ($4, 'fixture-org-a'),
         ($5, 'fixture-paused-owner'),
         ($6, 'fixture-stranger'),
         ($7, 'fixture-history-active-owner')`,
      [
        tenantIsolationIds.userDual,
        tenantIsolationIds.userOrgB,
        tenantIsolationIds.userInactive,
        tenantIsolationIds.userOrgA,
        tenantIsolationIds.userPausedOwner,
        tenantIsolationIds.userStranger,
        tenantIsolationIds.userHistoryActiveOwner,
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
         ($1, $6, 'runner', true),
         ($1, $7, 'runner', true),
         ($1, $8, 'coach', true),
         ($1, $9, 'runner', true)`,
      [
        tenantIsolationIds.orgA,
        tenantIsolationIds.orgB,
        tenantIsolationIds.userDual,
        tenantIsolationIds.userOrgB,
        tenantIsolationIds.userInactive,
        tenantIsolationIds.userOrgA,
        tenantIsolationIds.userPausedOwner,
        tenantIsolationIds.userStranger,
        tenantIsolationIds.userHistoryActiveOwner,
      ],
    );
    await client.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at
       )
       VALUES
         ($1, $3, $11, 'recording', $15, $15, NULL),
         ($1, $4, $12, 'paused', $15, $15, NULL),
         ($1, $5, $11, 'finished', $15, $15, $16),
         ($1, $6, $13, 'recording', $15, $15, NULL),
         ($1, $7, $11, 'finished', $15, $15, $16),
         ($1, $8, $11, 'finished', $15, $15, $16),
         ($2, $9, $14, 'finished', $15, $15, $16),
         ($2, $10, $14, 'finished', $15, $15, $16)`,
      [
        tenantIsolationIds.orgA,
        tenantIsolationIds.orgB,
        tenantIsolationIds.runRecording,
        tenantIsolationIds.runPaused,
        tenantIsolationIds.runFinishedHistory,
        tenantIsolationIds.runRecordingHistoryOnly,
        tenantIsolationIds.runFinishedLiveOnly,
        tenantIsolationIds.runFinishedBoth,
        tenantIsolationIds.runOrgBCoachHidden,
        tenantIsolationIds.runOrgBShared,
        tenantIsolationIds.userOrgA,
        tenantIsolationIds.userPausedOwner,
        tenantIsolationIds.userHistoryActiveOwner,
        tenantIsolationIds.userOrgB,
        '2026-09-20T08:00:00.000Z',
        '2026-09-20T09:00:00.000Z',
      ],
    );
    await client.query(
      `INSERT INTO run_shares (
         org_id, run_id, grantee_user_id, can_read_live, can_read_history
       )
       VALUES
         ($1, $3, $11, true, false),
         ($1, $4, $11, true, true),
         ($1, $5, $11, false, true),
         ($1, $6, $11, false, true),
         ($1, $7, $11, true, false),
         ($1, $8, $11, true, true),
         ($1, $5, $12, false, true),
         ($2, $10, $11, false, true)`,
      [
        tenantIsolationIds.orgA,
        tenantIsolationIds.orgB,
        tenantIsolationIds.runRecording,
        tenantIsolationIds.runPaused,
        tenantIsolationIds.runFinishedHistory,
        tenantIsolationIds.runRecordingHistoryOnly,
        tenantIsolationIds.runFinishedLiveOnly,
        tenantIsolationIds.runFinishedBoth,
        tenantIsolationIds.runOrgBCoachHidden,
        tenantIsolationIds.runOrgBShared,
        tenantIsolationIds.userDual,
        tenantIsolationIds.userInactive,
      ],
    );
  } catch (error) {
    releaseError = asError(error);
    throw error;
  } finally {
    client.release(releaseError);
  }
}
