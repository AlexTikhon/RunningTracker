import { Router } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import {
  createAuthenticatedMutationProtection,
  csrfHeaderName,
  getAuthenticatedSession,
} from '../src/auth/session-http.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import { systemClock } from '../src/clock.js';
import {
  loadIntegrationTestConfiguration,
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { withAuthenticatedTenantTransaction } from '../src/database/authenticated-tenant-transaction.js';
import { createDatabasePool } from '../src/database/database.js';
import {
  prepareTenantIsolationFixtures,
  tenantIsolationIds as ids,
} from './tenant-isolation-fixtures.js';

const allowedOrigin = 'http://127.0.0.1:5173';

interface LoginResult {
  csrfToken: string;
}

type TestAgent = ReturnType<typeof request.agent>;

function responseBody(response: request.Response): Record<string, unknown> {
  const body = response.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected an object response body');
  }
  return body as Record<string, unknown>;
}

function nestedString(response: request.Response, objectName: string, property: string): string {
  const nested = responseBody(response)[objectName];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    throw new Error(`Expected ${objectName} object`);
  }
  const value = (nested as Record<string, unknown>)[property];
  if (typeof value !== 'string') {
    throw new Error(`Expected ${objectName}.${property} string`);
  }
  return value;
}

describe('HTTP session to runtime-role tenant boundary', () => {
  let app: ReturnType<typeof createApp>;
  let callbackCount = 0;
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
      LOCAL_AUTH_USER_IDS: [ids.userDual, ids.userOrgB, ids.userInactive].join(','),
      SESSION_COOKIE_SECURE: 'false',
    });
    runtimePool = createDatabasePool({ ...config, DB_POOL_MAX: 1 });
    ownerPool = new Pool({
      application_name: 'running-tracker-http-session-fixtures',
      connectionString: integration.migration.connectionString,
      max: 1,
    });
    await prepareTenantIsolationFixtures(ownerPool, integration.migration);

    const sessionManager = new SessionManager({
      clock: systemClock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
    const testRouter = Router();
    testRouter.post(
      '/__test/orgs/:orgId/probe',
      ...createAuthenticatedMutationProtection(config, sessionManager),
      async (httpRequest, response, next) => {
        try {
          const orgId = httpRequest.params.orgId;
          if (!orgId || Array.isArray(orgId)) {
            throw new Error('The test route requires orgId');
          }
          const result = await withAuthenticatedTenantTransaction(
            runtimePool,
            getAuthenticatedSession(httpRequest),
            orgId,
            async (client) => {
              callbackCount += 1;
              const context = await client.query<{
                org_id: string;
                pid: number;
                user_id: string;
              }>(
                `SELECT current_setting('app.org_id', true) AS org_id,
                        current_setting('app.user_id', true) AS user_id,
                        pg_backend_pid() AS pid
                 FROM organizations
                 WHERE id = $1`,
                [orgId],
              );
              return context.rows[0];
            },
          );
          response.status(200).json(result);
        } catch (error) {
          next(error);
        }
      },
    );
    app = createApp({
      clock: systemClock,
      config,
      pool: runtimePool,
      sessionManager,
      testOnlyRouter: testRouter,
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
  });

  async function login(agent: TestAgent, userId: string): Promise<LoginResult> {
    const response = await agent
      .post('/api/session')
      .set('Origin', allowedOrigin)
      .type('application/json')
      .send({ userId })
      .expect(201);
    return { csrfToken: nestedString(response, 'csrf', 'token') };
  }

  function probe(agent: TestAgent, orgId: string, csrfToken: string) {
    return agent
      .post(`/api/__test/orgs/${orgId}/probe`)
      .set('Origin', allowedOrigin)
      .set(csrfHeaderName, csrfToken);
  }

  it('derives userId from the verified session and switches a dual member across organizations on one pooled connection', async () => {
    const agent = request.agent(app);
    const { csrfToken } = await login(agent, ids.userDual);

    const orgA = await probe(agent, ids.orgA, csrfToken)
      .set('x-user-id', ids.userOrgB)
      .query({ userId: ids.userOrgB })
      .send({ userId: ids.userOrgB })
      .expect(200);
    expect(responseBody(orgA)).toMatchObject({ org_id: ids.orgA, user_id: ids.userDual });

    const orgB = await probe(agent, ids.orgB, csrfToken).expect(200);
    expect(responseBody(orgB)).toMatchObject({ org_id: ids.orgB, user_id: ids.userDual });
    expect(responseBody(orgB).pid).toBe(responseBody(orgA).pid);
  });

  it('returns ORG_ACCESS_DENIED for inactive or absent membership before the protected callback', async () => {
    for (const userId of [ids.userInactive, ids.userOrgB]) {
      const agent = request.agent(app);
      const { csrfToken } = await login(agent, userId);
      const before = callbackCount;
      await probe(agent, ids.orgA, csrfToken)
        .expect(403)
        .expect((response) =>
          expect(nestedString(response, 'error', 'code')).toBe('ORG_ACCESS_DENIED'),
        );
      expect(callbackCount).toBe(before);
    }
  });

  it('validates orgId before opening the tenant transaction', async () => {
    const agent = request.agent(app);
    const { csrfToken } = await login(agent, ids.userDual);
    const before = callbackCount;

    await probe(agent, 'not-a-uuid', csrfToken)
      .expect(400)
      .expect((response) => expect(nestedString(response, 'error', 'code')).toBe('INVALID_REQUEST'));
    expect(callbackCount).toBe(before);
  });

  it('observes membership deactivation on the next request and does not run its DB callback', async () => {
    const agent = request.agent(app);
    const { csrfToken } = await login(agent, ids.userDual);
    await probe(agent, ids.orgA, csrfToken).expect(200);

    await ownerPool.query(
      'UPDATE memberships SET active = false WHERE org_id = $1 AND user_id = $2',
      [ids.orgA, ids.userDual],
    );
    try {
      const before = callbackCount;
      await probe(agent, ids.orgA, csrfToken)
        .expect(403)
        .expect((response) =>
          expect(nestedString(response, 'error', 'code')).toBe('ORG_ACCESS_DENIED'),
        );
      expect(callbackCount).toBe(before);
    } finally {
      await ownerPool.query(
        'UPDATE memberships SET active = true WHERE org_id = $1 AND user_id = $2',
        [ids.orgA, ids.userDual],
      );
    }
  });
});
