import { resolve } from 'node:path';

import type { PlaywrightTestConfig } from '@playwright/test';

import type { E2eEnvironment } from './environment.js';

// Shared by playwright.config.ts (the full suite) and playwright.smoke.config.ts (the pre-demo smoke), so both run
// with the same timeouts, retries, worker count, diagnostics and teardown, and start the API and Vite the same way.

type WebServerConfig = Extract<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>[number];

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');

// Fixed local-only HMAC key, the same fixture value as .env.example. Not valid for any deployment.
export const liveTrackCursorSigningKey = 'cnVubmluZy10cmFja2VyLWxvY2FsLWN1cnNvci1rZXktdjE';

export function suiteSettings(environment: E2eEnvironment) {
  return {
    expect: { timeout: 15_000 },
    fullyParallel: false,
    globalTeardown: './global-teardown.ts',
    reporter: 'list',
    retries: 0,
    testDir: '.',
    timeout: 60_000,
    use: {
      baseURL: environment.webOrigin,
      screenshot: 'only-on-failure',
      trace: 'retain-on-failure',
    },
    workers: 1,
  } satisfies PlaywrightTestConfig;
}

// The development-session API on environment.apiOrigin: a local session endpoint for the suite users and the demo
// people the demo sign-in buttons send (demoScenario creates them), and no identity provider.
export function localSessionApi(
  environment: E2eEnvironment,
  options: {
    // Every web origin that signs in and out through this API.
    readonly allowedOrigins: readonly string[];
    // The run-search interpreter variables, stated by each config rather than inherited from a developer's .env.
    readonly runSearchAi: Readonly<Record<string, string>>;
  },
): WebServerConfig {
  return {
    // The dev script without --watch, so a file change cannot restart the API mid-test.
    command: 'node --import tsx src/entrypoint.ts',
    cwd: resolve(repositoryRoot, 'apps', 'api'),
    env: {
      ALLOWED_ORIGINS: options.allowedOrigins.join(','),
      APP_ENV: 'test',
      DATABASE_URL: environment.runtimeDatabaseUrl,
      LIVE_TRACK_CURSOR_SIGNING_KEY: liveTrackCursorSigningKey,
      LOCAL_AUTH_ENABLED: 'true',
      LOCAL_AUTH_USER_IDS: [
        environment.runnerUserId,
        environment.coachUserId,
        environment.demoRunnerUserId,
        environment.demoCoachUserId,
      ].join(','),
      MAINTENANCE_DATABASE_URL: environment.maintenanceDatabaseUrl,
      PORT: new URL(environment.apiOrigin).port,
      ...options.runSearchAi,
      SESSION_COOKIE_SECURE: 'false',
    },
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    url: `${environment.apiOrigin}/api/health/ready`,
  };
}

// A Vite development server of the web app on `origin`, proxying /api to `apiOrigin`.
export function webApp(origin: string, apiOrigin: string, env: Readonly<Record<string, string>>): WebServerConfig {
  return {
    command: `npx vite --port ${new URL(origin).port}`,
    cwd: resolve(repositoryRoot, 'apps', 'web'),
    env: { API_PROXY_TARGET: apiOrigin, ...env },
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    url: origin,
  };
}
