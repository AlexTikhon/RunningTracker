import { Router } from 'express';

import type { DatabaseProbe } from '../database/database.js';
import { HttpError } from '../http/errors.js';

interface HealthResponse {
  status: 'ok' | 'not-ready';
  checks?: {
    database: 'up' | 'down';
  };
}

export function createHealthRouter(database: DatabaseProbe): Router {
  const router = Router();

  router.get('/live', (_request, response) => {
    response.status(200).json({ status: 'ok' } satisfies HealthResponse);
  });

  router.get('/ready', async (_request, response, next) => {
    try {
      await database.ping();
      response
        .status(200)
        .json({ checks: { database: 'up' }, status: 'ok' } satisfies HealthResponse);
    } catch {
      next(
        new HttpError(503, {
          checks: { database: 'down' },
          status: 'not-ready',
        } satisfies HealthResponse),
      );
    }
  });

  return router;
}
