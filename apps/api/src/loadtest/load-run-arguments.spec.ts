import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ordinaryProfile, smokeProfile, stressProfile } from './dataset-plan.js';
import { defaultResultsDirectory, parseLoadArguments } from './load-run-arguments.js';
import { defaultSeed } from './seed-dataset-cli.js';

describe('parseLoadArguments', () => {
  it('selects a dataset profile and defaults everything else', () => {
    const parsed = parseLoadArguments(['--profile', 'ordinary']);
    expect(parsed.profile).toBe(ordinaryProfile);
    expect(parsed.seed).toBe(defaultSeed);
    expect(parsed.asOf).toBeUndefined();
    expect(parsed.cleanup).toBe(true);
    expect(parsed.cleanupOnly).toBe(false);
    expect(parsed.resultsDir).toBe(defaultResultsDirectory);
    const normalized = defaultResultsDirectory.replaceAll('\\', '/');
    expect(normalized.endsWith('/.local/load-results')).toBe(true);
    expect(normalized).not.toContain('/apps/api/');
    expect(parseLoadArguments(['--profile', 'stress']).profile).toBe(stressProfile);
    expect(parseLoadArguments(['--profile', 'smoke']).profile).toBe(smokeProfile);
  });

  it('accepts an explicit seed, instant, results directory, and switches in any order', () => {
    const parsed = parseLoadArguments([
      '--no-cleanup',
      '--results-dir',
      'out/here',
      '--as-of',
      '2032-01-01T00:00:00.000Z',
      '--profile',
      'smoke',
      '--seed',
      '7',
    ]);
    expect(parsed).toMatchObject({
      asOf: new Date('2032-01-01T00:00:00.000Z'),
      cleanup: false,
      cleanupOnly: false,
      resultsDir: resolve('out/here'),
      seed: 7,
    });
    expect(parseLoadArguments(['--profile', 'smoke', '--cleanup-only']).cleanupOnly).toBe(true);
  });

  it('rejects malformed input and contradictory switches', () => {
    const invalid: string[][] = [
      [],
      ['--profile'],
      ['--profile', 'toString'],
      ['--profile', 'huge'],
      ['--profile', 'smoke', '--seed', '-1'],
      ['--profile', 'smoke', '--seed', '4294967296'],
      ['--profile', 'smoke', '--as-of', '2032-03-01'],
      ['--profile', 'smoke', '--as-of', 'yesterday'],
      ['--profile', 'smoke', '--bogus', 'x'],
      ['--profile', 'smoke', '--results-dir'],
      ['--profile', 'smoke', '--seed', '--no-cleanup'],
      ['--profile', 'smoke', '--cleanup-only', '--no-cleanup'],
      ['--profile', 'smoke', '--reset'],
      ['--profile', 'smoke', '--url', 'http://example.com'],
    ];
    for (const argv of invalid) {
      expect(() => parseLoadArguments(argv), argv.join(' ')).toThrow();
    }
  });

  it('offers no way to name a URL, a database, or a reseed', () => {
    expect(() => parseLoadArguments(['--profile', 'smoke', '--database-url', 'x'])).toThrow();
    expect(() => parseLoadArguments(['--profile', 'smoke', '--base-url', 'http://x'])).toThrow();
  });
});

describe('parseLoadArguments --no-tiles', () => {
  it('keeps tile bursts on by default and turns them off with a switch that takes no value', () => {
    expect(parseLoadArguments(['--profile', 'ordinary']).tiles).toBe(true);
    expect(parseLoadArguments(['--profile', 'ordinary', '--no-tiles']).tiles).toBe(false);
    expect(parseLoadArguments(['--no-tiles', '--profile', 'stress']).tiles).toBe(false);
  });
});
