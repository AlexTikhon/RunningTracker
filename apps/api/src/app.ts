import express, { type Express, type Router } from 'express';
import type { Pool } from 'pg';

import { createActivityRouter } from './activities/activity.routes.js';
import { ActivityHistoryService, type ActivityHistoryTestHooks } from './activity-history/activity-history-service.js';
import { activityHistoryNoStore, createActivityHistoryRouter } from './activity-history/activity-history.routes.js';
import { createDailyMetricsRouter } from './daily-metrics/daily-metrics.routes.js';
import { createDailyMovementRouter, dailyMovementNoStore } from './daily-movement/daily-movement.routes.js';
import { DailyOverviewService, type DailyOverviewTestHooks } from './daily-overview/daily-overview-service.js';
import { createDailyOverviewRouter, dailyOverviewNoStore } from './daily-overview/daily-overview.routes.js';
import { DailyTrendsService, type DailyTrendsTestHooks } from './daily-trends/daily-trends-service.js';
import { createDailyTrendsRouter, dailyTrendsNoStore } from './daily-trends/daily-trends.routes.js';
import { createMealRouter, mealsNoStore } from './meals/meal.routes.js';
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
import type { PendingLoginStore } from './auth/pending-login-store.js';
import type { SessionManager } from './auth/session-manager.js';
import { createSessionRouter } from './auth/session-http.js';
import type { Clock } from './clock.js';
import type { Environment } from './config/environment.js';
import { DatabaseProbe, type DatabasePool } from './database/database.js';
import { createHealthRouter } from './health/health.routes.js';
import { apiErrorHandler, unknownApiRoute } from './http/errors.js';
import { requestIdMiddleware } from './http/request-id.js';
import { createApiMetrics, type ApiMetrics } from './observability/api-metrics.js';
import { createHttpMetricsMiddleware, routePrefix } from './observability/http-metrics.js';
import { defaultLogger, type Logger } from './observability/logger.js';
import { observeArchiveTiles } from './observability/runtime-metrics.js';
import { createLiveRouter } from './live/live.routes.js';
import {
  createLiveSseHub,
  type LiveConnectionManager,
} from './live/live-sse.js';
import { createOrganizationCoachRouter } from './organizations/organization-coach.routes.js';
import { createOrganizationRouter } from './organizations/organization.routes.js';
import { createInterpretationService } from './runs/interpretation/interpretation-factory.js';
import type { RunSearchInterpreter } from './runs/interpretation/interpretation-types.js';
import { createRunRouter } from './runs/run.routes.js';
import type { LlmProvider } from './insights/llm-provider.js';
import { createWeeklyInsightService } from './insights/weekly-insight-factory.js';
import type { WeeklyInsightService } from './insights/weekly-insight-service.js';
import { createWeeklyInsightRouter } from './insights/weekly-insight.routes.js';
import { WeeklyReviewService, type WeeklyReviewTestHooks } from './insights/weekly-review-service.js';
import { createWeeklyReviewRouter } from './insights/weekly-review.routes.js';
import type { TestOnlyFaultInjector } from './testing/fault-injection.js';

export interface AppDependencies {
  clock: Clock;
  config: Environment;
  logger?: Logger;
  metrics?: ApiMetrics;
  /**
   * Required when OIDC is configured: production wires the PostgreSQL store (main.ts, ADR-0081), so a login can complete
   * after a restart or on another instance; tests pass an explicit in-memory one. There is no default.
   */
  oidcLoginStore?: PendingLoginStore;
  pool: DatabasePool;
  /** Required: production wires the PostgreSQL store (main.ts); tests pass an explicit in-memory one. */
  sessionManager: SessionManager;
  liveConnections?: LiveConnectionManager;
  archiveTileCache?: ArchiveTileCacheStore;
  archiveTilePipeline?: ArchiveTilePipeline;
  archiveTileScheduler?: ArchiveTileGenerationScheduler;
  /** Barriers inside the activity history's read transaction, for snapshot tests. */
  testOnlyActivityHistoryHooks?: ActivityHistoryTestHooks;
  /** Barriers inside the daily overview's read transaction, for snapshot tests. */
  testOnlyDailyOverviewHooks?: DailyOverviewTestHooks;
  testOnlyDailyTrendsHooks?: DailyTrendsTestHooks;
  testOnlyFaultInjector?: TestOnlyFaultInjector;
  /** Replaces the configured interpreter in tests, so that no test can reach a provider. */
  testOnlyRunSearchInterpreter?: RunSearchInterpreter;
  /** Replaces the configured weekly insight model in tests, so that no test can reach Ollama. */
  testOnlyWeeklyInsightProvider?: LlmProvider;
  /** Barriers inside the weekly review's read transaction, for snapshot tests. */
  testOnlyWeeklyReviewHooks?: WeeklyReviewTestHooks;
  testOnlyRouter?: Router;
  /** The weekly insight service; built from the configuration when omitted. The caller stops its queue at shutdown. */
  weeklyInsights?: WeeklyInsightService;
}

