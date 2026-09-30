import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
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
  clock?: Pick<Clock, 'monotonicNow'>;
  metrics?: ApiMetrics['archive'];
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
    const { metrics } = this.dependencies;
    if (metrics === undefined) {
      return this.#read(session, request, cacheKey, signal, { hit: false });
    }
    const outcome = { hit: false };
    try {
      const tile = await this.#read(session, request, cacheKey, signal, outcome);
      metrics.requests.inc({ result: outcome.hit ? 'hit' : 'miss' });
      metrics.tileBytes.observe({}, tile.byteLength);
      return tile;
    } catch (error) {
      metrics.requests.inc({ result: signal?.aborted === true ? 'aborted' : 'error' });
      throw error;
    }
  }

  async #read(
    session: Pick<StoredSession, 'userId'>,
    request: ArchiveTileRequest,
    cacheKey: string,
    signal: AbortSignal | undefined,
    outcome: { hit: boolean },
  ): Promise<Buffer> {
    const { cache, clock, metrics, pipeline, pool, scheduler } = this.dependencies;
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
      outcome.hit = true;
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
                const renderStartedAt = clock?.monotonicNow();
                try {
                  tile = await pipeline.render(client, request);
                  if (renderStartedAt !== undefined && clock !== undefined) {
                    metrics?.generationSeconds.observe(
                      {},
                      Math.max(0, (clock.monotonicNow() - renderStartedAt) / 1_000),
                    );
                  }
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
