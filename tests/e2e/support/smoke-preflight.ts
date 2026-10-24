import { connect, createServer } from 'node:net';
import process from 'node:process';

import { chromium, firefox } from '@playwright/test';
import pg from 'pg';

import { loadE2eEnvironment } from './environment.js';

// Run by `npm run test:e2e:smoke` and `npm run test:e2e:smoke:firefox` before Playwright starts any server. Playwright
// itself would launch the API and Vite first and only then find a missing browser, report a port that answers with a
// generic message, or wait out its server timeout when PostgreSQL is down. This checks those three up front, says
// which one failed and how to fix it, and exits 1. It only looks: it never stops, reuses or signals another process,
// and never writes to the database.

const browsers = { chromium, firefox } as const;
const browserName = process.argv[2];
if (browserName !== 'chromium' && browserName !== 'firefox') {
  console.error('Usage: smoke-preflight.ts chromium|firefox');
  process.exit(2);
}

// Throws on a missing or non-_test database URL, as the Playwright config would.
const environment = loadE2eEnvironment();
const problems: string[] = [];

try {
  const browser = await browsers[browserName].launch();
  await browser.close();
} catch (error) {
  const firstLine = String(error instanceof Error ? error.message : error).split('\n')[0];
  problems.push(
    `${browserName} could not be launched (${firstLine}).\n` +
      `  Install the build the installed @playwright/test pins: cd tests/e2e; npx playwright install ${browserName}`,
  );
}

// The ports of the three servers playwright.smoke.config.ts starts. Each must be free on 127.0.0.1, where they listen.
const servers = [
  { name: 'API', origin: environment.apiOrigin },
  { name: 'web', origin: environment.webOrigin },
  { name: 'demo web', origin: environment.demoWebOrigin },
];
for (const server of servers) {
  const port = Number(new URL(server.origin).port);
  const bindable = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ exclusive: true, host: '127.0.0.1', port }, () => probe.close(() => resolve(true)));
  });
  // Windows lets 127.0.0.1 be bound while another process listens on 0.0.0.0 with the same port, so also ask whether
  // anything accepts a connection there. The connection is closed at once; nothing is sent.
  const answered = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (!bindable || answered) {
    problems.push(
      `Port ${port} (${server.name}, ${server.origin}) is in use by another process. The smoke neither reuses nor stops ` +
        `it.\n  Find its owner (Windows: netstat -ano | findstr :${port}; elsewhere: lsof -nP -iTCP:${port} -sTCP:LISTEN), ` +
        'stop it yourself and run the smoke again.',
    );
  }
}

// Every role the stack logs in as: the API's runtime and maintenance roles, and the owner role of the fixtures.
const logins = [
  { url: environment.runtimeDatabaseUrl, variable: 'TEST_DATABASE_URL' },
  { url: environment.maintenanceDatabaseUrl, variable: 'TEST_MAINTENANCE_DATABASE_URL' },
  { url: environment.ownerDatabaseUrl, variable: 'TEST_MIGRATION_DATABASE_URL' },
];
for (const login of logins) {
  const parsed = new URL(login.url);
  // Never the URL itself: it carries a password.
  const target = `${decodeURIComponent(parsed.username)}@${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  const client = new pg.Client({
    application_name: 'running-tracker-e2e-preflight',
    connectionString: login.url,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    const result = await client.query<{ name: string; runs: string | null }>(
      "SELECT current_database() AS name, to_regclass('public.runs')::text AS runs",
    );
    const row = result.rows[0];
    if (!row?.name.endsWith('_test')) {
      problems.push(`${login.variable} (${target}) is connected to "${row?.name ?? ''}", which does not end in _test.`);
    } else if (row.runs === null) {
      problems.push(`${login.variable} (${target}) reaches a database without the schema.\n  Run: npm run db:migrate:test`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    problems.push(
      `PostgreSQL is not available as ${login.variable} (${target}): ${reason}.\n` +
        '  Start it with npm run db:up, then npm run db:bootstrap:test and npm run db:migrate:test if this is the first time.',
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (problems.length > 0) {
  console.error(`Smoke preflight failed; nothing was started.\n\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}

console.log(
  `Smoke preflight: ${browserName} launches, ports ${servers.map((server) => new URL(server.origin).port).join(', ')} ` +
    'are free, PostgreSQL answers for all three test roles.',
);
