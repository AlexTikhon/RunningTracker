import { createServer, type Server } from 'node:http';
import process from 'node:process';
import type { Pool } from 'pg';

import { createApp } from './app.js';
import { SessionManager } from './auth/session-manager.js';
import { InMemorySessionStore } from './auth/session-store.js';
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
import { createLiveSseHub } from './live/live-sse.js';
import {
  createFileDeletionJournalSink,
  type DeletionJournalSink,
} from './maintenance/deletion-journal-sink.js';
import { PeriodicRunner } from './maintenance/periodic-runner.js';
import { RunAutoFinishRunner, runAutoFinishOnce } from './maintenance/run-auto-finish.js';
import { runAccessJournalExportOnce } from './maintenance/run-access-journal-export.js';
import { runDeletionJournalExportOnce } from './maintenance/run-deletion-journal-export.js';
import { runRawPurgeOnce } from './maintenance/run-raw-purge.js';
import { runRetentionDeleteOnce } from './maintenance/run-retention-delete.js';
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

function listen(server: Server, port: number): Promise<void> {
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
    server.listen(port, '0.0.0.0');
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
  const sessionManager = new SessionManager({
    clock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    ttlMs: config.SESSION_TTL_MS,
  });
  const liveSseHub = createLiveSseHub({
    clock,
    config,
    metrics: metrics.live,
    pool,
    sessionManager,
  });
  const app = createApp({
    clock,
    config,
    liveConnections: liveSseHub,
    metrics,
    pool,
    sessionManager,
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
          runOnce: () => runDeletionJournalExportOnce(maintenancePool, sink, clock),
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
  let metricsListener: MetricsListener | undefined;
  const runner: StoppableRunner = {
    stop: () => {
      void metricsListener?.close();
      processMetrics.stop();
      deletionJournalRunner?.stop();
      accessJournalRunner?.stop();
      liveSseHub.stop();
      autoFinishRunner.stop();
      rawPurgeRunner.stop();
      retentionDeleteRunner.stop();
      tombstoneReclaimRunner.stop();
      summaryRunner.stop();
    },
  };

  try {
    await listen(server, config.PORT);
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
  deletionJournalRunner?.start();
  accessJournalRunner?.start();
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
