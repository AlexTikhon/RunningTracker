import { describe, expect, it } from 'vitest';

import { defaultResultsDirectory } from './load-run-arguments.js';
import { parseExplainArguments } from './explain-run-arguments.js';

describe('parseExplainArguments', () => {
  it('requires a profile and applies the defaults for everything else', () => {
    const parsed = parseExplainArguments(['--profile', 'ordinary']);

    expect(parsed.profile.name).toBe('ordinary');
    expect(parsed.repetitions).toBe(5);
    expect(parsed.resultsDir).toBe(defaultResultsDirectory);
    expect(parsed.asOf).toBeUndefined();
    expect(parsed.seed).toBe(42);
  });

  it('accepts a seed, a canonical dataset instant, a repetition count, and a results directory', () => {
    const parsed = parseExplainArguments([
      '--profile', 'stress',
      '--seed', '7',
      '--as-of', '2026-09-30T00:00:00.000Z',
      '--repetitions', '3',
      '--results-dir', 'out',
    ]);

    expect(parsed.seed).toBe(7);
    expect(parsed.asOf?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(parsed.repetitions).toBe(3);
    expect(parsed.resultsDir).toMatch(/out$/u);
  });

  it.each([
    [[], /--profile is required/u],
    [['--profile', 'huge'], /Unknown profile/u],
    [['--profile', 'smoke', '--repetitions', '0'], /--repetitions/u],
    [['--profile', 'smoke', '--repetitions', '51'], /--repetitions/u],
    [['--profile', 'smoke', '--repetitions', '2.5'], /--repetitions/u],
    [['--profile', 'smoke', '--seed', '-1'], /--seed/u],
    [['--profile', 'smoke', '--as-of', 'yesterday'], /--as-of/u],
    [['--profile', 'smoke', '--database-url', 'postgres://x'], /Unknown argument/u],
    [['--profile', 'smoke', '--reset'], /requires a value|Unknown argument/u],
    [['--profile'], /requires a value/u],
  ])('rejects %j', (argv, message) => {
    expect(() => parseExplainArguments(argv)).toThrow(message);
  });
});

describe('parseExplainArguments --keep-plans', () => {
  it('is off by default and is a switch that takes no value', () => {
    expect(parseExplainArguments(['--profile', 'smoke']).keepPlans).toBe(false);
    expect(parseExplainArguments(['--profile', 'smoke', '--keep-plans']).keepPlans).toBe(true);
    expect(parseExplainArguments(['--keep-plans', '--profile', 'smoke']).keepPlans).toBe(true);
  });
});
