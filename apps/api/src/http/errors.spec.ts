import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApiMetrics } from '../observability/api-metrics.js';
import { createHttpMetricsMiddleware } from '../observability/http-metrics.js';
import { createLogger } from '../observability/logger.js';
import { ApiError, apiErrorHandler } from './errors.js';
import { requestIdMiddleware } from './request-id.js';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function build() {
  const logged: string[] = [];
  const clock = { monotonicNow: () => 0, utcNow: () => new Date('2033-01-10T00:00:00.000Z') };
  const logger = createLogger({ clock, write: (_level, line) => void logged.push(line) });
  const app = express();
  app.use(requestIdMiddleware);
  app.use(createHttpMetricsMiddleware({ clock, logger, metrics: createApiMetrics().http }));
  app.get('/api/statement', () => {
    throw pgError('57014', 'canceling statement due to statement timeout: SELECT secret FROM users');
  });
  app.get('/api/lock', () => {
    throw pgError('55P03', 'canceling statement due to lock timeout: UPDATE runs SET secret = 1');
  });
  app.get('/api/user-cancel', () => {
    throw pgError('57014', 'canceling statement due to user request');
  });
  app.get('/api/duplicate', () => {
    throw pgError('23505', 'duplicate key value violates unique constraint');
  });
  app.get('/api/domain', () => {
    throw new ApiError(409, 'ARCHIVE_REVISION_CHANGED', 'changed');
  });
  app.use(apiErrorHandler({ lockTimeoutMs: 1_500, statementTimeoutMs: 4_000 }));
  return { app, logged };
}

describe('apiErrorHandler database timeouts', () => {
  it('answers a statement timeout with a stable retryable 503 and no database text', async () => {
    const { app } = build();

    const response = await request(app).get('/api/statement').expect(503);

    expect(response.body).toEqual({
      error: {
        code: 'DB_STATEMENT_TIMEOUT',
        message: 'The database did not finish the request within its time limit',
        requestId: response.headers['x-request-id'],
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|SELECT|57014|canceling/u);
  });

  it('answers a lock timeout with a stable retryable 503 and no database text', async () => {
    const { app } = build();

    const response = await request(app).get('/api/lock').expect(503);

    expect(response.body).toEqual({
      error: {
        code: 'DB_LOCK_TIMEOUT',
        message: 'The requested data is busy; retry the request shortly',
        requestId: response.headers['x-request-id'],
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|UPDATE|55P03|canceling/u);
  });

  it('logs the timeout kind and configured budget with the request id and route, never the message', async () => {
    const { app, logged } = build();

    const statement = await request(app).get('/api/statement').expect(503);
    const lock = await request(app).get('/api/lock').expect(503);

    const entries = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      errorCode: 'DB_STATEMENT_TIMEOUT',
      event: 'http.request.failed',
      reason: 'statement',
      requestId: statement.headers['x-request-id'],
      route: '/api/statement',
      status: 503,
      timeoutMs: 4_000,
    });
    expect(entries[1]).toMatchObject({
      errorCode: 'DB_LOCK_TIMEOUT',
      reason: 'lock',
      requestId: lock.headers['x-request-id'],
      route: '/api/lock',
      status: 503,
      timeoutMs: 1_500,
    });
    expect(logged.join('|')).not.toMatch(/secret|SELECT|UPDATE/u);
  });

  it('keeps every other failure on its existing path', async () => {
    const { app } = build();

    await request(app).get('/api/user-cancel').expect(500);
    await request(app).get('/api/duplicate').expect(500);
    const domain = await request(app).get('/api/domain').expect(409);
    expect(domain.body).toMatchObject({ error: { code: 'ARCHIVE_REVISION_CHANGED' } });
  });

  it('classifies a timeout even when no budgets are supplied to the handler', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get('/api/lock', () => {
      throw pgError('55P03', 'canceling statement due to lock timeout');
    });
    app.use(apiErrorHandler());

    const response = await request(app).get('/api/lock').expect(503);

    expect(response.body).toMatchObject({ error: { code: 'DB_LOCK_TIMEOUT' } });
  });
});
