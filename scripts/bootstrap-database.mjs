import { existsSync } from 'node:fs';
import process from 'node:process';

import pg from 'pg';

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

function requireDatabaseUrl(variableName, expectedUser) {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`${variableName} is required. Copy .env.example to .env or set it explicitly.`);
  }

  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${variableName} must use the postgres or postgresql protocol`);
  }
  if (expectedUser && decodeURIComponent(url.username) !== expectedUser) {
    throw new Error(`${variableName} must authenticate as ${expectedUser}`);
  }
  if (!url.password) {
    throw new Error(`${variableName} must include the role password for bootstrap`);
  }
  if (useTestDatabase && !decodeURIComponent(url.pathname.slice(1)).endsWith('_test')) {
    throw new Error(`${variableName} must target a database ending in _test`);
  }

  return url;
}

const bootstrapUrl = requireDatabaseUrl(names.bootstrap);
const roleUrls = [
  {
    role: 'running_tracker_owner',
    url: requireDatabaseUrl(names.migration, 'running_tracker_owner'),
  },
  {
    role: 'running_tracker_runtime',
    url: requireDatabaseUrl(names.runtime, 'running_tracker_runtime'),
  },
  {
    role: 'running_tracker_maintenance',
    url: requireDatabaseUrl(names.maintenance, 'running_tracker_maintenance'),
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
