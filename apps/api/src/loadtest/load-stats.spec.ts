import { describe, expect, it } from 'vitest';

import { percentile, summarize } from './load-stats.js';

describe('percentile', () => {
  it('uses the nearest-rank definition on an unsorted copy', () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 0)).toBe(15);
    expect(percentile(values, 100)).toBe(50);
    expect(values).toEqual([15, 20, 35, 40, 50]);
    expect(percentile([9, 1, 5], 50)).toBe(5);
  });

  it('returns the only value for a single sample and rejects empty input or bad ranks', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(() => percentile([], 50)).toThrow();
    expect(() => percentile([1], -1)).toThrow();
    expect(() => percentile([1], 100.5)).toThrow();
  });
});

describe('summarize', () => {
  it('reports count, extremes, mean, and p50/p95/p99', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(summarize(values)).toEqual({
      count: 100,
      max: 100,
      mean: 50.5,
      min: 1,
      p50: 50,
      p95: 95,
      p99: 99,
    });
  });

  it('is null-valued for no samples instead of inventing numbers', () => {
    expect(summarize([])).toEqual({
      count: 0,
      max: null,
      mean: null,
      min: null,
      p50: null,
      p95: null,
      p99: null,
    });
  });
});
