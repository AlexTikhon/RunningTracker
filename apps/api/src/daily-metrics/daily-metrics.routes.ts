import {
  dailyMetricsListQuerySchema,
  dailyMetricsPathSchema,
  organizationPathSchema,
  putDailyMetricsRequestSchema,
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
  deleteDailyMetrics,
  listDailyMetrics,
  putDailyMetrics,
  readDailyMetrics,
} from './daily-metrics-service.js';

interface DailyMetricsRouterDependencies {
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

function routeInput(request: Request): { localDate: string; orgId: string } {
  const path = parseContract(dailyMetricsPathSchema, request.params, 'daily metrics path');
  return { localDate: path.localDate, orgId: path.orgId.toLowerCase() };
}

/** Owner-only daily check-ins under /api/orgs/:orgId/daily-metrics (ADR-0074). */
export function createDailyMetricsRouter({ clock, config, pool, sessionManager }: DailyMetricsRouterDependencies): Router {
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
      const query = parseContract(dailyMetricsListQuerySchema, request.query, 'daily metrics range');
      const session = getAuthenticatedSession(request);
      const orgId = path.orgId.toLowerCase();
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        listDailyMetrics(client, session, orgId, query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:localDate', authenticate, async (request, response, next) => {
    try {
      const { localDate, orgId } = routeInput(request);
      parseContract(noQuerySchema, request.query, 'daily metrics query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        readDailyMetrics(client, session, orgId, localDate),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:localDate', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const { localDate, orgId } = routeInput(request);
      const body = parseContract(putDailyMetricsRequestSchema, request.body, 'daily metrics request');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        putDailyMetrics(client, session, orgId, localDate, body, clock),
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
        deleteDailyMetrics(client, session, orgId, localDate),
      );
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
