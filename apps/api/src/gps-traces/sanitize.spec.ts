import { describe, expect, it } from 'vitest';

import { geodesicDistanceM } from './geodesy.js';
import { RawTraceError } from './raw-trace.js';
import { sanitizeRawTrace } from './sanitize.js';
import { MAX_POINTS, serializeSanitizedTrace } from './trace-schema.js';
import { FAKE_PRIVATE_ORIGIN, FAKE_PRIVATE_START_MS, rawFromLocal, straightLine } from './test-traces.js';

describe('sanitizing a raw trace', () => {
  const raw = rawFromLocal(straightLine(60, 3, Math.PI / 6, 4.83));

  it('makes the first fix the origin and time relative to it', () => {
    const trace = sanitizeRawTrace(raw, { scenario: 'steady_run' });
    expect(trace.points[0]).toEqual({ accuracyM: 4.83, elapsedMs: 0, xM: 0, yM: 0 });
    expect(trace.points.map((point) => point.elapsedMs)).toEqual(raw.points.map((_, index) => index * 1000));
    expect(trace.schemaVersion).toBe(1);
    expect(trace.source).toBe('real-device-sanitized');
    expect(trace.scenario).toBe('steady_run');
  });

  it('puts east at positive x and north at positive y', () => {
    const trace = sanitizeRawTrace(raw, { scenario: 'steady_run' });
    const last = trace.points[59] as { xM: number; yM: number };
    // 3 m/s on a bearing of 30 degrees for 59 s.
    expect(last.xM).toBeCloseTo(Math.sin(Math.PI / 6) * 3 * 59, 1);
    expect(last.yM).toBeCloseTo(Math.cos(Math.PI / 6) * 3 * 59, 1);
  });

  it('preserves every segment length to within 3 mm, which is the 1 mm rounding of two coordinates', () => {
    const trace = sanitizeRawTrace(raw, { scenario: 'steady_run' });
    for (let index = 1; index < raw.points.length; index += 1) {
      const a = raw.points[index - 1] as (typeof raw.points)[number];
      const b = raw.points[index] as (typeof raw.points)[number];
      const original = geodesicDistanceM(a, b);
      const p = trace.points[index - 1] as { xM: number; yM: number };
      const q = trace.points[index] as { xM: number; yM: number };
      expect(Math.abs(Math.hypot(q.xM - p.xM, q.yM - p.yM) - original)).toBeLessThan(0.003);
    }
  });

  it('keeps a turn, a stop and a timing gap exactly as recorded', () => {
    const trace = sanitizeRawTrace(
      rawFromLocal([
        { elapsedMs: 0, xM: 0, yM: 0 },
        { elapsedMs: 1000, xM: 3, yM: 0 },
        { elapsedMs: 2000, xM: 6, yM: 0 },
        { elapsedMs: 3000, xM: 6, yM: 3 },
        { elapsedMs: 4000, xM: 6, yM: 3 },
        { elapsedMs: 5000, xM: 6, yM: 3 },
        { elapsedMs: 19_500, xM: 20, yM: 3 },
      ]),
      { scenario: 'stop_start' },
    );
    const at = (index: number) => trace.points[index] as { elapsedMs: number; xM: number; yM: number };
    expect(at(2).xM).toBeCloseTo(6, 2);
    expect(at(3).yM).toBeCloseTo(3, 2);
    // A stop keeps repeated coordinates; the sanitizer does not merge or drop them.
    expect([at(3).xM, at(3).yM]).toEqual([at(4).xM, at(4).yM]);
    expect([at(4).xM, at(4).yM]).toEqual([at(5).xM, at(5).yM]);
    // A gap keeps its length: 14.5 s.
    expect(at(6).elapsedMs - at(5).elapsedMs).toBe(14_500);
    expect(at(6).xM).toBeCloseTo(20, 2);
  });

  it('omits accuracy when the source had none', () => {
    const trace = sanitizeRawTrace(rawFromLocal(straightLine(5, 3)), { scenario: 'steady_run' });
    expect(trace.points.every((point) => !('accuracyM' in point))).toBe(true);
  });

  it('carries an independently measured reference distance only when it is given', () => {
    expect(sanitizeRawTrace(raw, { scenario: 'steady_run' })).not.toHaveProperty('referenceDistanceM');
    expect(sanitizeRawTrace(raw, { referenceDistanceM: 175, scenario: 'steady_run' }).referenceDistanceM).toBe(175);
  });

  it('never produces a negative zero', () => {
    const trace = sanitizeRawTrace(rawFromLocal(straightLine(5, 3, 0)), { scenario: 'steady_run' });
    expect(trace.points.some((point) => Object.is(point.xM, -0) || Object.is(point.yM, -0))).toBe(false);
  });

  it('leaves no trace of the private origin or instant in the serialized fixture', () => {
    const text = serializeSanitizedTrace(sanitizeRawTrace(raw, { scenario: 'steady_run' }));
    expect(text).not.toContain(String(FAKE_PRIVATE_ORIGIN.latitude));
    expect(text).not.toContain(String(FAKE_PRIVATE_ORIGIN.longitude));
    expect(text).not.toContain('12.3456');
    expect(text).not.toContain('98.7654');
    expect(text).not.toContain(String(FAKE_PRIVATE_START_MS));
    expect(text).not.toContain(String(FAKE_PRIVATE_START_MS).slice(0, 8));
    expect(text).not.toMatch(/20\d\d-\d\d-\d\d/u);
    expect(text).not.toMatch(/"(?:lat|lon|latitude|longitude|time|timestamp|recordedAt|device\w*|serial\w*|creator|name)"/iu);
  });

  it('rejects a trace that cannot be a fixture, with an actionable message', () => {
    const tooMany = rawFromLocal(straightLine(MAX_POINTS + 1, 0.1));
    expect(() => sanitizeRawTrace(tooMany, { scenario: 'steady_run' })).toThrow(/10000 points.*split/u);
    const tooWide = rawFromLocal([
      { elapsedMs: 0, xM: 0, yM: 0 },
      { elapsedMs: 1000, xM: 60_000, yM: 0 },
    ]);
    expect(() => sanitizeRawTrace(tooWide, { scenario: 'steady_run' })).toThrow(/50000 m/u);
    const polar = {
      points: [
        { latitude: 89, longitude: 0, timeMs: 1_800_000_000_000 },
        { latitude: 89, longitude: 1, timeMs: 1_800_000_001_000 },
      ],
    };
    expect(() => sanitizeRawTrace(polar, { scenario: 'steady_run' })).toThrow(RawTraceError);
  });
});
