import {
  createWeeklyInsightRequestSchema,
  organizationPathSchema,
  weeklyInsightQuerySchema,
} from '@running-tracker/contracts';
import type { RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { ZodType } from 'zod';

import {
  createAuthenticatedMutationProtection,
  createSessionAuthentication,
  getAuthenticatedSession,
} from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import type { Environment } from '../config/environment.js';
import { ApiError } from '../http/errors.js';
import type { WeeklyInsightService } from './weekly-insight-service.js';

interface WeeklyInsightRouterDependencies {
  config: Environment;
  insights: WeeklyInsightService;
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

const requireJson: RequestHandler = (request, _response, next) => {
  if (!request.is('application/json')) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    return;
  }
  next();
};

/** Owner-only weekly insights under /api/orgs/:orgId/insights/weekly (ADR-0076). */
export function createWeeklyInsightRouter({ config, insights, sessionManager }: WeeklyInsightRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);

  // Derived health data: no response of this router, an error included, may be stored by a shared cache.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/weekly', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const query = parseContract(weeklyInsightQuerySchema, request.query, 'weekly insight query');
      const session = getAuthenticatedSession(request);
      response.status(200).json(await insights.read(session, path.orgId.toLowerCase(), query.weekStart));
    } catch (error) {
      next(error);
    }
  });

  router.post('/weekly', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const body = parseContract(createWeeklyInsightRequestSchema, request.body, 'weekly insight request');
      const session = getAuthenticatedSession(request);
      response.status(202).json(await insights.request(session, path.orgId.toLowerCase(), body));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
