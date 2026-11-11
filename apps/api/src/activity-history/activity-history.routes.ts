import { activityHistoryQuerySchema, organizationPathSchema } from '@running-tracker/contracts';
import type { RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { ZodType } from 'zod';

import { createSessionAuthentication, getAuthenticatedSession } from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { ApiError } from '../http/errors.js';
import type { ActivityHistoryService } from './activity-history-service.js';

interface ActivityHistoryRouterDependencies {
  history: ActivityHistoryService;
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
 * Health data: no response under this path, an error included, may be stored by a cache that does not know the session.
 * `app.ts` mounts it before the JSON body parser, so even a malformed body's 400 carries it.
 */
export const activityHistoryNoStore: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

/** The owner-only unified activity history under /api/orgs/:orgId/activity-history (ADR-0087). Read-only. */
export function createActivityHistoryRouter({ history, sessionManager }: ActivityHistoryRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);

  router.use(activityHistoryNoStore);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const query = parseContract(activityHistoryQuerySchema, request.query, 'activity history query');
      const session = getAuthenticatedSession(request);
      response.status(200).json(await history.read(session, path.orgId.toLowerCase(), query));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
