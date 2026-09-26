import express, { type Express, type Router } from 'express';
import type { Pool } from 'pg';

import { SessionManager } from './auth/session-manager.js';
import { createSessionRouter } from './auth/session-http.js';
import { InMemorySessionStore } from './auth/session-store.js';
import type { Clock } from './clock.js';
import type { Environment } from './config/environment.js';
import { DatabaseProbe, type DatabasePool } from './database/database.js';
import { createHealthRouter } from './health/health.routes.js';
import { apiErrorHandler, unknownApiRoute } from './http/errors.js';
import { requestIdMiddleware } from './http/request-id.js';
import { createRunRouter } from './runs/run.routes.js';
import type { TestOnlyFaultInjector } from './testing/fault-injection.js';

export interface AppDependencies {
  clock: Clock;
  config: Environment;
  pool: DatabasePool;
  sessionManager?: SessionManager;
  testOnlyFaultInjector?: TestOnlyFaultInjector;
  testOnlyRouter?: Router;
}

export function createApp({
  clock,
  config,
  pool,
  sessionManager,
  testOnlyFaultInjector,
  testOnlyRouter,
}: AppDependencies): Express {
  if ((testOnlyFaultInjector || testOnlyRouter) && config.APP_ENV !== 'test') {
    throw new Error('test-only app dependencies require APP_ENV=test');
  }

  const app = express();
  const database = new DatabaseProbe(pool, clock, config.DB_QUERY_TIMEOUT_MS);
  const sessions =
    sessionManager ??
    new SessionManager({
      clock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use('/api/health', createHealthRouter(database));
  app.use('/api/session', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/session', createSessionRouter(config, sessions));
  app.use(
    '/api/orgs/:orgId/runs',
    createRunRouter({
      clock,
      config,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
      ...(testOnlyFaultInjector ? { testOnlyFaultInjector } : {}),
    }),
  );
  if (testOnlyRouter) {
    app.use('/api', testOnlyRouter);
  }
  app.use('/api', unknownApiRoute);
  app.use(apiErrorHandler);

  return app;
}