export function createApp({
  clock,
  config,
  logger = defaultLogger,
  metrics = createApiMetrics(),
  oidcLoginStore,
  pool,
  sessionManager,
  liveConnections,
  archiveTileCache,
  archiveTilePipeline,
  archiveTileScheduler,
  testOnlyActivityHistoryHooks,
  testOnlyDailyOverviewHooks,
  testOnlyDailyTrendsHooks,
  testOnlyFaultInjector,
  testOnlyRunSearchInterpreter,
  testOnlyWeeklyInsightProvider,
  testOnlyWeeklyReviewHooks,
  testOnlyRouter,
  weeklyInsights,
}: AppDependencies): Express {
  if (
    (testOnlyActivityHistoryHooks ||
      testOnlyDailyOverviewHooks ||
      testOnlyDailyTrendsHooks ||
      testOnlyFaultInjector ||
      testOnlyRouter ||
      testOnlyRunSearchInterpreter ||
      testOnlyWeeklyInsightProvider ||
      testOnlyWeeklyReviewHooks) &&
    config.APP_ENV !== 'test'
  ) {
    throw new Error('test-only app dependencies require APP_ENV=test');
  }
  if (config.OIDC && oidcLoginStore === undefined) {
    throw new Error('OIDC sign-in requires a pending-login store');
  }

  const app = express();
  const database = new DatabaseProbe(pool, clock, config.DB_QUERY_TIMEOUT_MS);
  const sessions = sessionManager;
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
  // Undefined unless RUN_SEARCH_AI_ENABLED: then no provider client exists and the route answers 503.
  const interpretation = createInterpretationService({
    clock,
    config,
    ...(testOnlyRunSearchInterpreter ? { interpreter: testOnlyRunSearchInterpreter } : {}),
    logger,
    metrics: metrics.interpretation,
  });
  const insights =
    weeklyInsights ??
    createWeeklyInsightService({
      clock,
      config,
      logger,
      pool: pool as Pick<Pool, 'connect'>,
      ...(testOnlyWeeklyInsightProvider ? { provider: testOnlyWeeklyInsightProvider } : {}),
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
  app.use('/api/health', routePrefix('/api/health', createHealthRouter(database)));
  app.use('/api/session', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Before the body parser, so that a malformed or oversized body's error answer is not cacheable either (ADR-0078).
  app.use('/api/orgs/:orgId/daily-movement', dailyMovementNoStore);
  app.use('/api/orgs/:orgId/activity-history', activityHistoryNoStore);
  app.use('/api/orgs/:orgId/daily-overview', dailyOverviewNoStore);
  app.use('/api/orgs/:orgId/daily-trends', dailyTrendsNoStore);
  app.use('/api/orgs/:orgId/meals', mealsNoStore);
  // The global body limit. It reads application/json only; the two GPX upload routes (ADR-0086) read their own, larger
  // application/gpx+xml body inside the activity router, after the session, Origin and CSRF checks.
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/session', routePrefix('/api/session', createSessionRouter(config, sessions)));
  if (config.OIDC && oidcLoginStore) {
    app.use(
      '/api/auth',
      routePrefix('/api/auth', createOidcRouter({
        client: createOidcClient(config.OIDC, clock),
        config,
        logger,
        loginStore: oidcLoginStore,
        resolveIdentity: createDatabaseIdentityResolver(pool as Pick<Pool, 'connect'>),
        sessionManager: sessions,
      })),
    );
  }
  app.use(
    '/api/organizations',
    routePrefix('/api/organizations', createOrganizationRouter({ pool: pool as Pick<Pool, 'connect'>, sessionManager: sessions })),
  );
  app.use(
    '/api/orgs/:orgId',
    routePrefix('/api/orgs/:orgId', createArchiveRouter({
      clock,
      metrics: metrics.archive,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
      tileCache: archiveTiles,
      tilePipeline: archiveTilePipeline ?? postgisArchiveTilePipeline,
      tileScheduler: archiveTileGenerations,
    })),
  );
  app.use(
    '/api/orgs/:orgId/coaches',
    routePrefix('/api/orgs/:orgId/coaches', createOrganizationCoachRouter({ pool: pool as Pick<Pool, 'connect'>, sessionManager: sessions })),
  );
  app.use('/api/orgs/:orgId/live', routePrefix('/api/orgs/:orgId/live', createLiveRouter(sessions, live)));
  app.use(
    '/api/orgs/:orgId/runs',
    routePrefix('/api/orgs/:orgId/runs', createRunRouter({
      clock,
      config,
      ...(interpretation ? { interpretation } : {}),
      metrics: metrics.ingestion,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
      ...(testOnlyFaultInjector ? { testOnlyFaultInjector } : {}),
    })),
  );
  app.use(
    '/api/orgs/:orgId/activities',
    routePrefix('/api/orgs/:orgId/activities', createActivityRouter({
      clock,
      config,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
    })),
  );
  // The unified activity history (ADR-0087): read-only, owner-only, over activities and the person's own finished runs.
  app.use(
    '/api/orgs/:orgId/activity-history',
    routePrefix('/api/orgs/:orgId/activity-history', createActivityHistoryRouter({
      history: new ActivityHistoryService({
        pool: pool as Pick<Pool, 'connect'>,
        ...(testOnlyActivityHistoryHooks ? { hooks: testOnlyActivityHistoryHooks } : {}),
      }),
      sessionManager: sessions,
    })),
  );
  app.use(
    '/api/orgs/:orgId/daily-metrics',
    routePrefix('/api/orgs/:orgId/daily-metrics', createDailyMetricsRouter({
      clock,
      config,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
    })),
  );
  // Manual daily movement (ADR-0078): owner-only, not an insight or weekly review source.
  app.use(
    '/api/orgs/:orgId/daily-movement',
    routePrefix('/api/orgs/:orgId/daily-movement', createDailyMovementRouter({
      clock,
      config,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
    })),
  );
  // The manual meal log (ADR-0083): owner-only, not an insight or weekly review source.
  app.use(
    '/api/orgs/:orgId/meals',
    routePrefix('/api/orgs/:orgId/meals', createMealRouter({
      clock,
      config,
      pool: pool as Pick<Pool, 'connect'>,
      sessionManager: sessions,
    })),
  );
  // The daily overview (Today, ADR-0082): read-only, derived on every read from the person's own records.
  app.use(
    '/api/orgs/:orgId/daily-overview',
    routePrefix('/api/orgs/:orgId/daily-overview', createDailyOverviewRouter({
      overview: new DailyOverviewService({
        clock,
        pool: pool as Pick<Pool, 'connect'>,
        ...(testOnlyDailyOverviewHooks ? { hooks: testOnlyDailyOverviewHooks } : {}),
      }),
      sessionManager: sessions,
    })),
  );
  // 28-day trends (ADR-0084): read-only, derived on every read from the person's own daily records.
  app.use(
    '/api/orgs/:orgId/daily-trends',
    routePrefix('/api/orgs/:orgId/daily-trends', createDailyTrendsRouter({
      sessionManager: sessions,
      trends: new DailyTrendsService({
        clock,
        pool: pool as Pick<Pool, 'connect'>,
        ...(testOnlyDailyTrendsHooks ? { hooks: testOnlyDailyTrendsHooks } : {}),
      }),
    })),
  );
  app.use(
    '/api/orgs/:orgId/insights',
    routePrefix('/api/orgs/:orgId/insights', createWeeklyInsightRouter({ config, insights, sessionManager: sessions })),
  );
  // The deterministic weekly review: independent of the insight service and of any model provider.
  app.use(
    '/api/orgs/:orgId/weekly-review',
    routePrefix('/api/orgs/:orgId/weekly-review', createWeeklyReviewRouter({
      review: new WeeklyReviewService({
        clock,
        pool: pool as Pick<Pool, 'connect'>,
        ...(testOnlyWeeklyReviewHooks ? { hooks: testOnlyWeeklyReviewHooks } : {}),
      }),
      sessionManager: sessions,
    })),
  );
  if (testOnlyRouter) {
    app.use('/api', routePrefix('/api', testOnlyRouter));
  }
  app.use('/api', unknownApiRoute);
  app.use(
    apiErrorHandler({
      lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    }),
  );

  return app;
}
