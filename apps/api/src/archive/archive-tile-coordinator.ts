import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import type { ArchiveTileCacheStore } from './archive-tile-cache.js';
import type { ArchiveTileGenerationScheduler } from './archive-tile-scheduler.js';
import {
  assertCurrentArchiveRevision,
  type ArchiveTilePipeline,
  type ArchiveTileRequest,
  isPostgresStatementTimeout,
  setArchiveTileStatementTimeout,
} from './archive-service.js';

export const ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES = 1 * 1024 * 1024;

interface ArchiveTileCoordinatorDependencies {
  cache: ArchiveTileCacheStore;
  pipeline: ArchiveTilePipeline;
  pool: Pick<Pool, 'connect'>;
  scheduler: ArchiveTileGenerationScheduler;
}

export class ArchiveTileCoordinator {
  public constructor(private readonly dependencies: ArchiveTileCoordinatorDependencies) {}

  public async read(
    session: Pick<StoredSession, 'userId'>,
    request: ArchiveTileRequest,
    cacheKey: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const { cache, pipeline, pool, scheduler } = this.dependencies;
    const cached = await withAuthenticatedTenantTransaction(
      pool,
      session,
      request.path.orgId,
      async (client) => {
        await assertCurrentArchiveRevision(
          client,
          request.path.orgId,
          request.query.revision,
        );
        return cache.get(cacheKey);
      },
    );
    if (cached !== undefined) {
      return cached;
    }

    return cache.runSingleFlight(
      cacheKey,
      (flightSignal) =>
        scheduler.schedule(
          () =>
            withAuthenticatedTenantTransaction(
              pool,
              session,
              request.path.orgId,
              async (client) => {
                await assertCurrentArchiveRevision(
                  client,
                  request.path.orgId,
                  request.query.revision,
                );
                const populatedWhileWaiting = await cache.get(cacheKey);
                if (populatedWhileWaiting !== undefined) {
                  return populatedWhileWaiting;
                }

                await setArchiveTileStatementTimeout(client);
                let tile: Buffer;
                try {
                  tile = await pipeline.render(client, request);
                } catch (error) {
                  if (isPostgresStatementTimeout(error)) {
                    throw new ApiError(
                      503,
                      'TILE_TIMEOUT',
                      'Archive tile generation exceeded its SQL time limit',
                    );
                  }
                  throw error;
                }
                if (tile.byteLength > ARCHIVE_TILE_MAX_UNCOMPRESSED_BYTES) {
                  throw new ApiError(
                    422,
                    'TILE_TOO_COMPLEX',
                    'The complete archive tile exceeds the uncompressed size limit',
                  );
                }
                cache.set(cacheKey, tile);
                return tile;
              },
            ),
          flightSignal,
        ),
      signal,
    );
  }
}
