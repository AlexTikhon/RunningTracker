import { organizationPathSchema, weeklyReviewQuerySchema } from '@running-tracker/contracts';
import type { Router } from 'express';
import { Router as createRouter } from 'express';
import type { ZodType } from 'zod';

import { createSessionAuthentication, getAuthenticatedSession } from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { ApiError } from '../http/errors.js';
import type { WeeklyReviewService } from './weekly-review-service.js';

interface WeeklyReviewRouterDependencies {
  review: WeeklyReviewService;
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

/** Owner-only weekly review under /api/orgs/:orgId/weekly-review. Read-only: no mutation route exists. */
export function createWeeklyReviewRouter({ review, sessionManager }: WeeklyReviewRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);

  // Derived health data: no response of this router, an error included, may be stored by a shared cache.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const query = parseContract(weeklyReviewQuerySchema, request.query, 'weekly review query');
      const session = getAuthenticatedSession(request);
      response.status(200).json(await review.read(session, path.orgId.toLowerCase(), query));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
