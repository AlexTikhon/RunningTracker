import {
  apiErrorResponseSchema,
  runCommandResponseSchema,
  runViewSchema,
} from '@running-tracker/contracts';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const startedAt = '2029-09-22T10:00:00.000Z';
const finishedAt = '2030-09-22T10:00:00.000Z';

const testIds = {
  commandA: 'c3300000-0000-4000-8000-000000000001',
  commandB: 'c3300000-0000-4000-8000-000000000002',
  commandC: 'c3300000-0000-4000-8000-000000000003',
  commandRollback: 'c3300000-0000-4000-8000-000000000004',
  runA: 'a3300000-0000-4000-8000-000000000001',
  runB: 'a3300000-0000-4000-8000-000000000002',
  runC: 'a3300000-0000-4000-8000-000000000003',
  runD: 'a3300000-0000-4000-8000-000000000004',
  runE: 'a3300000-0000-4000-8000-000000000005',
  runF: 'a3300000-0000-4000-8000-000000000006',
  runTombstoned: 'a3300000-0000-4000-8000-000000000007',
} as const;

const testRunIds = [
  testIds.runA,
  testIds.runB,
  testIds.runC,
  testIds.runD,
  testIds.runE,
  testIds.runF,
  testIds.runTombstoned,
];

class FixedClock implements Clock {
  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return Date.parse(finishedAt);
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(finishedAt);
  }
}

interface Authentication {
  cookie: string;
  csrfToken: string;
}

function objectBody(response: request.Response): Record<string, unknown> {
  const body = response.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected an object response body');
  }
  return body as Record<string, unknown>;
}

function cookiePair(response: request.Response): string {
  const header: unknown = response.headers['set-cookie'];
  if (typeof header === 'string') {
    return header.split(';', 1)[0]!;
  }
  if (Array.isArray(header)) {
    const first: unknown = header[0];
    if (typeof first === 'string') {
      return first.split(';', 1)[0]!;
    }
  }
  throw new Error('Expected a session cookie');
}

