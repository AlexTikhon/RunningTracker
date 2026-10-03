import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

import { loadE2eEnvironment } from './support/environment.js';

// Throws before any server starts when the test database variables are missing or point elsewhere,
// so a wrong database never reaches the API process.
const environment = loadE2eEnvironment();

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const apiPort = new URL(environment.apiOrigin).port;
const webPort = new URL(environment.webOrigin).port;

// Fixed local-only HMAC key, the same fixture value as .env.example. Not valid for any deployment.
const liveTrackCursorSigningKey = 'cnVubmluZy10cmFja2VyLWxvY2FsLWN1cnNvci1rZXktdjE';

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  globalTeardown: './global-teardown.ts',
  outputDir: 'test-results',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  reporter: 'list',
  retries: 0,
  testDir: '.',
  timeout: 60_000,
  use: {
    baseURL: environment.webOrigin,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // The dev script without --watch, so a file change cannot restart the API mid-test.
      command: 'node --import tsx src/entrypoint.ts',
      cwd: resolve(repositoryRoot, 'apps', 'api'),
      env: {
        ALLOWED_ORIGINS: environment.webOrigin,
        APP_ENV: 'test',
        DATABASE_URL: environment.runtimeDatabaseUrl,
        LIVE_TRACK_CURSOR_SIGNING_KEY: liveTrackCursorSigningKey,
        LOCAL_AUTH_ENABLED: 'true',
        LOCAL_AUTH_USER_IDS: `${environment.runnerUserId},${environment.coachUserId}`,
        MAINTENANCE_DATABASE_URL: environment.maintenanceDatabaseUrl,
        PORT: apiPort,
        SESSION_COOKIE_SECURE: 'false',
      },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: `${environment.apiOrigin}/api/health/ready`,
    },
    {
      command: `npx vite --port ${webPort}`,
      cwd: resolve(repositoryRoot, 'apps', 'web'),
      env: { API_PROXY_TARGET: environment.apiOrigin },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: environment.webOrigin,
    },
  ],
  workers: 1,
});
