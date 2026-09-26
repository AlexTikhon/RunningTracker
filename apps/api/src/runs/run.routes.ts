import {
  createRunRequestSchema,
  ingestPointsRequestSchema,
  POINT_BATCH_MAX_SIZE,
  organizationPathSchema,
  pointsQuerySchema,
  runCommandRequestSchema,
  runListQuerySchema,
  runPathSchema,
  runSharePathSchema,
  upsertRunShareRequestSchema,
} from '@running-tracker/contracts';
import type { Request, RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import type { ZodType } from 'zod';

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
  applyRunCommand,
  createRun,
  ingestRunPoints,
  listRuns,
  readRunPoints,
  readRun,
  revokeRunShare,
  upsertRunShare,
} from './run-service.js';

interface RunRouterDependencies {
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

const requireJson: RequestHandler = (request, _response, next) => {
  if (!request.is('application/json')) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    return;
  }
  next();
};

function routeInput(request: Request): { orgId: string; runId: string } {
  const path = parseContract(runPathSchema, request.params, 'run path');
  return { orgId: path.orgId.toLowerCase(), runId: path.runId.toLowerCase() };
}

function shareRouteInput(request: Request): { orgId: string; runId: string; userId: string } {
  const path = parseContract(runSharePathSchema, request.params, 'run share path');
  return {
    orgId: path.orgId.toLowerCase(),
    runId: path.runId.toLowerCase(),
    userId: path.userId.toLowerCase(),
  };
}

export function createRunRouter({
  clock,
  config,
  pool,
  sessionManager,
}: RunRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const query = parseContract(runListQuerySchema, request.query, 'run-list query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(
        pool,
        session,
        path.orgId.toLowerCase(),
        (client) => listRuns(client, path.orgId.toLowerCase(), query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:runId', authenticate, async (request, response, next) => {
    try {
      const { orgId, runId } = routeInput(request);
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        readRun(client, orgId, runId),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:runId/points', authenticate, async (request, response, next) => {
    try {
      const { orgId, runId } = routeInput(request);
      const query = parseContract(pointsQuerySchema, request.query, 'point-history query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        readRunPoints(client, orgId, runId, query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:runId', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const { orgId, runId } = routeInput(request);
      const body = parseContract(createRunRequestSchema, request.body, 'run creation request');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        createRun(client, session, orgId, runId, body, clock),
      );
      response.status(result.created ? 201 : 200).json(result.run);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/:runId/points',
    ...mutationProtection,
    requireJson,
    async (request, response, next) => {
      try {
        const { orgId, runId } = routeInput(request);
        const input = request.body as { points?: unknown } | undefined;
        if (Array.isArray(input?.points) && input.points.length > POINT_BATCH_MAX_SIZE) {
          throw new ApiError(
            413,
            'BATCH_TOO_LARGE',
            `A point batch cannot exceed ${POINT_BATCH_MAX_SIZE} entries`,
          );
        }
        const body = parseContract(ingestPointsRequestSchema, request.body, 'point batch request');
        const session = getAuthenticatedSession(request);
        const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
          ingestRunPoints(client, session, orgId, runId, body, clock),
        );
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/:runId/commands',
    ...mutationProtection,
    requireJson,
    async (request, response, next) => {
      try {
        const { orgId, runId } = routeInput(request);
        const body = parseContract(runCommandRequestSchema, request.body, 'run command request');
        const session = getAuthenticatedSession(request);
        const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
          applyRunCommand(client, session, orgId, runId, body, clock),
        );
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/:runId/shares/:userId',
    ...mutationProtection,
    requireJson,
    async (request, response, next) => {
      try {
        const { orgId, runId, userId } = shareRouteInput(request);
        const body = parseContract(upsertRunShareRequestSchema, request.body, 'run share request');
        const session = getAuthenticatedSession(request);
        const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
          upsertRunShare(client, session, orgId, runId, userId, body),
        );
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/:runId/shares/:userId',
    ...mutationProtection,
    async (request, response, next) => {
      try {
        const { orgId, runId, userId } = shareRouteInput(request);
        const session = getAuthenticatedSession(request);
        await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
          revokeRunShare(client, session, orgId, runId, userId),
        );
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
