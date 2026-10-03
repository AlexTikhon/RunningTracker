import { describe, expect, it } from 'vitest';

import { RawTraceError, validateRawTrace, type RawPoint } from './raw-trace.js';

function point(index: number, overrides: Partial<RawPoint> = {}): RawPoint {
  return { latitude: 10 + index * 1e-5, longitude: 20, timeMs: 1_000_000 + index * 1000, ...overrides };
}

function rejection(points: RawPoint[]): string {
  try {
    validateRawTrace(points);
  } catch (error) {
    expect(error).toBeInstanceOf(RawTraceError);
    return (error as Error).message;
  }
  throw new Error('The trace was accepted');
}

describe('raw trace validation', () => {
  it('accepts an ordered trace with valid coordinates', () => {
    expect(() => validateRawTrace([point(0), point(1), point(2)])).not.toThrow();
  });

  it('rejects an empty trace and a single point', () => {
    expect(rejection([])).toMatch(/at least 2/u);
    expect(rejection([point(0)])).toMatch(/at least 2/u);
  });

  it('rejects non-finite values, which a hand-built input can carry', () => {
    expect(rejection([point(0, { latitude: Number.NaN }), point(1)])).toMatch(/point #1.*latitude/u);
    expect(rejection([point(0), point(1, { longitude: Number.POSITIVE_INFINITY })])).toMatch(/point #2.*longitude/u);
    expect(rejection([point(0), point(1, { timeMs: Number.NaN })])).toMatch(/point #2.*time/u);
    expect(rejection([point(0), point(1, { accuracyM: Number.NaN })])).toMatch(/point #2.*accuracy/u);
  });

  it('rejects non-increasing time with the offending indices and no values', () => {
    expect(rejection([point(0), point(1, { timeMs: point(0).timeMs })])).toMatch(/point #2.*same time.*point #1/u);
    expect(rejection([point(0), point(1), point(2, { timeMs: point(0).timeMs - 5 })])).toMatch(/point #3.*before.*point #2/u);
  });

  it('rejects an absurd number of points before they are processed', () => {
    const many = Array.from({ length: 500_001 }, (_, index) => point(index));
    expect(rejection(many)).toMatch(/500000/u);
  });
});
