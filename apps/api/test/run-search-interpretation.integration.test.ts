import { apiErrorResponseSchema, runSearchInterpretationResponseSchema } from '@running-tracker/contracts';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { createDatabasePool, type DatabasePool } from '../src/database/database.js';
import type { ProviderProposal } from '../src/runs/interpretation/interpretation-schema.js';
import type {
  InterpretationInput,
  InterpretCallOptions,
  InterpreterAnswer,
  RunSearchInterpreter,
} from '../src/runs/interpretation/interpretation-types.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';
// Belongs to no organization at all (tenant-isolation-fixtures gives userStranger an active coach membership).
const nobody = '99999999-9999-4999-8999-999999999999';
const sentence = 'Show my runs of at least 5 km from last month, longest first.';

const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date('2026-10-15T12:00:00.000Z'),
};

const proposal: ProviderProposal = {
  clarificationReason: null,
  distanceUnit: 'km',
  fromDate: null,
  maxDistance: null,
  minDistance: '5',
  outcome: 'search',
  period: 'previous-month',
  sort: 'longest',
  toDate: null,
  unsupportedReason: null,
};

type Behaviour = (input: InterpretationInput, options: InterpretCallOptions) => Promise<InterpreterAnswer>;

class TestInterpreter implements RunSearchInterpreter {
  public readonly model = 'test-model';
  public calls = 0;
  public behaviour: Behaviour = () => Promise.resolve({ proposal, usage: null });

  public interpret(input: InterpretationInput, options: InterpretCallOptions): Promise<InterpreterAnswer> {
    this.calls += 1;
    return this.behaviour(input, options);
  }
}

describe('run search interpretation under the runtime role', () => {
  let app: ReturnType<typeof createApp>;
  let ownerPool: Pool;
  let runtimePool: Pool;
  const interpreter = new TestInterpreter();
  const statements: string[] = [];
  const credentials = new Map<string, { cookie: string; csrf: string }>();
  const patched = Symbol('statementsRecorded');

  // The real runtime pool, with every statement recorded so that "no run table is read" is a fact and not a hope.
  const recordingPool: DatabasePool = {
    connect: async () => {
      const client = (await runtimePool.connect()) as PoolClient & { [patched]?: true };
      if (client[patched] !== true) {
        const query = client.query.bind(client) as (...args: unknown[]) => unknown;
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
          const first = args[0];
          statements.push(typeof first === 'string' ? first : (first as { text: string }).text);
          return query(...args);
        };
        client[patched] = true;
      }
      return client;
    },
  };

  beforeAll(async () => {
    const integration = loadIntegrationTestConfiguration();
    const users = [ids.userDual, ids.userInactive, ids.userOrgA, ids.userOrgB, nobody];
    const config: Environment = validateEnvironment({
      ALLOWED_ORIGINS: allowedOrigin,
      APP_ENV: 'test',
      DATABASE_URL: integration.runtime.connectionString,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: users.join(','),
      MAINTENANCE_DATABASE_URL: integration.maintenance.connectionString,
      RUN_SEARCH_AI_ENABLED: 'true',
      RUN_SEARCH_AI_PROVIDER: 'fake',
      RUN_SEARCH_AI_USER_RATE_PER_MINUTE: '60',
      SESSION_COOKIE_SECURE: 'false',
    });
    // One connection only: if a request kept it while the provider worked, nothing else could use the database.
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 1 });
    ownerPool = new Pool({
      application_name: 'running-tracker-interpretation-fixtures',
      connectionString: integration.migration.connectionString,
      max: 2,
    });
    app = createApp({
      clock,
      config,
      pool: recordingPool,
      sessionManager: new SessionManager({
        clock,
        store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
        ttlMs: config.SESSION_TTL_MS,
      }),
      testOnlyRunSearchInterpreter: interpreter,
    });
    for (const userId of users) {
      const login = await request(app)
        .post('/api/session')
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ userId })
        .expect(201);
      const setCookie = (login.headers['set-cookie'] as unknown as string[])[0]!;
      credentials.set(userId, {
        cookie: setCookie.split(';', 1)[0]!,
        csrf: (login.body as { csrf: { token: string } }).csrf.token,
      });
    }
  });

  beforeEach(async () => {
    await prepareTenantIsolationFixtures(ownerPool, loadIntegrationTestConfiguration().migration);
    interpreter.calls = 0;
    interpreter.behaviour = () => Promise.resolve({ proposal, usage: null });
    statements.length = 0;
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  function interpret(userId: string, orgId: string, text = sentence) {
    const who = credentials.get(userId)!;
    return request(app)
      .post(`/api/orgs/${orgId}/runs/search/interpretations`)
      .set('Cookie', who.cookie)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, who.csrf)
      .type('application/json')
      .send({ text, timeZone: 'Europe/Warsaw' });
  }

  it('answers an active member and reads no run, summary, point, share or archive table', async () => {
    const response = await interpret(ids.userDual, ids.orgA).expect(200);
    expect(runSearchInterpretationResponseSchema.parse(response.body)).toMatchObject({ outcome: 'search' });
    expect(interpreter.calls).toBe(1);

    const touched = statements.join('\n').toLowerCase();
    for (const table of ['runs', 'run_summaries', 'run_points', 'run_shares', 'archive']) {
      expect(touched, table).not.toMatch(new RegExp(`\\b${table}\\b`, 'u'));
    }
    expect(touched).toContain('memberships');
  });

  it.each([
    ['a person with no membership at all', nobody, ids.orgA],
    ['a member of another organization asking about this one', ids.userOrgB, ids.orgA],
    ['a person whose membership is inactive', ids.userInactive, ids.orgA],
    ['a member of a different organization', ids.userOrgA, ids.orgB],
  ])('refuses %s before any provider call', async (_name, userId, orgId) => {
    const response = await interpret(userId, orgId).expect(403);
    expect(apiErrorResponseSchema.parse(response.body).error.code).toBe('ORG_ACCESS_DENIED');
    expect(interpreter.calls).toBe(0);
  });

  it('holds no database connection while the provider works (a one-connection pool stays usable)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    interpreter.behaviour = async () => {
      started();
      await gate;
      return { proposal, usage: null };
    };

    const pending = interpret(ids.userDual, ids.orgA).then((response) => response);
    await providerStarted;

    // With the only connection free, an unrelated request that needs the database is answered at once.
    const during = await request(app)
      .get('/api/organizations')
      .set('Cookie', credentials.get(ids.userOrgA)!.cookie)
      .timeout(3_000);
    expect(during.status).toBe(200);

    release();
    expect((await pending).status).toBe(200);
  });

  it('does not deliver the proposal when the membership is revoked while the provider works', async () => {
    interpreter.behaviour = async () => {
      await ownerPool.query('UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2', [
        ids.orgA,
        ids.userDual,
      ]);
      return { proposal, usage: null };
    };
    const response = await interpret(ids.userDual, ids.orgA).expect(403);
    const body = apiErrorResponseSchema.parse(response.body);
    expect(body.error.code).toBe('ORG_ACCESS_DENIED');
    expect(JSON.stringify(response.body)).not.toContain('previous-month');
    expect(interpreter.calls).toBe(1);
  });
});
