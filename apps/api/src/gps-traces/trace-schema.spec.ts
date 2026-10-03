import { describe, expect, it } from 'vitest';

import {
  MAX_EXTENT_M,
  MAX_POINTS,
  parseSanitizedTrace,
  parseSanitizedTraceText,
  serializeSanitizedTrace,
  TraceValidationError,
  type SanitizedTrace,
} from './trace-schema.js';

function valid(): SanitizedTrace {
  return {
    points: [
      { accuracyM: 4.8, elapsedMs: 0, xM: 0, yM: 0 },
      { accuracyM: 5, elapsedMs: 1000, xM: 3, yM: 0.5 },
      { accuracyM: 4.9, elapsedMs: 2000, xM: 6, yM: 1 },
    ],
    scenario: 'steady_run',
    schemaVersion: 1,
    source: 'real-device-sanitized',
  };
}

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
}

function rejection(candidate: unknown): string {
  try {
    parseSanitizedTrace(candidate);
  } catch (error) {
    expect(error).toBeInstanceOf(TraceValidationError);
    return (error as Error).message;
  }
  throw new Error('The trace was accepted');
}

describe('sanitized GPS trace schema', () => {
  it('accepts a minimal valid trace and returns it unchanged', () => {
    expect(parseSanitizedTrace(valid())).toEqual(valid());
  });

  it('accepts traces without any accuracy and an optional independent reference distance', () => {
    const trace = clone();
    trace.points = [
      { elapsedMs: 0, xM: 0, yM: 0 },
      { elapsedMs: 1000, xM: 3, yM: 0 },
    ];
    trace.referenceDistanceM = 1500;
    expect(parseSanitizedTrace(trace).referenceDistanceM).toBe(1500);
  });

  it('rejects a schema version other than 1 with a message that names it', () => {
    expect(rejection({ ...clone(), schemaVersion: 2 })).toMatch(/schemaVersion 2.*version 1/u);
    expect(rejection({ ...clone(), schemaVersion: undefined })).toMatch(/schemaVersion/u);
    expect(rejection({ ...clone(), schemaVersion: '1' })).toMatch(/schemaVersion/u);
  });

  it('rejects anything that is not an object', () => {
    for (const candidate of [null, [], 'text', 7]) {
      expect(rejection(candidate)).toMatch(/object/u);
    }
  });

  it('rejects unknown top-level and per-point fields, which is how private fields cannot slip in', () => {
    expect(rejection({ ...clone(), deviceId: 'abc' })).toMatch(/deviceId/u);
    expect(rejection({ ...clone(), recordedAt: '2026-01-01T00:00:00Z' })).toMatch(/recordedAt/u);
    const withLatitude = clone();
    (withLatitude.points as Record<string, unknown>[])[1] = { elapsedMs: 1000, latitude: 52.1, xM: 3, yM: 0 };
    expect(rejection(withLatitude)).toMatch(/latitude/u);
  });

  it('rejects an unknown scenario or source', () => {
    expect(rejection({ ...clone(), scenario: 'my_home_run' })).toMatch(/scenario/u);
    expect(rejection({ ...clone(), source: 'garmin' })).toMatch(/source/u);
  });

  it('requires the first point to be the origin at time zero, so no absolute position or time can be stored', () => {
    const shifted = clone();
    (shifted.points as Record<string, number>[])[0] = { elapsedMs: 0, xM: 12, yM: 0 };
    expect(rejection(shifted)).toMatch(/origin/u);
    const late = clone();
    (late.points as Record<string, number>[])[0] = { elapsedMs: 5, xM: 0, yM: 0 };
    expect(rejection(late)).toMatch(/origin/u);
  });

  it('requires strictly increasing integer elapsed times', () => {
    const duplicate = clone();
    (duplicate.points as Record<string, number>[])[2] = { elapsedMs: 1000, xM: 6, yM: 1 };
    expect(rejection(duplicate)).toMatch(/points\[2\].*increase/u);
    const backwards = clone();
    (backwards.points as Record<string, number>[])[2] = { elapsedMs: 500, xM: 6, yM: 1 };
    expect(rejection(backwards)).toMatch(/points\[2\].*increase/u);
    const fractional = clone();
    (fractional.points as Record<string, number>[])[1] = { elapsedMs: 1000.5, xM: 3, yM: 0 };
    expect(rejection(fractional)).toMatch(/elapsedMs/u);
  });

  it('rejects non-finite, missing and out-of-extent coordinates', () => {
    // JSON cannot carry NaN, but an in-memory caller can.
    const nan = clone();
    (nan.points as Record<string, number>[])[1] = { elapsedMs: 1000, xM: Number.NaN, yM: 0 };
    expect(rejection(nan)).toMatch(/xM/u);
    const missing = clone();
    (missing.points as Record<string, number>[])[1] = { elapsedMs: 1000, xM: 3 };
    expect(rejection(missing)).toMatch(/yM/u);
    const far = clone();
    (far.points as Record<string, number>[])[1] = { elapsedMs: 1000, xM: MAX_EXTENT_M + 1, yM: 0 };
    expect(rejection(far)).toMatch(/extent/u);
  });

  it('rejects an empty trace and a single point', () => {
    expect(rejection({ ...clone(), points: [] })).toMatch(/points/u);
    expect(rejection({ ...clone(), points: [{ elapsedMs: 0, xM: 0, yM: 0 }] })).toMatch(/points/u);
  });

  it('rejects more points than the size limit', () => {
    const points = Array.from({ length: MAX_POINTS + 1 }, (_, index) => ({ elapsedMs: index, xM: 0, yM: 0 }));
    expect(rejection({ ...clone(), points })).toMatch(/points/u);
  });

  it('rejects accuracy that is present on some points only, or negative', () => {
    const mixed = clone();
    (mixed.points as Record<string, number>[])[1] = { elapsedMs: 1000, xM: 3, yM: 0 };
    expect(rejection(mixed)).toMatch(/accuracy/u);
    const negative = clone();
    (negative.points as Record<string, number>[])[1] = { accuracyM: -1, elapsedMs: 1000, xM: 3, yM: 0 };
    expect(rejection(negative)).toMatch(/accuracyM/u);
  });

  it('rejects a non-positive reference distance', () => {
    expect(rejection({ ...clone(), referenceDistanceM: 0 })).toMatch(/referenceDistanceM/u);
  });

  it('parses text, and rejects invalid JSON and oversized text without echoing the content', () => {
    expect(parseSanitizedTraceText(serializeSanitizedTrace(valid()))).toEqual(valid());
    expect(() => parseSanitizedTraceText('{"private": "52.123 21.456"')).toThrow(/not valid JSON/u);
    try {
      parseSanitizedTraceText('{"private": "52.123 21.456"');
    } catch (error) {
      expect((error as Error).message).not.toContain('52.123');
    }
    expect(() => parseSanitizedTraceText(' '.repeat(3 * 1024 * 1024))).toThrow(/larger than/u);
  });

  it('serializes canonically: stable key order, one point per line, trailing newline', () => {
    const text = serializeSanitizedTrace(valid());
    expect(text).toBe(
      [
        '{',
        '  "schemaVersion": 1,',
        '  "scenario": "steady_run",',
        '  "source": "real-device-sanitized",',
        '  "points": [',
        '    {"elapsedMs":0,"xM":0,"yM":0,"accuracyM":4.8},',
        '    {"elapsedMs":1000,"xM":3,"yM":0.5,"accuracyM":5},',
        '    {"elapsedMs":2000,"xM":6,"yM":1,"accuracyM":4.9}',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
    expect(serializeSanitizedTrace(parseSanitizedTraceText(text))).toBe(text);
  });
});
