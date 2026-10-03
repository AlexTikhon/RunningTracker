import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';
import { analyzeTrace, type TraceReport } from '../src/gps-traces/analyze.js';
import { geodesicDistanceM } from '../src/gps-traces/geodesy.js';
import { parseGpx } from '../src/gps-traces/gpx.js';
import { sanitizeRawTrace } from '../src/gps-traces/sanitize.js';
import { gpxFromRaw, rawFromLocal } from '../src/gps-traces/test-traces.js';
import {
  parseSanitizedTraceText,
  serializeSanitizedTrace,
  type SanitizedTrace,
} from '../src/gps-traces/trace-schema.js';

// The replay path of D10: a sanitized trace goes through the production point contract, production insert SQL and
// the production SQL evaluator, summary and simplifier on the _test database. These tests use small synthetic
// shapes whose verdicts are known from the v1 rules (accuracy 30 m, gap 10 s, speed 12 m/s).

type Waypoint = [elapsedMs: number, xM: number, yM: number];

function fixture(waypoints: Waypoint[], accuracyM: number | null = 5): SanitizedTrace {
  return {
    points: waypoints.map(([elapsedMs, xM, yM]) => ({
      ...(accuracyM === null ? {} : { accuracyM }),
      elapsedMs,
      xM,
      yM,
    })),
    scenario: 'steady_run',
    schemaVersion: 1,
    source: 'synthetic',
  };
}

function line(count: number, speedMps: number): Waypoint[] {
  return Array.from({ length: count }, (_, index): Waypoint => [index * 1000, index * speedMps, 0]);
}

