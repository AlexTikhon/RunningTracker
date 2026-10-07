import { test as base } from '@playwright/test';

import {
  createExtraOrganization,
  createOutsider,
  createScenarioData,
  removeExtraOrganizations,
  removeScenarioData,
} from './database.js';
import type { ScenarioData } from './database.js';
import { loadE2eEnvironment } from './environment.js';
import type { E2eEnvironment } from './environment.js';

// Further organizations for one test, removed with it. Memberships are exact: a suite user is a member only of
// the organizations a test asks for.
interface OrganizationFactory {
  // An organization the user is not a member of: only a throwaway outsider is.
  foreign(): Promise<string>;
  // An organization in which the user's membership was deactivated.
  inactiveFor(userId: string): Promise<string>;
  // A further organization in which the user is an active member.
  memberOf(userId: string): Promise<string>;
}

interface E2eFixtures {
  readonly environment: E2eEnvironment;
  // A fresh organization with an active runner and coach. Removed after the test whether it passed,
  // failed or timed out: Playwright runs fixture teardown in every case.
  readonly scenario: ScenarioData;
  readonly organizations: OrganizationFactory;
}

export const test = base.extend<E2eFixtures>({
  // eslint-disable-next-line no-empty-pattern
  environment: async ({}, use) => {
    await use(loadE2eEnvironment());
  },

  organizations: async ({ environment, scenario }, use) => {
    // The scenario fixture is listed so it is created first and torn down last.
    void scenario;
    const organizationIds: string[] = [];
    const outsiderUserIds: string[] = [];
    try {
      await use({
        async foreign() {
          const outsider = await createOutsider(environment);
          outsiderUserIds.push(outsider);
          const orgId = await createExtraOrganization(environment, [{ active: true, userId: outsider }]);
          organizationIds.push(orgId);
          return orgId;
        },
        async inactiveFor(userId) {
          const orgId = await createExtraOrganization(environment, [{ active: false, userId }]);
          organizationIds.push(orgId);
          return orgId;
        },
        async memberOf(userId) {
          const orgId = await createExtraOrganization(environment, [{ active: true, userId }]);
          organizationIds.push(orgId);
          return orgId;
        },
      });
    } finally {
      await removeExtraOrganizations(environment, { organizationIds, outsiderUserIds });
    }
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
