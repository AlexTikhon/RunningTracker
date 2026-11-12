import { activityTrendsQuerySchema, organizationPathSchema } from '@running-tracker/contracts';
import type { RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { ZodType } from 'zod';

import { createSessionAuthentication, getAuthenticatedSession } from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { ApiError } from '../http/errors.js';
import type { ActivityTrendsService } from './activity-trends-service.js';

interface ActivityTrendsRouterDependencies {
  sessionManager: SessionManager;
  trends: ActivityTrendsService;
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
export const activityTrendsNoStore: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

/** Owner-only activity trends under /api/orgs/:orgId/activity-trends (ADR-0089). Read-only: no mutation route. */
export function createActivityTrendsRouter({ sessionManager, trends }: ActivityTrendsRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);

  router.use(activityTrendsNoStore);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      // A repeated parameter arrives as an array and is refused by the strict query contract.
      const query = parseContract(activityTrendsQuerySchema, request.query, 'activity trends query');
      const session = getAuthenticatedSession(request);
      response.status(200).json(await trends.read(session, path.orgId.toLowerCase(), query));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
