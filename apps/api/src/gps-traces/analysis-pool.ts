import { Pool } from 'pg';

import { loadIntegrationTestConfiguration } from '../config/environment.js';
import { guardBorrowedClients } from '../database/borrowed-client-guard.js';

/**
 * A single-connection pool on the integration test database as the schema owner. The configuration loader refuses
 * any database whose name does not end in `_test`, so the replay can never run against development or production data.
 */
export function createAnalysisPool(): Pool {
  const config = loadIntegrationTestConfiguration();
  return guardBorrowedClients(new Pool({
    application_name: 'running-tracker-gps-trace-analysis',
    connectionString: config.migration.connectionString,
    max: 1,
  }), 'gps-trace-analysis');
}
