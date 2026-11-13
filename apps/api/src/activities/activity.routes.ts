import {
  activityListQuerySchema,
  activityPathSchema,
  createActivityRequestSchema,
  GPX_FILE_TOO_LARGE,
  GPX_IMPORT_CONTENT_TYPE,
  GPX_IMPORT_MAX_BYTES,
  GPX_UNSUPPORTED,
  gpxImportConfirmQuerySchema,
  organizationPathSchema,
  TCX_FILE_TOO_LARGE,
  TCX_IMPORT_CONTENT_TYPE,
  TCX_IMPORT_MAX_BYTES,
  TCX_UNSUPPORTED,
  tcxImportConfirmQuerySchema,
} from '@running-tracker/contracts';
import type { Request, RequestHandler, Router } from 'express';
import express, { Router as createRouter } from 'express';
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
import { GpxImportError, readGpxActivity, type GpxActivity } from './gpx-activity.js';
import { confirmGpxImport, previewGpxImport } from './gpx-import-service.js';
import { readTcxActivity, TcxImportError, type TcxActivity } from './tcx-activity.js';
import { confirmTcxImport, previewTcxImport } from './tcx-import-service.js';

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

// The GPX upload routes (ADR-0086) are the only ones that read more than the global 64 KiB JSON body. The allowance is
// narrow: these two routes only, after the session, Origin and CSRF checks have passed (an unauthenticated or cross-site
// request is answered before a byte of its body is read), for exactly one media type, with no content encoding (no
// decompression), and bounded by GPX_IMPORT_MAX_BYTES of request body, which is the file itself. A body that announces
// or reaches more is refused with 413 and is never truncated. The global JSON parser does not touch these requests: it
// reads application/json only.
const requireGpx: RequestHandler = (request, _response, next) => {
  if (!request.is(GPX_IMPORT_CONTENT_TYPE)) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content-Type must be ${GPX_IMPORT_CONTENT_TYPE}`));
    return;
  }
  next();
};

const rawGpxBody = express.raw({ inflate: false, limit: GPX_IMPORT_MAX_BYTES, type: GPX_IMPORT_CONTENT_TYPE });

const boundedGpxBody: RequestHandler = (request, response, next) => {
  rawGpxBody(request, response, (error?: unknown) => {
    const type = (error as { type?: unknown } | undefined)?.type;
    if (type === 'entity.too.large') {
      next(
        new ApiError(413, GPX_FILE_TOO_LARGE, `The GPX file exceeds ${String(GPX_IMPORT_MAX_BYTES)} bytes`, {
          maxBytes: GPX_IMPORT_MAX_BYTES,
        }),
      );
    } else if (type === 'encoding.unsupported') {
      next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'A GPX upload must not use a Content-Encoding'));
    } else if (error !== undefined) {
      next(error);
    } else if (!Buffer.isBuffer(request.body)) {
      next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content-Type must be ${GPX_IMPORT_CONTENT_TYPE}`));
    } else {
      next();
    }
  });
};

// The TCX upload routes (ADR-0091) follow exactly the GPX boundary above, with their own media type: session, Origin and
// CSRF before a byte of the body is read, then the one media type (the GPX type is a 415 here, and the TCX type is a 415
// on the GPX routes), no content encoding, and at most TCX_IMPORT_MAX_BYTES of body, refused with 413, never truncated.
const requireTcx: RequestHandler = (request, _response, next) => {
  if (!request.is(TCX_IMPORT_CONTENT_TYPE)) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content-Type must be ${TCX_IMPORT_CONTENT_TYPE}`));
    return;
  }
  next();
};

const rawTcxBody = express.raw({ inflate: false, limit: TCX_IMPORT_MAX_BYTES, type: TCX_IMPORT_CONTENT_TYPE });

const boundedTcxBody: RequestHandler = (request, response, next) => {
  rawTcxBody(request, response, (error?: unknown) => {
    const type = (error as { type?: unknown } | undefined)?.type;
    if (type === 'entity.too.large') {
      next(
        new ApiError(413, TCX_FILE_TOO_LARGE, `The TCX file exceeds ${String(TCX_IMPORT_MAX_BYTES)} bytes`, {
          maxBytes: TCX_IMPORT_MAX_BYTES,
        }),
      );
    } else if (type === 'encoding.unsupported') {
      next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'A TCX upload must not use a Content-Encoding'));
    } else if (error !== undefined) {
      next(error);
    } else if (!Buffer.isBuffer(request.body)) {
      next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content-Type must be ${TCX_IMPORT_CONTENT_TYPE}`));
    } else {
      next();
    }
  });
};

