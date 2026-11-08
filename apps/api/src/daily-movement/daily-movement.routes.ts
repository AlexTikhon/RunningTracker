import {
  dailyMovementListQuerySchema,
  dailyMovementPathSchema,
  organizationPathSchema,
  putDailyMovementRequestSchema,
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
  deleteDailyMovement,
  listDailyMovement,
  putDailyMovement,
  readDailyMovement,
} from './daily-movement-service.js';

interface DailyMovementRouterDependencies {
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
export const dailyMovementNoStore: RequestHandler = (_request, response, next) => {
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

function routeInput(request: Request): { localDate: string; orgId: string } {
  const path = parseContract(dailyMovementPathSchema, request.params, 'daily movement path');
  return { localDate: path.localDate, orgId: path.orgId.toLowerCase() };
}

/**
 * Owner-only manual daily movement under /api/orgs/:orgId/daily-movement (ADR-0078). The owner is the session's
 * identity, the organization is the path's, and the provenance is always manual entry: none of them is read from a
 * request body or query.
 */
export function createDailyMovementRouter({ clock, config, pool, sessionManager }: DailyMovementRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);

  router.use(dailyMovementNoStore);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const query = parseContract(dailyMovementListQuerySchema, request.query, 'daily movement range');
      const session = getAuthenticatedSession(request);
      const orgId = path.orgId.toLowerCase();
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        listDailyMovement(client, session, orgId, query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:localDate', authenticate, async (request, response, next) => {
    try {
      const { localDate, orgId } = routeInput(request);
      parseContract(noQuerySchema, request.query, 'daily movement query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        readDailyMovement(client, session, orgId, localDate),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:localDate', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const { localDate, orgId } = routeInput(request);
      const body = parseContract(putDailyMovementRequestSchema, request.body, 'daily movement request');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        putDailyMovement(client, session, orgId, localDate, body, clock),
      );
      response.status(result.created ? 201 : 200).json(result.view);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:localDate', ...mutationProtection, async (request, response, next) => {
    try {
      const { localDate, orgId } = routeInput(request);
      const session = getAuthenticatedSession(request);
      await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        deleteDailyMovement(client, session, orgId, localDate),
      );
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
