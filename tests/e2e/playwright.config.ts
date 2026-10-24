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

// Shaped like a public Mapbox token so the runtime accepts it; it belongs to no account.
const mapPlaceholderToken = 'pk.e2e-local-placeholder';

// The bounded Firefox gate: the core recording, recovery, authorization and sharing specs, reused unchanged. Only
// these files run in Firefox; the rest of the suite stays Chromium-only. The real-runtime map smoke is tagged and
// excluded, so Firefox runs the fake-runtime map lifecycle but not WebGL.
const firefoxCoreSpecs =
  /[\\/](record|reload-offline|second-tab|gps-recovery|run-sharing|archive-sharing|coach-map)\.spec\.ts$/;

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
    // Run on its own (`npm run test:e2e:firefox`); `npm run test:e2e` selects only the two Chromium projects, so a
    // machine without Firefox installed never launches it.
    {
      grepInvert: /@real-map-runtime/,
      name: 'firefox-core',
      testMatch: firefoxCoreSpecs,
      use: { browserName: 'firefox' },
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
        // The map and demo origins sign in and out through the same API.
        ALLOWED_ORIGINS: `${environment.webOrigin},${environment.mapWebOrigin},${environment.demoWebOrigin}`,
        APP_ENV: 'test',
        DATABASE_URL: environment.runtimeDatabaseUrl,
        LIVE_TRACK_CURSOR_SIGNING_KEY: liveTrackCursorSigningKey,
        LOCAL_AUTH_ENABLED: 'true',
        // The suite users, and the demo people the demo sign-in buttons send (demoScenario creates them).
        LOCAL_AUTH_USER_IDS: [
          environment.runnerUserId,
          environment.coachUserId,
          environment.demoRunnerUserId,
          environment.demoCoachUserId,
        ].join(','),
        MAINTENANCE_DATABASE_URL: environment.maintenanceDatabaseUrl,
        PORT: apiPort,
        // The in-process deterministic interpreter: describing a search in words works with no provider and no
        // network. The real provider is never configured here (APP_ENV=test refuses nothing, so keep it explicit).
        RUN_SEARCH_AI_ENABLED: 'true',
        RUN_SEARCH_AI_PROVIDER: 'fake',
        RUN_SEARCH_AI_USER_RATE_PER_MINUTE: '60',
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
      // Explicitly off, whatever a developer's .env says: this is the ordinary `npm run dev` page.
      env: { API_PROXY_TARGET: environment.apiOrigin, VITE_LOCAL_DEMO_ENABLED: 'false' },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: environment.webOrigin,
    },
    {
      // The same app with a placeholder public Mapbox token, for the Coach map tests. The token is not valid for
      // any provider account; those tests answer or abort every provider request in the browser.
      command: `npx vite --port ${new URL(environment.mapWebOrigin).port}`,
      cwd: resolve(repositoryRoot, 'apps', 'web'),
      env: { API_PROXY_TARGET: environment.apiOrigin, VITE_MAPBOX_ACCESS_TOKEN: mapPlaceholderToken },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: environment.mapWebOrigin,
    },
    {
      // The same app as `npm run demo:up` serves it: a dev server with the demo sign-in buttons turned on.
      command: `npx vite --port ${new URL(environment.demoWebOrigin).port}`,
      cwd: resolve(repositoryRoot, 'apps', 'web'),
      env: { API_PROXY_TARGET: environment.apiOrigin, VITE_LOCAL_DEMO_ENABLED: 'true' },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: environment.demoWebOrigin,
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
      env: { API_PROXY_TARGET: oidc.apiOrigin, VITE_LOCAL_DEMO_ENABLED: 'false' },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: oidc.webOrigin,
    },
  ],
  workers: 1,
});
