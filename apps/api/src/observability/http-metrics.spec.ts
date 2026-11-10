import express, { Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { sessionCookieName } from '../auth/session-http.js';
import { SessionManager } from '../auth/session-manager.js';
import { SessionStoreUnavailableError } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { validateEnvironment } from '../config/environment.js';
import type { DatabasePool } from '../database/database.js';
import { ApiError, apiErrorHandler } from '../http/errors.js';
import { requestIdMiddleware } from '../http/request-id.js';
import { inMemorySessionManager } from '../testing/in-memory-sessions.js';
import { createApiMetrics } from './api-metrics.js';
import { createHttpMetricsMiddleware, routePrefix } from './http-metrics.js';
import { createLogger } from './logger.js';

const uuidA = '7c0f2d36-3b8f-4d40-8a55-0e5a3c9b6f11';
const uuidB = '0d9a9c62-4f2c-4b8e-9d3e-6a7f1b2c3d4e';

function build() {
  const metrics = createApiMetrics();
  const logged: string[] = [];
  let ticks = 0;
  const clock: Pick<Clock, 'monotonicNow' | 'utcNow'> = {
    monotonicNow: () => (ticks += 250),
    utcNow: () => new Date('2033-01-10T00:00:00.000Z'),
  };
  const logger = createLogger({ clock, write: (_level, line) => void logged.push(line) });
  const app = express();
  app.use(requestIdMiddleware);
  app.use(createHttpMetricsMiddleware({ clock, logger, metrics: metrics.http }));
  const orgs = Router();
  orgs.get('/runs/:runId', (_request, response) => {
    response.json({ ok: true });
  });
  orgs.get('/tiles/runs/:z/:x/:y.mvt', (_request, response) => {
    response.status(204).end();
  });
  app.use('/api/orgs/:orgId', routePrefix('/api/orgs/:orgId', orgs));
  app.get('/api/boom', () => {
    throw new Error('SELECT secret FROM users');
  });
  app.get('/api/orgs/:orgId/live', (_request, response) => {
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(': hi\n\n');
    response.end();
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    response.status(500).json({ error: 'x' });
  });
  return { app, logged, metrics };
}

describe('P11.1 HTTP metrics', () => {
  it('counts and times matched routes by template, never by concrete identifiers', async () => {
    const { app, metrics } = build();

    await request(app).get(`/api/orgs/${uuidA}/runs/${uuidB}?secret=1`).expect(200);
    await request(app).get(`/api/orgs/${uuidB}/runs/${uuidA}`).expect(200);
    await request(app).get(`/api/orgs/${uuidA}/tiles/runs/3/4/5.mvt`).expect(204);

    const output = metrics.registry.render();
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/orgs/:orgId/runs/:runId",status="200"} 2',
    );
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/orgs/:orgId/tiles/runs/:z/:x/:y.mvt",status="204"} 1',
    );
    expect(output).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/orgs/:orgId/runs/:runId"} 2',
    );
    expect(output).not.toContain(uuidA);
    expect(output).not.toContain(uuidB);
    expect(output).not.toContain('secret');
    expect(output).toContain('http_requests_in_flight 0');
  });

  it('collapses unmatched paths into one label so scanners cannot create series', async () => {
    const { app, metrics } = build();

    for (const path of ['/api/a1', '/api/a2', '/nope/x', `/api/${uuidA}`]) {
      await request(app).get(path).expect(404);
    }

    const output = metrics.registry.render();
    expect(output).toContain('http_requests_total{method="GET",route="unmatched",status="404"} 4');
  });

  it('logs only failed requests, with the request id and no message, path, or query', async () => {
    const { app, logged } = build();

    await request(app).get(`/api/orgs/${uuidA}/runs/${uuidB}`).expect(200);
    const failure = await request(app).get('/api/boom?token=abc').expect(500);

    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({
      event: 'http.request.failed',
      level: 'error',
      method: 'GET',
      requestId: failure.headers['x-request-id'],
      route: '/api/boom',
      status: 500,
    });
    expect(logged[0]).not.toMatch(/secret|token|SELECT/u);
  });

  it('excludes long-lived event streams from the latency histogram but still counts them', async () => {
    const { app, metrics } = build();

    await request(app).get(`/api/orgs/${uuidA}/live`).expect(200);

    const output = metrics.registry.render();
    expect(output).toContain('http_requests_total{method="GET",route="/api/orgs/:orgId/live",status="200"} 1');
    expect(output).not.toMatch(/http_request_duration_seconds_count\{[^}]*live/u);
  });

  it('emits one failure line that carries the error class and code from the shared error handler', async () => {
    const metrics = createApiMetrics();
    const logged: string[] = [];
    const clock = { monotonicNow: () => 0, utcNow: () => new Date('2033-01-10T00:00:00.000Z') };
    const logger = createLogger({ clock, write: (_level, line) => void logged.push(line) });
    const app = express();
    app.use(requestIdMiddleware);
    app.use(createHttpMetricsMiddleware({ clock, logger, metrics: metrics.http }));
    app.get('/api/unexpected', () => {
      throw Object.assign(new TypeError('SELECT secret'), { code: '42P01' });
    });
    app.get('/api/busy', () => {
      throw new ApiError(503, 'TILE_BUSY', 'busy');
    });
    app.get('/api/missing', () => {
      throw new ApiError(404, 'RUN_NOT_FOUND', 'missing');
    });
    app.use(apiErrorHandler());

    await request(app).get('/api/unexpected').expect(500);
    await request(app).get('/api/busy').expect(503);
    await request(app).get('/api/missing').expect(404);

    const entries = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      errorCode: '42P01',
      errorName: 'TypeError',
      event: 'http.request.failed',
      route: '/api/unexpected',
      status: 500,
    });
    expect(entries[1]).toMatchObject({
      errorCode: 'TILE_BUSY',
      errorName: 'ApiError',
      route: '/api/busy',
      status: 503,
    });
    expect(logged.join('|')).not.toContain('secret');
  });
});

