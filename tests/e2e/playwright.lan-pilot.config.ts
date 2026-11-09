import { defineConfig } from '@playwright/test';

import { loadLanPilot } from './lan-pilot/pilot-environment.js';

// Desktop Chromium against the RUNNING iPhone LAN pilot (`npm run pilot:e2e`, docs/runbooks/iphone-lan-pilot.md): the
// real HTTPS proxy on its private address, its API and its own database. No server is started here, and nothing in the
// normal suites' databases is touched. This is desktop automation; it does not show that Safari on an iPhone works.
//
// Trust: the pilot authority is not installed anywhere (and must not be, by policy). Chromium is told to accept the one
// pilot server key and nothing else (--ignore-certificate-errors-spki-list, in Playwright's throwaway profile), and the
// test asserts that the certificate it was given was issued by the pilot authority. Full chain, name-constraint and
// address validation is `npm run pilot:verify`'s job (Node's TLS with the pilot authority as the only extra root).
const pilot = loadLanPilot();

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  outputDir: 'test-results/lan-pilot',
  reporter: 'list',
  retries: 0,
  testDir: 'lan-pilot',
  timeout: 180_000,
  use: {
    baseURL: pilot.origin,
    browserName: 'chromium',
    ignoreHTTPSErrors: false,
    launchOptions: {
      args: [
        `--ignore-certificate-errors-spki-list=${pilot.serverSpkiSha256}`,
        // A configured name resolves to the bind address without depending on this computer's mDNS.
        ...(pilot.hostname === null ? [] : [`--host-resolver-rules=MAP ${pilot.hostname} ${pilot.bindAddress}`]),
      ],
    },
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    // A phone-sized viewport (CSS pixels of a 6.1-inch iPhone); still desktop Chromium.
    viewport: { height: 844, width: 390 },
  },
  projects: [{ name: 'lan-pilot-chromium' }],
  workers: 1,
});