describe('D10 replay of sanitized traces through the production evaluator', () => {
  let ownerPool: Pool;
  let analysisPool: Pool;

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    ownerPool = new Pool({ connectionString: config.migration.connectionString, max: 1 });
    analysisPool = new Pool({ connectionString: config.migration.connectionString, max: 1 });
  });

  afterAll(async () => {
    await ownerPool?.end();
    await analysisPool?.end();
  });

  async function analyze(trace: SanitizedTrace): Promise<TraceReport> {
    return analyzeTrace(analysisPool, 'case', trace);
  }

  it('accepts every edge of a clean 3 m/s line and measures canonical distance equal to the polyline', async () => {
    const report = await analyze(fixture(line(60, 3)));
    expect(report.algorithmVersion).toBe('v1');
    expect(report.edges.edgeCount).toBe(59);
    expect(report.edges.acceptedCount).toBe(59);
    expect(report.edges.rejectionReasons).toEqual({});
    expect(report.distance.rawObservedM).toBeCloseTo(177, 1);
    expect(report.distance.canonicalM).toBeCloseTo(177, 1);
    expect(report.distance.differenceM).toBeCloseTo(0, 6);
    expect(report.distance.differencePercent).toBeCloseTo(0, 6);
    expect(report.consistency).toEqual({ agreesWithProductionSummary: true, mismatches: [] });
    expect(report.edges.acceptedSpeedMps?.median).toBeCloseTo(3, 2);
  });

  it('reproduces the fixture geometry in PostGIS: raw distance equals the planar polyline within 1e-4', async () => {
    const waypoints: Waypoint[] = Array.from({ length: 200 }, (_, index): Waypoint => [
      index * 1000,
      800 * Math.sin(index / 25),
      800 * (1 - Math.cos(index / 25)),
    ]);
    const trace = fixture(waypoints);
    const report = await analyze(trace);
    expect(Math.abs(report.distance.rawObservedM - report.characteristics.planarDistanceM) / report.characteristics.planarDistanceM)
      .toBeLessThan(1e-4);
  });

  it('shows a one-fix spike as a pair of excessive-speed edges that splits the accepted chain', async () => {
    const waypoints = line(61, 3);
    waypoints[30] = [30_000, 90, 100];
    const report = await analyze(fixture(waypoints));
    expect(report.edges.rejectionReasons).toEqual({ excessive_speed: 2 });
    expect(report.edges.excessiveSpeedRuns).toEqual({ isolated: 0, longer: 0, pair: 1 });
    expect(report.edges.maxSpeedMps).toBeGreaterThan(90);
    expect(report.distance.canonicalM).toBeLessThan(report.distance.rawObservedM);
    expect(report.distance.differenceM).toBeLessThan(-190);
    expect(report.display.acceptedChainCount).toBe(2);
  });

  it('rejects an interval longer than 10 s as a time gap and counts it as a gap in the source', async () => {
    const waypoints: Waypoint[] = [...line(10, 3), [24_500, 24.5 * 3, 0], [25_500, 25.5 * 3, 0]];
    const report = await analyze(fixture(waypoints));
    expect(report.edges.rejectionReasons).toEqual({ excessive_time_gap: 1 });
    expect(report.characteristics.gapCount).toBe(1);
    expect(report.characteristics.maxGapS).toBe(15.5);
  });

  it('rejects every edge at 13 m/s and has no display line for it', async () => {
    const report = await analyze(fixture(line(30, 13)));
    expect(report.edges.rejectedCount).toBe(29);
    expect(report.edges.rejectionReasons).toEqual({ excessive_speed: 29 });
    expect(report.distance.canonicalM).toBe(0);
    expect(report.display.simplifiedVertexCount).toBeNull();
    expect(report.display.maxDeviationM).toBeNull();
    expect(report.display.reductionPercent).toBeNull();
  });

  it('accepts 11 m/s, which is under the 12 m/s rule', async () => {
    const report = await analyze(fixture(line(30, 11)));
    expect(report.edges.acceptedCount).toBe(29);
  });

  it('rejects by accuracy and relates the verdict to the accuracy buckets', async () => {
    const report = await analyze(fixture(line(20, 3), 35));
    expect(report.edges.rejectionReasons).toEqual({ poor_accuracy: 19 });
    expect(report.edges.accuracyBuckets?.find((bucket) => bucket.label === '> 30 m')).toEqual({
      edges: 19,
      label: '> 30 m',
      rejected: 19,
    });
  });

  it('says so when it had to assume an accuracy because the fixture had none', async () => {
    const withoutAccuracy = await analyze(fixture(line(10, 3), null));
    expect(withoutAccuracy.replay).toEqual({ accuracyAssumed: true, assumedAccuracyM: 5 });
    expect(withoutAccuracy.edges.accuracyBuckets).toBeNull();
    const withAccuracy = await analyze(fixture(line(10, 3)));
    expect(withAccuracy.replay).toEqual({ accuracyAssumed: false, assumedAccuracyM: null });
  });

  it('keeps the display line within the 5 m tolerance of the accepted vertices and removes vertices from a straight line', async () => {
    const waypoints: Waypoint[] = Array.from({ length: 120 }, (_, index): Waypoint => [
      index * 1000,
      index * 3,
      2 * Math.sin(index / 3),
    ]);
    const report = await analyze(fixture(waypoints));
    expect(report.display.toleranceM).toBe(5);
    expect(report.display.maxDeviationM).not.toBeNull();
    expect(report.display.maxDeviationM as number).toBeLessThanOrEqual(5.05);
    expect(report.display.simplifiedVertexCount as number).toBeLessThan(report.display.acceptedVertexCount);
    expect(report.display.reductionPercent as number).toBeGreaterThan(50);
  });

  it('carries an optional independent reference distance and relates both distances to it, without calling either truth', async () => {
    const report = await analyze({ ...fixture(line(60, 3)), referenceDistanceM: 180 });
    expect(report.distance.referenceM).toBe(180);
    expect(report.distance.canonicalVsReferencePercent).toBeCloseTo(((177 - 180) / 180) * 100, 1);
    expect(report.distance.rawVsReferencePercent).toBeCloseTo(((177 - 180) / 180) * 100, 1);
    const none = await analyze(fixture(line(60, 3)));
    expect(none.distance.referenceM).toBeNull();
    expect(none.distance.canonicalVsReferencePercent).toBeNull();
  });

  it('is deterministic: analyzing the same fixture twice gives identical reports', async () => {
    const trace = fixture(line(40, 3.3));
    expect(await analyze(trace)).toEqual(await analyze(trace));
  });

  it('measures a raw export end to end: GPX, sanitize, write, read, re-anchor, replay', async () => {
    const waypoints = line(61, 3);
    waypoints[30] = [30_000, 90, 100];
    const gpx = gpxFromRaw(
      rawFromLocal(waypoints.map(([elapsedMs, xM, yM]) => ({ accuracyM: 5, elapsedMs, xM, yM }))),
    );
    const raw = parseGpx(gpx);
    const text = serializeSanitizedTrace(sanitizeRawTrace(raw, { scenario: 'gps_noise' }));
    const report = await analyze(parseSanitizedTraceText(text));

    // The verdicts are the evaluator's, on the geometry the device recorded.
    expect(report.edges.rejectionReasons).toEqual({ excessive_speed: 2 });
    expect(report.edges.excessiveSpeedRuns).toEqual({ isolated: 0, longer: 0, pair: 1 });
    // The raw polyline in PostGIS equals the polyline of the original GPS points to within 1e-4 relative.
    let original = 0;
    for (let index = 1; index < raw.points.length; index += 1) {
      original += geodesicDistanceM(raw.points[index - 1] as (typeof raw.points)[number], raw.points[index] as (typeof raw.points)[number]);
    }
    expect(Math.abs(report.distance.rawObservedM - original) / original).toBeLessThan(1e-4);
  });

  it('leaves nothing behind in the test database', async () => {
    await analyze(fixture(line(10, 3)));
    const leftovers = await ownerPool.query<{ table_name: string; count: string }>(
      `SELECT 'runs' AS table_name, count(*) FROM runs WHERE org_id::text LIKE '67000000-%'
       UNION ALL SELECT 'run_points', count(*) FROM run_points WHERE org_id::text LIKE '67000000-%'
       UNION ALL SELECT 'organizations', count(*) FROM organizations WHERE id::text LIKE '67000000-%'
       UNION ALL SELECT 'users', count(*) FROM users WHERE id::text LIKE '67000000-%'`,
    );
    expect(leftovers.rows).toHaveLength(4);
    for (const row of leftovers.rows) {
      expect(row.count, row.table_name).toBe('0');
    }
  });
});
