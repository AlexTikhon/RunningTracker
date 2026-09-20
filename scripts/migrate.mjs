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

const client = new Client({
  application_name: 'running-tracker-migrations',
  connectionString: databaseUrl,
});

await client.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('running-tracker:migrations'))");
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
  await client.query("SELECT pg_advisory_unlock(hashtext('running-tracker:migrations'))");
  await client.end();
}
