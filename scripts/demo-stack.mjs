// Shared parts of `npm run demo:doctor` and `npm run demo:up` (docs/runbooks/demo.md): the demo configuration,
// the guards that keep it on the local development database and loopback, port probes, a single-instance lock,
// and starting and stopping the processes one invocation owns. Nothing here reads or writes `.env`; callers pass
// its parsed contents in.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';

import { demoIds } from './demo-plan.mjs';

export const demoHost = '127.0.0.1';
export const demoPorts = Object.freeze({ api: 3000, web: 5173 });
export const demoAppUrl = `http://${demoHost}:${demoPorts.web}`;
export const demoApiUrl = `http://${demoHost}:${demoPorts.api}`;
export const composeFile = 'infra/compose/docker-compose.yml';
export const lockPath = join('.local', 'demo', 'demo-up.lock');

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const demoDatabase = 'running_tracker';

/** The four connections the existing bootstrap, migration, seed and API read, and the role each must use. */
const databaseVariables = Object.freeze([
  { name: 'BOOTSTRAP_DATABASE_URL', user: undefined },
  { name: 'MIGRATION_DATABASE_URL', user: 'running_tracker_owner' },
  { name: 'DATABASE_URL', user: 'running_tracker_runtime' },
  { name: 'MAINTENANCE_DATABASE_URL', user: 'running_tracker_maintenance' },
]);

function describeDatabaseUrl(name, value, expectedUser) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { problem: `${name} is not a valid URL` };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return { problem: `${name} must use the postgres or postgresql protocol` };
  }
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  const target = { database, host: url.hostname, port: url.port || '5432', user };
  // The summary names the role and target only; the password never leaves this function.
  const summary = `${user}@${url.hostname}:${target.port}/${database}`;
  if (expectedUser !== undefined && user !== expectedUser) {
    return { problem: `${name} must authenticate as ${expectedUser}, not ${user || '(none)'}`, summary, target };
  }
  if (!url.password) {
    return { problem: `${name} must include the role password (the bootstrap sets it)`, summary, target };
  }
  if (!loopbackHosts.has(url.hostname)) {
    return { problem: `${name} must point at a loopback host: the demo only uses the local database`, summary, target };
  }
  if (database !== demoDatabase) {
    return { problem: `${name} must name the database ${demoDatabase}: the demo writes nowhere else`, summary, target };
  }
  return { summary, target };
}

/**
 * Works out what the demo children run with. Each database URL comes from the process environment, then `.env`,
 * then `.env.example` (the fixed local fixtures that match the Compose file), and is passed explicitly, because the
 * scripts' own `.env` loading never overrides a variable that is already set. Everything that makes it a demo is an
 * override on top: local auth for the two demo identities only, loopback listeners, no search interpreter.
 *
 * Returns `problems` (strings without credentials), `report` lines for the doctor, and the `environment` to spawn with.
 */
export function resolveDemoConfiguration({ dotenv = {}, example = {}, processEnvironment = {} }) {
  const problems = [];
  const report = [];
  const resolved = {};
  const pick = (name) => {
    if (processEnvironment[name] !== undefined && processEnvironment[name] !== '') {
      return { source: 'environment', value: processEnvironment[name] };
    }
    if (dotenv[name] !== undefined && dotenv[name] !== '') {
      return { source: '.env', value: dotenv[name] };
    }
    if (example[name] !== undefined && example[name] !== '') {
      return { source: '.env.example', value: example[name] };
    }
    return undefined;
  };

  const targets = [];
  for (const { name, user } of databaseVariables) {
    const picked = pick(name);
    if (picked === undefined) {
      problems.push(`${name} is not set in the environment, .env or .env.example`);
      continue;
    }
    const described = describeDatabaseUrl(name, picked.value, user);
    if (described.problem !== undefined) {
      problems.push(`${described.problem} (from ${picked.source})`);
    } else {
      report.push(`${name}: ${described.summary} (from ${picked.source})`);
      targets.push(described.target);
    }
    resolved[name] = picked.value;
  }
  const [first, ...rest] = targets;
  if (first !== undefined && rest.some((target) => target.host !== first.host || target.port !== first.port)) {
    problems.push('The four database URLs must use the same host and port');
  }

  const appEnvironment = pick('APP_ENV');
  if (appEnvironment?.value === 'production') {
    problems.push(`APP_ENV is production (from ${appEnvironment.source}); the demo runs only in development`);
  }

  const mapboxToken = pick('VITE_MAPBOX_ACCESS_TOKEN');
  report.push(
    mapboxToken === undefined || mapboxToken.source === '.env.example'
      ? 'VITE_MAPBOX_ACCESS_TOKEN: not set (maps show a notice; everything else works)'
      : `VITE_MAPBOX_ACCESS_TOKEN: set (from ${mapboxToken.source}; value not shown)`,
  );

  const overrides = {
    ALLOWED_ORIGINS: demoAppUrl,
    API_HOST: demoHost,
    API_PROXY_TARGET: demoApiUrl,
    APP_ENV: 'development',
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: `${demoIds.runner},${demoIds.coach}`,
    METRICS_HOST: demoHost,
    PORT: String(demoPorts.api),
    RUN_SEARCH_AI_ENABLED: 'false',
    SESSION_COOKIE_SECURE: 'false',
  };
  report.push(
    `Demo overrides (children only; .env is not changed): local auth for runner ${demoIds.runner} and coach ` +
      `${demoIds.coach}, API on ${demoApiUrl}, web on ${demoAppUrl}, search interpreter off`,
  );

  const databasePort = first === undefined ? undefined : Number(first.port);
  return {
    databasePort,
    environment: { ...processEnvironment, ...resolved, ...overrides },
    problems,
    report,
  };
}

