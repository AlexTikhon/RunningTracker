import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { demoIds } from './demo-plan.mjs';
import {
  acquireLock,
  isProcessAlive,
  parseComposePs,
  probePort,
  resolveDemoConfiguration,
  runStep,
  satisfiesRange,
  startProcess,
  startServices,
  stopProcess,
  waitForHttp,
} from './demo-stack.mjs';

const example = {
  BOOTSTRAP_DATABASE_URL: 'postgresql://running_tracker:example_bootstrap@127.0.0.1:5433/running_tracker',
  DATABASE_URL: 'postgresql://running_tracker_runtime:example_runtime@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:example_maintenance@127.0.0.1:5433/running_tracker',
  MIGRATION_DATABASE_URL: 'postgresql://running_tracker_owner:example_owner@127.0.0.1:5433/running_tracker',
  VITE_MAPBOX_ACCESS_TOKEN: '',
};

/**
 * A parent that starts a long-lived grandchild and prints its PID, then waits forever. On Windows the grandchild is
 * detached, which takes it out of libuv's kill-on-close job: like a grandchild that is not a Node process, it then
 * outlives a parent that is merely killed, so only ending the whole tree passes.
 */
const parentWithGrandchild = [
  "const { spawn } = require('node:child_process');",
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform === 'win32', stdio: 'ignore' });",
  "console.log('grandchild ' + grandchild.pid);",
  'setInterval(() => {}, 1000);',
].join('\n');

function collector() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

async function waitUntilGone(pid, timeoutMs = 10_000) {
  await waitFor(() => !isProcessAlive(pid), timeoutMs);
}

test('the demo configuration takes each database URL from the environment, then .env, then .env.example', () => {
  const { environment, problems, report } = resolveDemoConfiguration({
    dotenv: { MIGRATION_DATABASE_URL: example.MIGRATION_DATABASE_URL.replace('example_owner', 'dotenv_owner') },
    example,
    processEnvironment: {
      DATABASE_URL: example.DATABASE_URL.replace('example_runtime', 'process_runtime'),
      UNRELATED: 'kept',
    },
  });
  assert.deepEqual(problems, []);
  assert.match(environment.DATABASE_URL, /process_runtime/);
  assert.match(environment.MIGRATION_DATABASE_URL, /dotenv_owner/);
  assert.match(environment.MAINTENANCE_DATABASE_URL, /example_maintenance/);
  assert.equal(environment.UNRELATED, 'kept');
  assert.ok(report.some((line) => line.startsWith('DATABASE_URL:') && line.endsWith('(from environment)')));
  assert.ok(report.some((line) => line.startsWith('MIGRATION_DATABASE_URL:') && line.endsWith('(from .env)')));
  assert.ok(report.some((line) => line.startsWith('MAINTENANCE_DATABASE_URL:') && line.endsWith('(from .env.example)')));
});

test('the demo overrides enable local auth for the two demo people only and keep every listener on loopback', () => {
  const { environment } = resolveDemoConfiguration({
    dotenv: {
      ALLOWED_ORIGINS: 'https://tracker.example',
      LOCAL_AUTH_ENABLED: 'false',
      LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
      METRICS_HOST: '0.0.0.0',
      RUN_SEARCH_AI_ENABLED: 'true',
    },
    example,
    processEnvironment: { API_HOST: '0.0.0.0', APP_ENV: 'test', API_PROXY_TARGET: 'http://example.org' },
  });
  assert.equal(environment.LOCAL_AUTH_ENABLED, 'true');
  assert.equal(environment.LOCAL_AUTH_USER_IDS, `${demoIds.runner},${demoIds.coach}`);
  assert.equal(environment.API_HOST, '127.0.0.1');
  assert.equal(environment.METRICS_HOST, '127.0.0.1');
  assert.equal(environment.PORT, '3000');
  assert.equal(environment.ALLOWED_ORIGINS, 'http://127.0.0.1:5173');
  assert.equal(environment.API_PROXY_TARGET, 'http://127.0.0.1:3000');
  assert.equal(environment.APP_ENV, 'development');
  assert.equal(environment.RUN_SEARCH_AI_ENABLED, 'false');
  assert.equal(environment.SESSION_COOKIE_SECURE, 'false');
});

