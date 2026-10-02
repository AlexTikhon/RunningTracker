import { openApiDocument } from '@running-tracker/contracts';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { DatabasePool } from '../src/database/database.js';

const methods = ['get', 'put', 'post', 'delete'] as const;
type Method = (typeof methods)[number];

const uuid = '11111111-1111-4111-8111-111111111111';
const pathValues: Record<string, string> = {
  orgId: uuid,
  runId: uuid,
  userId: uuid,
  x: '1',
  y: '1',
  z: '10',
};

const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => Date.parse('2026-10-02T10:00:00.000Z'),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date('2026-10-02T10:00:00.000Z'),
};

// OIDC points at a closed loopback port: the sign-in routes are mounted, and a request to one fails
// fast as "provider unavailable" instead of reaching any network.
const config = validateEnvironment({
  ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
  LOCAL_AUTH_ENABLED: 'true',
  LOCAL_AUTH_USER_IDS: uuid,
  MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/test',
  OIDC_CLIENT_ID: 'running-tracker',
  OIDC_CLIENT_SECRET: 'client-secret-value',
  OIDC_ISSUER_URL: 'http://127.0.0.1:1',
  OIDC_REDIRECT_URI: 'http://127.0.0.1:5173/api/auth/callback',
  SESSION_COOKIE_SECURE: 'false',
});
const pool: DatabasePool = {
  connect: vi.fn(() => Promise.reject(new Error('The database must not be used by route coverage'))),
};

interface Operation {
  implemented: boolean;
  method: Method;
  path: string;
}

function operations(): Operation[] {
  const found: Operation[] = [];
  for (const [template, item] of Object.entries(openApiDocument.paths)) {
    const path = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = pathValues[name];
      if (value === undefined) {
        throw new Error(`No test value for path parameter ${name}`);
      }
      return value;
    });
    for (const method of methods) {
      const operation = (item as Record<string, { 'x-implemented'?: boolean } | undefined>)[method];
      if (operation !== undefined) {
        found.push({ implemented: operation['x-implemented'] !== false, method, path });
      }
    }
  }
  return found;
}

async function answerFor(operation: Operation): Promise<{ code: unknown; status: number }> {
  const app = createApp({ clock, config, pool });
  const response = await request(app)[operation.method](operation.path);
  const body = response.body as { error?: { code?: unknown } } | undefined;
  return { code: body?.error?.code, status: response.status };
}

describe('the OpenAPI document and the mounted routes', () => {
  const all = operations();

  it('covers every documented operation', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all.filter((operation) => operation.implemented))(
    'implements $method $path',
    async (operation) => {
      const answer = await answerFor(operation);
      expect(answer.code).not.toBe('ROUTE_NOT_FOUND');
    },
  );

  it.each(all.filter((operation) => !operation.implemented))(
    'marks $method $path as not implemented only while it is not mounted',
    async (operation) => {
      const answer = await answerFor(operation);
      expect(answer.status).toBe(404);
      expect(answer.code).toBe('ROUTE_NOT_FOUND');
    },
  );

  it('flags exactly the three read operations the SDD specifies but the service never built', () => {
    expect(
      all
        .filter((operation) => !operation.implemented)
        .map((operation) => `${operation.method} ${operation.path.replaceAll(uuid, '{id}')}`)
        .sort(),
    ).toEqual([
      'get /api/orgs/{id}/archive/runs',
      'get /api/orgs/{id}/live/nearby',
      'get /api/orgs/{id}/runs/{id}/track',
    ]);
  });
});
