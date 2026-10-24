import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

// The OpenID Connect stack: a provider, an API that has only OIDC sign-in (no local session endpoint, like
// production) and its own Vite server. The provider is on `localhost` and the application on `127.0.0.1`.
// Those are different sites, so the redirect from the provider back to the application is a cross-site
// navigation, which is what the Strict session cookie and the meta-refresh page in oidc-http.ts exist for.
export interface OidcE2eEnvironment {
  readonly apiOrigin: string;
  readonly clientId: string;
  // Fixed, local-only, not valid for any deployment (same idea as the cursor signing key in the config).
  readonly clientSecret: string;
  readonly providerOrigin: string;
  readonly redirectUri: string;
  // Short on purpose: the expiry scenario waits for it. Every other scenario finishes well inside it.
  readonly sessionTtlMs: number;
  readonly webOrigin: string;
}

export interface E2eEnvironment {
  readonly oidc: OidcE2eEnvironment;
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly runtimeDatabaseUrl: string;
  readonly maintenanceDatabaseUrl: string;
  readonly ownerDatabaseUrl: string;
  readonly runnerUserId: string;
  readonly coachUserId: string;
  // The fixed demo people the web app's demo sign-in buttons send (scripts/demo-plan.mjs). In this suite they are
  // suite users of the _test database like the two above, created by the demoScenario fixture.
  readonly demoRunnerUserId: string;
  readonly demoCoachUserId: string;
  // The same app served with VITE_LOCAL_DEMO_ENABLED=true, as `npm run demo:up` serves it, so it shows those buttons.
  readonly demoWebOrigin: string;
  // The same app served with a placeholder public Mapbox token, so the Coach map code path runs. Tests on this
  // origin intercept every provider request inside the browser; nothing is sent to Mapbox.
  readonly mapWebOrigin: string;
}

// Fixed rather than generated per run: playwright.config.ts is imported again in every worker, so a random
// value created there would differ between the API process and the tests.
const runnerUserId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0001';
const coachUserId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0002';
// Not chosen here: the web app sends these, so they are demoIds of scripts/demo-plan.mjs (its test checks the copy).
const demoRunnerUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddd0001';
const demoCoachUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddd0002';

interface DatabaseTarget {
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

function readDatabaseTarget(
  source: Record<string, string | undefined>,
  variableName: string,
): { readonly url: string; readonly target: DatabaseTarget } {
  const url = source[variableName]?.trim();

  if (!url) {
    throw new Error(`${variableName} is required: the browser suite only runs against the test database`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The URL itself is never echoed: it carries a password.
    throw new Error(`${variableName} is not a valid connection URL`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  if (!database.endsWith('_test')) {
    throw new Error(
      `${variableName} points at database "${database}", whose name does not end in _test: ` +
        'the browser suite refuses to run against anything but the test database',
    );
  }

  return {
    target: { database, host: parsed.hostname, port: parsed.port || '5432' },
    url,
  };
}

export function resolveE2eEnvironment(source: Record<string, string | undefined>): E2eEnvironment {
  const runtime = readDatabaseTarget(source, 'TEST_DATABASE_URL');
  const maintenance = readDatabaseTarget(source, 'TEST_MAINTENANCE_DATABASE_URL');
  const owner = readDatabaseTarget(source, 'TEST_MIGRATION_DATABASE_URL');

  for (const other of [maintenance, owner]) {
    if (
      other.target.host !== runtime.target.host ||
      other.target.port !== runtime.target.port ||
      other.target.database !== runtime.target.database
    ) {
      throw new Error(
        'TEST_DATABASE_URL, TEST_MAINTENANCE_DATABASE_URL and TEST_MIGRATION_DATABASE_URL must use the same host, port and database',
      );
    }
  }

  return {
    apiOrigin: 'http://127.0.0.1:3100',
    coachUserId,
    demoCoachUserId,
    demoRunnerUserId,
    demoWebOrigin: 'http://127.0.0.1:5276',
    maintenanceDatabaseUrl: maintenance.url,
    mapWebOrigin: 'http://127.0.0.1:5275',
    oidc: {
      apiOrigin: 'http://127.0.0.1:3101',
      clientId: 'running-tracker-e2e',
      clientSecret: 'e2e-only-oidc-client-secret',
      providerOrigin: 'http://localhost:9100',
      redirectUri: 'http://127.0.0.1:5274/api/auth/callback',
      sessionTtlMs: 20_000,
      webOrigin: 'http://127.0.0.1:5274',
    },
    ownerDatabaseUrl: owner.url,
    runnerUserId,
    runtimeDatabaseUrl: runtime.url,
    webOrigin: 'http://127.0.0.1:5273',
  };
}

export function loadE2eEnvironment(): E2eEnvironment {
  const envFile = resolve(import.meta.dirname, '..', '..', '..', '.env');

  if (existsSync(envFile)) {
    // process.loadEnvFile never overrides a variable that is already set.
    process.loadEnvFile(envFile);
  }

  return resolveE2eEnvironment(process.env);
}
