import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import pg from 'pg';

const { Client } = pg;
const useTestDatabase = process.argv.includes('--test');

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const variableName = useTestDatabase ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const databaseUrl = process.env[variableName];

if (!databaseUrl) {
  throw new Error(`${variableName} is required. Copy .env.example to .env or set it explicitly.`);
}

if (useTestDatabase) {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to run test migrations against non-test database ${databaseName}`);
  }
}

const migrationsDirectory = join(process.cwd(), 'db', 'migrations');
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => file.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right));

const client = new Client({
  application_name: 'running-tracker-migrations',
  connectionString: databaseUrl,
});

await client.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('running-tracker:migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await client.query('SELECT id, checksum FROM schema_migrations');
  const checksums = new Map(applied.rows.map((row) => [row.id, row.checksum]));

  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDirectory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previousChecksum = checksums.get(file);

    if (previousChecksum === checksum) {
      console.log(`skip ${file}`);
      continue;
    }

    if (previousChecksum) {
      throw new Error(`Applied migration ${file} has changed`);
    }

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

