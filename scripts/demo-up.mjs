// One command for the local demo (docs/runbooks/demo.md): PostgreSQL, bootstrap, migrations, the demo people, then
// the API and the web app on loopback, until Ctrl+C. Run with `npm run demo:up`. It reuses the existing commands,
// passes the demo settings to its own children only (.env is read, never written), and on exit stops exactly the
// processes it started. The database container and its volume are left as they are.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { demoIds } from './demo-plan.mjs';
import { collectChecks, printChecks } from './demo-preflight.mjs';
import {
  acquireLock,
  composeFile,
  demoApiUrl,
  demoAppUrl,
  forceActiveSteps,
  forceTree,
  lockPath,
  runStep,
  startServices,
  stopAll,
  waitForHttp,
} from './demo-stack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';

function fail(message) {
  console.error(`\ndemo:up: ${message}`);
  process.exitCode = 1;
}

/** Exits with process.exitCode once everything written so far has reached the terminal. Never resolves. */
function exitAfterFlush() {
  return new Promise(() => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit()));
  });
}

mkdirSync(dirname(join(root, lockPath)), { recursive: true });
let releaseLock;
try {
  releaseLock = acquireLock(join(root, lockPath));
} catch (error) {
  fail(error.message);
  await exitAfterFlush();
}

const owned = [];
const interrupt = new AbortController();
let interruptedBy;

// Last resort if this process ends some other way: never leave an owned process behind.
process.on('exit', () => {
  forceActiveSteps();
  for (const handle of owned) {
    if (handle.running && handle.child.pid !== undefined) {
      forceTree(handle.child.pid);
    }
  }
  releaseLock?.();
});

function onSignal(signal) {
  if (interruptedBy !== undefined) {
    console.log(`\n${signal} again: forcing the demo processes to stop.`);
    forceActiveSteps();
    for (const handle of owned) {
      if (handle.child.pid !== undefined) {
        forceTree(handle.child.pid);
      }
    }
    return;
  }
  interruptedBy = signal;
  console.log(`\n${signal}: stopping the demo (again to force).`);
  // A setup command on POSIX leads its own process group, so the terminal's Ctrl+C did not reach it.
  forceActiveSteps();
  interrupt.abort(new Error(`Interrupted by ${signal}`));
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, onSignal);
}

/** On Windows a console Ctrl+C or close has already reached the children; they get the grace period first. */
const stopOptions = () => ({ alreadySignalled: windows && interruptedBy !== undefined });

const npmCommand = process.env.npm_execpath?.endsWith('.js')
  ? { args: [process.env.npm_execpath], command: process.execPath }
  : undefined;

async function step(title, { args, command = process.execPath, shell = false, summarize, stream = false, timeoutMs }) {
  if (interrupt.signal.aborted) {
    throw interrupt.signal.reason;
  }
  process.stdout.write(`- ${title} ...${stream ? '\n' : ' '}`);
  const result = await runStep({ args, command, cwd: root, environment, shell, stream, timeoutMs });
  if (interrupt.signal.aborted) {
    throw interrupt.signal.reason;
  }
  if (result.code !== 0) {
    if (!stream) {
      console.log('failed');
    }
    if (result.output.trim() !== '') {
      console.log(result.output.trimEnd().replace(/^/gm, '    '));
    }
    throw new Error(
      result.timedOut
        ? `${title} did not finish within ${Math.round(timeoutMs / 1_000)} s`
        : result.error !== undefined
          ? `${title} could not start (${result.error.code ?? result.error.message})`
          : `${title} failed (exit ${result.code ?? result.signal})`,
    );
  }
  console.log(stream ? `  ${title}: done` : (summarize?.(result.output) ?? 'done'));
}

console.log('Checking prerequisites (the same checks as npm run demo:doctor)...');
const { checks, context } = await collectChecks({ holdsLock: true, root });
const blocking = checks.filter((check) => check.status === 'fail');
if (blocking.length > 0) {
  printChecks(blocking);
  fail('nothing was started. Fix the problems above (npm run demo:doctor shows the full report).');
  await exitAfterFlush();
}
const environment = context.configuration.environment;
console.log('Prerequisites ok.\n');