describe('route labels of the real application come from code, never from the request path (F03)', () => {
  const marker = 'personal-path-marker';
  const allowedOrigin = 'http://127.0.0.1:5173';
  const config = validateEnvironment({
    ALLOWED_ORIGINS: allowedOrigin,
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/test',
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: uuidA,
    MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/test',
    SESSION_COOKIE_SECURE: 'false',
  });
  const clock: Clock = {
    clearTimeout: (handle) => clearTimeout(handle),
    monotonicNow: () => 0,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    utcNow: () => new Date('2026-11-10T10:00:00.000Z'),
  };
  // Every request here is refused before any SQL: a pool that is touched fails the test.
  const connect = vi.fn(() => Promise.reject(new Error('the database must not be reached')));
  const pool: DatabasePool = { connect };
  const dates = Array.from({ length: 450 }, (_, index) => new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10));

  function application(sessionManager: SessionManager) {
    const metrics = createApiMetrics();
    const logged: string[] = [];
    const logger = createLogger({ clock, write: (_level, line) => void logged.push(line) });
    return { app: createApp({ clock, config, logger, metrics, pool, sessionManager }), logged, metrics };
  }

  function routeLabels(output: string): Set<string> {
    return new Set([...output.matchAll(/route="([^"]*)"/gu)].map((match) => match[1]!));
  }

  it('collapses malformed organization, run and meal ids and hundreds of valid dates on 401 to fixed templates', async () => {
    const { app, metrics } = application(inMemorySessionManager(clock, config));

    for (const [index, date] of dates.entries()) {
      await request(app).get(`/api/orgs/scanner-${index}-${marker}/daily-metrics/${date}`).expect(401);
      await request(app).get(`/api/orgs/${uuidA}/daily-metrics/${date}`).expect(401);
    }
    for (let index = 0; index < 50; index += 1) {
      await request(app).get(`/api/orgs/${marker}-${index}/runs/${marker}-run-${index}`).expect(401);
      await request(app).get(`/api/orgs/${uuidB}/meals/${marker}-meal-${index}`).expect(401);
      await request(app).get(`/api/orgs/${marker}/daily-overview/${dates[index]!}`).expect(401);
    }

    const output = metrics.registry.render();
    expect(routeLabels(output)).toEqual(
      new Set([
        '/api/orgs/:orgId/daily-metrics/:localDate',
        '/api/orgs/:orgId/runs/:runId',
        '/api/orgs/:orgId/meals/:mealId',
        '/api/orgs/:orgId/daily-overview/:localDate',
      ]),
    );
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/orgs/:orgId/daily-metrics/:localDate",status="401"} 900',
    );
    expect(output).not.toContain(marker);
    expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    // Nothing folded into an overflow series: the per-route attribution survives a scan.
    expect(output).not.toContain('"_overflow"');
    expect(output).not.toMatch(/^metrics_series_overflow_total\{[^}]*\} [1-9]/mu);
    expect(connect).not.toHaveBeenCalled();
  }, 60_000);

  it('labels and logs a session-store outage (503) by template, with no path text in the log line', async () => {
    const outage = (): Promise<never> => Promise.reject(new SessionStoreUnavailableError('test outage'));
    const sessionManager = new SessionManager({
      clock,
      store: { delete: outage, find: outage, insert: outage },
      ttlMs: config.SESSION_TTL_MS,
    });
    const { app, logged, metrics } = application(sessionManager);
    const cookie = `${sessionCookieName}=${'A'.repeat(43)}`;

    for (const date of dates.slice(0, 20)) {
      await request(app).get(`/api/orgs/${marker}/daily-metrics/${date}`).set('Cookie', cookie).expect(503);
    }
    await request(app).get(`/api/orgs/${marker}/meals/${marker}-meal`).set('Cookie', cookie).expect(503);

    const output = metrics.registry.render();
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/orgs/:orgId/daily-metrics/:localDate",status="503"} 20',
    );
    expect(output).toContain('http_requests_total{method="GET",route="/api/orgs/:orgId/meals/:mealId",status="503"} 1');
    const failures = logged.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'http.request.failed');
    expect(failures).toHaveLength(21);
    expect(new Set(failures.map((entry) => entry.route))).toEqual(
      new Set(['/api/orgs/:orgId/daily-metrics/:localDate', '/api/orgs/:orgId/meals/:mealId']),
    );
    const everything = `${output}\n${logged.join('\n')}`;
    expect(everything).not.toContain(marker);
    expect(everything.replaceAll('2026-11-10T10:00:00.000Z', '')).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });
});
