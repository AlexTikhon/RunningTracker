import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { ApiError, apiErrorHandler } from '../http/errors.js';
import { requestIdMiddleware } from '../http/request-id.js';
import { createApiMetrics } from './api-metrics.js';
import { createHttpMetricsMiddleware, normalizeRoutePath } from './http-metrics.js';
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
  app.get('/api/orgs/:orgId/runs/:runId', (_request, response) => {
    response.json({ ok: true });
  });
  app.get('/api/orgs/:orgId/tiles/runs/:z/:x/:y.mvt', (_request, response) => {
    response.status(204).end();
  });
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
  it('normalizes identifiers and tile coordinates so route labels stay bounded', () => {
    expect(normalizeRoutePath(`/api/orgs/${uuidA}/runs/${uuidB}/points?limit=5`)).toBe(
      '/api/orgs/:uuid/runs/:uuid/points',
    );
    expect(normalizeRoutePath(`/api/orgs/${uuidA.toUpperCase()}/tiles/runs/12/2048/1361.mvt`)).toBe(
      '/api/orgs/:uuid/tiles/runs/:n/:n/:n.mvt',
    );
    expect(normalizeRoutePath('/api/health/ready')).toBe('/api/health/ready');
    expect(normalizeRoutePath('//api///x/')).toBe('/api/x');
  });

  it('counts and times matched routes by template, never by concrete identifiers', async () => {
    const { app, metrics } = build();

    await request(app).get(`/api/orgs/${uuidA}/runs/${uuidB}?secret=1`).expect(200);
    await request(app).get(`/api/orgs/${uuidB}/runs/${uuidA}`).expect(200);
    await request(app).get(`/api/orgs/${uuidA}/tiles/runs/3/4/5.mvt`).expect(204);

    const output = metrics.registry.render();
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/orgs/:uuid/runs/:uuid",status="200"} 2',
    );
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/orgs/:uuid/tiles/runs/:n/:n/:n.mvt",status="204"} 1',
    );
    expect(output).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/orgs/:uuid/runs/:uuid"} 2',
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
    expect(output).toContain('http_requests_total{method="GET",route="/api/orgs/:uuid/live",status="200"} 1');
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
