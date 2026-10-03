import { pointInputSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { geodesicDistanceM } from './geodesy.js';
import {
  ASSUMED_ACCURACY_M,
  REPLAY_ANCHOR,
  REPLAY_EPOCH_MS,
  anchorTrace,
} from './replay.js';
import { sanitizeRawTrace } from './sanitize.js';
import { FAKE_PRIVATE_ORIGIN, rawFromLocal, straightLine } from './test-traces.js';

describe('re-anchoring a sanitized trace for replay', () => {
  const raw = rawFromLocal([
    ...straightLine(30, 3, Math.PI / 3, 5),
    // a right-angle turn, a stop and a 14.5 s signal gap
    ...[0, 1, 2].map((index) => ({ accuracyM: 5, elapsedMs: 30_000 + index * 1000, xM: 87 - index * 0.0, yM: 51 + index * 3 })),
    { accuracyM: 5, elapsedMs: 33_000, xM: 87, yM: 60 },
    { accuracyM: 5, elapsedMs: 34_000, xM: 87, yM: 60 },
    { accuracyM: 5, elapsedMs: 48_500, xM: 120, yM: 60 },
  ]);
  const trace = sanitizeRawTrace(raw, { scenario: 'stop_start' });

  it('uses the documented public anchor, not the private origin', () => {
    const points = anchorTrace(trace);
    expect(REPLAY_ANCHOR).toEqual({ latitude: 50, longitude: 10 });
    expect(points[0]?.latitude).toBeCloseTo(50, 8);
    expect(points[0]?.longitude).toBeCloseTo(10, 8);
    expect(geodesicDistanceM(points[0] as { latitude: number; longitude: number }, FAKE_PRIVATE_ORIGIN)).toBeGreaterThan(1_000_000);
  });

  it('maps elapsed time onto a fixed epoch and numbers the points from 1 in one segment', () => {
    const points = anchorTrace(trace);
    expect(points[0]).toMatchObject({ recordedAt: new Date(REPLAY_EPOCH_MS).toISOString(), segmentId: 0, seq: '1' });
    expect(points.map((point) => Date.parse(point.recordedAt) - REPLAY_EPOCH_MS)).toEqual(
      trace.points.map((point) => point.elapsedMs),
    );
    expect(points.map((point) => point.seq)).toEqual(trace.points.map((_, index) => String(index + 1)));
  });

  it('is deterministic: the same fixture always gives the same points', () => {
    expect(anchorTrace(trace)).toEqual(anchorTrace(trace));
  });

  it('produces points that satisfy the production point contract', () => {
    for (const point of anchorTrace(trace)) {
      expect(() => pointInputSchema.parse(point)).not.toThrow();
    }
  });

  it('preserves every segment length of the original within 4 mm', () => {
    const points = anchorTrace(trace);
    for (let index = 1; index < raw.points.length; index += 1) {
      const original = geodesicDistanceM(
        raw.points[index - 1] as { latitude: number; longitude: number },
        raw.points[index] as { latitude: number; longitude: number },
      );
      const replayed = geodesicDistanceM(
        points[index - 1] as { latitude: number; longitude: number },
        points[index] as { latitude: number; longitude: number },
      );
      expect(Math.abs(replayed - original), `segment ${String(index)}`).toBeLessThan(0.004);
    }
  });

  it('preserves derived speeds, so the speed rule sees what the device recorded', () => {
    const points = anchorTrace(trace);
    for (let index = 1; index < raw.points.length; index += 1) {
      const dt = ((raw.points[index]?.timeMs ?? 0) - (raw.points[index - 1]?.timeMs ?? 0)) / 1000;
      const original =
        geodesicDistanceM(
          raw.points[index - 1] as { latitude: number; longitude: number },
          raw.points[index] as { latitude: number; longitude: number },
        ) / dt;
      const replayed =
        geodesicDistanceM(
          points[index - 1] as { latitude: number; longitude: number },
          points[index] as { latitude: number; longitude: number },
        ) / dt;
      expect(Math.abs(replayed - original)).toBeLessThan(0.004 / dt + 1e-9);
    }
  });

  it('uses the documented assumed accuracy when the fixture has none, and says so', () => {
    const bare = sanitizeRawTrace(rawFromLocal(straightLine(5, 3)), { scenario: 'steady_run' });
    expect(anchorTrace(bare).every((point) => point.accuracyM === ASSUMED_ACCURACY_M)).toBe(true);
    expect(ASSUMED_ACCURACY_M).toBe(5);
    expect(anchorTrace(trace).every((point) => point.accuracyM === 5)).toBe(true);
  });
});