test('the demo refuses any database but the local running_tracker one, and production', () => {
  const cases = [
    [{ MIGRATION_DATABASE_URL: example.MIGRATION_DATABASE_URL.replace('127.0.0.1', 'db.example.org') }, /loopback/],
    [{ DATABASE_URL: example.DATABASE_URL.replace(/\/running_tracker$/, '/running_tracker_test') }, /must name the database running_tracker/],
    [{ MAINTENANCE_DATABASE_URL: example.MAINTENANCE_DATABASE_URL.replace('running_tracker_maintenance:', 'running_tracker_owner:') }, /must authenticate as running_tracker_maintenance/],
    [{ BOOTSTRAP_DATABASE_URL: example.BOOTSTRAP_DATABASE_URL.replace(':5433', ':5434') }, /same host and port/],
    [{ DATABASE_URL: 'not a url' }, /not a valid URL/],
    [{ APP_ENV: 'production' }, /production/],
  ];
  for (const [dotenv, expected] of cases) {
    const { problems } = resolveDemoConfiguration({ dotenv, example, processEnvironment: {} });
    assert.ok(problems.some((problem) => expected.test(problem)), `${JSON.stringify(problems)} ~ ${expected}`);
  }
  const missing = resolveDemoConfiguration({ dotenv: {}, example: {}, processEnvironment: {} });
  assert.equal(missing.problems.length, 4);
});

test('the configuration report and problems never contain a password', () => {
  const secret = 'S3cret-Password';
  const dotenv = {
    BOOTSTRAP_DATABASE_URL: `postgresql://running_tracker:${secret}@db.example.org:5433/running_tracker`,
    DATABASE_URL: `postgresql://running_tracker_runtime:${secret}@127.0.0.1:5433/other`,
    MIGRATION_DATABASE_URL: `postgresql://running_tracker_owner:${secret}@127.0.0.1:5433/running_tracker`,
    VITE_MAPBOX_ACCESS_TOKEN: `pk.${secret}`,
  };
  const { problems, report } = resolveDemoConfiguration({ dotenv, example, processEnvironment: {} });
  assert.ok(problems.length >= 2);
  for (const line of [...problems, ...report]) {
    assert.ok(!line.includes(secret), line);
  }
});

test('engine ranges are checked comparator by comparator', () => {
  assert.equal(satisfiesRange('v24.11.1', '>=24.11.0 <25'), true);
  assert.equal(satisfiesRange('v24.10.9', '>=24.11.0 <25'), false);
  assert.equal(satisfiesRange('v25.0.0', '>=24.11.0 <25'), false);
  assert.equal(satisfiesRange('11.6.2', '>=11.6.0 <12'), true);
});

test('a port held by another process is reported in use and left alone', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const probe = await probePort(port);
    assert.equal(probe.free, false);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(await probePort(port), { free: true });
});

test('a second demo:up is refused while the first holds the lock, and a stale lock is replaced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-lock-'));
  const path = join(directory, 'demo-up.lock');
  try {
    const release = acquireLock(path, { pid: 1001, isAlive: (pid) => pid === 1001 });
    const before = readFileSync(path, 'utf8');
    assert.throws(() => acquireLock(path, { pid: 1002, isAlive: (pid) => pid === 1001 }), {
      code: 'DEMO_ALREADY_RUNNING',
      message: /process 1001/,
    });
    assert.equal(readFileSync(path, 'utf8'), before);
    release();
    assert.throws(() => readFileSync(path), { code: 'ENOENT' });

    writeFileSync(path, JSON.stringify({ pid: 2001, startedAt: 'earlier' }));
    const releaseNew = acquireLock(path, { pid: 2002, isAlive: () => false });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 2002);
    releaseNew();

    // A lock that someone else now holds is not removed by an old release.
    const releaseOld = acquireLock(path, { pid: 3001, isAlive: () => false });
    writeFileSync(path, JSON.stringify({ pid: 3002, startedAt: 'later' }));
    releaseOld();
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 3002);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('stopping a started process also ends the processes it started', async () => {
  const output = collector();
  const handle = startProcess({
    args: ['-e', parentWithGrandchild],
    command: process.execPath,
    environment: process.env,
    name: 'tree',
    output,
  });
  const line = await waitFor(() => output.lines.find((entry) => entry.startsWith('[tree] grandchild ')));
  const grandchild = Number(line.trim().split(' ').pop());
  assert.ok(isProcessAlive(grandchild));

  await stopProcess(handle, { graceMs: 2_000 });
  assert.equal(handle.running, false);
  await waitUntilGone(grandchild);
});

