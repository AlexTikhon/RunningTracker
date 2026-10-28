import { defineConfig } from '@playwright/test';

import { loadE2eEnvironment } from './support/environment.js';
import { localSessionApi, suiteSettings, webApp } from './support/suite-config.js';

// The pre-demo smoke (`npm run test:e2e:smoke`, `npm run test:e2e:smoke:firefox`): existing specs for the demo
// story, reused unchanged with the full suite's settings, against only the servers they use. No identity provider,
// no OpenID Connect API or web server, no map server. Run `support/smoke-preflight.ts` first (the npm scripts do),
// so a missing browser, an occupied port or an unreachable database is reported before anything starts.

// Throws before any server starts when the test database variables are missing or point elsewhere,
// so a wrong database never reaches the API process.
const environment = loadE2eEnvironment();

// Demo sign-in, the demo's two-minute simulator, recording, reload and offline recovery, the second tab, live
// sharing, sharing from My runs and deleting a run from My runs.
const smokeSpecs =
  /[\\/](demo-sign-in|demo-simulator|record|reload-offline|second-tab|run-sharing|archive-sharing|run-deletion)\.spec\.ts$/;

// Neither the run-search interpreter nor a Mapbox token is used by these specs, and none is passed on from a
// developer's .env: the API has the interpreter off, and both pages have no token (the tokenless map notice).
const noMapToken = { VITE_MAPBOX_ACCESS_TOKEN: '' };

export default defineConfig({
  ...suiteSettings(environment),
  projects: [
    // Separate from test-results/ so a smoke run neither removes nor mixes with the full suite's results.
    {
      name: 'smoke-chromium',
      outputDir: 'smoke-results/chromium',
      testIgnore: /[\\/]oidc[\\/]/,
      testMatch: smokeSpecs,
      use: { browserName: 'chromium' },
    },
    {
      name: 'smoke-firefox',
      outputDir: 'smoke-results/firefox',
      testIgnore: /[\\/]oidc[\\/]/,
      testMatch: smokeSpecs,
      use: { browserName: 'firefox' },
    },
  ],
  webServer: [
    localSessionApi(environment, {
      allowedOrigins: [environment.webOrigin, environment.demoWebOrigin],
      runSearchAi: { RUN_SEARCH_AI_ENABLED: 'false' },
    }),
    // The ordinary `npm run dev` page, for the test that the demo buttons are absent without the flag.
    webApp(environment.webOrigin, environment.apiOrigin, { ...noMapToken, VITE_LOCAL_DEMO_ENABLED: 'false' }),
    // The page as `npm run demo:up` serves it, with the demo sign-in buttons.
    webApp(environment.demoWebOrigin, environment.apiOrigin, { ...noMapToken, VITE_LOCAL_DEMO_ENABLED: 'true' }),
  ],
});
