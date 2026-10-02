import { removeSuiteUsers } from './support/database.js';
import { loadE2eEnvironment } from './support/environment.js';

// Runs once after the whole suite. Scenario data is removed per test by the scenario fixture; this removes
// the two shared suite users so a full run leaves no rows behind. Nothing depends on it having run: the
// next run inserts the users again with ON CONFLICT DO NOTHING.
export default async function globalTeardown(): Promise<void> {
  await removeSuiteUsers(loadE2eEnvironment());
}
