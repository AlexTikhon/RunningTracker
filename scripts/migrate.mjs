import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import pg from 'pg';

import { normalizeMigrationSql } from './migration-checksum.mjs';
import { prepareMigrations, validateMigrationHistory } from './migration-history.mjs';

const { Client } = pg;
const useTestDatabase = process.argv.includes('--test');

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const variableName = useTestDatabase ? 'TEST_MIGRATION_DATABASE_URL' : 'MIGRATION_DATABASE_URL';
const databaseUrl = process.env[variableName];

if (!databaseUrl) {
  throw new Error(`${variableName} is required. Copy .env.example to .env or set it explicitly.`);
}

const migrationUrl = new URL(databaseUrl);
if (decodeURIComponent(migrationUrl.username) !== 'running_tracker_owner') {
  throw new Error(`${variableName} must authenticate as running_tracker_owner`);
}

if (useTestDatabase) {
  const databaseName = migrationUrl.pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to run test migrations against non-test database ${databaseName}`);
  }
}

const migrationsDirectory = join(process.cwd(), 'db', 'migrations');

// Bounded waits (milliseconds; 0 disables a bound). The connection and the migration lock are the two places a run
// can wait on something else: a stuck server or another migration run. Neither may wait forever. Migration statements
// themselves are unbounded by default (MIGRATION_STATEMENT_TIMEOUT_MS), since a large data migration may legitimately
// run long.
function bound(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer of milliseconds`);
  return value;
}
const connectTimeoutMs = bound('MIGRATION_CONNECT_TIMEOUT_MS', 10_000);
const lockTimeoutMs = bound('MIGRATION_LOCK_TIMEOUT_MS', 60_000);
const statementTimeoutMs = bound('MIGRATION_STATEMENT_TIMEOUT_MS', 0);

const client = new Client({
  application_name: 'running-tracker-migrations',
  connectionString: databaseUrl,
  connectionTimeoutMillis: connectTimeoutMs,
});

await client.connect();
let locked = false;

try {
  // lock_timeout bounds the advisory lock wait too; it is reset before any migration runs.
  await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('running-tracker:migrations'))");
  } catch (error) {
    if (error?.code === '55P03') {
      throw new Error(
        `Another migration run holds the migration lock; not acquired within ${lockTimeoutMs} ms (MIGRATION_LOCK_TIMEOUT_MS)`,
        { cause: error },
      );
    }
    throw error;
  }
  locked = true;
  await client.query('SET lock_timeout = 0');
  await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const migrations = prepareMigrations(
    await Promise.all(
      migrationFiles.map(async (file) => ({
        file,
        sql: normalizeMigrationSql(await readFile(join(migrationsDirectory, file), 'utf8')),
      })),
    ),
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await client.query(
    'SELECT id, checksum FROM schema_migrations ORDER BY applied_at ASC, id ASC',
  );
  const pending = validateMigrationHistory(migrations, applied.rows);

  for (const { file } of migrations.slice(0, applied.rows.length)) {
    console.log(`skip ${file}`);
  }

  for (const { checksum, file, sql } of pending) {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
      await client.query('COMMIT');
      console.log(`apply ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  try {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('running-tracker:migrations'))");
  } finally {
    // The session ends either way, and ending it releases a session advisory lock that the unlock could not.
    await Promise.race([client.end(), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
  }
}
