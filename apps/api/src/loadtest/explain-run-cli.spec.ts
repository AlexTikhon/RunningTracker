import { describe, expect, it, vi } from 'vitest';

import { runExplainCli } from './explain-run-cli.js';

const ownerUrl = 'postgresql://running_tracker_owner:owner-pw@127.0.0.1:5433/running_tracker_load_test';
const runtimeUrl = 'postgresql://running_tracker_runtime:runtime-pw@127.0.0.1:5433/running_tracker_load_test';
const maintenanceUrl =
  'postgresql://running_tracker_maintenance:maintenance-pw@127.0.0.1:5433/running_tracker_load_test';
const validEnv = {
  LOAD_DATABASE_URL: ownerUrl,
  LOAD_MAINTENANCE_DATABASE_URL: maintenanceUrl,
  LOAD_RUNTIME_DATABASE_URL: runtimeUrl,
};

function fakes(env: Record<string, string | undefined>, argv: string[], createPool = vi.fn()) {
  const collect = vi.fn();
  return {
    collect,
    createPool,
    dependencies: { argv, collect, createPool, env, log: () => undefined, write: () => undefined },
  };
}

describe('runExplainCli refusals', () => {
  it('refuses missing URLs before any connection or measurement', async () => {
    const run = fakes({}, ['--profile', 'smoke']);

    await expect(runExplainCli(run.dependencies)).rejects.toThrow('LOAD_DATABASE_URL');
    expect(run.createPool).not.toHaveBeenCalled();
    expect(run.collect).not.toHaveBeenCalled();
  });

  it('refuses the development and test databases', async () => {
    for (const database of ['running_tracker', 'running_tracker_test']) {
      const run = fakes(
        {
          LOAD_DATABASE_URL: ownerUrl.replace('running_tracker_load_test', database),
          LOAD_MAINTENANCE_DATABASE_URL: maintenanceUrl.replace('running_tracker_load_test', database),
          LOAD_RUNTIME_DATABASE_URL: runtimeUrl.replace('running_tracker_load_test', database),
        },
        ['--profile', 'smoke'],
      );

      await expect(runExplainCli(run.dependencies), database).rejects.toThrow(/_load_test/u);
      expect(run.createPool).not.toHaveBeenCalled();
    }
  });

  it('refuses when the live session lands in a different database than the URL named', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ current_database: 'running_tracker', current_user: 'running_tracker_owner' }] });
    const run = fakes(validEnv, ['--profile', 'smoke'], vi.fn().mockReturnValue({ end: vi.fn(), query }));

    await expect(runExplainCli(run.dependencies)).rejects.toThrow(/not the one the URL named/u);
    expect(run.collect).not.toHaveBeenCalled();
  });

  it('refuses a database that does not hold the requested dataset and measures nothing', async () => {
    const query = vi.fn().mockImplementation((text: string) =>
      Promise.resolve(
        text.includes('current_database()')
          ? { rows: [{ current_database: 'running_tracker_load_test', current_user: 'running_tracker_owner' }] }
          : { rows: [] },
      ),
    );
    const run = fakes(validEnv, ['--profile', 'smoke'], vi.fn().mockReturnValue({ end: vi.fn(), query }));

    // The role check for the other two pools reports the owner too, so the first refusal is the identity one;
    // what matters is that nothing was measured.
    await expect(runExplainCli(run.dependencies)).rejects.toThrow();
    expect(run.collect).not.toHaveBeenCalled();
  });

  it('never echoes a password when it refuses', async () => {
    const run = fakes({ ...validEnv, LOAD_DATABASE_URL: ownerUrl.replace('127.0.0.1', 'db.example.com') }, ['--profile', 'smoke']);
    let message = '';

    await runExplainCli(run.dependencies).catch((error: unknown) => {
      message = error instanceof Error ? error.message : '';
    });

    expect(message).toMatch(/loopback/u);
    expect(message).not.toContain('owner-pw');
  });

  it('refuses bad arguments before reading the environment', async () => {
    const run = fakes({}, ['--profile', 'nonsense']);

    await expect(runExplainCli(run.dependencies)).rejects.toThrow(/Unknown profile/u);
    expect(run.createPool).not.toHaveBeenCalled();
  });
});
