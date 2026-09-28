import {
  archiveMetadataQuerySchema,
  organizationPathSchema,
  tilePathSchema,
  tileQuerySchema,
} from '@running-tracker/contracts';
import type { Request, Router } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import type { ZodType } from 'zod';

import {
  createSessionAuthentication,
  getAuthenticatedSession,
} from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import {
  type ArchiveTileCacheStore,
  createArchiveTileCacheKey,
} from './archive-tile-cache.js';
import { ArchiveTileCoordinator } from './archive-tile-coordinator.js';
import type { ArchiveTileGenerationScheduler } from './archive-tile-scheduler.js';
import {
  type ArchiveTilePipeline,
  readArchiveMetadata,
} from './archive-service.js';

interface ArchiveRouterDependencies {
  tileCache: ArchiveTileCacheStore;
  pool: Pick<Pool, 'connect'>;
  sessionManager: SessionManager;
  tileScheduler: ArchiveTileGenerationScheduler;
  tilePipeline: ArchiveTilePipeline;
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

function organizationId(request: Request): string {
  return parseContract(
    organizationPathSchema,
    request.params,
    'organization path',
  ).orgId.toLowerCase();
}

export function createArchiveRouter({
  pool,
  sessionManager,
  tileCache,
  tilePipeline,
  tileScheduler,
}: ArchiveRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const tileCoordinator = new ArchiveTileCoordinator({
    cache: tileCache,
    pipeline: tilePipeline,
    pool,
    scheduler: tileScheduler,
  });
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store');
    next();
  });

  router.get('/archive/metadata', authenticate, async (request, response, next) => {
    try {
      const orgId = organizationId(request);
      const query = parseContract(
        archiveMetadataQuerySchema,
        request.query,
        'archive metadata query',
      );
      const result = await withAuthenticatedTenantTransaction(
        pool,
        getAuthenticatedSession(request),
        orgId,
        (client) => readArchiveMetadata(client, orgId, query),
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/tiles/runs/:z/:x/:y.mvt', authenticate, async (request, response, next) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const path = parseContract(tilePathSchema, request.params, 'archive tile path');
      const query = parseContract(tileQuerySchema, request.query, 'archive tile query');
      const normalizedPath = { ...path, orgId: path.orgId.toLowerCase() };
      const session = getAuthenticatedSession(request);
      const cacheKey = createArchiveTileCacheKey({
        path: normalizedPath,
        query,
        userId: session.userId,
      });
      const tile = await tileCoordinator.read(
        session,
        { path: normalizedPath, query },
        cacheKey,
        abortController.signal,
      );
      response.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
      response.status(200).send(tile);
    } catch (error) {
      if (abortController.signal.aborted || response.destroyed) {
        return;
      }
      next(error);
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
  });

  return router;
}
