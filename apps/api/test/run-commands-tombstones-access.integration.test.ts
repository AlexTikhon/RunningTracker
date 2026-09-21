import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

interface DatabaseErrorShape {
  code: string;
  column?: string;
  constraint?: string;
}

const seedCommandId = 'c1000000-0000-4000-8000-000000000001';
const commandId = (suffix: string) => `c2000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const tombstoneRunId = 'c3000000-0000-4000-8000-000000000001';
const inactiveTombstoneRunId = 'c3000000-0000-4000-8000-000000000002';
const sameRunTombstoneId = 'c3000000-0000-4000-8000-000000000003';
const transactionRunId = 'c4000000-0000-4000-8000-000000000001';

const fixtureRunIds = [
  ids.runRecording,
  ids.runPaused,
  ids.runFinishedHistory,
  ids.runRecordingHistoryOnly,
  ids.runFinishedLiveOnly,
  ids.runFinishedBoth,
  ids.runOrgBCoachHidden,
  ids.runOrgBShared,
] as const;

async function expectDatabaseError(
  operation: Promise<unknown>,
  expected: DatabaseErrorShape,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error(`Expected PostgreSQL error ${expected.code}`);
}

describe('P02B run_commands and run_tombstones ACL', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    expectedOwner = config.migration;
    runtimePool = createDatabasePool({ ...config.environment, DB_POOL_MAX: 2 });
    ownerPool = new Pool({
      application_name: 'running-tracker-command-tombstone-fixtures',
      connectionString: config.migration.connectionString,
      max: 1,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-command-tombstone-maintenance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await withVerifiedOwnerTransaction(async (client) => {
      await client.query(
        `INSERT INTO run_commands (
           org_id, run_id, command_id, canonical_payload, response, received_at
         )
         SELECT target.org_id,
                target.run_id,
                $3,
                jsonb_build_object('type', 'pause'),
                jsonb_build_object('status', 'paused'),
                $4::timestamptz
         FROM unnest($1::uuid[], $2::uuid[]) AS target(org_id, run_id)`,
        [
          [
            ids.orgA,
            ids.orgA,
            ids.orgA,
            ids.orgA,
            ids.orgA,
            ids.orgA,
            ids.orgB,
            ids.orgB,
          ],
          fixtureRunIds,
          seedCommandId,
          '2026-09-21T10:00:00.123Z',
        ],
      );
      await client.query(
        `INSERT INTO run_tombstones (
           org_id, run_id, owner_user_id, deleted_at, expires_at
         ) VALUES
           ($1, $2, $3, $4, $5),
           ($1, $6, $7, $4, $5)`,
        [
          ids.orgA,
          tombstoneRunId,
          ids.userOrgA,
          '2026-09-21T11:00:00.123Z',
          '2027-09-21T11:00:00.123Z',
          inactiveTombstoneRunId,
          ids.userInactive,
        ],
      );
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await maintenancePool?.end();
    await ownerPool?.end();
  });

  const withVerifiedOwnerTransaction = async (
    mutation: (client: PoolClient) => Promise<void>,
  ): Promise<void> => {
    const client = await ownerPool.connect();
    let releaseError: Error | undefined;

    try {
      const identity = await client.query<{ database_name: string; role_name: string }>(
        'SELECT current_database() AS database_name, current_user AS role_name',
      );
      expect(identity.rows[0]).toEqual({
        database_name: expectedOwner.database,
        role_name: expectedOwner.user,
      });

      await client.query('BEGIN');
      await mutation(client);
      await client.query('COMMIT');
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error('Owner fixture mutation failed');
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release(releaseError);
    }
  };

  const insertCommand = (
    client: Pick<PoolClient, 'query'>,
    orgId: string,
    runId: string,
    insertedCommandId: string,
    canonicalPayload: unknown = { expectedControlRevision: '0', type: 'pause' },
    response: unknown = { controlRevision: '1', status: 'paused' },
  ) =>
    client.query<{ command_id: string; received_at: Date }>(
      `INSERT INTO run_commands (
         org_id, run_id, command_id, canonical_payload, response
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING command_id, received_at`,
      [orgId, runId, insertedCommandId, JSON.stringify(canonicalPayload), JSON.stringify(response)],
    );

  const readCommandRunIds = (
    orgId: string,
    userId: string,
    joinRuns = false,
  ) =>
    withTenantTransaction(runtimePool, { orgId, userId }, async (client) => {
      const result = await client.query<{ run_id: string }>(
        joinRuns
          ? `SELECT command.run_id
             FROM run_commands AS command
             JOIN runs AS parent
               ON parent.org_id = command.org_id AND parent.id = command.run_id
             ORDER BY command.run_id`
          : 'SELECT run_id FROM run_commands ORDER BY run_id',
      );
      return result.rows.map(({ run_id }) => run_id);
    });

  const readTombstones = (orgId: string, userId: string) =>
    withTenantTransaction(runtimePool, { orgId, userId }, async (client) => {
      const result = await client.query<{
        deleted_at: Date;
        owner_user_id: string;
        run_id: string;
      }>(
        `SELECT run_id, owner_user_id, deleted_at
         FROM run_tombstones
         ORDER BY run_id`,
      );
      return result.rows;
    });

  it('restricts direct and joined command reads to active run owners', async () => {
    const orgAOwnerRuns = [
      ids.runRecording,
      ids.runFinishedHistory,
      ids.runFinishedLiveOnly,
      ids.runFinishedBoth,
    ];
    const orgBOwnerRuns = [ids.runOrgBCoachHidden, ids.runOrgBShared];

    for (const joinRuns of [false, true]) {
      await expect(readCommandRunIds(ids.orgA, ids.userOrgA, joinRuns)).resolves.toEqual(
        orgAOwnerRuns,
      );
      await expect(readCommandRunIds(ids.orgA, ids.userHistoryActiveOwner, joinRuns)).resolves.toEqual([
        ids.runRecordingHistoryOnly,
      ]);
      await expect(readCommandRunIds(ids.orgB, ids.userOrgB, joinRuns)).resolves.toEqual(
        orgBOwnerRuns,
      );
      await expect(readCommandRunIds(ids.orgA, ids.userDual, joinRuns)).resolves.toEqual([]);
      await expect(readCommandRunIds(ids.orgB, ids.userDual, joinRuns)).resolves.toEqual([]);
      await expect(readCommandRunIds(ids.orgA, ids.userPausedOwner, joinRuns)).resolves.toEqual([
        ids.runPaused,
      ]);
      await expect(readCommandRunIds(ids.orgA, ids.userStranger, joinRuns)).resolves.toEqual([]);
      await expect(readCommandRunIds(ids.orgA, ids.userOrgB, joinRuns)).resolves.toEqual([]);
    }
  });

  it('fails command reads closed for missing, empty, malformed, and switched contexts', async () => {
    const missing = await runtimePool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM run_commands',
    );
    expect(missing.rows[0]?.count).toBe('0');

    const client = await runtimePool.connect();
    try {
      for (const value of ['invalid', '']) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [value]);
        await client.query("SELECT set_config('app.org_id', $1, true)", [value]);
        const result = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM run_commands',
        );
        expect(result.rows[0]?.count).toBe('0');
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }

    await expect(readCommandRunIds(ids.orgB, ids.userOrgA)).resolves.toEqual([]);
    await expect(readCommandRunIds(ids.orgA, ids.userOrgB)).resolves.toEqual([]);
  });

  it('allows owner INSERT RETURNING and a command after run creation in one transaction', async () => {
    const inserted = await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userOrgA },
      (client) => insertCommand(client, ids.orgA, ids.runRecording, commandId('1')),
    );
    expect(inserted.rows[0]).toMatchObject({ command_id: commandId('1') });
    expect(inserted.rows[0]?.received_at).toBeInstanceOf(Date);

    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userStranger },
        async (client) => {
          const run = await client.query<{ id: string }>(
            `INSERT INTO runs (org_id, id, user_id)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [ids.orgA, transactionRunId, ids.userStranger],
          );
          const command = await insertCommand(
            client,
            ids.orgA,
            transactionRunId,
            commandId('2'),
          );
          return { commandId: command.rows[0]?.command_id, runId: run.rows[0]?.id };
        },
      ),
    ).resolves.toEqual({ commandId: commandId('2'), runId: transactionRunId });
  });

  it('denies command INSERT to grantees, coaches, inactive owners, and wrong tenants', async () => {
    const deniedCases = [
      { orgId: ids.orgA, runId: ids.runRecording, userId: ids.userDual },
      { orgId: ids.orgA, runId: ids.runFinishedHistory, userId: ids.userDual },
      { orgId: ids.orgA, runId: ids.runFinishedBoth, userId: ids.userDual },
      { orgId: ids.orgB, runId: ids.runOrgBShared, userId: ids.userDual },
      { orgId: ids.orgA, runId: ids.runRecording, userId: ids.userOrgB },
    ];

    for (const [index, denied] of deniedCases.entries()) {
      await expectDatabaseError(
        withTenantTransaction(
          runtimePool,
          { orgId: denied.orgId, userId: denied.userId },
          (client) =>
            insertCommand(
              client,
              denied.orgId,
              denied.runId,
              commandId((index + 10).toString()),
            ),
        ),
        { code: '42501' },
      );
    }

    await ownerPool.query(
      'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
      [ids.orgA, ids.userPausedOwner],
    );
    await expectDatabaseError(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userPausedOwner },
        (client) =>
          insertCommand(client, ids.orgA, ids.runPaused, commandId('19')),
      ),
      { code: '42501' },
    );

    await expectDatabaseError(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgB, userId: ids.userOrgB },
        (client) =>
          insertCommand(client, ids.orgA, ids.runRecording, commandId('20')),
      ),
      { code: '42501' },
    );
  });

  it('keeps saved commands immutable for duplicate, upsert, UPDATE, and DELETE attempts', async () => {
    const readSeed = () =>
      ownerPool.query<{ canonical_payload: unknown; response: unknown }>(
        `SELECT canonical_payload, response
         FROM run_commands
         WHERE org_id = $1 AND run_id = $2 AND command_id = $3`,
        [ids.orgA, ids.runRecording, seedCommandId],
      );
    const expected = {
      canonical_payload: { type: 'pause' },
      response: { status: 'paused' },
    };

    await expectDatabaseError(
      ownerPool.query(
        `INSERT INTO run_commands (
           org_id, run_id, command_id, canonical_payload, response
         ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb)`,
        [ids.orgA, ids.runRecording, seedCommandId],
      ),
      { code: '23505', constraint: 'run_commands_pkey' },
    );
    expect((await readSeed()).rows[0]).toEqual(expected);

    await expectDatabaseError(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userOrgA },
        (client) =>
          client.query(
            `INSERT INTO run_commands (
               org_id, run_id, command_id, canonical_payload, response
             ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb)
             ON CONFLICT (org_id, run_id, command_id)
             DO UPDATE SET response = EXCLUDED.response`,
            [ids.orgA, ids.runRecording, seedCommandId],
          ),
      ),
      { code: '42501' },
    );
    expect((await readSeed()).rows[0]).toEqual(expected);

    for (const statement of [
      `UPDATE run_commands SET response = '{}'::jsonb
       WHERE org_id = $1 AND run_id = $2 AND command_id = $3`,
      `DELETE FROM run_commands
       WHERE org_id = $1 AND run_id = $2 AND command_id = $3`,
    ]) {
      await expectDatabaseError(
        withTenantTransaction(
          runtimePool,
          { orgId: ids.orgA, userId: ids.userOrgA },
          (client) => client.query(statement, [ids.orgA, ids.runRecording, seedCommandId]),
        ),
        { code: '42501' },
      );
    }
    expect((await readSeed()).rows[0]).toEqual(expected);
  });

  it('enforces command JSON object, timestamp, composite FK, and cascade constraints', async () => {
    const jsonCases = [
      { column: 'canonical_payload', value: [] },
      { column: 'canonical_payload', value: 'pause' },
      { column: 'canonical_payload', value: 1 },
      { column: 'canonical_payload', value: null },
      { column: 'response', value: [] },
      { column: 'response', value: false },
      { column: 'response', value: null },
    ] as const;

    for (const [index, testCase] of jsonCases.entries()) {
      const canonicalPayload = testCase.column === 'canonical_payload' ? testCase.value : {};
      const response = testCase.column === 'response' ? testCase.value : {};
      await expectDatabaseError(
        ownerPool.query(
          `INSERT INTO run_commands (
             org_id, run_id, command_id, canonical_payload, response
           ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            ids.orgA,
            ids.runRecording,
            commandId((index + 30).toString()),
            JSON.stringify(canonicalPayload),
            JSON.stringify(response),
          ],
        ),
        {
          code: '23514',
          constraint:
            testCase.column === 'canonical_payload'
              ? 'run_commands_canonical_payload_object'
              : 'run_commands_response_object',
        },
      );
    }

    for (const column of ['canonical_payload', 'response'] as const) {
      await expectDatabaseError(
        ownerPool.query(
          `INSERT INTO run_commands (
             org_id, run_id, command_id, canonical_payload, response
           ) VALUES ($1, $2, $3, ${column === 'canonical_payload' ? 'NULL' : "'{}'::jsonb"}, ${column === 'response' ? 'NULL' : "'{}'::jsonb"})`,
          [ids.orgA, ids.runRecording, commandId(column === 'canonical_payload' ? '40' : '41')],
        ),
        { code: '23502', column },
      );
    }

    await expectDatabaseError(
      ownerPool.query(
        `INSERT INTO run_commands (
           org_id, run_id, command_id, canonical_payload, response, received_at
         ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, 'infinity')`,
        [ids.orgA, ids.runRecording, commandId('42')],
      ),
      { code: '23514', constraint: 'run_commands_received_at_finite' },
    );
    await expectDatabaseError(
      ownerPool.query(
        `INSERT INTO run_commands (
           org_id, run_id, command_id, canonical_payload, response
         ) VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb)`,
        [ids.orgB, ids.runRecording, commandId('43')],
      ),
      { code: '23503', constraint: 'run_commands_run_fk' },
    );

    const accepted = await insertCommand(
      ownerPool,
      ids.orgA,
      ids.runRecording,
      commandId('44'),
      { expectedControlRevision: '9007199254740993', type: 'finish' },
      { controlRevision: '9007199254740994', status: 'finished' },
    );
    expect(accepted.rows[0]?.command_id).toBe(commandId('44'));
    const roundTrip = await ownerPool.query<{
      canonical_payload: unknown;
      response: unknown;
    }>(
      `SELECT canonical_payload, response
       FROM run_commands
       WHERE org_id = $1 AND run_id = $2 AND command_id = $3`,
      [ids.orgA, ids.runRecording, commandId('44')],
    );
    expect(roundTrip.rows[0]).toEqual({
      canonical_payload: { expectedControlRevision: '9007199254740993', type: 'finish' },
      response: { controlRevision: '9007199254740994', status: 'finished' },
    });

    await ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      ids.runRecording,
    ]);
    const remaining = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM run_commands
       WHERE org_id = $1 AND run_id = $2`,
      [ids.orgA, ids.runRecording],
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });

  it('reads a tombstone only for its active owner without consulting runs or grants', async () => {
    await ownerPool.query(
      `INSERT INTO run_tombstones (
         org_id, run_id, owner_user_id, deleted_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        ids.orgA,
        ids.runFinishedBoth,
        ids.userOrgA,
        '2026-09-21T12:00:00.000Z',
        '2027-09-21T12:00:00.000Z',
      ],
    );
    await ownerPool.query('DELETE FROM runs WHERE org_id = $1 AND id = $2', [
      ids.orgA,
      ids.runFinishedBoth,
    ]);

    const ownerRows = await readTombstones(ids.orgA, ids.userOrgA);
    expect(ownerRows.map(({ run_id }) => run_id)).toEqual([
      ids.runFinishedBoth,
      tombstoneRunId,
    ]);
    expect(ownerRows.every(({ owner_user_id }) => owner_user_id === ids.userOrgA)).toBe(true);

    await expect(readTombstones(ids.orgA, ids.userDual)).resolves.toEqual([]);
    await expect(readTombstones(ids.orgB, ids.userDual)).resolves.toEqual([]);
    await expect(readTombstones(ids.orgA, ids.userStranger)).resolves.toEqual([]);
    await expect(readTombstones(ids.orgA, ids.userInactive)).resolves.toEqual([]);
    await expect(readTombstones(ids.orgA, ids.userOrgB)).resolves.toEqual([]);

    const noParent = await ownerPool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM runs WHERE org_id = $1 AND id = $2
       ) AS exists`,
      [ids.orgA, tombstoneRunId],
    );
    expect(noParent.rows[0]?.exists).toBe(false);
  });

  it('fails tombstone reads closed and removes access after owner deactivation', async () => {
    const missing = await runtimePool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM run_tombstones',
    );
    expect(missing.rows[0]?.count).toBe('0');

    const client = await runtimePool.connect();
    try {
      for (const value of ['invalid', '']) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [value]);
        await client.query("SELECT set_config('app.org_id', $1, true)", [value]);
        const result = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM run_tombstones',
        );
        expect(result.rows[0]?.count).toBe('0');
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }

    await expect(readTombstones(ids.orgA, ids.userOrgA)).resolves.toHaveLength(1);
    await ownerPool.query(
      'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
      [ids.orgA, ids.userOrgA],
    );
    await expect(readTombstones(ids.orgA, ids.userOrgA)).resolves.toEqual([]);
    const retained = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM run_tombstones
       WHERE org_id = $1 AND run_id = $2`,
      [ids.orgA, tombstoneRunId],
    );
    expect(retained.rows[0]?.count).toBe('1');
  });

  it('keeps same run IDs in different organizations isolated', async () => {
    await ownerPool.query(
      `INSERT INTO run_tombstones (
         org_id, run_id, owner_user_id, deleted_at, expires_at
       ) VALUES
         ($1, $3, $4, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
         ($2, $3, $4, '2026-02-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z')`,
      [ids.orgA, ids.orgB, sameRunTombstoneId, ids.userDual],
    );

    const orgARows = await readTombstones(ids.orgA, ids.userDual);
    const orgBRows = await readTombstones(ids.orgB, ids.userDual);
    expect(orgARows).toHaveLength(1);
    expect(orgBRows).toHaveLength(1);
    expect(orgARows[0]?.run_id).toBe(sameRunTombstoneId);
    expect(orgBRows[0]?.run_id).toBe(sameRunTombstoneId);
    expect(orgARows[0]?.deleted_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(orgBRows[0]?.deleted_at.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('denies runtime tombstone INSERT, UPDATE, and DELETE', async () => {
    const statements = [
      `INSERT INTO run_tombstones (
         org_id, run_id, owner_user_id, deleted_at, expires_at
       ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 day')`,
      `UPDATE run_tombstones SET expires_at = expires_at + interval '1 day'
       WHERE org_id = $1 AND run_id = $2 AND owner_user_id = $3`,
      `DELETE FROM run_tombstones
       WHERE org_id = $1 AND run_id = $2 AND owner_user_id = $3`,
    ];

    for (const [index, statement] of statements.entries()) {
      await expectDatabaseError(
        withTenantTransaction(
          runtimePool,
          { orgId: ids.orgA, userId: ids.userOrgA },
          (client) =>
            client.query(statement, [
              ids.orgA,
              index === 0 ? sameRunTombstoneId : tombstoneRunId,
              ids.userOrgA,
            ]),
        ),
        { code: '42501' },
      );
    }
  });

  it('enforces tombstone membership, key, and timestamp constraints exactly', async () => {
    await expectDatabaseError(
      ownerPool.query(
        `INSERT INTO run_tombstones (
           org_id, run_id, owner_user_id, deleted_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          ids.orgA,
          sameRunTombstoneId,
          ids.userOrgB,
          '2026-09-21T00:00:00.000Z',
          '2027-09-21T00:00:00.000Z',
        ],
      ),
      { code: '23503', constraint: 'run_tombstones_owner_membership_fk' },
    );
    await expectDatabaseError(
      ownerPool.query(
        `INSERT INTO run_tombstones (
           org_id, run_id, owner_user_id, deleted_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          ids.orgA,
          tombstoneRunId,
          ids.userOrgA,
          '2026-09-21T00:00:00.000Z',
          '2027-09-21T00:00:00.000Z',
        ],
      ),
      { code: '23505', constraint: 'run_tombstones_pkey' },
    );

    const timestampCases = [
      {
        constraint: 'run_tombstones_deleted_at_finite',
        deletedAt: 'infinity',
        expiresAt: '2027-09-21T00:00:00.000Z',
      },
      {
        constraint: 'run_tombstones_expires_at_finite',
        deletedAt: '2026-09-21T00:00:00.000Z',
        expiresAt: 'infinity',
      },
      {
        constraint: 'run_tombstones_expiry_after_deletion',
        deletedAt: '2026-09-21T00:00:00.000Z',
        expiresAt: '2026-09-21T00:00:00.000Z',
      },
      {
        constraint: 'run_tombstones_expiry_after_deletion',
        deletedAt: '2026-09-21T00:00:00.000Z',
        expiresAt: '2026-09-20T23:59:59.999Z',
      },
    ] as const;

    for (const [index, testCase] of timestampCases.entries()) {
      await expectDatabaseError(
        ownerPool.query(
          `INSERT INTO run_tombstones (
             org_id, run_id, owner_user_id, deleted_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            ids.orgA,
            `c3000000-0000-4000-8000-${(index + 100).toString().padStart(12, '0')}`,
            ids.userOrgA,
            testCase.deletedAt,
            testCase.expiresAt,
          ],
        ),
        { code: '23514', constraint: testCase.constraint },
      );
    }
  });

  it('uses narrow grants, RLS, owner-owned objects, and a run-independent tombstone policy', async () => {
    const relations = await ownerPool.query<{
      relname: string;
      relowner: string;
      relrowsecurity: boolean;
    }>(
      `SELECT relation.relname,
              owner.rolname AS relowner,
              relation.relrowsecurity
       FROM pg_class AS relation
       JOIN pg_roles AS owner ON owner.oid = relation.relowner
       WHERE relation.oid IN ('run_commands'::regclass, 'run_tombstones'::regclass)
       ORDER BY relation.relname`,
    );
    expect(relations.rows).toEqual([
      {
        relname: 'run_commands',
        relowner: expectedOwner.user,
        relrowsecurity: true,
      },
      {
        relname: 'run_tombstones',
        relowner: expectedOwner.user,
        relrowsecurity: true,
      },
    ]);

    const privileges = await ownerPool.query<{
      command_delete: boolean;
      command_insert: boolean;
      command_select: boolean;
      command_update: boolean;
      maintenance_commands: boolean;
      maintenance_tombstones: boolean;
      tombstone_delete: boolean;
      tombstone_insert: boolean;
      tombstone_select: boolean;
      tombstone_update: boolean;
    }>(
      `SELECT
         has_table_privilege('running_tracker_runtime', 'run_commands', 'SELECT')
           AS command_select,
         has_table_privilege('running_tracker_runtime', 'run_commands', 'INSERT')
           AS command_insert,
         has_table_privilege('running_tracker_runtime', 'run_commands', 'UPDATE')
           AS command_update,
         has_table_privilege('running_tracker_runtime', 'run_commands', 'DELETE')
           AS command_delete,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'SELECT')
           AS tombstone_select,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'INSERT')
           AS tombstone_insert,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'UPDATE')
           AS tombstone_update,
         has_table_privilege('running_tracker_runtime', 'run_tombstones', 'DELETE')
           AS tombstone_delete,
         has_table_privilege('running_tracker_maintenance', 'run_commands', 'SELECT')
           AS maintenance_commands,
         has_table_privilege('running_tracker_maintenance', 'run_tombstones', 'SELECT')
           AS maintenance_tombstones`,
    );
    expect(privileges.rows[0]).toEqual({
      command_delete: false,
      command_insert: true,
      command_select: true,
      command_update: false,
      maintenance_commands: false,
      maintenance_tombstones: false,
      tombstone_delete: false,
      tombstone_insert: false,
      tombstone_select: true,
      tombstone_update: false,
    });

    const policies = await ownerPool.query<{ policy: string; qual: string | null; with_check: string | null }>(
      `SELECT polname AS policy,
              pg_get_expr(polqual, polrelid) AS qual,
              pg_get_expr(polwithcheck, polrelid) AS with_check
       FROM pg_policy
       WHERE polrelid IN ('run_commands'::regclass, 'run_tombstones'::regclass)
       ORDER BY polname`,
    );
    const tombstonePolicy = policies.rows.find(
      ({ policy }) => policy === 'run_tombstones_select_owner',
    );
    expect(tombstonePolicy?.qual).toContain('owner_user_id');
    expect(tombstonePolicy?.qual).toContain('has_active_membership');
    expect(tombstonePolicy?.qual).not.toMatch(/is_run_owner|can_read_run/u);
    expect(policies.rows).toHaveLength(3);

    const constraints = await ownerPool.query<{ definition: string; name: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'run_tombstones'::regclass
       ORDER BY conname`,
    );
    const membershipForeignKey = constraints.rows.find(
      ({ name }) => name === 'run_tombstones_owner_membership_fk',
    );
    expect(membershipForeignKey?.definition).toMatch(/memberships.*ON DELETE RESTRICT/u);
    expect(constraints.rows.some(({ definition }) => /REFERENCES runs/u.test(definition))).toBe(false);

    const expiryIndex = await ownerPool.query<{ exists: boolean }>(
      `SELECT to_regclass('public.run_tombstones_expires_at_idx') IS NOT NULL AS exists`,
    );
    expect(expiryIndex.rows[0]?.exists).toBe(true);

    await expect(maintenancePool.query('SELECT * FROM run_commands')).rejects.toThrow(
      /permission denied/u,
    );
    await expect(maintenancePool.query('SELECT * FROM run_tombstones')).rejects.toThrow(
      /permission denied/u,
    );
  });
});
