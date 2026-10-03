import { describe, expect, it } from 'vitest';

import { distribution, edgeStatistics, percentile, sourceCharacteristics, type EdgeResult } from './statistics.js';
import type { SanitizedTrace } from './trace-schema.js';

function trace(points: Array<[elapsedMs: number, xM: number, yM: number, accuracyM?: number]>): SanitizedTrace {
  return {
    points: points.map(([elapsedMs, xM, yM, accuracyM]) => ({
      ...(accuracyM === undefined ? {} : { accuracyM }),
      elapsedMs,
      xM,
      yM,
    })),
    scenario: 'steady_run',
    schemaVersion: 1,
    source: 'synthetic',
  };
}

describe('percentile and distribution', () => {
  it('interpolates linearly between ranks', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([0, 10], 95)).toBeCloseTo(9.5);
  });

  it('summarizes a list, and is null for no values rather than inventing zeros', () => {
    expect(distribution([3, 1, 2])).toEqual({ count: 3, max: 3, median: 2, min: 1, p95: 2.9 });
    expect(distribution([])).toBeNull();
  });
});

describe('source characteristics', () => {
  it('counts points, duration, intervals and the gaps over the evaluator 10 s threshold', () => {
    const source = sourceCharacteristics(
      trace([
        [0, 0, 0, 4],
        [1000, 3, 0, 5],
        [2000, 6, 0, 6],
        [12_000, 36, 0, 40],
        [12_500, 37.5, 0, 12],
        [22_500, 67.5, 0, 8],
      ]),
    );
    expect(source.pointCount).toBe(6);
    expect(source.durationS).toBe(22.5);
    expect(source.intervalS).toEqual({ count: 5, max: 10, median: 1, min: 0.5, p95: 10 });
    // Only an interval strictly over 10 s is a gap: 10 s exactly is still accepted by the evaluator.
    expect(source.gapCount).toBe(0);
    expect(source.maxGapS).toBe(10);
    expect(source.accuracyM).toMatchObject({ max: 40, min: 4 });
    expect(source.accuracyOver10mCount).toBe(2);
    expect(source.accuracyOver30mCount).toBe(1);
    expect(source.planarDistanceM).toBeCloseTo(67.5);
  });

  it('counts a gap when an interval exceeds 10 s', () => {
    const source = sourceCharacteristics(trace([[0, 0, 0], [10_001, 5, 0], [11_001, 8, 0]]));
    expect(source.gapCount).toBe(1);
    expect(source.maxGapS).toBeCloseTo(10.001);
  });

  it('reports no accuracy when the fixture has none', () => {
    const source = sourceCharacteristics(trace([[0, 0, 0], [1000, 3, 0]]));
    expect(source.accuracyM).toBeNull();
    expect(source.accuracyOver10mCount).toBeNull();
    expect(source.accuracyOver30mCount).toBeNull();
  });

  it('counts consecutive identical fixes', () => {
    const source = sourceCharacteristics(trace([[0, 0, 0], [1000, 0, 0], [2000, 0, 0], [3000, 2, 0], [4000, 2, 0]]));
    expect(source.repeatedCoordinateCount).toBe(3);
  });

  it('measures how much longer the full-rate path is than the same track sampled about every 10 s', () => {
    // 1 Hz, moving 1 m/s straight, but jittering 1 m sideways on alternate fixes.
    const noisy = trace(
      Array.from({ length: 31 }, (_, index): [number, number, number] => [index * 1000, index, index % 2 === 0 ? 0 : 1]),
    );
    const smooth = trace(Array.from({ length: 31 }, (_, index): [number, number, number] => [index * 1000, index, 0]));
    expect(sourceCharacteristics(smooth).jitterRatio).toBeCloseTo(1, 6);
    expect(sourceCharacteristics(noisy).jitterRatio).toBeGreaterThan(1.3);
  });

  it('has no jitter ratio for a short or stationary track', () => {
    expect(sourceCharacteristics(trace([[0, 0, 0], [1000, 1, 0], [2000, 2, 0]])).jitterRatio).toBeNull();
    const still = trace(Array.from({ length: 40 }, (_, index): [number, number, number] => [index * 1000, 0, 0]));
    expect(sourceCharacteristics(still).jitterRatio).toBeNull();
  });
});

function edge(distanceM: number, durationS: number, reason: string | null = null): EdgeResult {
  return { accepted: reason === null, distanceM, durationS, rejectionReason: reason };
}

describe('edge statistics', () => {
  it('counts, rates, reasons, speeds and both distance sums, without inventing reasons', () => {
    const stats = edgeStatistics([
      edge(3, 1),
      edge(3, 1),
      edge(30, 1, 'excessive_speed'),
      edge(3, 12, 'excessive_time_gap'),
      edge(4, 1),
    ]);
    expect(stats.edgeCount).toBe(5);
    expect(stats.acceptedCount).toBe(3);
    expect(stats.rejectedCount).toBe(2);
    expect(stats.rejectedPercent).toBe(40);
    expect(stats.rejectionReasons).toEqual({ excessive_speed: 1, excessive_time_gap: 1 });
    expect(stats.acceptedSpeedMps).toEqual({ count: 3, max: 4, median: 3, min: 3, p95: 3.9 });
    expect(stats.rejectedSpeedMps).toMatchObject({ count: 2, max: 30, min: 0.25 });
    expect(stats.maxSpeedMps).toBe(30);
    expect(stats.rawDistanceM).toBe(43);
    expect(stats.acceptedDistanceM).toBe(10);
  });

  it('leaves speed out for an edge with no positive duration, as the evaluator cannot divide by it', () => {
    const stats = edgeStatistics([edge(3, 0, 'nonpositive_time_delta'), edge(3, 1)]);
    expect(stats.rejectedSpeedMps).toBeNull();
    expect(stats.maxSpeedMps).toBe(3);
  });

  it('is well defined with no edges', () => {
    const stats = edgeStatistics([]);
    expect(stats.rejectedPercent).toBe(0);
    expect(stats.maxSpeedMps).toBeNull();
    expect(stats.acceptedSpeedMps).toBeNull();
  });

  it('classifies runs of consecutive excessive-speed edges: isolated, a spike pair, longer', () => {
    const fast = () => edge(30, 1, 'excessive_speed');
    const ok = () => edge(3, 1);
    const stats = edgeStatistics([ok(), fast(), ok(), fast(), fast(), ok(), fast(), fast(), fast(), fast(), ok()]);
    expect(stats.excessiveSpeedRuns).toEqual({ isolated: 1, longer: 1, pair: 1 });
  });

  it('relates the worse endpoint accuracy of an edge to how often it is rejected', () => {
    const accuracies = [4, 5, 8, 15, 25, 35];
    const stats = edgeStatistics(
      [edge(3, 1), edge(3, 1), edge(30, 1, 'excessive_speed'), edge(30, 1, 'excessive_speed'), edge(3, 1, 'poor_accuracy')],
      accuracies,
    );
    expect(stats.accuracyBuckets).toEqual([
      { edges: 1, label: '<= 5 m', rejected: 0 },
      { edges: 1, label: '5-10 m', rejected: 0 },
      { edges: 1, label: '10-20 m', rejected: 1 },
      { edges: 1, label: '20-30 m', rejected: 1 },
      { edges: 1, label: '> 30 m', rejected: 1 },
    ]);
  });

  it('has no accuracy buckets without accuracy', () => {
    expect(edgeStatistics([edge(3, 1)]).accuracyBuckets).toBeNull();
  });
});
