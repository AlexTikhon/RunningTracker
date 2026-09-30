import { describe, expect, it, vi } from 'vitest';

import { ordinaryProfile, smokeProfile, stressProfile } from './dataset-plan.js';
import { defaultSeed, parseSeedArguments, runSeedCli } from './seed-dataset-cli.js';

const now = new Date('2032-03-05T17:45:12.345Z');

describe('parseSeedArguments', () => {
  it('selects a named profile and defaults the seed and instant', () => {
    expect(parseSeedArguments(['--profile', 'ordinary'], now)).toEqual({
      asOf: new Date('2032-03-05T00:00:00.000Z'),
      profile: ordinaryProfile,
      reset: false,
      seed: defaultSeed,
    });
    expect(parseSeedArguments(['--profile', 'stress'], now).profile).toBe(stressProfile);
    expect(parseSeedArguments(['--profile', 'smoke'], now).profile).toBe(smokeProfile);
  });

  it('accepts an explicit seed, canonical instant, and reset in any order', () => {
    expect(
      parseSeedArguments(
        ['--reset', '--as-of', '2032-01-01T00:00:00.000Z', '--profile', 'smoke', '--seed', '4294967295'],
        now,
      ),
    ).toEqual({
      asOf: new Date('2032-01-01T00:00:00.000Z'),
      profile: smokeProfile,
      reset: true,
      seed: 4_294_967_295,
    });
  });

  it('rejects malformed input', () => {
    const invalid: string[][] = [
      [],
      ['--profile'],
      ['--profile', 'toString'],
      ['--profile', 'huge'],
      ['--profile', 'smoke', '--seed', '-1'],
      ['--profile', 'smoke', '--seed', '4294967296'],
      ['--profile', 'smoke', '--seed', '1.5'],
      ['--profile', 'smoke', '--as-of', '2032-03-01'],
      ['--profile', 'smoke', '--as-of', 'yesterday'],
      ['--profile', 'smoke', '--bogus', 'x'],
      ['--profile', 'smoke', '--seed', '--reset'],
    ];
    for (const argv of invalid) {
      expect(() => parseSeedArguments(argv, now), argv.join(' ')).toThrow();
    }
  });
});

describe('runSeedCli', () => {
  it('requires LOAD_DATABASE_URL before opening any connection', async () => {
    const createPool = vi.fn();
    await expect(
      runSeedCli({ argv: ['--profile', 'smoke'], createPool, env: {}, now: () => now }),
    ).rejects.toThrow(/LOAD_DATABASE_URL is required/);
    expect(createPool).not.toHaveBeenCalled();
  });

  it('refuses a database that is not a _load_test target and always closes the pool', async () => {
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ database_name: 'running_tracker', role_name: 'running_tracker_owner' }] });
    const createPool = vi.fn(() => ({ connect: vi.fn().mockResolvedValue({ query, release }), end }));

    await expect(
      runSeedCli({
        argv: ['--profile', 'smoke'],
        createPool,
        env: { LOAD_DATABASE_URL: 'postgres://example' },
        log: () => undefined,
        now: () => now,
        write: () => undefined,
      }),
    ).rejects.toThrow(/Refusing to seed database running_tracker/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
