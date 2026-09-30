import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { loadEnvironment, type Environment } from '../config/environment.js';
import { sleep } from './load-concurrency.js';
import type { LoadTarget } from './load-target.js';

/** The API under load, however it was started. */
export interface ApiTarget {
  /** Non-secret settings the API actually runs with, recorded in the result. */
  configuration: Record<string, boolean | number | string>;
  /** Origin sent with every mutation; the API is configured to allow exactly this one. */
  origin: string;
  baseUrl: string;
  logSummary: () => { byEvent: Record<string, number>; errorLines: number; warnLines: number } | null;
  metricsUrl: string | null;
  stop: () => Promise<void>;
}

export interface ApiEnvironmentOptions {
  metricsPort: number;
  origin: string;
  port: number;
  target: LoadTarget;
  userIds: readonly string[];
}

/**
 * The child process gets a scrubbed copy of the runner's environment: every database URL is removed (the
 * owner and bootstrap credentials must never reach the API) and replaced by the load target's runtime and
 * maintenance roles. Local sessions are enabled only for the planned members; nothing here touches the
 * production guard, which lives in the API's own configuration validation.
 */
export function buildApiEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  { metricsPort, origin, port, target, userIds }: ApiEnvironmentOptions,
): NodeJS.ProcessEnv {
  if (userIds.length === 0) {
    throw new Error('Local sessions need at least one member');
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !key.endsWith('DATABASE_URL')) {
      environment[key] = value;
    }
  }
  // A seeded dataset ages in real time: the oldest runs cross the one-year line and the newest raw points
  // cross the seven-day line as the clock moves. Left running, the retention jobs would rewrite the dataset
  // during the measurement, so they are parked at their longest interval unless the caller opts in.
  const parkedJobs: NodeJS.ProcessEnv =
    inherited.LOAD_KEEP_RETENTION_JOBS === 'true'
      ? {}
      : {
          RUN_RAW_PURGE_INTERVAL_MS: String(24 * 60 * 60 * 1_000),
          RUN_RETENTION_DELETE_INTERVAL_MS: String(24 * 60 * 60 * 1_000),
          RUN_TOMBSTONE_RECLAIM_INTERVAL_MS: String(24 * 60 * 60 * 1_000),
        };
  return {
    ...environment,
    ...parkedJobs,
    ALLOWED_ORIGINS: origin,
    APP_ENV: 'test',
    DATABASE_URL: target.runtime.connectionString,
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: userIds.join(','),
    MAINTENANCE_DATABASE_URL: target.maintenance.connectionString,
    METRICS_HOST: '127.0.0.1',
    METRICS_PORT: String(metricsPort),
    PORT: String(port),
    SESSION_COOKIE_SECURE: 'false',
  };
}

const configurationKeys = [
  'DB_CONNECTION_TIMEOUT_MS',
  'DB_POOL_MAX',
  'DB_QUERY_TIMEOUT_MS',
  'LIVE_SSE_BACKPRESSURE_TIMEOUT_MS',
  'LIVE_SSE_HEARTBEAT_INTERVAL_MS',
  'LIVE_SSE_MAX_CONNECTIONS',
  'LIVE_SSE_POLL_CONCURRENCY',
  'LIVE_SSE_POLL_INTERVAL_MS',
  'RUN_AUTO_FINISH_INTERVAL_MS',
  'RUN_RAW_PURGE_INTERVAL_MS',
  'RUN_RETENTION_DELETE_INTERVAL_MS',
  'RUN_SUMMARY_CONCURRENCY',
  'RUN_SUMMARY_INTERVAL_MS',
  'RUN_TOMBSTONE_RECLAIM_INTERVAL_MS',
  'SESSION_STORE_MAX_ENTRIES',
  'SESSION_TTL_MS',
] as const satisfies readonly (keyof Environment)[];

export function describeConfiguration(environment: Environment): Record<string, boolean | number | string> {
  const configuration: Record<string, boolean | number | string> = {};
  for (const key of configurationKeys) {
    configuration[key] = environment[key];
  }
  return configuration;
}

const maximumDistinctEvents = 64;

/** Counts log lines by level and event name only. Contents are never stored. */
export class ServerLogTally {
  readonly #byEvent = new Map<string, number>();
  #errorLines = 0;
  #warnLines = 0;

  public add(line: string): void {
    let entry: { event?: unknown; level?: unknown };
    try {
      entry = JSON.parse(line) as { event?: unknown; level?: unknown };
    } catch {
      return;
    }
    if (entry.level === 'error') {
      this.#errorLines += 1;
    } else if (entry.level === 'warn') {
      this.#warnLines += 1;
    }
    let event = typeof entry.event === 'string' && entry.event.length > 0 ? entry.event.slice(0, 80) : 'unknown';
    if (!this.#byEvent.has(event) && this.#byEvent.size >= maximumDistinctEvents) {
      event = 'other';
    }
    this.#byEvent.set(event, (this.#byEvent.get(event) ?? 0) + 1);
  }

  public summary(): { byEvent: Record<string, number>; errorLines: number; warnLines: number } {
    return {
      byEvent: Object.fromEntries(this.#byEvent),
      errorLines: this.#errorLines,
      warnLines: this.#warnLines,
    };
  }
}

export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Could not reserve a local port'));
        }
      });
    });
  });
}

const apiDirectory = fileURLToPath(new URL('../..', import.meta.url));

async function waitUntilReady(child: ChildProcess, url: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let exited = child.exitCode !== null;
  child.once('exit', () => {
    exited = true;
  });
  while (performance.now() < deadline) {
    if (exited) {
      throw new Error('The API process exited before it became ready');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) {
        return;
      }
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error('The API process did not become ready in time');
}

export interface StartApiProcessOptions {
  /** Environment of the runner; database URLs in it never reach the child. */
  environment: Readonly<Record<string, string | undefined>>;
  origin: string;
  readyTimeoutMs?: number;
  target: LoadTarget;
  userIds: readonly string[];
}

/**
 * Starts the real API (`src/entrypoint.ts` through tsx, exactly as `npm run dev` minus the watcher) on free
 * loopback ports, waits for it to answer, and hands back an `ApiTarget` whose `stop` ends the process.
 */
export async function startApiProcess(options: StartApiProcessOptions): Promise<ApiTarget> {
  const port = await findFreePort();
  const metricsPort = await findFreePort();
  const childEnvironment = buildApiEnvironment(options.environment, {
    metricsPort,
    origin: options.origin,
    port,
    target: options.target,
    userIds: options.userIds,
  });
  const configuration = describeConfiguration(loadEnvironment({ environment: childEnvironment }));

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/entrypoint.ts'], {
    cwd: apiDirectory,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tally = new ServerLogTally();
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        tally.add(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const forced = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(forced);
  };

  try {
    await waitUntilReady(child, `http://127.0.0.1:${port}/api/health/live`, options.readyTimeoutMs ?? 60_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    configuration,
    logSummary: () => tally.summary(),
    metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
    origin: options.origin,
    stop,
  };
}
