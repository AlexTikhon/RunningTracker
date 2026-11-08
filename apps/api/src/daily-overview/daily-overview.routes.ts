import { dailyOverviewPathSchema, dailyOverviewQuerySchema } from '@running-tracker/contracts';
import type { RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { ZodType } from 'zod';

import { createSessionAuthentication, getAuthenticatedSession } from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { ApiError } from '../http/errors.js';
import type { DailyOverviewService } from './daily-overview-service.js';

interface DailyOverviewRouterDependencies {
  overview: DailyOverviewService;
  sessionManager: SessionManager;
}

function parseContract<Output>(schema: ZodType<Output>, input: unknown, label: string): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_REQUEST', `The ${label} is invalid`, {
      fields: parsed.error.issues.map(({ message, path }) => ({ message, path })),
    });
  }
  return parsed.data;
}

/**
 * Derived health data: no response under this path, an error included, may be stored by a cache that does not know the
 * session. `app.ts` mounts it before the JSON body parser, so even a malformed body's 400 carries it.
 */
export const dailyOverviewNoStore: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

/** Owner-only daily overview under /api/orgs/:orgId/daily-overview/:localDate (ADR-0082). Read-only: no mutation route. */
export function createDailyOverviewRouter({ overview, sessionManager }: DailyOverviewRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);

  router.use(dailyOverviewNoStore);

  router.get('/:localDate', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(dailyOverviewPathSchema, request.params, 'daily overview path');
      const query = parseContract(dailyOverviewQuerySchema, request.query, 'daily overview query');
      const session = getAuthenticatedSession(request);
      response.status(200).json(await overview.read(session, path.orgId.toLowerCase(), path.localDate, query));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
