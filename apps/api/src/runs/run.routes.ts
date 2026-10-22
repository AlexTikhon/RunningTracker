import {
  createRunRequestSchema,
  ingestPointsRequestSchema,
  liveTrackChangesQuerySchema,
  liveTrackQuerySchema,
  POINT_BATCH_MAX_SIZE,
  organizationPathSchema,
  pointsQuerySchema,
  runCommandRequestSchema,
  runListQuerySchema,
  runPathSchema,
  runSearchInterpretationRequestSchema,
  runSearchQuerySchema,
  runSharePathSchema,
  upsertRunShareRequestSchema,
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
import { getRequestId } from '../http/request-id.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import type { TestOnlyFaultInjector } from '../testing/fault-injection.js';
import { measureIngestion } from './ingestion-metrics.js';
import type { InterpretationService } from './interpretation/interpretation-service.js';
import { LiveTrackCursorCodec } from './live-track-cursor.js';
import { searchRuns } from './run-search-service.js';
import {
  applyRunCommand,
  createRun,
  deleteRun,
  ingestRunPoints,
  listRunShares,
  listRuns,
  readLiveTrackChanges,
  readLiveTrackSnapshot,
  readRunPoints,
  readRun,
  revokeRunShare,
  upsertRunShare,
} from './run-service.js';

interface RunRouterDependencies {
  clock: Clock;
  config: Environment;
  /** Absent when the natural-language interpreter is not enabled: the route then answers 503. */
  interpretation?: InterpretationService;
  metrics?: ApiMetrics['ingestion'];
  pool: Pick<Pool, 'connect'>;
  sessionManager: SessionManager;
  testOnlyFaultInjector?: TestOnlyFaultInjector;
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

// A read that takes no parameters refuses any instead of ignoring them.
const noQuerySchema = z.strictObject({});

const requireJson: RequestHandler =(request, _response, next) => {
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
  interpretation,
  metrics,
  pool,
  sessionManager,
  testOnlyFaultInjector,
}: RunRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);
  const liveTrackCursorCodec = new LiveTrackCursorCodec({
    clock,
    signingKey: config.LIVE_TRACK_CURSOR_SIGNING_KEY,
  });

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

  // Registered before '/:runId' on purpose: the static segment must never be read as a run id. It answers
  // "my runs" only (the session's own finished runs); the list above keeps returning shared runs.
  router.get('/search', authenticate, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      const query = parseContract(runSearchQuerySchema, request.query, 'run search query');
      const session = getAuthenticatedSession(request);
      const orgId = path.orgId.toLowerCase();
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        searchRuns(client, session, orgId, query, clock),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // Natural language in, a filter proposal out (ADR-0057). It reads no run, summary or point: the only database
  // question is "is this person an active member", asked before the provider is contacted and again before the
  // answer is returned, each in its own short transaction, so no connection is held while the provider works.
  router.post(
    '/search/interpretations',
    ...mutationProtection,
    requireJson,
    async (request, response, next) => {
      try {
        const path = parseContract(organizationPathSchema, request.params, 'organization path');
        const body = parseContract(
          runSearchInterpretationRequestSchema,
          request.body,
          'interpretation request',
        );
        const session = getAuthenticatedSession(request);
        const orgId = path.orgId.toLowerCase();
        if (interpretation === undefined) {
          throw new ApiError(
            503,
            'INTERPRETATION_DISABLED',
            'Natural-language search is not enabled on this server',
          );
        }

        const verifyAccess = async (): Promise<void> => {
          await withAuthenticatedTenantTransaction(pool, session, orgId, () => Promise.resolve());
        };
        await verifyAccess();

        // A client that goes away ends the request; the provider call is abandoned and its place freed.
        const clientGone = new AbortController();
        response.once('close', () => {
          if (!response.writableFinished) {
            clientGone.abort();
          }
        });

        const result = await interpretation.interpret({
          requestId: getRequestId(request),
          revalidate: async () => {
            if (!sessionManager.isActive(session)) {
              throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
            }
            await verifyAccess();
          },
          signal: clientGone.signal,
          text: body.text,
          timeZone: body.timeZone,
          userId: session.userId,
        });
        response.setHeader('Cache-Control', 'no-store');
        response.status(200).json(result);
      } catch (error) {
        const retryAfter = (error as ApiError | undefined)?.details?.retryAfterSeconds;
        if (typeof retryAfter === 'number') {
          response.setHeader('Retry-After', String(retryAfter));
        }
        next(error);
      }
    },
  );

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

  router.get('/:runId/live-track', authenticate, async (request, response, next) => {
    try {
      const { orgId, runId } = routeInput(request);
      const query = parseContract(liveTrackQuerySchema, request.query, 'live-track query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        readLiveTrackSnapshot(client, session, orgId, runId, query, liveTrackCursorCodec),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:runId/live-track/changes', authenticate, async (request, response, next) => {
    try {
      const { orgId, runId } = routeInput(request);
      const query = parseContract(
        liveTrackChangesQuerySchema,
        request.query,
        'live-track changes query',
      );
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        readLiveTrackChanges(client, session, orgId, runId, query, liveTrackCursorCodec),
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

  router.delete('/:runId', ...mutationProtection, async (request, response, next) => {
    try {
      const { orgId, runId } = routeInput(request);
      const session = getAuthenticatedSession(request);
      await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        deleteRun(client, session, orgId, runId, clock),
      );
      response.status(204).end();
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
        const ingest = (): ReturnType<typeof ingestRunPoints> =>
          withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
            ingestRunPoints(client, session, orgId, runId, body, clock),
          );
        const result = metrics ? await measureIngestion(metrics, clock, ingest) : await ingest();
        if (
          testOnlyFaultInjector?.shouldDropPointIngestionResponseAfterCommit({
            orgId,
            result,
            runId,
          }) === true
        ) {
          response.destroy();
          return;
        }
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

  router.get('/:runId/shares', authenticate, async (request, response, next) => {
    try {
      const { orgId, runId } = routeInput(request);
      parseContract(noQuerySchema, request.query, 'run share list query');
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        listRunShares(client, session, orgId, runId),
      );
      // Owner-only data: never stored by a cache that does not know the session.
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

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
