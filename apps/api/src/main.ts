import { createServer, type Server } from 'node:http';
import process from 'node:process';
import type { Pool } from 'pg';

import { createApp } from './app.js';
import { PostgresPendingLoginStore } from './auth/postgres-pending-login-store.js';
import { PostgresSessionStore } from './auth/postgres-session-store.js';
import { SessionManager } from './auth/session-manager.js';
import { systemClock, type Clock } from './clock.js';
import { loadEnvironment } from './config/environment.js';
import {
  createDatabasePool,
  createMaintenanceDatabasePool,
} from './database/database.js';
import {
  shutdownInfrastructure,
  type StoppableRunner,
} from './lifecycle/shutdown.js';
import { createWeeklyInsightService } from './insights/weekly-insight-factory.js';
import { createLiveSseHub } from './live/live-sse.js';
import {
  createFileDeletionJournalSink,
  type DeletionJournalSink,
} from './maintenance/deletion-journal-sink.js';
import { createBacklogMeasuredExport } from './maintenance/journal-backlog.js';
import { PeriodicRunner } from './maintenance/periodic-runner.js';
import { RunAutoFinishRunner, runAutoFinishOnce } from './maintenance/run-auto-finish.js';
import { runAccessJournalExportOnce } from './maintenance/run-access-journal-export.js';
import { runDeletionJournalExportOnce } from './maintenance/run-deletion-journal-export.js';
import { runErasureLedgerExportOnce } from './maintenance/run-erasure-ledger-export.js';
import { runOidcLoginPurgeOnce } from './maintenance/run-oidc-login-purge.js';
import { runRawPurgeOnce } from './maintenance/run-raw-purge.js';
import { runRetentionDeleteOnce } from './maintenance/run-retention-delete.js';
import { runSessionPurgeOnce } from './maintenance/run-session-purge.js';
import { runSummaryPublicationBatch } from './maintenance/run-summary-publication.js';
import { runTombstoneReclaimOnce } from './maintenance/run-tombstone-reclaim.js';
import { createApiMetrics } from './observability/api-metrics.js';
import { defaultLogger, describeError } from './observability/logger.js';
import { startMetricsListener, type MetricsListener } from './observability/metrics-server.js';
import { observePool, registerProcessMetrics } from './observability/runtime-metrics.js';

