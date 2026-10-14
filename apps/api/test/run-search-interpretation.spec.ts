import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  apiErrorResponseSchema,
  runSearchInterpretationResponseSchema,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { SessionManager } from '../src/auth/session-manager.js';
import { csrfHeaderName } from '../src/auth/session-http.js';
import { InMemorySessionStore } from '../src/auth/session-store.js';
import type { Clock } from '../src/clock.js';
import { validateEnvironment, type Environment } from '../src/config/environment.js';
import type { DatabasePool } from '../src/database/database.js';
import { createApiMetrics } from '../src/observability/api-metrics.js';
import { createLogger } from '../src/observability/logger.js';
import type { ProviderProposal } from '../src/runs/interpretation/interpretation-schema.js';
import {
  InterpreterFailure,
  type InterpretationInput,
  type InterpretCallOptions,
  type InterpreterAnswer,
  type RunSearchInterpreter,
} from '../src/runs/interpretation/interpretation-types.js';

const allowedOrigin = 'http://127.0.0.1:5173';
const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const orgId = '33333333-3333-4333-8333-333333333333';
const SENTINEL = 'SENTINEL-HOME-ADDRESS-91c2';
const sentence = 'Show my runs of at least 5 km from last month, longest first.';
const url = `/api/orgs/${orgId}/runs/search/interpretations`;

const clock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date('2026-10-15T12:00:00.000Z'),
};

const search: ProviderProposal = {
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

class Interpreter implements RunSearchInterpreter {
  public readonly model = 'test-model';
  public calls: InterpretationInput[] = [];
  public openClientsAtCall: number[] = [];

  public constructor(
    private readonly openClients: () => number,
    public behaviour: Behaviour,
  ) {}

  public interpret(input: InterpretationInput, options: InterpretCallOptions): Promise<InterpreterAnswer> {
    this.calls.push(input);
    this.openClientsAtCall.push(this.openClients());
    return this.behaviour(input, options);
  }
}

const answerWith =
  (proposal: ProviderProposal = search): Behaviour =>
  () =>
    Promise.resolve({ proposal, usage: { inputTokens: 700, outputTokens: 40 } });

// A pool that is only a membership table and a count of connections currently checked out.
class FakeDatabase {
  public connects = 0;
  public membership = true;
  public open = 0;
  public statements: string[] = [];

  public readonly pool: DatabasePool = {
    connect: () => {
      this.connects += 1;
      this.open += 1;
      let released = false;
      const client = {
        query: (sql: string) => {
          this.statements.push(sql);
          if (sql.includes('FROM memberships')) {
            return Promise.resolve({ command: 'SELECT', rows: [{ allowed: this.membership }] });
          }
          return Promise.resolve({ command: sql.startsWith('COMMIT') ? 'COMMIT' : 'SELECT', rows: [] });
        },
        release: () => {
          if (!released) {
            released = true;
            this.open -= 1;
          }
        },
      };
      return Promise.resolve(client as unknown as PoolClient);
    },
  };
}

interface Harness {
  config: Environment;
  csrf: string;
  database: FakeDatabase;
  interpreter: Interpreter;
  logs: string[];
  metrics: ReturnType<typeof createApiMetrics>;
  sessions: SessionManager;
  app: ReturnType<typeof createApp>;
  cookie: string;
}

function configuration(overrides: Record<string, unknown> = {}): Environment {
  return validateEnvironment({
    ALLOWED_ORIGINS: allowedOrigin,
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: `${userId},${otherUserId}`,
    MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/test',
    RUN_SEARCH_AI_ENABLED: 'true',
    RUN_SEARCH_AI_PROVIDER: 'fake',
    SESSION_COOKIE_SECURE: 'false',
    ...overrides,
  });
}

async function harness(overrides: Record<string, unknown> = {}, who = userId): Promise<Harness> {
  const config = configuration(overrides);
  const database = new FakeDatabase();
  const interpreter = new Interpreter(() => database.open, answerWith());
  const sessions = new SessionManager({
    clock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    ttlMs: config.SESSION_TTL_MS,
  });
  const logs: string[] = [];
  const metrics = createApiMetrics();
  const app = createApp({
    clock,
    config,
    logger: createLogger({ clock, write: (_level, line) => logs.push(line) }),
    metrics,
    pool: database.pool,
    sessionManager: sessions,
    testOnlyRunSearchInterpreter: interpreter,
  });
  const login = await request(app)
    .post('/api/session')
    .set('Origin', allowedOrigin)
    .type('application/json')
    .send({ userId: who })
    .expect(201);
  const setCookie: unknown = login.headers['set-cookie'];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';', 1)[0]!;
  const csrf = (login.body as { csrf: { token: string } }).csrf.token;
  return { app, config, cookie, csrf, database, interpreter, logs, metrics, sessions };
}

