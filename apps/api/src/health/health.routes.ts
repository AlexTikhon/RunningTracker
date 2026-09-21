import { Router } from 'express';

import type { DatabaseProbe } from '../database/database.js';
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

  router.get('/ready', async (_request, response) => {
    try {
      await database.ping();
      response
        .status(200)
        .json({ checks: { database: 'up' }, status: 'ok' } satisfies HealthResponse);
    } catch {
      response.status(503).json({
        checks: { database: 'down' },
        status: 'not-ready',
      } satisfies HealthResponse);
    }
  });

  return router;
}