/** Reads a dotenv-style file without loading it into this process. A missing file is an empty object. */
export function readEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }
  // The parser Node's own process.loadEnvFile uses, so the demo sees `.env` exactly as the scripts do.
  return Object.fromEntries(
    Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter(([, value]) => value !== undefined),
  );
}

/** `>=24.11.0 <25`-style engine ranges: space-separated comparators, every one must hold. */
export function satisfiesRange(version, range) {
  const parse = (value) => {
    const parts = value.replace(/^v/, '').split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) {
        return left[index] < right[index] ? -1 : 1;
      }
    }
    return 0;
  };
  const actual = parse(version);
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const match = /^(>=|<=|>|<|=)?(v?[0-9][0-9.]*)$/.exec(comparator);
      if (match === null) {
        throw new Error(`Unsupported version comparator ${comparator}`);
      }
      const result = compare(actual, parse(match[2]));
      switch (match[1] ?? '=') {
        case '>=':
          return result >= 0;
        case '<=':
          return result <= 0;
        case '>':
          return result > 0;
        case '<':
          return result < 0;
        default:
          return result === 0;
      }
    });
}

/**
 * Whether anything holds `host:port`: a connection that succeeds, or a listen that fails, means in use.
 * Never touches whatever holds it.
 */
export async function probePort(port, host = demoHost) {
  const answers = await new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  if (answers) {
    return { free: false, reason: 'a process is accepting connections on it' };
  }
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) =>
      resolve({ free: false, reason: error.code === 'EADDRINUSE' ? 'it is already bound' : `it cannot be bound (${error.code})` }),
    );
    server.listen({ exclusive: true, host, port }, () => server.close(() => resolve({ free: true })));
  });
}

