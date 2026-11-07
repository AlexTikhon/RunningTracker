import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';

// The migration runner never waits forever for the migration lock (restore drill reliability, ADR-0076): with the lock
// held by another session it fails after MIGRATION_LOCK_TIMEOUT_MS with a message that names the cause, and it applies
// nothing. Runs the real script against the guarded test database only.
const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');

function runMigrations(env: NodeJS.ProcessEnv): Promise<{ code: number | null; elapsedMs: number; output: string }> {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [resolve(repositoryRoot, 'scripts', 'migrate.mjs'), '--test'],
      { cwd: repositoryRoot, env: { ...process.env, ...env }, timeout: 60_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? null) : 0;
        resolvePromise({ code: typeof code === 'number' ? code : 1, elapsedMs: performance.now() - started, output: `${stdout}${stderr}` });
      },
    );
  });
}

describe('migration runner lock bound', () => {
  it('fails within its lock timeout while another session holds the migration lock, and succeeds once it is free', async () => {
    const { migration } = loadIntegrationTestConfiguration();
    expect(new URL(migration.connectionString).pathname.endsWith('_test')).toBe(true);
    const holder = new Client({ application_name: 'rt-migration-lock-holder', connectionString: migration.connectionString });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('running-tracker:migrations'))");
      const blocked = await runMigrations({ MIGRATION_LOCK_TIMEOUT_MS: '1500' });
      expect(blocked.code).not.toBe(0);
      expect(blocked.output).toContain('Another migration run holds the migration lock; not acquired within 1500 ms');
      expect(blocked.elapsedMs).toBeLessThan(20_000);
      expect(blocked.output).not.toMatch(/apply \d{4}_/u);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext('running-tracker:migrations'))").catch(() => undefined);
      await holder.end();
    }
    const free = await runMigrations({ MIGRATION_LOCK_TIMEOUT_MS: '1500' });
    expect(free.code).toBe(0);
  }, 90_000);
});
