import { test as base } from '@playwright/test';

import { createScenarioData, removeScenarioData } from './database.js';
import type { ScenarioData } from './database.js';
import { loadE2eEnvironment } from './environment.js';
import type { E2eEnvironment } from './environment.js';

interface E2eFixtures {
  readonly environment: E2eEnvironment;
  // A fresh organization with an active runner and coach. Removed after the test whether it passed,
  // failed or timed out: Playwright runs fixture teardown in every case.
  readonly scenario: ScenarioData;
}

export const test = base.extend<E2eFixtures>({
  // eslint-disable-next-line no-empty-pattern
  environment: async ({}, use) => {
    await use(loadE2eEnvironment());
  },

  scenario: async ({ environment }, use) => {
    const data = await createScenarioData(environment);
    try {
      await use(data);
    } finally {
      await removeScenarioData(environment, data);
    }
  },
});

export { expect } from '@playwright/test';
