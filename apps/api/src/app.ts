import express, { type ErrorRequestHandler, type Express } from 'express';

import type { Clock } from './clock.js';
import type { Environment } from './config/environment.js';
import { DatabaseProbe, type DatabasePool } from './database/database.js';
import { createHealthRouter } from './health/health.routes.js';
import { HttpError } from './http/errors.js';

export interface AppDependencies {
  clock: Clock;
  config: Environment;
  pool: DatabasePool;
}

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.statusCode).json(error.body);
    return;
  }

  const summary = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  console.error(`Unhandled HTTP error: ${summary}`);
  response.status(500).json({ status: 'error' });
};

export function createApp({ clock, config, pool }: AppDependencies): Express {
  const app = express();
  const database = new DatabaseProbe(pool, clock, config.DB_QUERY_TIMEOUT_MS);

  app.disable('x-powered-by');
  app.use('/api/health', createHealthRouter(database));
  app.use(errorHandler);

  return app;
}
