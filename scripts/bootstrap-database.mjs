import { existsSync } from 'node:fs';
import process from 'node:process';

import pg from 'pg';

import { assertConnectedIdentity, parseDatabaseUrl } from './database-url.mjs';

const { Client } = pg;
const useTestDatabase = process.argv.includes('--test');

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const names = useTestDatabase
  ? {
      bootstrap: 'TEST_BOOTSTRAP_DATABASE_URL',
      maintenance: 'TEST_MAINTENANCE_DATABASE_URL',
      migration: 'TEST_MIGRATION_DATABASE_URL',
      runtime: 'TEST_DATABASE_URL',
    }
  : {
      bootstrap: 'BOOTSTRAP_DATABASE_URL',
      maintenance: 'MAINTENANCE_DATABASE_URL',
      migration: 'MIGRATION_DATABASE_URL',
      runtime: 'DATABASE_URL',
    };

// The same checks as the migration runner and the API parser: the role URLs name the logins whose passwords are set
// here, so a URL whose query parameters would point pg elsewhere is refused rather than half-trusted.
function requireDatabaseUrl(variableName, expectedUser) {
  return parseDatabaseUrl(process.env[variableName], variableName, {
    expectedUser,
    requirePassword: true,
    requireTestDatabase: useTestDatabase,
  });
}

const bootstrap = requireDatabaseUrl(names.bootstrap);
const bootstrapUrl = bootstrap.url;
const roleUrls = [
  {
    role: 'running_tracker_owner',
    url: requireDatabaseUrl(names.migration, 'running_tracker_owner').url,
  },
  {
    role: 'running_tracker_runtime',
    url: requireDatabaseUrl(names.runtime, 'running_tracker_runtime').url,
  },
  {
    role: 'running_tracker_maintenance',
    url: requireDatabaseUrl(names.maintenance, 'running_tracker_maintenance').url,
  },
];
const databaseName = decodeURIComponent(bootstrapUrl.pathname.slice(1));

for (const { url } of roleUrls) {
  if (decodeURIComponent(url.pathname.slice(1)) !== databaseName) {
    throw new Error('Bootstrap, migration, runtime, and maintenance URLs must target one database');
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function createOrUpdateRole(client, role, password) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN`);
  }

  const passwordStatement = await client.query(
    "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
    [role, password],
  );
  await client.query(passwordStatement.rows[0].sql);
  await client.query(
    `ALTER ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
}

const client = new Client({
  application_name: 'running-tracker-bootstrap',
  connectionString: bootstrapUrl.toString(),
});

await client.connect();

try {
  // Grants and role passwords go to the database the URL names, through the login it names.
  await assertConnectedIdentity(client, { database: databaseName, user: bootstrap.user }, names.bootstrap);
  for (const { role, url } of roleUrls) {
    await createOrUpdateRole(client, role, decodeURIComponent(url.password));
  }

  await client.query('CREATE EXTENSION IF NOT EXISTS postgis');

  const database = quoteIdentifier(databaseName);
  await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await client.query(
    `GRANT CONNECT ON DATABASE ${database} TO running_tracker_owner, running_tracker_runtime, running_tracker_maintenance`,
  );
  await client.query(`GRANT CREATE, TEMPORARY ON DATABASE ${database} TO running_tracker_owner`);

  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query(
    'REVOKE CREATE ON SCHEMA public FROM running_tracker_runtime, running_tracker_maintenance',
  );
  await client.query('ALTER SCHEMA public OWNER TO running_tracker_owner');
  await client.query('GRANT USAGE, CREATE ON SCHEMA public TO running_tracker_owner');
  await client.query('GRANT USAGE ON SCHEMA public TO running_tracker_runtime');

  const migrationsTable = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
  if (migrationsTable.rows[0].name) {
    await client.query('ALTER TABLE public.schema_migrations OWNER TO running_tracker_owner');
    await client.query(
      'REVOKE ALL ON TABLE public.schema_migrations FROM running_tracker_runtime, running_tracker_maintenance',
    );
  }

  console.log(`bootstrapped roles and PostGIS in ${databaseName}`);
} finally {
  await client.end();
}
