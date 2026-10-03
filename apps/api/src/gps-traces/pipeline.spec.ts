import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadFixtureFile } from './fixtures.js';
import { geodesicDistanceM } from './geodesy.js';
import { parseGpx } from './gpx.js';
import { RawTraceError } from './raw-trace.js';
import { anchorTrace, REPLAY_EPOCH_MS } from './replay.js';
import { sanitizeRawTrace } from './sanitize.js';
import { sourceCharacteristics } from './statistics.js';
import { serializeSanitizedTrace, TraceValidationError } from './trace-schema.js';
import { gpxFromRaw, rawFromLocal, straightLine, type Waypoint } from './test-traces.js';

// raw GPX -> parse -> sanitize -> write -> read -> re-anchor, checked against the raw points as the sanitizer saw
// them. Tolerance: a coordinate is rounded to 1 mm, so a segment length moves by at most 2 * 0.71 mm; replay rounds
// to about 0.1 mm and the local frame adds under 1e-6 relative. 2 mm + 1e-6 of the length therefore bounds the error.

const lengthTolerance = (lengthM: number) => 0.002 + 1e-6 * lengthM;

describe('raw GPX to replay input, end to end', () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'gps-pipeline-'));
  });

  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  function roundTrip(name: string, waypoints: Waypoint[]) {
    const rawGpx = gpxFromRaw(rawFromLocal(waypoints));
    const raw = parseGpx(rawGpx);
    const fixture = sanitizeRawTrace(raw, { scenario: 'stop_start' });
    const path = join(directory, `${name}.trace.json`);
    writeFileSync(path, serializeSanitizedTrace(fixture));
    const loaded = loadFixtureFile(path);
    return { loaded, points: anchorTrace(loaded.trace), raw };
  }

  function expectGeometryPreserved(result: ReturnType<typeof roundTrip>): void {
    const { points, raw } = result;
    expect(points).toHaveLength(raw.points.length);
    for (let index = 1; index < raw.points.length; index += 1) {
      const a = raw.points[index - 1] as (typeof raw.points)[number];
      const b = raw.points[index] as (typeof raw.points)[number];
      const original = geodesicDistanceM(a, b);
      const replayed = geodesicDistanceM(
        points[index - 1] as { latitude: number; longitude: number },
        points[index] as { latitude: number; longitude: number },
      );
      expect(Math.abs(replayed - original), `segment ${String(index)}`).toBeLessThan(lengthTolerance(original));
      // Elapsed time is exact, so a derived speed moves by at most the length error over the interval.
      const elapsedMs = b.timeMs - a.timeMs;
      expect(Date.parse((points[index] as { recordedAt: string }).recordedAt) - Date.parse((points[index - 1] as { recordedAt: string }).recordedAt)).toBe(elapsedMs);
    }
    expect(Date.parse((points[0] as { recordedAt: string }).recordedAt)).toBe(REPLAY_EPOCH_MS);
  }

  it('preserves a straight line', () => {
    expectGeometryPreserved(roundTrip('straight', straightLine(60, 3, 0.7, 5)));
  });

  it('preserves a turn', () => {
    const waypoints: Waypoint[] = [
      ...straightLine(20, 3, 0, 5),
      ...Array.from({ length: 20 }, (_, index) => ({ accuracyM: 5, elapsedMs: (20 + index) * 1000, xM: 3 * (index + 1), yM: 57 })),
    ];
    expectGeometryPreserved(roundTrip('turn', waypoints));
  });

  it('preserves a stop, including repeated coordinates', () => {
    const waypoints: Waypoint[] = [
      { accuracyM: 5, elapsedMs: 0, xM: 0, yM: 0 },
      { accuracyM: 5, elapsedMs: 1000, xM: 3, yM: 0 },
      ...[2, 3, 4, 5].map((second) => ({ accuracyM: 5, elapsedMs: second * 1000, xM: 6, yM: 0 })),
      { accuracyM: 5, elapsedMs: 6000, xM: 9, yM: 0 },
    ];
    const result = roundTrip('stop', waypoints);
    expectGeometryPreserved(result);
    expect(sourceCharacteristics(result.loaded.trace).repeatedCoordinateCount).toBe(3);
  });

  it('preserves a timing gap exactly', () => {
    const waypoints: Waypoint[] = [
      ...straightLine(5, 3, 1, 5),
      { accuracyM: 5, elapsedMs: 4000 + 17_250, xM: 12 + 50, yM: 0 },
      { accuracyM: 5, elapsedMs: 4000 + 18_250, xM: 12 + 53, yM: 0 },
    ];
    const result = roundTrip('gap', waypoints);
    expectGeometryPreserved(result);
    expect(sourceCharacteristics(result.loaded.trace).maxGapS).toBe(17.25);
  });

  it('preserves a duplicate point: the same position at a later time', () => {
    const waypoints: Waypoint[] = [
      { accuracyM: 5, elapsedMs: 0, xM: 0, yM: 0 },
      { accuracyM: 5, elapsedMs: 1000, xM: 3, yM: 0 },
      { accuracyM: 5, elapsedMs: 2000, xM: 3, yM: 0 },
      { accuracyM: 5, elapsedMs: 3000, xM: 6, yM: 0 },
    ];
    const result = roundTrip('duplicate', waypoints);
    expectGeometryPreserved(result);
    expect(result.points.map((point) => point.seq)).toEqual(['1', '2', '3', '4']);
  });

  it('works without accuracy', () => {
    const result = roundTrip('no-accuracy', straightLine(20, 3, 1));
    expectGeometryPreserved(result);
    expect(result.loaded.trace.points.every((point) => !('accuracyM' in point))).toBe(true);
  });

  it('rejects a malformed point and a timestamp that goes backwards, before any fixture exists', () => {
    const good = gpxFromRaw(rawFromLocal(straightLine(5, 3)));
    const malformed = good.replace(/lat="[^"]*"/u, 'lat="not-a-number"');
    expect(() => parseGpx(malformed)).toThrow(RawTraceError);
    expect(() => parseGpx(malformed)).toThrow(/trkpt #1.*lat/u);
    const times = [...good.matchAll(/<time>([^<]*)<\/time>/gu)].map((match) => match[1] as string);
    const swapped = good
      .replace(times[1] as string, '__A__')
      .replace(times[2] as string, times[1] as string)
      .replace('__A__', times[2] as string);
    expect(() => parseGpx(swapped)).toThrow(/trkpt #3.*before.*trkpt #2/u);
  });

  it('rejects an old or unsupported fixture schema when reading', () => {
    const path = join(directory, 'old.trace.json');
    writeFileSync(path, JSON.stringify({ points: [], schemaVersion: 0 }));
    expect(() => loadFixtureFile(path)).toThrow(TraceValidationError);
    expect(() => loadFixtureFile(path)).toThrow(/unsupported schemaVersion 0/u);
    writeFileSync(path, JSON.stringify({ points: [], scenario: 'steady_run', schemaVersion: 2, source: 'synthetic' }));
    expect(() => loadFixtureFile(path)).toThrow(/unsupported schemaVersion 2/u);
  });
});
