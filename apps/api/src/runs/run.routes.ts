import {
  createRunRequestSchema,
  runCommandRequestSchema,
  runPathSchema,
} from '@running-tracker/contracts';
import type { Request, RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import type { ZodType } from 'zod';

import {
  createAuthenticatedMutationProtection,
  getAuthenticatedSession,
} from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import { applyRunCommand, createRun } from './run-service.js';

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

export function createRunRouter({
  clock,
  config,
  pool,
  sessionManager,
}: RunRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);

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

  return router;
}
