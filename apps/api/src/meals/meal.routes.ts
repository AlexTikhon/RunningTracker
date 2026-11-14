import {
  createMealRequestSchema,
  MEAL_DRAFT_CONTRACT_VERSION,
  MEAL_DRAFT_ERROR_CODES,
  mealDraftProposalRequestSchema,
  mealDraftProposalResponseSchema,
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
import { SessionStoreUnavailableError } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';
import { assertNotAfterToday, canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError, sessionStoreUnavailable } from '../http/errors.js';
import { getRequestId } from '../http/request-id.js';
import type { MealDraftService } from './drafts/meal-draft-service.js';
import { createMeal, deleteMeal, listMeals, readMeal, updateMeal } from './meal-service.js';

interface MealRouterDependencies {
  clock: Clock;
  config: Environment;
  /** "Draft from text" (ADR-0092); undefined when MEAL_DRAFTS_PROVIDER=off. */
  mealDrafts?: MealDraftService;
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
export function createMealRouter({ clock, config, mealDrafts, pool, sessionManager }: MealRouterDependencies): Router {
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

  // Text describing one meal in, an editable draft proposal out (ADR-0092). Nothing is read from or written to `meals`:
  // the only database question is "is this person an active member", asked before the model is called and again (with
  // the session) before the answer leaves, each in its own short transaction, so no connection is held while the model
  // works. The date and the zone are the form's; the meal log's date rules apply to them before any model call, and they
  // are echoed, never the model's. Registered before '/:mealId'.
  router.post('/draft-proposals', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const orgId = organizationOf(request);
      parseContract(noQuerySchema, request.query, 'meal draft query');
      const body = parseContract(mealDraftProposalRequestSchema, request.body, 'meal draft request');
      const session = getAuthenticatedSession(request);
      if (mealDrafts === undefined) {
        throw new ApiError(503, MEAL_DRAFT_ERROR_CODES.disabled, 'Drafting a meal from text is not enabled on this server');
      }
      const timeZone = canonicalTimeZone(body.timeZone);
      assertNotAfterToday(body.localDate, timeZone, clock);

      const verifyAccess = async (): Promise<void> => {
        await withAuthenticatedTenantTransaction(pool, session, orgId, () => Promise.resolve());
      };
      await verifyAccess();

      // A client that goes away ends the request; the model call is asked to stop, and keeps its place until it settles.
      const clientGone = new AbortController();
      response.once('close', () => {
        if (!response.writableFinished) clientGone.abort();
      });

      const proposal = await mealDrafts.propose({
        requestId: getRequestId(request),
        // Asked again before the answer leaves (ADR-0080: the session may have been revoked on another instance).
        revalidate: async () => {
          let active: boolean;
          try {
            active = (await sessionManager.isActive(session)) === true;
          } catch (error) {
            throw error instanceof SessionStoreUnavailableError ? sessionStoreUnavailable() : error;
          }
          if (!active) throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
          await verifyAccess();
        },
        signal: clientGone.signal,
        text: body.text,
        userId: session.userId,
      });
      response
        .status(200)
        .json(mealDraftProposalResponseSchema.parse({ ...proposal, localDate: body.localDate, timeZone, version: MEAL_DRAFT_CONTRACT_VERSION }));
    } catch (error) {
      const retryAfter = (error as ApiError | undefined)?.details?.retryAfterSeconds;
      if (typeof retryAfter === 'number') response.setHeader('Retry-After', String(retryAfter));
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
