import {
  createMealRequestSchema,
  mealListQuerySchema,
  mealPathSchema,
  organizationPathSchema,
  updateMealRequestSchema,
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
import { createMeal, deleteMeal, listMeals, readMeal, updateMeal } from './meal-service.js';

interface MealRouterDependencies {
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

/**
 * Health data: no response under this path, an error included, may be stored by a cache that does not know the
 * session. `app.ts` also mounts it before the JSON body parser, so a malformed body's 400 carries it too.
 */
export const mealsNoStore: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

const requireJson: RequestHandler = (request, _response, next) => {
  if (!request.is('application/json')) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    return;
  }
  next();
};

function organizationOf(request: Request): string {
  return parseContract(organizationPathSchema, request.params, 'organization path').orgId.toLowerCase();
}

function entryOf(request: Request): { mealId: string; orgId: string } {
  const path = parseContract(mealPathSchema, request.params, 'meal path');
  return { mealId: path.mealId.toLowerCase(), orgId: path.orgId.toLowerCase() };
}

/**
 * Owner-only manual meal log under /api/orgs/:orgId/meals (ADR-0083). The owner is the session's identity, the
 * organization is the path's, the identity is the database's and the provenance is always manual entry: none of them is
 * read from a request body or query.
 */
export function createMealRouter({ clock, config, pool, sessionManager }: MealRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);

  router.use(mealsNoStore);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const orgId = organizationOf(request);
      const query = parseContract(mealListQuerySchema, request.query, 'meal list query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) => listMeals(client, session, orgId, query));
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const orgId = organizationOf(request);
      parseContract(noQuerySchema, request.query, 'meal query');
      const body = parseContract(createMealRequestSchema, request.body, 'meal request');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        createMeal(client, session, orgId, body, clock),
      );
      response.status(result.created ? 201 : 200).json(result.view);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:mealId', authenticate, async (request, response, next) => {
    try {
      const { mealId, orgId } = entryOf(request);
      parseContract(noQuerySchema, request.query, 'meal query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) => readMeal(client, session, orgId, mealId));
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:mealId', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const { mealId, orgId } = entryOf(request);
      parseContract(noQuerySchema, request.query, 'meal query');
      const body = parseContract(updateMealRequestSchema, request.body, 'meal request');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        updateMeal(client, session, orgId, mealId, body),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:mealId', ...mutationProtection, async (request, response, next) => {
    try {
      const { mealId, orgId } = entryOf(request);
      const session = getAuthenticatedSession(request);
      await withAuthenticatedTenantTransaction(pool, session, orgId, (client) => deleteMeal(client, session, orgId, mealId));
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