export function portHint(port) {
  return process.platform === 'win32'
    ? `find its owner with: netstat -ano | findstr :${port}`
    : `find its owner with: lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * One `demo:up` at a time per checkout. The lock file is created exclusively and holds the owner's PID; a lock
 * whose PID is gone is stale and is replaced. Returns `release`, which removes the file only if it is still ours.
 */
export function acquireLock(path, { isAlive = isProcessAlive, pid = process.pid } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx');
      writeSync(descriptor, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
      closeSync(descriptor);
      return () => {
        if (readLock(path)?.pid === pid) {
          unlinkSync(path);
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const holder = readLock(path);
      if (holder !== undefined && isAlive(holder.pid)) {
        const failure = new Error(
          `Another demo:up is running (process ${holder.pid}, started ${holder.startedAt}). Stop it with Ctrl+C in ` +
            `its terminal. If no such process is a demo, delete ${path}.`,
        );
        failure.code = 'DEMO_ALREADY_RUNNING';
        throw failure;
      }
      unlinkSync(path);
    }
  }
  throw new Error(`Could not take the demo lock ${path}`);
}

/** The lock's holder, or undefined when there is no readable lock. */
export function readLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(parsed.pid) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts one long-running child. On POSIX it leads its own process group, so the whole group can be signalled; on
 * Windows it stays on this console, so a Ctrl+C reaches it directly, and its tree is ended with taskkill.
 */
export function startProcess({ args, command, cwd, environment, name, output = process.stdout }) {
  // No windowsHide: on Windows it creates the child with a console of its own, which a Ctrl+C here never reaches.
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== 'win32',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, error, signal: null }));
  });
  let state = 'running';
  void exited.then(() => {
    state = 'exited';
  });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        output.write(`[${name}] ${line}\n`);
      }
    });
  }
  return {
    child,
    exited,
    get running() {
      return state === 'running';
    },
    name,
  };
}

/**
 * Ends a child started by startProcess and everything it started. First asks politely and waits up to `graceMs`
 * (on Windows the polite request is the Ctrl+C the console already delivered, so `alreadySignalled` skips straight
 * to waiting), then forces the whole tree. Only this child's own tree is addressed: never a port, name or image.
 */
export async function stopProcess(handle, { alreadySignalled = false, graceMs = 8_000 } = {}) {
  const { child } = handle;
  if (child.pid === undefined) {
    return;
  }
  const windows = process.platform === 'win32';
  if (handle.running && !windows && !alreadySignalled) {
    signalGroup(child.pid, 'SIGTERM');
  }
  if (handle.running && (alreadySignalled || !windows)) {
    await Promise.race([handle.exited, sleep(graceMs)]);
  }
  if (windows) {
    if (handle.running) {
      forceTree(child.pid);
      await Promise.race([handle.exited, sleep(5_000)]);
    }
  } else {
    // Also reaches anything the leader left behind in its group.
    signalGroup(child.pid, 'SIGKILL');
    await Promise.race([handle.exited, sleep(5_000)]);
  }
}

/**
 * Starts each service in order and waits for its `ready(handle, signal)` before the next. Every handle goes into
 * `owned` as soon as it exists, so the caller can always stop exactly what this invocation started. If a start or a
 * readiness check fails (or `signal` aborts), the services already started are stopped before the error is rethrown.
 */
export async function startServices(specs, { owned, signal, stopOptions = () => ({}) }) {
  try {
    for (const spec of specs) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const handle = startProcess(spec);
      owned.push(handle);
      await spec.ready(handle, signal);
    }
  } catch (error) {
    await stopAll(owned, stopOptions());
    throw error;
  }
}

/** Stops the handles concurrently; each one's own tree only. */
export async function stopAll(handles, options = {}) {
  await Promise.all([...handles].reverse().map((handle) => stopProcess(handle, options)));
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

/** Synchronous, so it also works from an 'exit' handler. Windows: the tree rooted at `pid`; POSIX: its group. */
export function forceTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    signalGroup(pid, 'SIGKILL');
  }
}

/**
 * Polls `url` until it answers 200, the child exits, or `timeoutMs` passes. `handle` may be undefined for a
 * check that is not tied to one process.
 */
export async function waitForHttp(url, { handle, intervalMs = 500, signal, timeoutMs }) {
  const deadline = performance.now() + timeoutMs;
  let lastStatus = 'no answer';
  while (performance.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (handle !== undefined && !handle.running) {
      throw new Error(`${handle.name} exited before ${url} answered`);
    }
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.status === 200) {
        return;
      }
      lastStatus = `HTTP ${response.status}`;
    } catch {
      lastStatus = 'no answer';
    }
    await sleep(intervalMs);
  }
  throw new Error(`${url} was not ready within ${Math.round(timeoutMs / 1_000)} s (last: ${lastStatus})`);
}

/**
 * Runs a command to completion with a deadline, capturing its output (bounded). On timeout the command's tree is
 * ended. `stream` passes output through as it arrives instead (for image pulls).
 */
export function runStep({ args, command, cwd, environment, shell = false, stream = false, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: environment,
      shell,
      stdio: ['ignore', stream ? 'inherit' : 'pipe', stream ? 'inherit' : 'pipe'],
    });
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk).slice(-16_384);
    };
    child.stdout?.setEncoding('utf8').on('data', keep);
    child.stderr?.setEncoding('utf8').on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        forceTree(child.pid);
      }
    }, timeoutMs);
    activeSteps.add(child);
    const finish = (result) => {
      clearTimeout(timer);
      activeSteps.delete(child);
      resolve({ ...result, output, timedOut });
    };
    child.once('error', (error) => finish({ code: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
}

const activeSteps = new Set();

/** Ends any setup command still running (used on Ctrl+C and on exit). */
export function forceActiveSteps() {
  for (const child of activeSteps) {
    if (child.pid !== undefined && child.exitCode === null) {
      forceTree(child.pid);
    }
  }
}

/**
 * The Compose project's postgres service as `docker compose ps` reports it, or undefined when it has no
 * container. Compose prints one JSON object per line (or one array, in older versions).
 */
export function parseComposePs(text) {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  const entries = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const postgres = entries.find((entry) => entry.Service === 'postgres');
  if (postgres === undefined) {
    return undefined;
  }
  return { health: postgres.Health ?? '', state: postgres.State ?? '' };
}
