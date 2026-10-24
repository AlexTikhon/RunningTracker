// The read-only checks behind `npm run demo:doctor`, also run by `npm run demo:up` before it changes anything.
// Each check is { status: 'ok' | 'warn' | 'fail', title, detail, hint }. No check prints a credential.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  composeFile,
  demoHost,
  demoPorts,
  isProcessAlive,
  lockPath,
  parseComposePs,
  portHint,
  probePort,
  readEnvFile,
  readLock,
  resolveDemoConfiguration,
  satisfiesRange,
} from './demo-stack.mjs';

const requiredPackages = [
  ['pg', '.'],
  ['tsx', 'apps/api'],
  ['vite', 'apps/web'],
  ['typescript', '.'],
  ['@running-tracker/contracts', '.'],
  ['@running-tracker/fixtures', '.'],
];

function run(command, args, { root, shell = false, timeoutMs = 15_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    missing: result.error?.code === 'ENOENT',
    ok: result.status === 0,
    stderr: (result.stderr ?? '').trim(),
    stdout: (result.stdout ?? '').trim(),
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function firstLine(text) {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function npmVersion(root) {
  const agent = /\bnpm\/([0-9.]+)/.exec(process.env.npm_config_user_agent ?? '');
  if (agent !== null) {
    return agent[1];
  }
  const result = run('npm', ['--version'], { root, shell: process.platform === 'win32' });
  return result.ok ? result.stdout : undefined;
}

function packageInstalled(root, name, workspace) {
  return [join(root, workspace, 'node_modules', name), join(root, 'node_modules', name)].some((directory) =>
    existsSync(join(directory, 'package.json')),
  );
}

/**
 * Collects every check. `context` carries what demo:up needs afterwards: the child environment, the database port,
 * and whether the Compose postgres container already runs. `holdsLock` is demo:up's own run, whose lock is not
 * another demo.
 */
export async function collectChecks({ holdsLock = false, root }) {
  const checks = [];
  const add = (status, title, detail = '', hint = '') => checks.push({ detail, hint, status, title });
  const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines;

  add(
    satisfiesRange(process.version, engines.node) ? 'ok' : 'fail',
    `Node ${process.version}`,
    `required ${engines.node}`,
    'install a Node version in that range',
  );
  const npm = npmVersion(root);
  if (npm === undefined) {
    add('fail', 'npm not found', `required ${engines.npm}`, 'install npm with Node');
  } else {
    add(satisfiesRange(npm, engines.npm) ? 'ok' : 'fail', `npm ${npm}`, `required ${engines.npm}`, 'install an npm version in that range');
  }

  const missingPackages = requiredPackages
    .filter(([name, workspace]) => !packageInstalled(root, name, workspace))
    .map(([name]) => name);
  if (missingPackages.length === 0) {
    add('ok', 'Dependencies installed');
  } else {
    add('fail', 'Dependencies missing', missingPackages.join(', '), 'run: npm ci');
  }

  const dotenvPath = join(root, '.env');
  const dotenvExists = existsSync(dotenvPath);
  add(
    'ok',
    dotenvExists ? '.env present' : '.env absent',
    dotenvExists
      ? 'read, never written; the demo settings are passed to its own processes only'
      : 'the database URLs come from .env.example, which matches the Compose file',
  );
  const configuration = resolveDemoConfiguration({
    dotenv: readEnvFile(dotenvPath),
    example: readEnvFile(join(root, '.env.example')),
    processEnvironment: process.env,
  });
  for (const line of configuration.report) {
    add('ok', 'Configuration', line);
  }
  for (const problem of configuration.problems) {
    add('fail', 'Configuration', problem, 'fix the value in .env (or unset the variable) and rerun');
  }

  const holder = holdsLock ? undefined : readLock(join(root, lockPath));
  const runningDemo = holder !== undefined && isProcessAlive(holder.pid) ? holder : undefined;
  if (runningDemo !== undefined) {
    add(
      'fail',
      'A demo is already running',
      `process ${runningDemo.pid}, started ${runningDemo.startedAt}`,
      `use it at http://${demoHost}:${demoPorts.web}, or press Ctrl+C in its terminal to stop it`,
    );
  }

  let postgres;
  const dockerCli = run('docker', ['--version'], { root });
  if (dockerCli.missing) {
    add('fail', 'Docker CLI not found', '', 'install Docker Desktop (or Docker Engine with the Compose plugin)');
  } else {
    add('ok', 'Docker CLI', firstLine(dockerCli.stdout));
    const engine = run('docker', ['version', '--format', '{{.Server.Version}}'], { root });
    if (!engine.ok) {
      add(
        'fail',
        'Docker engine not reachable',
        engine.timedOut ? 'docker version timed out' : firstLine(engine.stderr),
        'start Docker Desktop (or the Docker service) and wait until it reports running',
      );
    } else {
      add('ok', 'Docker engine', `server ${engine.stdout}`);
      const compose = run('docker', ['compose', 'version', '--short'], { root });
      if (!compose.ok) {
        add('fail', 'Docker Compose not available', firstLine(compose.stderr), 'install the Docker Compose v2 plugin');
      } else {
        add('ok', 'Docker Compose', compose.stdout);
        const ps = run('docker', ['compose', '-f', composeFile, 'ps', '--all', '--format', 'json', 'postgres'], { root });
        try {
          postgres = ps.ok ? parseComposePs(ps.stdout) : undefined;
        } catch {
          postgres = undefined;
        }
        add(
          'ok',
          'PostgreSQL container',
          postgres === undefined
            ? 'not created yet; demo:up creates it'
            : `${postgres.state}${postgres.health ? ` (${postgres.health})` : ''}`,
        );
        const volume = run('docker', ['volume', 'inspect', '--format', '{{.Name}}', 'running-tracker_running_tracker_postgres'], { root });
        add(
          'ok',
          'Database volume',
          volume.ok
            ? 'exists; its data is kept'
            : 'not created yet; the first start creates an empty one',
        );
      }
    }
  }

  const ports = [
    ['API', demoPorts.api],
    ['web', demoPorts.web],
  ];
  for (const [label, port] of ports) {
    const probe = await probePort(port);
    if (probe.free) {
      add('ok', `Port ${port} (${label}) free`);
    } else {
      add(
        'fail',
        `Port ${port} (${label}) in use`,
        runningDemo === undefined ? probe.reason : `${probe.reason}, probably the running demo`,
        runningDemo === undefined
          ? `stop whatever holds it (demo:up never stops other processes); ${portHint(port)}`
          : 'stop the running demo first',
      );
    }
  }
  if (configuration.databasePort !== undefined) {
    const port = configuration.databasePort;
    const probe = await probePort(port);
    const ours = postgres?.state === 'running';
    if (probe.free || ours) {
      add('ok', `Port ${port} (PostgreSQL)`, ours ? 'held by the Compose postgres container' : 'free');
    } else {
      add(
        'fail',
        `Port ${port} (PostgreSQL) in use by something else`,
        `${probe.reason}, but the Compose postgres container is not running`,
        `stop the other database or service; ${portHint(port)}`,
      );
    }
  }

  return { checks, context: { configuration, postgres } };
}

export function printChecks(checks, { onlyProblems = false, output = process.stdout } = {}) {
  const marks = { fail: 'FAIL', ok: ' ok ', warn: 'warn' };
  for (const check of checks) {
    if (onlyProblems && check.status === 'ok') {
      continue;
    }
    output.write(`[${marks[check.status]}] ${check.title}${check.detail ? `: ${check.detail}` : ''}\n`);
    if (check.status !== 'ok' && check.hint) {
      output.write(`       -> ${check.hint}\n`);
    }
  }
}