try {
  await step('Start PostgreSQL (docker compose up --wait)', {
    args: ['compose', '-f', composeFile, 'up', '-d', '--wait', '--wait-timeout', '120', 'postgres'],
    command: 'docker',
    stream: true,
    // The first start may pull the PostGIS image.
    timeoutMs: 10 * 60_000,
  });
  await step('Bootstrap roles (npm run db:bootstrap)', {
    args: ['scripts/bootstrap-database.mjs'],
    timeoutMs: 60_000,
  });
  await step('Apply migrations (npm run db:migrate)', {
    args: ['scripts/migrate.mjs'],
    summarize: (output) => {
      const applied = output.split(/\r?\n/).filter((line) => line.startsWith('apply ')).length;
      const skipped = output.split(/\r?\n/).filter((line) => line.startsWith('skip ')).length;
      return `${applied} applied, ${skipped} already in place`;
    },
    timeoutMs: 120_000,
  });
  await step('Seed the demo people (npm run demo:seed)', {
    args: ['scripts/demo-seed.mjs'],
    timeoutMs: 60_000,
  });
  await step('Build the shared packages the dev servers import', {
    args: [...(npmCommand?.args ?? []), 'run', 'build', '--workspace=@running-tracker/fixtures'],
    // Outside `npm run`, Windows can only start npm.cmd through a shell; the arguments are fixed.
    command: npmCommand?.command ?? 'npm',
    shell: npmCommand === undefined && windows,
    timeoutMs: 180_000,
  });

  console.log('- Start the API and the web app');
  await startServices(
    [
      {
        args: ['--import', 'tsx', 'src/entrypoint.ts'],
        command: process.execPath,
        cwd: join(root, 'apps', 'api'),
        environment,
        name: 'api',
        ready: (handle, signal) =>
          waitForHttp(`${demoApiUrl}/api/health/ready`, { handle, signal, timeoutMs: 90_000 }),
      },
      {
        args: [join(root, 'node_modules', 'vite', 'bin', 'vite.js')],
        command: process.execPath,
        cwd: join(root, 'apps', 'web'),
        environment,
        name: 'web',
        ready: async (handle, signal) => {
          await waitForHttp(demoAppUrl, { handle, signal, timeoutMs: 60_000 });
          // The page reaches the API only through Vite's proxy; check that path too.
          await waitForHttp(`${demoAppUrl}/api/health/ready`, { handle, signal, timeoutMs: 15_000 });
        },
      },
    ],
    { owned, signal: interrupt.signal, stopOptions },
  );
} catch (error) {
  // startServices has already stopped what it started; a failure before it started nothing.
  await stopAll(owned, stopOptions());
  if (interruptedBy !== undefined) {
    console.log('Stopped before the demo was ready. The database and its data are untouched.');
  } else {
    fail(`${error.message}\nEverything this command started has been stopped; the database and its data are untouched.`);
  }
  await exitAfterFlush();
}

console.log(`
The demo is running.

  App:     ${demoAppUrl}   (use this host name, not localhost)
  API:     ${demoApiUrl}   (loopback only)
  Runner:  ${demoIds.runner}
  Coach:   ${demoIds.coach}

Sign in: open the app and press "Demo runner" or "Demo coach" (docs/runbooks/demo.md, section 3).
  For both at once, use two browser profiles or an ordinary and a private window: tabs and windows
  of one profile share the session cookie, so a second tab is the same person.
Play the runner in another terminal: npm run demo:run

Ctrl+C stops the API and the web app. PostgreSQL keeps running with its data (npm run db:down stops it).
`);

const ended = await Promise.race([
  ...owned.map((handle) => handle.exited.then((result) => ({ handle, result }))),
  new Promise((resolve) => interrupt.signal.addEventListener('abort', () => resolve(undefined), { once: true })),
]);
if (ended !== undefined) {
  fail(`${ended.handle.name} exited unexpectedly (exit ${ended.result.code ?? ended.result.signal}); stopping the rest.`);
}
await stopAll(owned, stopOptions());
const survivors = owned.filter((handle) => handle.running).map((handle) => handle.name);
if (survivors.length > 0) {
  fail(`could not confirm that ${survivors.join(' and ')} stopped; check process ${owned.map((h) => h.child.pid).join(', ')}.`);
} else {
  console.log('API and web app stopped. PostgreSQL and its data were left as they were.');
}
await exitAfterFlush();