test('a startup failure stops the services this invocation already started', async () => {
  const output = collector();
  const owned = [];
  let grandchild;
  await assert.rejects(
    startServices(
      [
        {
          args: ['-e', parentWithGrandchild],
          command: process.execPath,
          environment: process.env,
          name: 'first',
          output,
          ready: async () => {
            const line = await waitFor(() => output.lines.find((entry) => entry.startsWith('[first] grandchild ')));
            grandchild = Number(line.trim().split(' ').pop());
          },
        },
        {
          args: ['-e', 'process.exit(3)'],
          command: process.execPath,
          environment: process.env,
          name: 'second',
          output,
          ready: (handle) => waitForHttp('http://127.0.0.1:9/', { handle, intervalMs: 50, timeoutMs: 10_000 }),
        },
      ],
      { owned, stopOptions: () => ({ graceMs: 2_000 }) },
    ),
    /second exited before/,
  );
  assert.deepEqual(
    owned.map((handle) => [handle.name, handle.running]),
    [
      ['first', false],
      ['second', false],
    ],
  );
  await waitUntilGone(grandchild);
});

test('an interrupted startup starts nothing further and stops what it started', async () => {
  const owned = [];
  const interrupt = new AbortController();
  const started = startServices(
    [
      {
        args: ['-e', 'setInterval(() => {}, 1000)'],
        command: process.execPath,
        environment: process.env,
        name: 'slow',
        output: collector(),
        ready: (handle, signal) => waitForHttp('http://127.0.0.1:9/', { handle, intervalMs: 50, signal, timeoutMs: 10_000 }),
      },
      { args: [], command: process.execPath, name: 'never', ready: () => undefined },
    ],
    { owned, signal: interrupt.signal, stopOptions: () => ({ graceMs: 1_000 }) },
  );
  await sleep(200);
  interrupt.abort(new Error('Interrupted by SIGINT'));
  await assert.rejects(started, /Interrupted by SIGINT/);
  assert.deepEqual(owned.map((handle) => [handle.name, handle.running]), [['slow', false]]);
});

test('readiness waits are bounded', async () => {
  const started = performance.now();
  await assert.rejects(
    waitForHttp('http://127.0.0.1:9/', { intervalMs: 50, timeoutMs: 300 }),
    /was not ready within 0 s \(last: no answer\)/,
  );
  assert.ok(performance.now() - started < 5_000);
});

test('a setup command that overruns its deadline is ended with its children', async () => {
  const started = performance.now();
  const result = await runStep({
    args: ['-e', parentWithGrandchild],
    command: process.execPath,
    environment: process.env,
    timeoutMs: 1_000,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(performance.now() - started < 10_000);
  const grandchild = Number(/grandchild (\d+)/.exec(result.output)[1]);
  await waitUntilGone(grandchild);
});

test('the postgres service state is read from either docker compose ps format', () => {
  const line = JSON.stringify({ Health: 'healthy', Service: 'postgres', State: 'running' });
  assert.deepEqual(parseComposePs(`${line}\n`), { health: 'healthy', state: 'running' });
  assert.deepEqual(parseComposePs(`[${line}]`), { health: 'healthy', state: 'running' });
  assert.equal(parseComposePs(''), undefined);
  assert.equal(parseComposePs(JSON.stringify({ Service: 'proxy', State: 'running' })), undefined);
});
