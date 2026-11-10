import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvironmentSource, loadIntegrationTestConfiguration } from '../src/config/environment.js';

// F05: the migration runner checks the login and database the server reports, not only the URL. A role switch that the
// URL cannot show (PGOPTIONS='-c role=...', read by node-postgres) makes current_user differ from the URL user; the run
// must stop before the migration lock, schema_migrations or any DDL. Runs the real script against a fresh, empty probe
// database ending in _test, created and dropped here with the bootstrap (administrator) URL of the test database.
const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const probeDatabase = 'running_tracker_identity_probe_test';
const probeRole = 'running_tracker_identity_probe';

function runMigrations(env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [resolve(repositoryRoot, 'scripts', 'migrate.mjs'), '--test'],
      { cwd: repositoryRoot, env: { ...process.env, ...env }, killSignal: 'SIGKILL', timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number | string }).code ?? 1) : 0;
        resolvePromise({ code: typeof code === 'number' ? code : 1, output: `${stdout}${stderr}` });
      },
    );
  });
}

describe('migration runner effective identity', () => {
  let adminUrl: string;
  let probeOwnerUrl: string;

  async function asAdmin<T>(database: string, work: (client: Client) => Promise<T>): Promise<T> {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    const client = new Client({ application_name: 'rt-migration-identity-admin', connectionString: url.toString() });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  const schemaMigrationsExists = () =>
    asAdmin(probeDatabase, async (client) =>
      (await client.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present")).rows[0]!.present,
    );

  async function dropProbe(): Promise<void> {
    await asAdmin('postgres', async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${probeDatabase} WITH (FORCE)`);
      await client.query(`DROP ROLE IF EXISTS ${probeRole}`);
    });
  }

  beforeAll(async () => {
    const { migration } = loadIntegrationTestConfiguration();
    const bootstrap = loadEnvironmentSource().TEST_BOOTSTRAP_DATABASE_URL;
    if (!bootstrap) throw new Error('TEST_BOOTSTRAP_DATABASE_URL is required for this test');
    adminUrl = bootstrap;
    const owner = new URL(migration.connectionString);
    owner.pathname = `/${probeDatabase}`;
    probeOwnerUrl = owner.toString();

    await dropProbe();
    await asAdmin('postgres', async (client) => {
      await client.query(`CREATE DATABASE ${probeDatabase}`);
      await client.query(`GRANT CONNECT ON DATABASE ${probeDatabase} TO running_tracker_owner`);
      // A role the owner may switch to: without the identity check the run would go on as this role.
      await client.query(`CREATE ROLE ${probeRole} NOLOGIN`);
      await client.query(`GRANT ${probeRole} TO running_tracker_owner`);
    });
    // Both may create in the probe's public schema, so only the identity check stands between the switched role and DDL.
    await asAdmin(probeDatabase, (client) => client.query(`GRANT USAGE, CREATE ON SCHEMA public TO running_tracker_owner, ${probeRole}`));
  });

  afterAll(async () => {
    if (adminUrl !== undefined) await dropProbe();
  });

  it('stops before any schema statement when the server reports another login than the URL names', async () => {
    const switched = await runMigrations({ PGOPTIONS: `-c role=${probeRole}`, TEST_MIGRATION_DATABASE_URL: probeOwnerUrl });

    expect(switched.code, switched.output).not.toBe(0);
    expect(switched.output).toContain(
      `TEST_MIGRATION_DATABASE_URL connected as role ${probeRole} to database ${probeDatabase}, not as running_tracker_owner to ${probeDatabase}; nothing was changed`,
    );
    expect(switched.output).not.toMatch(/(apply|skip) \d{4}_/u);
    expect(await schemaMigrationsExists()).toBe(false);
  }, 90_000);

  it('refuses a URL whose query string would connect as another user, before connecting', async () => {
    const overridden = new URL(probeOwnerUrl);
    overridden.searchParams.set('user', 'running_tracker_runtime');
    const result = await runMigrations({ TEST_MIGRATION_DATABASE_URL: overridden.toString() });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('TEST_MIGRATION_DATABASE_URL must not override connection identity in query parameters (user)');
    expect(await schemaMigrationsExists()).toBe(false);
  }, 90_000);

  it('passes the check as the owner itself, and only then creates schema_migrations (control)', async () => {
    // The probe has no PostGIS, so the first migration fails; the identity check and schema_migrations come before it.
    const result = await runMigrations({ TEST_MIGRATION_DATABASE_URL: probeOwnerUrl });

    expect(result.output).not.toContain('nothing was changed');
    expect(await schemaMigrationsExists()).toBe(true);
  }, 90_000);
});