function post(h: Harness, body: unknown = { text: sentence, timeZone: 'Europe/Warsaw' }) {
  return request(h.app)
    .post(url)
    .set('Cookie', h.cookie)
    .set('Origin', allowedOrigin)
    .set(csrfHeaderName, h.csrf)
    .type('application/json')
    .send(body as object);
}

function errorOf(response: request.Response) {
  return apiErrorResponseSchema.parse(response.body).error;
}

describe('POST /runs/search/interpretations', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  describe('a proposal', () => {
    it('answers with validated filters and calls the interpreter once with only text, zone and date', async () => {
      const response = await post(h).expect(200);

      expect(runSearchInterpretationResponseSchema.parse(response.body)).toEqual({
        filters: {
          distanceUnit: 'km',
          maxDistance: null,
          minDistance: '5',
          period: { kind: 'preset', preset: 'previous-month' },
          sort: 'longest',
          timeZone: 'Europe/Warsaw',
        },
        outcome: 'search',
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(h.interpreter.calls).toEqual([{ text: sentence, timeZone: 'Europe/Warsaw', today: '2026-10-15' }]);
    });

    it('does not search: no run table is read', async () => {
      await post(h).expect(200);
      const all = h.database.statements.join('\n').toLowerCase();
      for (const table of ['from runs', 'run_summaries', 'run_points', 'archive', 'run_shares']) {
        expect(all, table).not.toContain(table);
      }
    });

    it('carries a clarification as a reason code and nothing the model said', async () => {
      h.interpreter.behaviour = answerWith({
        ...search,
        clarificationReason: 'distance_boundary_strict',
        distanceUnit: null,
        minDistance: null,
        outcome: 'clarify',
        period: null,
        sort: null,
      });
      const response = await post(h).expect(200);
      expect(response.body).toEqual({ outcome: 'clarify', reason: 'distance_boundary_strict' });
    });
  });

  describe('before any provider call', () => {
    it('refuses a request without a session', async () => {
      const response = await request(h.app)
        .post(url)
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ text: sentence, timeZone: 'UTC' })
        .expect(401);
      expect(errorOf(response).code).toBe('AUTH_REQUIRED');
      expect(h.interpreter.calls).toHaveLength(0);
    });

    it.each([
      ['a foreign origin', 'http://evil.example', undefined, 'ORIGIN_DENIED'],
      ['no origin', undefined, undefined, 'ORIGIN_DENIED'],
    ])('refuses %s', async (_name, origin, _csrf, code) => {
      const req = request(h.app).post(url).set('Cookie', h.cookie).set(csrfHeaderName, h.csrf);
      if (origin) req.set('Origin', origin);
      const response = await req.type('application/json').send({ text: sentence, timeZone: 'UTC' }).expect(403);
      expect(errorOf(response).code).toBe(code);
      expect(h.interpreter.calls).toHaveLength(0);
    });

    it('refuses a missing or wrong CSRF token', async () => {
      for (const token of [undefined, 'A'.repeat(43)]) {
        const req = request(h.app).post(url).set('Cookie', h.cookie).set('Origin', allowedOrigin);
        if (token) req.set(csrfHeaderName, token);
        const response = await req.type('application/json').send({ text: sentence, timeZone: 'UTC' }).expect(403);
        expect(errorOf(response).code).toBe('CSRF_DENIED');
      }
      expect(h.interpreter.calls).toHaveLength(0);
    });

    it('refuses a body that is not JSON', async () => {
      const response = await request(h.app)
        .post(url)
        .set('Cookie', h.cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, h.csrf)
        .type('text/plain')
        .send(sentence)
        .expect(415);
      expect(errorOf(response).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(h.interpreter.calls).toHaveLength(0);
    });

    it.each([
      ['empty text', { text: '', timeZone: 'UTC' }],
      ['whitespace text', { text: '  ', timeZone: 'UTC' }],
      ['text over the limit', { text: 'x'.repeat(501), timeZone: 'UTC' }],
      ['an offset zone', { text: sentence, timeZone: '+01:00' }],
      ['no zone', { text: sentence }],
      ['an unknown field', { model: 'gpt-x', text: sentence, timeZone: 'UTC' }],
      ['an owner', { text: sentence, timeZone: 'UTC', userId: otherUserId }],
      ['a control character', { text: 'runs\u0000', timeZone: 'UTC' }],
    ])('rejects %s without truncating it', async (_name, body) => {
      const response = await post(h, body).expect(400);
      expect(errorOf(response).code).toBe('INVALID_REQUEST');
      expect(JSON.stringify(response.body)).not.toContain('xxxxxxxx');
      expect(h.interpreter.calls).toHaveLength(0);
      expect(h.database.connects).toBe(0);
    });

    it('answers 403 and contacts nothing for someone who is not a member', async () => {
      h.database.membership = false;
      const response = await post(h).expect(403);
      expect(errorOf(response).code).toBe('ORG_ACCESS_DENIED');
      expect(h.interpreter.calls).toHaveLength(0);
    });

    it('answers a stable 503 when the feature is off, needing no provider and no database', async () => {
      const off = await harness({ RUN_SEARCH_AI_ENABLED: 'false' });
      const response = await post(off).expect(503);
      expect(errorOf(response).code).toBe('INTERPRETATION_DISABLED');
      expect(off.interpreter.calls).toHaveLength(0);
      expect(off.database.connects).toBe(0);
    });

    it('refuses an over-rate request with Retry-After and without a provider call', async () => {
      const limited = await harness({ RUN_SEARCH_AI_USER_RATE_PER_MINUTE: '1' });
      await post(limited).expect(200);
      const response = await post(limited).expect(429);
      expect(errorOf(response).code).toBe('INTERPRETATION_RATE_LIMITED');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.interpreter.calls).toHaveLength(1);
    });

    it('limits a person across sessions, because the key is the person', async () => {
      const limited = await harness({ RUN_SEARCH_AI_USER_RATE_PER_MINUTE: '1' });
      await post(limited).expect(200);
      const second = await request(limited.app)
        .post('/api/session')
        .set('Origin', allowedOrigin)
        .type('application/json')
        .send({ userId })
        .expect(201);
      const cookie = String((second.headers['set-cookie'] as unknown as string[])[0]).split(';', 1)[0]!;
      const csrf = (second.body as { csrf: { token: string } }).csrf.token;
      const response = await request(limited.app)
        .post(url)
        .set('Cookie', cookie)
        .set('Origin', allowedOrigin)
        .set(csrfHeaderName, csrf)
        .type('application/json')
        .send({ text: sentence, timeZone: 'UTC' })
        .expect(429);
      expect(errorOf(response).code).toBe('INTERPRETATION_RATE_LIMITED');
    });
  });

  describe('while the provider works', () => {
    it('holds no database connection during the provider call', async () => {
      await post(h).expect(200);
      expect(h.interpreter.openClientsAtCall).toEqual([0]);
      // One connection for the first membership check, one for the check before answering; none left open.
      expect(h.database.connects).toBe(2);
      expect(h.database.open).toBe(0);
    });

    it('returns the authorization error, not the proposal, when the session ended in the meantime', async () => {
      h.interpreter.behaviour = (input, options) => {
        const token = h.cookie.split('=')[1]!;
        h.sessions.revoke(token);
        return answerWith()(input, options);
      };
      const response = await post(h).expect(401);
      expect(errorOf(response).code).toBe('AUTH_REQUIRED');
      expect(JSON.stringify(response.body)).not.toContain('previous-month');
      expect(h.interpreter.calls).toHaveLength(1);
    });

    it('returns the authorization error when the membership was revoked in the meantime', async () => {
      h.interpreter.behaviour = (input, options) => {
        h.database.membership = false;
        return answerWith()(input, options);
      };
      const response = await post(h).expect(403);
      expect(errorOf(response).code).toBe('ORG_ACCESS_DENIED');
      expect(JSON.stringify(response.body)).not.toContain('previous-month');
    });

    it('reports a provider failure as a service failure, with the reason and not the text', async () => {
      h.interpreter.behaviour = () => Promise.reject(new InterpreterFailure('refusal'));
      const response = await post(h, { text: `${sentence} ${SENTINEL}`, timeZone: 'UTC' }).expect(502);
      const error = errorOf(response);
      expect(error).toMatchObject({ code: 'INTERPRETATION_FAILED', details: { reason: 'refusal' } });
      expect(JSON.stringify(response.body)).not.toContain(SENTINEL);
    });

    it('answers 504 at its own deadline although the provider never answers, and keeps its place until it does', async () => {
      const slow = await harness({ RUN_SEARCH_AI_TIMEOUT_MS: '1000' });
      let settle!: () => void;
      slow.interpreter.behaviour = () =>
        new Promise((resolve) => {
          settle = () => resolve({ proposal: search, usage: null });
        });
      const started = Date.now();
      const response = await post(slow).expect(504);
      expect(errorOf(response).code).toBe('INTERPRETATION_TIMEOUT');
      expect(Date.now() - started).toBeLessThan(5_000);

      // The request is over, the provider operation is not: the person's one reservation is still taken, so
      // submitting again cannot start a second call (ADR-0057, addendum).
      const again = await post(slow).expect(429);
      expect(errorOf(again).code).toBe('INTERPRETATION_IN_PROGRESS');
      expect(slow.interpreter.calls).toHaveLength(1);

      // Once the operation settles, the place is free again.
      settle();
      slow.interpreter.behaviour = answerWith();
      await post(slow).expect(200);
      expect(slow.interpreter.calls).toHaveLength(2);
    });

    describe('when the client disconnects', () => {
      let server: Server | undefined;

      afterEach(async () => {
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise((resolve) => server!.close(resolve));
        }
      });

      it('passes the cancellation on, and keeps the place until the provider that ignored it settles', async () => {
        let settle!: () => void;
        let cancelled!: () => void;
        const cancellationSeen = new Promise<void>((resolve) => {
          cancelled = resolve;
        });
        h.interpreter.behaviour = (_input, options) => {
          options.signal.addEventListener('abort', () => cancelled(), { once: true });
          return new Promise((resolve) => {
            settle = () => resolve({ proposal: search, usage: null });
          });
        };
        server = h.app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;

        const outgoing = httpRequest({
          headers: {
            'content-type': 'application/json',
            cookie: h.cookie,
            origin: allowedOrigin,
            [csrfHeaderName]: h.csrf,
          },
          host: '127.0.0.1',
          method: 'POST',
          path: url,
          port,
        });
        outgoing.on('error', () => undefined);
        outgoing.end(JSON.stringify({ text: sentence, timeZone: 'UTC' }));
        // Wait until the provider has been called, then drop the connection.
        for (let attempt = 0; attempt < 100 && h.interpreter.calls.length === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(h.interpreter.calls).toHaveLength(1);
        outgoing.destroy();
        // The server saw the client leave and asked the provider to stop; this one ignores that.
        await cancellationSeen;

        // The request has ended, the operation has not: the same person is still "in progress".
        const refused = await post(h).expect(429);
        expect(errorOf(refused).code).toBe('INTERPRETATION_IN_PROGRESS');
        expect(h.interpreter.calls).toHaveLength(1);

        settle();
        h.interpreter.behaviour = answerWith();
        await post(h).expect(200);
      });
    });
  });

  describe('privacy', () => {
    it('logs only bounded operational fields, never the text, an answer or an identifier', async () => {
      await post(h, { text: `${sentence} ${SENTINEL}`, timeZone: 'Europe/Warsaw' }).expect(200);
      const logged = h.logs.join('\n');
      expect(logged).toContain('run_search.interpretation');
      for (const secret of [SENTINEL, sentence, userId, orgId, h.cookie.split('=')[1]!, h.csrf, 'previous-month']) {
        expect(logged, secret).not.toContain(secret);
      }
      const entry = h.logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((candidate) => candidate.event === 'run_search.interpretation')!;
      expect(entry).toMatchObject({ model: 'test-model', outcome: 'search' });
      expect(Object.keys(entry).sort()).toEqual(
        ['durationMs', 'event', 'inputTokens', 'level', 'model', 'outcome', 'outputTokens', 'requestId', 'time'].sort(),
      );
    });

    it('counts outcomes and tokens in metrics with bounded labels only', async () => {
      await post(h, { text: `${sentence} ${SENTINEL}`, timeZone: 'UTC' }).expect(200);
      const rendered = h.metrics.registry.render();
      expect(rendered).toContain('run_search_interpretation_requests_total{outcome="search"} 1');
      expect(rendered).toContain('run_search_interpretation_tokens_total{direction="input"} 700');
      expect(rendered).not.toContain(SENTINEL);
      expect(rendered).not.toContain(userId);
    });
  });
});
