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

const tenantIsolationRunIds = [
  tenantIsolationIds.runRecording,
  tenantIsolationIds.runPaused,
  tenantIsolationIds.runFinishedHistory,
  tenantIsolationIds.runRecordingHistoryOnly,
  tenantIsolationIds.runFinishedLiveOnly,
  tenantIsolationIds.runFinishedBoth,
  tenantIsolationIds.runOrgBCoachHidden,
  tenantIsolationIds.runOrgBShared,
] as const;

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

    await client.query('DELETE FROM run_summaries');
    await client.query('DELETE FROM run_points');
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
         ($1, $2, $3, true, false),
         ($1, $4, $3, true, true),
         ($1, $5, $3, false, true),
         ($1, $6, $3, false, true),
         ($1, $7, $3, true, false),
         ($1, $8, $3, true, true),
         ($1, $5, $9, false, true),
         ($10, $11, $3, false, true)`,
      [
        tenantIsolationIds.orgA,
        tenantIsolationIds.runRecording,
        tenantIsolationIds.userDual,
        tenantIsolationIds.runPaused,
        tenantIsolationIds.runFinishedHistory,
        tenantIsolationIds.runRecordingHistoryOnly,
        tenantIsolationIds.runFinishedLiveOnly,
        tenantIsolationIds.runFinishedBoth,
        tenantIsolationIds.userInactive,
        tenantIsolationIds.orgB,
        tenantIsolationIds.runOrgBShared,
      ],
    );
    await client.query(
      `INSERT INTO run_points (
         org_id, run_id, seq, segment_id, recorded_at, received_at,
         geom, accuracy_m, ingested_revision
       )
       SELECT target.org_id,
              target.run_id,
              1,
              0,
              $3::timestamptz,
              $3::timestamptz,
              ST_SetSRID(
                ST_MakePoint(21.0 + target.ordinality / 1000.0, 52.0 + target.ordinality / 1000.0),
                4326
              ),
              5.0,
              1
       FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY
         AS target(org_id, run_id, ordinality)`,
      [
        [
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgB,
          tenantIsolationIds.orgB,
        ],
        tenantIsolationRunIds,
        '2026-09-20T08:15:00.000Z',
      ],
    );
    await client.query(
      `INSERT INTO run_summaries (
         org_id, run_id, source_revision, algorithm_version, display_geom,
         distance_m, observed_duration_s, quality_stats, computed_at
       )
       SELECT target.org_id,
              target.run_id,
              1,
              'fixture-v1',
              ST_GeomFromText(
                'MULTILINESTRING((21.0 52.0, 21.001 52.001))',
                4326
              ),
              130.5,
              60.25,
              jsonb_build_object(
                'rawPointCount', 2,
                'acceptedPointCount', 2,
                'acceptedEdgeCount', 1,
                'poorAccuracyPointCount', 0,
                'seqGapCount', 0,
                'segmentBreakCount', 0,
                'nonpositiveTimeDeltaCount', 0,
                'excessiveTimeGapCount', 0,
                'excessiveSpeedCount', 0,
                'insufficientData', false
              ),
              $3::timestamptz
       FROM unnest($1::uuid[], $2::uuid[]) AS target(org_id, run_id)`,
      [
        [
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgA,
          tenantIsolationIds.orgB,
          tenantIsolationIds.orgB,
        ],
        tenantIsolationRunIds,
        '2026-09-20T09:15:00.000Z',
      ],
    );
  } catch (error) {
    releaseError = asError(error);
    throw error;
  } finally {
    client.release(releaseError);
  }
}