export interface MainDependencies {
  clock?: Clock;
  createMaintenancePool?: typeof createMaintenanceDatabasePool;
  createDeletionJournalSink?: (directory: string) => DeletionJournalSink;
  createPool?: typeof createDatabasePool;
  loadConfig?: typeof loadEnvironment;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function registerShutdown(options: {
  clock: Clock;
  maintenancePool: Pool;
  pool: Pool;
  runner: StoppableRunner;
  server: Server;
  timeoutMs: number;
}): void {
  const { clock, maintenancePool, pool, runner, server, timeoutMs } = options;
  let shutdownStarted = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    defaultLogger.info('shutdown.started', { signal });
    void shutdownInfrastructure({
      clock,
      pools: [pool, maintenancePool],
      runner,
      server,
      timeoutMs,
    }).then(
      ({ forced }) => {
        if (forced) {
          defaultLogger.error('shutdown.forced', { timeoutMs });
          process.exit(1);
        }

        process.exitCode = 0;
      },
      (error: unknown) => {
        defaultLogger.error('shutdown.failed', describeError(error));
        process.exit(1);
      },
    );
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

export async function main(dependencies: MainDependencies = {}): Promise<void> {
  const config = (dependencies.loadConfig ?? loadEnvironment)();
  const clock = dependencies.clock ?? systemClock;
  const metrics = createApiMetrics();
  const processMetrics = registerProcessMetrics(metrics.registry);
  const pool = (dependencies.createPool ?? createDatabasePool)(config);
  let maintenancePool: Pool;
  try {
    maintenancePool = (dependencies.createMaintenancePool ?? createMaintenanceDatabasePool)(config);
  } catch (error) {
    processMetrics.stop();
    await pool.end();
    throw error;
  }
  observePool(pool, { clock, metrics, name: 'runtime' });
  observePool(maintenancePool, { clock, metrics, name: 'maintenance' });
  // Sessions live in PostgreSQL (ADR-0080): a restart keeps them, and every instance on the database sees the same
  // sign-outs. There is no in-memory fallback; a store that cannot answer refuses access with 503.
  const sessionManager = new SessionManager({
    clock,
    store: new PostgresSessionStore({
      capacity: config.SESSION_STORE_MAX_ENTRIES,
      clock,
      operationTimeoutMs: config.SESSION_STORE_TIMEOUT_MS,
      pool,
    }),
    ttlMs: config.SESSION_TTL_MS,
  });
  // Pending OIDC logins live in PostgreSQL too (ADR-0081): a login started before a restart, or on another instance
  // with the same database and OIDC configuration, can complete. No process-memory fallback and no cache; a store that
  // cannot answer fails the sign-in.
  const oidcLoginStore = config.OIDC
    ? new PostgresPendingLoginStore({
        capacity: config.OIDC.storeMaxEntries,
        clock,
        operationTimeoutMs: config.SESSION_STORE_TIMEOUT_MS,
        pool,
        ttlMs: config.OIDC.loginTtlMs,
      })
    : undefined;
  const liveSseHub = createLiveSseHub({
    clock,
    config,
    metrics: metrics.live,
    pool,
    sessionManager,
  });
  // Weekly insights run in this process, one generation at a time (ADR-0076); shutdown cancels the running one.
  const weeklyInsights = createWeeklyInsightService({ clock, config, logger: defaultLogger, pool });
  const app = createApp({
    clock,
    config,
    liveConnections: liveSseHub,
    metrics,
    ...(oidcLoginStore ? { oidcLoginStore } : {}),
    pool,
    sessionManager,
    weeklyInsights,
  });
  const server = createServer(app);
  const autoFinishRunner = new RunAutoFinishRunner({
    clock,
    intervalMs: config.RUN_AUTO_FINISH_INTERVAL_MS,
    metrics: metrics.maintenance,
    runOnce: () => runAutoFinishOnce(maintenancePool, clock),
  });
  const summaryRunner = new PeriodicRunner({
    clock,
    intervalMs: config.RUN_SUMMARY_INTERVAL_MS,
    metrics: metrics.maintenance,
    runOnce: () =>
      runSummaryPublicationBatch(maintenancePool, clock, config.RUN_SUMMARY_CONCURRENCY),
    taskName: 'Run summary publication',
  });
  const rawPurgeRunner = new PeriodicRunner({
    clock,
    intervalMs: config.RUN_RAW_PURGE_INTERVAL_MS,
    metrics: metrics.maintenance,
    runOnce: async () => {
      const result = await runRawPurgeOnce(maintenancePool, clock);
      if (result.status === 'blocked') {
        metrics.maintenance.rawPurgeBlocked.inc();
        defaultLogger.warn('retention.raw_purge.overdue', { reason: 'summary_unavailable' });
      }
      return result;
    },
    taskName: 'Run raw retention purge',
  });
  const retentionDeleteRunner = new PeriodicRunner({
    clock,
    intervalMs: config.RUN_RETENTION_DELETE_INTERVAL_MS,
    metrics: metrics.maintenance,
    runOnce: () => runRetentionDeleteOnce(maintenancePool, clock),
    taskName: 'Run annual retention deletion',
  });
  const tombstoneReclaimRunner = new PeriodicRunner({
    clock,
    intervalMs: config.RUN_TOMBSTONE_RECLAIM_INTERVAL_MS,
    metrics: metrics.maintenance,
    runOnce: () => runTombstoneReclaimOnce(maintenancePool, clock),
    taskName: 'Run tombstone reclamation',
  });
  const sessionPurgeRunner = new PeriodicRunner({
    clock,
    intervalMs: config.SESSION_PURGE_INTERVAL_MS,
    metrics: metrics.maintenance,
    runOnce: () => runSessionPurgeOnce(maintenancePool, clock),
    taskName: 'Expired session purge',
  });
  // Runs whether or not OIDC is configured: rows left by an earlier configuration still expire and are removed.
  const oidcLoginPurgeRunner = new PeriodicRunner({
    clock,
    intervalMs: config.SESSION_PURGE_INTERVAL_MS,
    metrics: metrics.maintenance,
    runOnce: () => runOidcLoginPurgeOnce(maintenancePool, clock),
    taskName: 'Expired pending login purge',
  });
  let deletionJournalSink: DeletionJournalSink | undefined;
  if (config.DELETION_JOURNAL_DIR !== undefined) {
    deletionJournalSink = (
      dependencies.createDeletionJournalSink ?? createFileDeletionJournalSink
    )(config.DELETION_JOURNAL_DIR);
    try {
      await deletionJournalSink.verify();
    } catch (error) {
      processMetrics.stop();
      await Promise.allSettled([pool.end(), maintenancePool.end()]);
      throw new Error('The deletion journal directory is not writable', { cause: error });
    }
  } else {
    defaultLogger.warn('deletion_journal.export_disabled', { reason: 'directory_not_set' });
  }
  const sink = deletionJournalSink;
  const deletionJournalRunner =
    sink === undefined
      ? undefined
      : new PeriodicRunner({
          clock,
          intervalMs: config.RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS,
          metrics: metrics.maintenance,
          // Measures the oldest-unexported age after every cycle and stamps when it last did (ADR-0037). The age is
          // only as current as that stamp, which a hung export or a failed read stops advancing.
          runOnce: createBacklogMeasuredExport({
            clock,
            exportOnce: () => runDeletionJournalExportOnce(maintenancePool, sink, clock),
            journal: 'deletion',
            metrics: metrics.maintenance,
            pool: maintenancePool,
          }),
          taskName: 'Run deletion journal export',
        });
  // The access-restriction journal (P12.4) goes to the same off-host directory, so it
  // shares the sink, the enabling variable and the export interval.
  const accessJournalRunner =
    sink === undefined
      ? undefined
      : new PeriodicRunner({
          clock,
          intervalMs: config.RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS,
          metrics: metrics.maintenance,
          runOnce: () => runAccessJournalExportOnce(maintenancePool, sink, clock),
          taskName: 'Run access journal export',
        });
  // The erasure ledger of owner-only health data (ADR-0073) uses the same directory, sink and interval.
  const erasureLedgerRunner =
    sink === undefined
      ? undefined
      : new PeriodicRunner({
          clock,
          intervalMs: config.RUN_DELETION_JOURNAL_EXPORT_INTERVAL_MS,
          metrics: metrics.maintenance,
          runOnce: createBacklogMeasuredExport({
            clock,
            exportOnce: () => runErasureLedgerExportOnce(maintenancePool, sink, clock),
            journal: 'erasure',
            metrics: metrics.maintenance,
            pool: maintenancePool,
          }),
          taskName: 'Erasure ledger export',
        });
  let metricsListener: MetricsListener | undefined;
  const runner: StoppableRunner = {
    stop: () => {
      void metricsListener?.close();
      processMetrics.stop();
      deletionJournalRunner?.stop();
      accessJournalRunner?.stop();
      erasureLedgerRunner?.stop();
      liveSseHub.stop();
      void weeklyInsights.stop();
      autoFinishRunner.stop();
      rawPurgeRunner.stop();
      retentionDeleteRunner.stop();
      tombstoneReclaimRunner.stop();
      sessionPurgeRunner.stop();
      oidcLoginPurgeRunner.stop();
      summaryRunner.stop();
    },
  };

  try {
    await listen(server, config.PORT, config.API_HOST);
    if (config.METRICS_PORT !== undefined) {
      metricsListener = await startMetricsListener(metrics.registry, {
        host: config.METRICS_HOST,
        port: config.METRICS_PORT,
      });
    }
  } catch (error) {
    processMetrics.stop();
    server.close();
    await Promise.allSettled([pool.end(), maintenancePool.end()]);
    throw error;
  }

  autoFinishRunner.start();
  rawPurgeRunner.start();
  retentionDeleteRunner.start();
  tombstoneReclaimRunner.start();
  sessionPurgeRunner.start();
  oidcLoginPurgeRunner.start();
  deletionJournalRunner?.start();
  accessJournalRunner?.start();
  erasureLedgerRunner?.start();
  summaryRunner.start();
  registerShutdown({
    clock,
    maintenancePool,
    pool,
    runner,
    server,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  defaultLogger.info('api.listening', { port: config.PORT });
  if (config.METRICS_PORT !== undefined) {
    defaultLogger.info('metrics.listening', { port: config.METRICS_PORT });
  }
}
