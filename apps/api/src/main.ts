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
import { shutdownInfrastructure } from './lifecycle/shutdown.js';
import { RunAutoFinishRunner, runAutoFinishOnce } from './maintenance/run-auto-finish.js';

export interface MainDependencies {
  clock?: Clock;
  createMaintenancePool?: typeof createMaintenanceDatabasePool;
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
  runner: RunAutoFinishRunner;
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
    console.info(`Received ${signal}; shutting down`);
    void shutdownInfrastructure({
      clock,
      pools: [pool, maintenancePool],
      runner,
      server,
      timeoutMs,
    }).then(
      ({ forced }) => {
        if (forced) {
          console.error(`Shutdown exceeded ${timeoutMs} ms; forcing process termination`);
          process.exit(1);
        }

        process.exitCode = 0;
      },
      (error: unknown) => {
        console.error('Shutdown failed', error);
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
  const pool = (dependencies.createPool ?? createDatabasePool)(config);
  let maintenancePool: Pool;
  try {
    maintenancePool = (dependencies.createMaintenancePool ?? createMaintenanceDatabasePool)(config);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const sessionManager = new SessionManager({
    clock,
    store: new InMemorySessionStore(config.SESSION_STORE_MAX_ENTRIES),
    ttlMs: config.SESSION_TTL_MS,
  });
  const app = createApp({ clock, config, pool, sessionManager });
  const server = createServer(app);
  const runner = new RunAutoFinishRunner({
    clock,
    intervalMs: config.RUN_AUTO_FINISH_INTERVAL_MS,
    runOnce: () => runAutoFinishOnce(maintenancePool, clock),
  });

  try {
    await listen(server, config.PORT);
  } catch (error) {
    await Promise.allSettled([pool.end(), maintenancePool.end()]);
    throw error;
  }

  runner.start();
  registerShutdown({
    clock,
    maintenancePool,
    pool,
    runner,
    server,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  console.info(`API listening on http://127.0.0.1:${config.PORT}/api`);
}
