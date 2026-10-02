import express, { type Express, type Router } from 'express';
import type { Pool } from 'pg';

import { createArchiveRouter } from './archive/archive.routes.js';
import {
  ArchiveTileCache,
  type ArchiveTileCacheStore,
} from './archive/archive-tile-cache.js';
import { ArchiveTileGenerationScheduler } from './archive/archive-tile-scheduler.js';
import {
  type ArchiveTilePipeline,
  postgisArchiveTilePipeline,
} from './archive/archive-service.js';
import { createDatabaseIdentityResolver } from './auth/identity-resolver.js';
import { createOidcClient } from './auth/oidc-client.js';
import { createOidcRouter } from './auth/oidc-http.js';
import { OidcLoginStore } from './auth/oidc-login-store.js';
import { SessionManager } from './auth/session-manager.js';
import { createSessionRouter } from './auth/session-http.js';
import { InMemorySessionStore } from './auth/session-store.js';
import type { Clock } from './clock.js';
import type { Environment } from './config/environment.js';
import { DatabaseProbe, type DatabasePool } from './database/database.js';
import { createHealthRouter } from './health/health.routes.js';
import { apiErrorHandler, unknownApiRoute } from './http/errors.js';
import { requestIdMiddleware } from './http/request-id.js';
import { createApiMetrics, type ApiMetrics } from './observability/api-metrics.js';
import { createHttpMetricsMiddleware } from './observability/http-metrics.js';
import { defaultLogger, type Logger } from './observability/logger.js';
import { observeArchiveTiles } from './observability/runtime-metrics.js';
import { createLiveRouter } from './live/live.routes.js';
import {
  createLiveSseHub,
  type LiveConnectionManager,
} from './live/live-sse.js';
import { createRunRouter } from './runs/run.routes.js';
import type { TestOnlyFaultInjector } from './testing/fault-injection.js';

export interface AppDependencies {
  clock: Clock;
  config: Environment;
  logger?: Logger;
  metrics?: ApiMetrics;
  pool: DatabasePool;
  sessionManager?: SessionManager;
  liveConnections?: LiveConnectionManager;
  archiveTileCache?: ArchiveTileCacheStore;
  archiveTilePipeline?: ArchiveTilePipeline;
  archiveTileScheduler?: ArchiveTileGenerationScheduler;
  testOnlyFaultInjector?: TestOnlyFaultInjector;
  testOnlyRouter?: Router;
}

export function createApp({
  clock,
  config,
  logger = defaultLogger,
  metrics = createApiMetrics(),
  pool,
  sessionManager,
  liveConnections,
  archiveTileCache,
  archiveTilePipeline,
  archiveTileScheduler,
  testOnlyFaultInjector,
  testOnlyRouter,
}: AppDependencies): Express {
  if ((testOnlyFaultInjector || testOnlyRouter) && config.APP_ENV !== 'test') {
    throw new Error('test-only app dependencies require APP_ENV=test');
  }

  const app = express();
  const database = new DatabaseProbe(pool, clock, config.DB_QUERY_TIMEOUT_MS);
  const sessions =
    sessionManager ??
    new SessionManager({
      clock,
      store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
      ttlMs: config.SESSION_TTL_MS,
    });
  const live =
    liveConnections ??
    createLiveSseHub({
      clock,
      config,
      logger,
      metrics: metrics.live,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
    });
  const archiveTiles = archiveTileCache ?? new ArchiveTileCache({ clock });
  const archiveTileGenerations =
    archiveTileScheduler ?? new ArchiveTileGenerationScheduler();
  if (archiveTiles instanceof ArchiveTileCache) {
    observeArchiveTiles(metrics, { cache: archiveTiles, scheduler: archiveTileGenerations });
  }

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(createHttpMetricsMiddleware({ clock, logger, metrics: metrics.http }));
  app.use('/api/health', createHealthRouter(database));
  app.use('/api/session', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/session', createSessionRouter(config, sessions));
  if (config.OIDC) {
    app.use(
      '/api/auth',
      createOidcRouter({
        client: createOidcClient(config.OIDC, clock),
        config,
        logger,
        loginStore: new OidcLoginStore({
          clock,
          maxEntries: config.OIDC.storeMaxEntries,
          ttlMs: config.OIDC.loginTtlMs,
        }),
        resolveIdentity: createDatabaseIdentityResolver(pool as Pick<Pool, 'connect'>),
        sessionManager: sessions,
      }),
    );
  }
  app.use(
    '/api/orgs/:orgId',
    createArchiveRouter({
      clock,
      metrics: metrics.archive,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
      tileCache: archiveTiles,
      tilePipeline: archiveTilePipeline ?? postgisArchiveTilePipeline,
      tileScheduler: archiveTileGenerations,
    }),
  );
  app.use('/api/orgs/:orgId/live', createLiveRouter(sessions, live));
  app.use(
    '/api/orgs/:orgId/runs',
    createRunRouter({
      clock,
      config,
      metrics: metrics.ingestion,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
      ...(testOnlyFaultInjector ? { testOnlyFaultInjector } : {}),
    }),
  );
  if (testOnlyRouter) {
    app.use('/api', testOnlyRouter);
  }
  app.use('/api', unknownApiRoute);
  app.use(apiErrorHandler());

  return app;
}
