import {
  activityListQuerySchema,
  activityPathSchema,
  createActivityRequestSchema,
  organizationPathSchema,
} from '@running-tracker/contracts';
import type { Request, RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import { z, type ZodType } from 'zod';

import {
  createAuthenticatedMutationProtection,
  createSessionAuthentication,
  getAuthenticatedSession,
} from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import {
  createActivity,
  deleteActivity,
  listActivities,
  readActivity,
} from './activity-service.js';

interface ActivityRouterDependencies {
  clock: Clock;
  config: Environment;
  pool: Pick<Pool, 'connect'>;
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

const noQuerySchema = z.strictObject({});

const requireJson: RequestHandler = (request, _response, next) => {
  if (!request.is('application/json')) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    return;
  }
  next();
};

function routeInput(request: Request): { activityId: string; orgId: string } {
  const path = parseContract(activityPathSchema, request.params, 'activity path');
  return { activityId: path.activityId.toLowerCase(), orgId: path.orgId.toLowerCase() };
}

/** Owner-only manual activities under /api/orgs/:orgId/activities (ADR-0072). */
export function createActivityRouter({ clock, config, pool, sessionManager }: ActivityRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);

  // Health data: no response of this router, an error included, may be stored by a cache that does not know the session.
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const query = parseContract(activityListQuerySchema, request.query, 'activity list query');
      const session = getAuthenticatedSession(request);
      const orgId = path.orgId.toLowerCase();
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        listActivities(client, session, orgId, query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:activityId', authenticate, async (request, response, next) => {
    try {
      const { activityId, orgId } = routeInput(request);
      parseContract(noQuerySchema, request.query, 'activity query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        readActivity(client, session, orgId, activityId),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:activityId', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const { activityId, orgId } = routeInput(request);
      const body = parseContract(createActivityRequestSchema, request.body, 'activity creation request');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        createActivity(client, session, orgId, activityId, body, clock),
      );
      response.status(result.created ? 201 : 200).json(result.activity);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:activityId', ...mutationProtection, async (request, response, next) => {
    try {
      const { activityId, orgId } = routeInput(request);
      const session = getAuthenticatedSession(request);
      await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        deleteActivity(client, session, orgId, activityId),
      );
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
