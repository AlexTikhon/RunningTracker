import { describe, expect, it, vi } from 'vitest';

import { runLoadCli } from './load-run-cli.js';

const ownerUrl = 'postgresql://running_tracker_owner:owner-pw@127.0.0.1:5433/running_tracker_load_test';
const runtimeUrl = 'postgresql://running_tracker_runtime:runtime-pw@127.0.0.1:5433/running_tracker_load_test';
const maintenanceUrl =
  'postgresql://running_tracker_maintenance:maintenance-pw@127.0.0.1:5433/running_tracker_load_test';

function dependencies(env: Record<string, string | undefined>, argv: string[]) {
  const createPool = vi.fn();
  const startApi = vi.fn();
  const runScenario = vi.fn();
  return {
    createPool,
    dependencies: {
      argv,
      createPool,
      env,
      log: () => undefined,
      runScenario,
      startApi,
      write: () => undefined,
    },
    runScenario,
    startApi,
  };
}

describe('runLoadCli target refusal', () => {
  it('refuses missing URLs before any connection, process, or scenario starts', async () => {
    const fakes = dependencies({}, ['--profile', 'smoke']);
    await expect(runLoadCli(fakes.dependencies)).rejects.toThrow('LOAD_DATABASE_URL');
    expect(fakes.createPool).not.toHaveBeenCalled();
    expect(fakes.startApi).not.toHaveBeenCalled();
    expect(fakes.runScenario).not.toHaveBeenCalled();
  });

  it('refuses the development and test databases', async () => {
    for (const database of ['running_tracker', 'running_tracker_test']) {
      const fakes = dependencies(
        {
          LOAD_DATABASE_URL: ownerUrl.replace('running_tracker_load_test', database),
          LOAD_MAINTENANCE_DATABASE_URL: maintenanceUrl.replace('running_tracker_load_test', database),
          LOAD_RUNTIME_DATABASE_URL: runtimeUrl.replace('running_tracker_load_test', database),
        },
        ['--profile', 'smoke'],
      );
      await expect(runLoadCli(fakes.dependencies), database).rejects.toThrow(/_load_test/u);
      expect(fakes.createPool).not.toHaveBeenCalled();
      expect(fakes.startApi).not.toHaveBeenCalled();
    }
  });

  it('refuses a remote host and never echoes a password', async () => {
    const fakes = dependencies(
      {
        LOAD_DATABASE_URL: ownerUrl.replace('127.0.0.1', 'db.example.com'),
        LOAD_MAINTENANCE_DATABASE_URL: maintenanceUrl,
        LOAD_RUNTIME_DATABASE_URL: runtimeUrl,
      },
      ['--profile', 'smoke'],
    );
    let message = '';
    await runLoadCli(fakes.dependencies).catch((error: unknown) => {
      message = error instanceof Error ? error.message : '';
    });
    expect(message).toMatch(/loopback/u);
    expect(message).not.toContain('owner-pw');
    expect(fakes.createPool).not.toHaveBeenCalled();
  });

  it('refuses bad arguments before reading the environment', async () => {
    const fakes = dependencies({}, ['--profile', 'nonsense']);
    await expect(runLoadCli(fakes.dependencies)).rejects.toThrow(/Unknown profile/u);
    expect(fakes.createPool).not.toHaveBeenCalled();
  });
});