function readUploadedTcx(request: Request, clock: Clock): TcxActivity {
  try {
    return readTcxActivity(request.body as Buffer, clock.utcNow().getTime());
  } catch (error) {
    if (error instanceof TcxImportError) {
      // The message names a reason and a lap by position only; it never quotes the file.
      throw new ApiError(422, TCX_UNSUPPORTED, error.message, { reason: error.reason });
    }
    throw error;
  }
}

function readUploadedGpx(request: Request, clock: Clock): GpxActivity {
  try {
    return readGpxActivity(request.body as Buffer, clock.utcNow().getTime());
  } catch (error) {
    if (error instanceof GpxImportError) {
      throw new ApiError(422, GPX_UNSUPPORTED, error.message, { reason: error.reason });
    }
    throw error;
  }
}

function routeInput(request: Request): { activityId: string; orgId: string } {
  const path = parseContract(activityPathSchema, request.params, 'activity path');
  return { activityId: path.activityId.toLowerCase(), orgId: path.orgId.toLowerCase() };
}

/**
 * Owner-only activities under /api/orgs/:orgId/activities: manual entries (ADR-0072), GPX imports (ADR-0086) and TCX
 * imports (ADR-0091).
 */
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

  // GPX preview (ADR-0086): parses and summarises the uploaded file and reports an existing import of the same track. It
  // writes nothing: the transaction is REPEATABLE READ, READ ONLY. It still needs Origin and CSRF, because it accepts the
  // larger body.
  router.post('/gpx-preview', ...mutationProtection, requireGpx, boundedGpxBody, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      parseContract(noQuerySchema, request.query, 'GPX preview query');
      const parsed = readUploadedGpx(request, clock);
      const session = getAuthenticatedSession(request);
      const orgId = path.orgId.toLowerCase();
      const preview = await withAuthenticatedTenantTransaction(
        pool,
        session,
        orgId,
        (client) => previewGpxImport(client, session, orgId, parsed),
        { snapshot: 'read-only snapshot' },
      );
      response.status(200).json(preview);
    } catch (error) {
      next(error);
    }
  });

  // GPX confirmation (ADR-0086): the body is the same file again, parsed and summarised again here; the query carries
  // only the person's type choice and the import attempt's idempotency key.
  router.put('/:activityId/gpx-import', ...mutationProtection, requireGpx, boundedGpxBody, async (request, response, next) => {
    try {
      const { activityId, orgId } = routeInput(request);
      const choice = parseContract(gpxImportConfirmQuerySchema, request.query, 'GPX import query');
      const parsed = readUploadedGpx(request, clock);
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        confirmGpxImport(client, session, orgId, activityId, choice, parsed),
      );
      response.status(result.created ? 201 : 200).json(result.activity);
    } catch (error) {
      next(error);
    }
  });

  // TCX preview (ADR-0091): parses and summarises the uploaded file and reports an existing TCX import with the same laps.
  // It writes nothing: the transaction is REPEATABLE READ, READ ONLY. Origin and CSRF are checked before the body is read.
  router.post('/tcx-preview', ...mutationProtection, requireTcx, boundedTcxBody, async (request, response, next) => {
    try {
      const path = parseContract(organizationPathSchema, request.params, 'organization path');
      parseContract(noQuerySchema, request.query, 'TCX preview query');
      const parsed = readUploadedTcx(request, clock);
      const session = getAuthenticatedSession(request);
      const orgId = path.orgId.toLowerCase();
      const preview = await withAuthenticatedTenantTransaction(
        pool,
        session,
        orgId,
        (client) => previewTcxImport(client, session, orgId, parsed),
        { snapshot: 'read-only snapshot' },
      );
      response.status(200).json(preview);
    } catch (error) {
      next(error);
    }
  });

  // TCX confirmation (ADR-0091): the body is the same file again, parsed and summarised again here; the query carries only
  // the person's type choice and the import attempt's idempotency key.
  router.put('/:activityId/tcx-import', ...mutationProtection, requireTcx, boundedTcxBody, async (request, response, next) => {
    try {
      const { activityId, orgId } = routeInput(request);
      const choice = parseContract(tcxImportConfirmQuerySchema, request.query, 'TCX import query');
      const parsed = readUploadedTcx(request, clock);
      const session = getAuthenticatedSession(request);
      const result = await withAuthenticatedTenantTransaction(pool, session, orgId, (client) =>
        confirmTcxImport(client, session, orgId, activityId, choice, parsed),
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
