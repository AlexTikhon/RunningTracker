import { Pool } from 'pg';

import { loadIntegrationTestConfiguration } from '../config/environment.js';

/**
 * A single-connection pool on the integration test database as the schema owner. The configuration loader refuses
 * any database whose name does not end in `_test`, so the replay can never run against development or production data.
 */
export function createAnalysisPool(): Pool {
  const config = loadIntegrationTestConfiguration();
  return new Pool({
    application_name: 'running-tracker-gps-trace-analysis',
    connectionString: config.migration.connectionString,
    max: 1,
  });
}
