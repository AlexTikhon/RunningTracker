import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

import { loadE2eEnvironment } from './support/environment.js';

// Throws before any server starts when the test database variables are missing or point elsewhere,
// so a wrong database never reaches the API process.
const environment = loadE2eEnvironment();

const { oidc } = environment;
const repositoryRoot =resolve(import.meta.dirname, '..', '..');
const apiPort = new URL(environment.apiOrigin).port;
const webPort = new URL(environment.webOrigin).port;

// Fixed local-only HMAC key, the same fixture value as .env.example. Not valid for any deployment.
const liveTrackCursorSigningKey = 'cnVubmluZy10cmFja2VyLWxvY2FsLWN1cnNvci1rZXktdjE';

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  globalTeardown: './global-teardown.ts',
  outputDir: 'test-results',
  projects: [
    // The development-session stack (a local session endpoint, no identity provider).
    { name: 'chromium', testIgnore: /[\\/]oidc[\\/]/, use: { browserName: 'chromium' } },
    // The OpenID Connect stack: the same sign-in route production has, against a real provider process.
    {
      name: 'chromium-oidc',
      testMatch: /[\\/]oidc[\\/].*\.spec\.ts$/,
      use: { baseURL: environment.oidc.webOrigin, browserName: 'chromium' },
    },
  ],
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
    {
      // OpenID Connect stack. The provider (oidc-provider with its development login pages) ...
      command: 'node --import tsx support/oidc-provider-server.ts',
      cwd: import.meta.dirname,
      env: {
        OIDC_E2E_CLIENT_ID: oidc.clientId,
        OIDC_E2E_CLIENT_SECRET: oidc.clientSecret,
        OIDC_E2E_ISSUER: oidc.providerOrigin,
        OIDC_E2E_REDIRECT_URI: oidc.redirectUri,
      },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: `${oidc.providerOrigin}/.well-known/openid-configuration`,
    },
    {
      // ... the API with OIDC and no local session endpoint, which is what production has ...
      command: 'node --import tsx src/entrypoint.ts',
      cwd: resolve(repositoryRoot, 'apps', 'api'),
      env: {
        ALLOWED_ORIGINS: oidc.webOrigin,
        APP_ENV: 'test',
        DATABASE_URL: environment.runtimeDatabaseUrl,
        LIVE_TRACK_CURSOR_SIGNING_KEY: liveTrackCursorSigningKey,
        MAINTENANCE_DATABASE_URL: environment.maintenanceDatabaseUrl,
        OIDC_CLIENT_ID: oidc.clientId,
        OIDC_CLIENT_SECRET: oidc.clientSecret,
        OIDC_ISSUER_URL: oidc.providerOrigin,
        OIDC_REDIRECT_URI: oidc.redirectUri,
        PORT: new URL(oidc.apiOrigin).port,
        // The production default. Chromium stores a Secure cookie for a loopback origin over plain http.
        SESSION_COOKIE_SECURE: 'true',
        SESSION_TTL_MS: String(oidc.sessionTtlMs),
      },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: `${oidc.apiOrigin}/api/health/ready`,
    },
    {
      // ... and the web app on its own origin.
      command: `npx vite --port ${new URL(oidc.webOrigin).port}`,
      cwd: resolve(repositoryRoot, 'apps', 'web'),
      env: { API_PROXY_TARGET: oidc.apiOrigin },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: oidc.webOrigin,
    },
  ],
  workers: 1,
});
