import { removeSuiteSessions, removeSuiteUsers } from './support/database.js';
import { loadE2eEnvironment } from './support/environment.js';

// Runs once after the whole suite. Scenario data is removed per test by the scenario fixture; this removes
// the two shared suite users so a full run leaves no rows behind, and every session and pending OIDC login the suite's
// API processes stored in the shared tables (ADR-0080, ADR-0081). Nothing depends on it having run: the next run inserts the users again with
// ON CONFLICT DO NOTHING, and leftover sessions only expire.
export default async function globalTeardown(): Promise<void> {
  const environment = loadE2eEnvironment();
  await removeSuiteUsers(environment);
  await removeSuiteSessions(environment);
}
