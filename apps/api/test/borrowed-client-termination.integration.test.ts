import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';

// A checked-out PostgreSQL client whose backend ends (pg_terminate_backend, a server restart, a TCP reset) must fail the
// operation that holds it, never the process. pg-pool listens for client errors only while a client is idle; the pools
// add a listener for the time a client is borrowed (guardBorrowedClients). The scenarios run in a child process
// (test/support/borrowed-client-termination-driver.ts) against the guarded test database, so an unhandled client
// 'error' shows up as a non-zero exit instead of taking the test runner down.
const apiDirectory = resolve(import.meta.dirname, '..');

interface ScenarioLine {
  errorName: string;
  failed: boolean;
  keptRows?: boolean;
  recovered: boolean;
  scenario: string;
}

function runDriver(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'test/support/borrowed-client-termination-driver.ts'],
      { cwd: apiDirectory, killSignal: 'SIGKILL', timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number | string }).code ?? 1) : 0;
        resolvePromise({ code: typeof code === 'number' ? code : 1, output: `${stdout}${stderr}` });
      },
    );
  });
}

describe('borrowed PostgreSQL clients whose backend is terminated', () => {
  it('fail the operation, keep the process alive and leave the pool usable (query, between statements, journal I/O gap)', async () => {
    expect(new URL(loadIntegrationTestConfiguration().runtime.connectionString).pathname.endsWith('_test')).toBe(true);

    const { code, output } = await runDriver();
    const lines = output
      .split('\n')
      .filter((line) => line.startsWith('{"driver":true'))
      .map((line) => JSON.parse(line) as ScenarioLine & { done?: true });

    expect(output).not.toContain("Unhandled 'error' event");
    expect(code, output).toBe(0);
    expect(lines.at(-1), output).toMatchObject({ done: true });
    const byName = new Map(lines.filter((line) => line.scenario !== undefined).map((line) => [line.scenario, line]));
    expect([...byName.keys()]).toEqual([
      'tenant-during-query',
      'tenant-between-statements',
      'tenant-before-commit',
      'bounded-during-query',
      'journal-export-io-gap',
    ]);
    for (const line of byName.values()) {
      expect(line, line.scenario).toMatchObject({ failed: true, recovered: true });
    }
    // A statement that failed with the connection is rolled back by the server; only a COMMIT that could not be sent or
    // answered is reported as an unknown outcome, as before.
    expect(byName.get('tenant-during-query')?.errorName).not.toBe('TenantTransactionCommitError');
    expect(byName.get('tenant-between-statements')?.errorName).not.toBe('TenantTransactionCommitError');
    expect(byName.get('tenant-before-commit')?.errorName).toBe('TenantTransactionCommitError');
    expect(byName.get('bounded-during-query')?.errorName).toBe('ProbeUnavailableError');
    // The exporter rolled back: the claimed rows stayed for the next cycle, which exported them.
    expect(byName.get('journal-export-io-gap')?.keptRows).toBe(true);
    // Every termination was recorded once by the borrowed-client listener (runtime and maintenance pools).
    const recorded = output.split('\n').filter((line) => line.includes('"database.client.error"'));
    expect(recorded.length).toBeGreaterThanOrEqual(5);
    expect(recorded.some((line) => line.includes('"reason":"maintenance"'))).toBe(true);
    expect(recorded.some((line) => line.includes('"reason":"runtime"'))).toBe(true);
  }, 120_000);
});