describe('P03.3 run creation and lifecycle commands', () => {
  let app: ReturnType<typeof createApp>;
  let authentication: Authentication;
  let config: Environment;
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    config = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: ids.userDual,
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 4 });
    ownerPool = new Pool({
      application_name: 'running-tracker-p033-fixtures',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);

    const sessionManager = new SessionManager({
      clock: new FixedClock(),
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    app = createApp({
      clock: new FixedClock(),
      config,
      pool: runtimePool,
      sessionManager,
    });
    const login = await request(app)
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId: ids.userDual })
      .expect(201);
    const csrf = objectBody(login).csrf;
    if (!csrf || typeof csrf !== 'object' || Array.isArray(csrf)) {
      throw new Error('Expected a CSRF response');
    }
    const token = (csrf as Record<string, unknown>).token;
    if (typeof token !== 'string') {
      throw new Error('Expected a CSRF token');
    }
    authentication = { cookie: cookiePair(login), csrfToken: token };
  });

  beforeEach(async () => {
    await ownerPool.query('DROP TRIGGER IF EXISTS p033_reject_command ON run_commands');
    await ownerPool.query('DROP FUNCTION IF EXISTS public.p033_reject_command()');
    await ownerPool.query('DELETE FROM runs WHERE id = ANY($1::uuid[])', [testRunIds]);
    await ownerPool.query('DELETE FROM run_tombstones WHERE run_id = ANY($1::uuid[])', [testRunIds]);
  });

  afterAll(async () => {
    if (ownerPool) {
      await ownerPool.query('DROP TRIGGER IF EXISTS p033_reject_command ON run_commands');
      await ownerPool.query('DROP FUNCTION IF EXISTS public.p033_reject_command()');
      await ownerPool.query('DELETE FROM runs WHERE id = ANY($1::uuid[])', [testRunIds]);
      await ownerPool.query('DELETE FROM run_tombstones WHERE run_id = ANY($1::uuid[])', [testRunIds]);
    }
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function mutation(method: 'post' | 'put', path: string) {
    const pending = method === 'post' ? request(app).post(path) : request(app).put(path);
    return pending
      .set('Cookie', authentication.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, authentication.csrfToken)
      .type('application/json');
  }

  function create(runId: string, body: { startedAt: string } = { startedAt }) {
    return mutation('put', `/api/orgs/${ids.orgA}/runs/${runId}`).send(body);
  }

  function command(
    runId: string,
    body: { commandId: string; expectedControlRevision: string; type: string },
  ) {
    return mutation('post', `/api/orgs/${ids.orgA}/runs/${runId}/commands`).send(body);
  }

  async function databaseRun(runId: string) {
    const result = await ownerPool.query<{
      control_revision: string;
      data_revision: string;
      finished_at: Date | null;
      status: string;
    }>(
      `SELECT status, finished_at, data_revision, control_revision
       FROM runs WHERE org_id = $1 AND id = $2`,
      [ids.orgA, runId],
    );
    return result.rows[0];
  }

  it('creates atomically, replays an equivalent PUT, rejects changed payload, and preserves string revisions', async () => {
    const preciseStartedAt = '2029-09-22T10:00:00.000001Z';
    const created = await create(testIds.runA, { startedAt: preciseStartedAt }).expect(201);
    expect(runViewSchema.parse(objectBody(created))).toEqual({
      controlRevision: '0',
      dataRevision: '0',
      finishedAt: null,
      rawState: 'available',
      runId: testIds.runA,
      startedAt: preciseStartedAt,
      status: 'recording',
      summary: null,
    });

    const replay = await create(testIds.runA, { startedAt: preciseStartedAt }).expect(200);
    expect(runViewSchema.parse(objectBody(replay))).toEqual(objectBody(created));

    const conflict = await create(testIds.runA, {
      startedAt: '2029-09-22T10:00:00.000002Z',
    }).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(conflict)).error.code).toBe('ACTIVE_RUN_EXISTS');
  });

  it('lets the database choose one winner for concurrent active-run creation in the same organization', async () => {
    const responses = await Promise.all([create(testIds.runA), create(testIds.runB)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const rejected = responses.find(({ status }) => status === 409);
    expect(apiErrorResponseSchema.parse(objectBody(rejected!)).error.code).toBe('ACTIVE_RUN_EXISTS');

    const count = await ownerPool.query<{ count: string }>(
      `SELECT count(*)
       FROM runs
       WHERE user_id = $1 AND status IN ('recording', 'paused')`,
      [ids.userDual],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('returns one creation and one replay for concurrent equivalent PUT requests', async () => {
    const responses = await Promise.all([create(testIds.runA), create(testIds.runA)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
    const first = runViewSchema.parse(objectBody(responses[0]));
    expect(runViewSchema.parse(objectBody(responses[1]))).toEqual(first);

    const count = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM runs WHERE org_id = $1 AND id = $2',
      [ids.orgA, testIds.runA],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('rejects recreation of an owned tombstoned run', async () => {
    await ownerPool.query(
      `INSERT INTO run_tombstones (org_id, run_id, owner_user_id, deleted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [ids.orgA, testIds.runTombstoned, ids.userDual, startedAt, finishedAt],
    );
    const response = await create(testIds.runTombstoned).expect(410);
    expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe('RUN_DELETED');
  });

  it('serializes two different commands at one revision so exactly one transition commits', async () => {
    await create(testIds.runC).expect(201);
    const responses = await Promise.all([
      command(testIds.runC, {
        commandId: testIds.commandA,
        expectedControlRevision: '0',
        type: 'pause',
      }),
      command(testIds.runC, {
        commandId: testIds.commandB,
        expectedControlRevision: '0',
        type: 'finish',
      }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const accepted = responses.find(({ status }) => status === 200);
    const rejected = responses.find(({ status }) => status === 409);
    if (!accepted || !rejected) {
      throw new Error('Expected one accepted and one rejected command');
    }
    expect(runCommandResponseSchema.parse(objectBody(accepted))).toMatchObject({
      controlRevision: '1',
      dataRevision: '1',
    });
    expect(apiErrorResponseSchema.parse(objectBody(rejected)).error.code).toBe(
      'CONTROL_REVISION_CONFLICT',
    );

    const persisted = await databaseRun(testIds.runC);
    expect(persisted).toMatchObject({ control_revision: '1', data_revision: '1' });
    const commandCount = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM run_commands WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, testIds.runC],
    );
    expect(commandCount.rows[0]?.count).toBe('1');
  });

  it('replays the same command concurrently and after commit before checking its stale revision', async () => {
    await create(testIds.runD).expect(201);
    const body = {
      commandId: testIds.commandA,
      expectedControlRevision: '0',
      type: 'pause',
    };
    const concurrent = await Promise.all([
      command(testIds.runD, body),
      command(testIds.runD, body),
    ]);
    expect(concurrent.map(({ status }) => status)).toEqual([200, 200]);
    const first = runCommandResponseSchema.parse(objectBody(concurrent[0]));
    expect(runCommandResponseSchema.parse(objectBody(concurrent[1]))).toEqual(first);
    expect(first).toMatchObject({ controlRevision: '1', dataRevision: '1', status: 'paused' });

    const replay = await command(testIds.runD, body).expect(200);
    expect(runCommandResponseSchema.parse(objectBody(replay))).toEqual(first);
    const persisted = await databaseRun(testIds.runD);
    expect(persisted).toMatchObject({
      control_revision: '1',
      data_revision: '1',
      status: 'paused',
    });
  });

  it('rejects command-ID reuse with a different payload and leaves the original result intact', async () => {
    await create(testIds.runE).expect(201);
    const original = await command(testIds.runE, {
      commandId: testIds.commandA,
      expectedControlRevision: '0',
      type: 'pause',
    }).expect(200);
    const conflict = await command(testIds.runE, {
      commandId: testIds.commandA,
      expectedControlRevision: '1',
      type: 'resume',
    }).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(conflict)).error.code).toBe(
      'CONTROL_REVISION_CONFLICT',
    );
    const stored = await ownerPool.query<{ response: unknown }>(
      `SELECT response FROM run_commands
       WHERE org_id = $1 AND run_id = $2 AND command_id = $3`,
      [ids.orgA, testIds.runE, testIds.commandA],
    );
    expect(stored.rows[0]?.response).toEqual(objectBody(original));
  });

  it('rejects stale expectedControlRevision without storing a command or changing either revision', async () => {
    await create(testIds.runF).expect(201);
    const response = await command(testIds.runF, {
      commandId: testIds.commandB,
      expectedControlRevision: '7',
      type: 'pause',
    }).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(response)).error.code).toBe(
      'CONTROL_REVISION_CONFLICT',
    );
    expect(await databaseRun(testIds.runF)).toMatchObject({
      control_revision: '0',
      data_revision: '0',
      status: 'recording',
    });
    const commandCount = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM run_commands WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, testIds.runF],
    );
    expect(commandCount.rows[0]?.count).toBe('0');
  });

  it('implements pause/resume/finish exactly and keeps finish terminal with one server timestamp', async () => {
    await create(testIds.runA).expect(201);
    const pause = await command(testIds.runA, {
      commandId: testIds.commandA,
      expectedControlRevision: '0',
      type: 'pause',
    }).expect(200);
    expect(runCommandResponseSchema.parse(objectBody(pause))).toMatchObject({
      controlRevision: '1',
      dataRevision: '1',
      finishedAt: null,
      status: 'paused',
    });

    await command(testIds.runA, {
      commandId: testIds.commandB,
      expectedControlRevision: '1',
      type: 'resume',
    }).expect(200);
    const finishBody = {
      commandId: testIds.commandC,
      expectedControlRevision: '2',
      type: 'finish',
    };
    const finish = await command(testIds.runA, finishBody).expect(200);
    const terminal = runCommandResponseSchema.parse(objectBody(finish));
    expect(terminal).toMatchObject({
      controlRevision: '3',
      dataRevision: '3',
      finishedAt,
      status: 'finished',
    });

    const invalid = await command(testIds.runA, {
      commandId: testIds.commandRollback,
      expectedControlRevision: '3',
      type: 'finish',
    }).expect(409);
    expect(apiErrorResponseSchema.parse(objectBody(invalid)).error.code).toBe(
      'CONTROL_REVISION_CONFLICT',
    );
    const replay = await command(testIds.runA, finishBody).expect(200);
    expect(runCommandResponseSchema.parse(objectBody(replay))).toEqual(terminal);
    expect(await databaseRun(testIds.runA)).toMatchObject({
      control_revision: '3',
      data_revision: '3',
      status: 'finished',
    });
  });

  it('rolls back the run transition when command-result persistence fails', async () => {
    await create(testIds.runB).expect(201);
    await ownerPool.query(
      `CREATE FUNCTION public.p033_reject_command()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$
       BEGIN
         IF NEW.command_id = '${testIds.commandRollback}'::uuid THEN
           RAISE EXCEPTION 'intentional P03.3 rollback probe';
         END IF;
         RETURN NEW;
       END
       $function$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER p033_reject_command
       BEFORE INSERT ON run_commands
       FOR EACH ROW EXECUTE FUNCTION public.p033_reject_command()`,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await command(testIds.runB, {
        commandId: testIds.commandRollback,
        expectedControlRevision: '0',
        type: 'pause',
      }).expect(500);
    } finally {
      log.mockRestore();
    }

    expect(await databaseRun(testIds.runB)).toMatchObject({
      control_revision: '0',
      data_revision: '0',
      status: 'recording',
    });
    const commandCount = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM run_commands WHERE org_id = $1 AND run_id = $2',
      [ids.orgA, testIds.runB],
    );
    expect(commandCount.rows[0]?.count).toBe('0');
  });
});
