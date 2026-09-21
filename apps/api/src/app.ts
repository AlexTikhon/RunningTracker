import express, { type Express, type Router } from 'express';

import { SessionManager } from './auth/session-manager.js';
import { createSessionRouter } from './auth/session-http.js';
import { InMemorySessionStore } from './auth/session-store.js';
import type { Clock } from './clock.js';
import type { Environment } from './config/environment.js';
import { DatabaseProbe, type DatabasePool } from './database/database.js';
import { createHealthRouter } from './health/health.routes.js';
import { apiErrorHandler, unknownApiRoute } from './http/errors.js';
import { requestIdMiddleware } from './http/request-id.js';

export interface AppDependencies {
  clock: Clock;
  config: Environment;
  pool: DatabasePool;
  sessionManager?: SessionManager;
  testOnlyRouter?: Router;
}

export function createApp({ clock, config, pool, sessionManager, testOnlyRouter }: AppDependencies): Express {
  if (testOnlyRouter && config.APP_ENV !== 'test') {
    throw new Error('testOnlyRouter can only be mounted when APP_ENV=test');
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
  if (testOnlyRouter) {
    app.use('/api', testOnlyRouter);
  }
  app.use('/api', unknownApiRoute);
  app.use(apiErrorHandler);

  return app;
}
