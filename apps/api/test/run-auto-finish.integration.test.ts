import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Clock } from '../src/clock.js';
import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import { ApiError } from '../src/http/errors.js';
import { runAutoFinishOnce } from '../src/maintenance/run-auto-finish.js';
import { applyRunCommand, createRun } from '../src/runs/run-service.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const effectiveNow = '2031-01-02T00:00:00.000Z';
const explicitFinishTime = '2031-01-02T00:00:05.000Z';
const cutoff = '2031-01-01T00:00:00.000Z';
const youngCreatedAt = '2031-01-01T00:00:00.001Z';
const oldCreatedAt = '2030-12-31T23:59:59.999Z';

const runIds = {
  concurrent: 'a3500000-0000-4000-8000-000000000001',
  exact: 'a3500000-0000-4000-8000-000000000002',
  finished: 'a3500000-0000-4000-8000-000000000003',
  newAfterFinish: 'a3500000-0000-4000-8000-000000000004',
  old: 'a3500000-0000-4000-8000-000000000005',
  paused: 'a3500000-0000-4000-8000-000000000006',
  raceCommand: 'a3500000-0000-4000-8000-000000000007',
  young: 'a3500000-0000-4000-8000-000000000008',
  invalidFutureStart: 'a3500000-0000-4000-8000-000000000009',
} as const;

const commandIds = {
  finish: 'c3500000-0000-4000-8000-000000000001',
  pause: 'c3500000-0000-4000-8000-000000000002',
  resume: 'c3500000-0000-4000-8000-000000000003',
} as const;

class FixedClock implements Clock {
  public constructor(private readonly timestamp: string) {}

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse(this.timestamp);
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.timestamp);
  }
}

interface RunState {
  control_revision: string;
  data_revision: string;
  finished_at: Date | null;
  raw_state: string;
  status: string;
}

describe('P03.5 clock-driven run auto-finish', () => {
  let maintenancePool: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let expectedOwner: ReturnType<typeof loadIntegrationTestConfiguration>['migration'];
  const maintenanceClock = new FixedClock(effectiveNow);

  beforeAll(() => {
    const integration = loadIntegrationTestConfiguration();
    expectedOwner = integration.migration;
    ownerPool = new Pool({
      application_name: 'running-tracker-p035-fixtures',
      connectionString: integration.migration.connectionString,
      max: 4,
    });
    runtimePool = new Pool({
      application_name: 'running-tracker-p035-runtime',
      connectionString: integration.runtime.connectionString,
      max: 4,
    });
    maintenancePool = new Pool({
      application_name: 'running-tracker-p035-maintenance',
      connectionString: integration.maintenance.connectionString,
      max: 4,
    });
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, expectedOwner);
    await ownerPool.query('DELETE FROM runs');
  });

  afterAll(async () => {
    await maintenancePool?.end();
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function insertRun(options: {
    createdAt: string;
    dataRevision?: number;
    finishedAt?: string;
    id: string;
    status: 'recording' | 'paused' | 'finished';
    userId?: string;
  }): Promise<void> {
    await ownerPool.query(
      `INSERT INTO runs (
         org_id, id, user_id, status, started_at, created_at, finished_at,
         data_revision, control_revision, raw_state
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'available')`,
      [
        ids.orgA,
        options.id,
        options.userId ?? ids.userDual,
        options.status,
        oldCreatedAt,
        options.createdAt,
        options.finishedAt ?? null,
        options.dataRevision ?? 0,
      ],
    );
  }

  async function readRun(id: string): Promise<RunState> {
    const result = await ownerPool.query<RunState>(
      `SELECT status, finished_at, data_revision, control_revision, raw_state
       FROM runs
       WHERE org_id = $1 AND id = $2`,
      [ids.orgA, id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Missing test run ${id}`);
    }
    return row;
  }

  async function commandCount(id: string): Promise<string> {
    const result = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM run_commands WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, id],
    );
    return result.rows[0]?.count ?? 'missing';
  }

  it.each([
    ['recording', runIds.young, ids.userDual],
    ['paused', runIds.paused, ids.userPausedOwner],
  ] as const)('leaves a young %s run unchanged', async (status, id, userId) => {
    await insertRun({ createdAt: youngCreatedAt, id, status, userId });

    await expect(runAutoFinishOnce(maintenancePool, maintenanceClock)).resolves.toBe(0);
    expect(await readRun(id)).toMatchObject({
      control_revision: '0',
      data_revision: '0',
      finished_at: null,
      raw_state: 'available',
      status,
    });
  });

  it('finishes recording runs exactly at and past the 24-hour cutoff', async () => {
    await insertRun({ createdAt: cutoff, id: runIds.exact, status: 'recording' });
    await insertRun({
      createdAt: oldCreatedAt,
      id: runIds.old,
      status: 'recording',
      userId: ids.userOrgA,
    });

    await expect(runAutoFinishOnce(maintenancePool, maintenanceClock)).resolves.toBe(2);
    for (const id of [runIds.exact, runIds.old]) {
      expect(await readRun(id)).toMatchObject({
        control_revision: '0',
        data_revision: '1',
        finished_at: new Date(effectiveNow),
        raw_state: 'available',
        status: 'finished',
      });
      expect(await commandCount(id)).toBe('0');
    }
  });

  it('finishes a paused old run with the supplied clock time and no control revision', async () => {
    await insertRun({
      createdAt: oldCreatedAt,
      dataRevision: 7,
      id: runIds.paused,
      status: 'paused',
      userId: ids.userPausedOwner,
    });

    await expect(runAutoFinishOnce(maintenancePool, maintenanceClock)).resolves.toBe(1);
    expect(await readRun(runIds.paused)).toEqual({
      control_revision: '0',
      data_revision: '8',
      finished_at: new Date(effectiveNow),
      raw_state: 'available',
      status: 'finished',
    });
    expect(await commandCount(runIds.paused)).toBe('0');
  });

  it('is idempotent and never rewrites an existing finished timestamp', async () => {
    await insertRun({ createdAt: oldCreatedAt, id: runIds.old, status: 'recording' });
    await expect(runAutoFinishOnce(maintenancePool, maintenanceClock)).resolves.toBe(1);
    const first = await readRun(runIds.old);
    await expect(
      runAutoFinishOnce(maintenancePool, new FixedClock('2031-01-02T01:00:00.000Z')),
    ).resolves.toBe(0);
    expect(await readRun(runIds.old)).toEqual(first);

    const explicitTimestamp = '2031-01-01T12:00:00.000Z';
    await insertRun({
      createdAt: oldCreatedAt,
      dataRevision: 4,
      finishedAt: explicitTimestamp,
      id: runIds.finished,
      status: 'finished',
      userId: ids.userOrgA,
    });
    await expect(runAutoFinishOnce(maintenancePool, maintenanceClock)).resolves.toBe(0);
    expect(await readRun(runIds.finished)).toMatchObject({
      data_revision: '4',
      finished_at: new Date(explicitTimestamp),
      status: 'finished',
    });
  });

  it('serializes explicit finish against auto-finish with one terminal update', async () => {
    await insertRun({ createdAt: oldCreatedAt, id: runIds.concurrent, status: 'recording' });
    const explicit = withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userDual },
      (client) =>
        applyRunCommand(
          client,
          { userId: ids.userDual },
          ids.orgA,
          runIds.concurrent,
          {
            commandId: commandIds.finish,
            expectedControlRevision: '0',
            type: 'finish',
          },
          new FixedClock(explicitFinishTime),
        ),
    );

    const [maintenanceResult, commandResult] = await Promise.allSettled([
      runAutoFinishOnce(maintenancePool, maintenanceClock),
      explicit,
    ]);
    expect(maintenanceResult.status).toBe('fulfilled');
    if (commandResult.status === 'rejected') {
      expect(commandResult.reason).toBeInstanceOf(ApiError);
      expect((commandResult.reason as ApiError).code).toBe('CONTROL_REVISION_CONFLICT');
    }

    const state = await readRun(runIds.concurrent);
    expect(state.status).toBe('finished');
    expect(state.data_revision).toBe('1');
    expect([
      ['0', effectiveNow],
      ['1', explicitFinishTime],
    ]).toContainEqual([state.control_revision, state.finished_at?.toISOString()]);
    expect(await commandCount(runIds.concurrent)).toBe(state.control_revision);
  });

  it.each([
    ['recording', 'pause', commandIds.pause],
    ['paused', 'resume', commandIds.resume],
  ] as const)(
    'serializes auto-finish against a %s -> %s lifecycle command',
    async (initialStatus, commandType, commandId) => {
      await insertRun({
        createdAt: oldCreatedAt,
        id: runIds.raceCommand,
        status: initialStatus,
      });
      const command = withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userDual },
        (client) =>
          applyRunCommand(
            client,
            { userId: ids.userDual },
            ids.orgA,
            runIds.raceCommand,
            { commandId, expectedControlRevision: '0', type: commandType },
            new FixedClock(explicitFinishTime),
          ),
      );

      const [, commandResult] = await Promise.allSettled([
        runAutoFinishOnce(maintenancePool, maintenanceClock),
        command,
      ]);
      if (commandResult.status === 'rejected') {
        expect(commandResult.reason).toBeInstanceOf(ApiError);
      }
      const state = await readRun(runIds.raceCommand);
      expect(state.status).toBe('finished');
      expect(state.finished_at?.toISOString()).toBe(effectiveNow);
      expect([
        ['1', '0'],
        ['2', '1'],
      ]).toContainEqual([state.data_revision, state.control_revision]);
      expect(await commandCount(runIds.raceCommand)).toBe(state.control_revision);
    },
  );

  it('allows only one of two concurrent maintenance passes to apply the transition', async () => {
    await insertRun({ createdAt: oldCreatedAt, id: runIds.concurrent, status: 'recording' });

    const counts = await Promise.all([
      runAutoFinishOnce(maintenancePool, maintenanceClock),
      runAutoFinishOnce(maintenancePool, maintenanceClock),
    ]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(await readRun(runIds.concurrent)).toMatchObject({
      control_revision: '0',
      data_revision: '1',
      finished_at: new Date(effectiveNow),
      status: 'finished',
    });
  });

  it('releases the one-active-run constraint when auto-finish commits', async () => {
    await insertRun({ createdAt: oldCreatedAt, id: runIds.old, status: 'recording' });
    await expect(runAutoFinishOnce(maintenancePool, maintenanceClock)).resolves.toBe(1);

    const created = await withTenantTransaction(
      runtimePool,
      { orgId: ids.orgA, userId: ids.userDual },
      (client) =>
        createRun(
          client,
          { userId: ids.userDual },
          ids.orgA,
          runIds.newAfterFinish,
          { startedAt: effectiveNow },
          new FixedClock(explicitFinishTime),
        ),
    );
    expect(created.created).toBe(true);
    expect(created.run.status).toBe('recording');
  });

  it('rejects a start beyond the auto-finish window at both service and schema boundaries', async () => {
    const clock = new FixedClock(effectiveNow);
    const tooFarInTheFuture = '2031-01-03T00:00:00.001Z';

    await expect(
      withTenantTransaction(
        runtimePool,
        { orgId: ids.orgA, userId: ids.userDual },
        (client) =>
          createRun(
            client,
            { userId: ids.userDual },
            ids.orgA,
            runIds.invalidFutureStart,
            { startedAt: tooFarInTheFuture },
            clock,
          ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 });

    await expect(
      ownerPool.query(
        `INSERT INTO runs (org_id, id, user_id, status, started_at, created_at)
         VALUES ($1, $2, $3, 'recording', $4, $5)`,
        [
          ids.orgA,
          runIds.invalidFutureStart,
          ids.userDual,
          tooFarInTheFuture,
          effectiveNow,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'runs_start_within_auto_finish_window' });
  });

  it('grants only the function capability and no direct runs access', async () => {
    await expect(maintenancePool.query('SELECT * FROM runs')).rejects.toThrow(/permission denied/u);
    await expect(
      maintenancePool.query("UPDATE runs SET status = 'finished' WHERE false"),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      maintenancePool.query('SELECT app_private.has_active_membership()'),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      runtimePool.query('SELECT app_private.auto_finish_runs($1::timestamptz)', [effectiveNow]),
    ).rejects.toThrow(/permission denied/u);

    const privileges = await maintenancePool.query<{
      can_call_auto_finish: boolean;
      can_select_runs: boolean;
      can_update_runs: boolean;
    }>(
      `SELECT
         has_function_privilege(
           current_user,
           'app_private.auto_finish_runs(timestamp with time zone)',
           'EXECUTE'
         ) AS can_call_auto_finish,
         has_table_privilege(current_user, 'runs', 'SELECT') AS can_select_runs,
         has_table_privilege(current_user, 'runs', 'UPDATE') AS can_update_runs`,
    );
    expect(privileges.rows[0]).toEqual({
      can_call_auto_finish: true,
      can_select_runs: false,
      can_update_runs: false,
    });

    const functionDefinition = await ownerPool.query<{
      function_owner: string;
      is_security_definer: boolean;
      settings: string[] | null;
    }>(
      `SELECT pg_get_userbyid(procedure.proowner) AS function_owner,
              procedure.prosecdef AS is_security_definer,
              procedure.proconfig AS settings
       FROM pg_proc AS procedure
       JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'app_private'
         AND procedure.proname = 'auto_finish_runs'`,
    );
    expect(functionDefinition.rows[0]).toEqual({
      function_owner: 'running_tracker_owner',
      is_security_definer: true,
      settings: ['search_path=pg_catalog'],
    });

    const role = await ownerPool.query<{
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles
       WHERE rolname = 'running_tracker_maintenance'`,
    );
    expect(role.rows[0]).toEqual({
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolsuper: false,
    });
    await expect(runAutoFinishOnce(maintenancePool, maintenanceClock)).resolves.toBe(0);
  });
});
