import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { loadIntegrationTestConfiguration } from '../src/config/environment.js';

// D10: measured behaviour of the real SQL edge evaluator (v1) and display simplifier on synthetic runs around the
// world. The tracks are synthetic by construction: a runner on a circular loop, with seeded Gaussian position noise.
// This measures what the algorithms do with a known truth; it says nothing about real receivers, multipath,
// urban canyons or tunnels, which need recorded traces.

const EARTH_RADIUS_M = 6_371_008.8;
const INTERVAL_S = 2;
const LOOP_RADIUS_M = 150;
const START_MS = Date.parse('2026-01-01T08:00:00.000Z');

interface Site {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

const SITES: readonly Site[] = [
  { latitude: -0.18, longitude: -78.47, name: 'Quito (equator)' },
  { latitude: 1.35, longitude: 103.82, name: 'Singapore' },
  { latitude: -33.92, longitude: 18.42, name: 'Cape Town (south)' },
  { latitude: 51.48, longitude: 0.0, name: 'Greenwich (prime meridian)' },
  { latitude: 52.23, longitude: 21.01, name: 'Warsaw' },
  { latitude: 69.65, longitude: 18.96, name: 'Tromso (70N)' },
  { latitude: 78.22, longitude: 15.65, name: 'Longyearbyen (78N)' },
  { latitude: 89.5, longitude: 0.0, name: 'Near the North Pole (89.5N)' },
  { latitude: -77.85, longitude: 166.67, name: 'McMurdo (78S)' },
  { latitude: -16.8, longitude: 179.999, name: 'Antimeridian (Fiji)' },
  { latitude: 64.8, longitude: -179.999, name: 'Antimeridian (Chukotka, 65N)' },
];
const NOISE_SIGMAS_M = [0, 3, 8, 15, 20, 25] as const;
// The 3 m/s pace is the noise matrix above; these two bracket the 12 m/s speed rule.
const SPEEDS_MPS = [11, 13] as const;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

// Spherical destination point: exact enough (sub-metre against the spheroid at these distances) to place a known
// truth; the measurements themselves use the spheroid in PostGIS.
function destination(latitude: number, longitude: number, bearingRad: number, distanceM: number) {
  const delta = distanceM / EARTH_RADIUS_M;
  const phi1 = toRad(latitude);
  const lambda1 = toRad(longitude);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(bearingRad),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { latitude: toDeg(phi2), longitude: normalizeLongitude(toDeg(lambda2)) };
}

interface TrackPoint {
  readonly accuracyM: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeS: number;
}

function createLoop(site: Site, sigmaM: number, speedMps: number, seed: number): TrackPoint[] {
  const random = mulberry32(seed);
  const circumference = 2 * Math.PI * LOOP_RADIUS_M;
  const count = Math.floor(circumference / (speedMps * INTERVAL_S)) + 1;
  // A receiver reports the radius holding about 68% of fixes, roughly 1.5 sigma per axis; never below 3 m.
  const accuracyM = Math.round(Math.max(3, 1.5 * sigmaM) * 10) / 10;
  const points: TrackPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index * speedMps * INTERVAL_S) / LOOP_RADIUS_M;
    // The loop passes through the site centre's bearing frame: a point on a circle of LOOP_RADIUS_M around centre.
    const truth = destination(site.latitude, site.longitude, angle, LOOP_RADIUS_M);
    const dx = sigmaM * gaussian(random);
    const dy = sigmaM * gaussian(random);
    const noisy =
      sigmaM === 0
        ? truth
        : destination(truth.latitude, truth.longitude, Math.atan2(dx, dy), Math.hypot(dx, dy));
    points.push({
      accuracyM,
      latitude: noisy.latitude,
      longitude: noisy.longitude,
      timeS: START_MS / 1000 + index * INTERVAL_S,
    });
  }
  return points;
}

interface Measurement {
  acceptedEdges: number;
  acceptedLengthM: number;
  chainCount: number;
  edges: number;
  maxDeviationFromAcceptedM: number | null;
  maxDeviationFromTruthM: number | null;
  noiseSigmaM: number;
  rejections: Record<string, number>;
  simplifiedLengthM: number | null;
  simplifiedVertices: number | null;
  site: string;
  speedMps: number;
  acceptedVertices: number;
  coordinatesValid: boolean | null;
  pointCount: number;
  reportedAccuracyM: number;
}

const measurements: Measurement[] = [];

function wkt(points: readonly TrackPoint[], chains: readonly number[][]): string {
  const lines = chains.map(
    (chain) =>
      `(${chain
        .map((index) => {
          const point = points[index] as TrackPoint;
          return `${point.longitude.toFixed(8)} ${point.latitude.toFixed(8)}`;
        })
        .join(',')})`,
  );
  return `MULTILINESTRING(${lines.join(',')})`;
}

describe('D10 measured GPS tolerances of the v1 edge evaluator and display simplifier', () => {
  let pool: Pool;

  beforeAll(() => {
    const config = loadIntegrationTestConfiguration();
    pool = new Pool({
      application_name: 'running-tracker-gps-tolerance',
      connectionString: config.maintenance.connectionString,
      max: 1,
    });
  });

  afterAll(async () => {
    await pool?.end();
    const reportPath = process.env.D10_REPORT_JSON;
    if (reportPath) {
      writeFileSync(reportPath, JSON.stringify(measurements, null, 2));
    }
  });

  async function measure(
    site: Site,
    sigmaM: number,
    speedMps: number,
    seed: number,
  ): Promise<Measurement> {
    const points = createLoop(site, sigmaM, speedMps, seed);
    const evaluation = await pool.query<{ accepted: boolean; rejection_reason: string | null }>(
      `WITH p AS (
         SELECT i,
                ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom,
                accuracy,
                to_timestamp(t) AS recorded_at
         FROM unnest($1::float8[], $2::float8[], $3::float8[], $4::float8[])
              WITH ORDINALITY AS u(lon, lat, accuracy, t, i)
       )
       SELECT evaluated.accepted, evaluated.rejection_reason
       FROM p AS a
       JOIN p AS b ON b.i = a.i + 1
       CROSS JOIN LATERAL app_private.evaluate_track_edge(
         'v1', a.i, 0, a.recorded_at, a.geom, a.accuracy,
         b.i, 0, b.recorded_at, b.geom, b.accuracy
       ) AS evaluated
       ORDER BY a.i`,
      [
        points.map((point) => point.longitude),
        points.map((point) => point.latitude),
        points.map((point) => point.accuracyM),
        points.map((point) => point.timeS),
      ],
    );

    const rejections: Record<string, number> = {};
    const chains: number[][] = [];
    let current: number[] | null = null;
    evaluation.rows.forEach((row, edgeIndex) => {
      if (row.accepted) {
        if (current === null) {
          current = [edgeIndex];
          chains.push(current);
        }
        current.push(edgeIndex + 1);
      } else {
        current = null;
        const reason = row.rejection_reason ?? 'unknown';
        rejections[reason] = (rejections[reason] ?? 0) + 1;
      }
    });
    const acceptedEdges = evaluation.rows.filter((row) => row.accepted).length;

    const result: Measurement = {
      acceptedEdges,
      acceptedLengthM: 0,
      acceptedVertices: chains.reduce((sum, chain) => sum + chain.length, 0),
      chainCount: chains.length,
      coordinatesValid: null,
      edges: evaluation.rows.length,
      maxDeviationFromAcceptedM: null,
      maxDeviationFromTruthM: null,
      noiseSigmaM: sigmaM,
      pointCount: points.length,
      rejections,
      reportedAccuracyM: points[0]?.accuracyM ?? 0,
      simplifiedLengthM: null,
      simplifiedVertices: null,
      site: site.name,
      speedMps,
    };
    if (chains.length === 0) {
      return result;
    }

    const simplified = await pool.query<{
      accepted_length_m: number;
      coordinates_valid: boolean | null;
      deviation_from_accepted_m: number | null;
      deviation_from_truth_m: number | null;
      simplified_length_m: number | null;
      simplified_vertices: number | null;
    }>(
      `WITH src AS (
         SELECT ST_GeomFromText($1, 4326) AS g,
                ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326) AS centre
       ),
       simp AS (
         SELECT app_private.simplify_display_geometry(g, 'v1') AS s, g, centre FROM src
       ),
       simplified_vertices AS (
         SELECT (ST_DumpPoints(s)).geom AS geom FROM simp WHERE s IS NOT NULL
       ),
       accepted_vertices AS (
         SELECT (ST_DumpPoints(g)).geom AS geom FROM simp
       )
       SELECT
         ST_Length(g::geography) AS accepted_length_m,
         ST_Length(s::geography) AS simplified_length_m,
         ST_NPoints(s)::integer AS simplified_vertices,
         (SELECT max(ST_Distance(geom::geography, s::geography)) FROM accepted_vertices)
           AS deviation_from_accepted_m,
         (SELECT max(abs(ST_Distance(geom::geography, centre::geography) - $4::float8))
            FROM simplified_vertices) AS deviation_from_truth_m,
         (SELECT bool_and(ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90)
            FROM simplified_vertices) AS coordinates_valid
       FROM simp`,
      [wkt(points, chains), site.longitude, site.latitude, LOOP_RADIUS_M],
    );
    const row = simplified.rows[0];
    if (row === undefined) {
      throw new Error('The simplification measurement returned no row');
    }
    result.acceptedLengthM = row.accepted_length_m;
    result.simplifiedLengthM = row.simplified_length_m;
    result.simplifiedVertices = row.simplified_vertices;
    result.maxDeviationFromAcceptedM = row.deviation_from_accepted_m;
    result.maxDeviationFromTruthM = row.deviation_from_truth_m;
    result.coordinatesValid = row.coordinates_valid;
    return result;
  }

  it('measures every site and noise level at running pace', async () => {
    let seed = 1;
    for (const site of SITES) {
      for (const sigma of NOISE_SIGMAS_M) {
        seed += 1;
        const row = await measure(site, sigma, 3, seed);
        measurements.push(row);
        if (row.coordinatesValid !== null) {
          expect(row.coordinatesValid, `${site.name} sigma ${sigma}`).toBe(true);
        }
      }
    }
    expect(measurements).toHaveLength(SITES.length * NOISE_SIGMAS_M.length);
  }, 120_000);

  it('measures the speed cap on a noiseless loop', async () => {
    const warsaw = SITES.find((site) => site.name === 'Warsaw') as Site;
    for (const speed of SPEEDS_MPS) {
      measurements.push(await measure(warsaw, 0, speed, 100 + speed));
    }
  }, 60_000);

  // The assertions below are regression guards on the measured limits documented in
  // docs/reports/d10-gps-tolerances.md. They hold with margin for the seeded tracks above; a change of the
  // algorithm version that moves them is meant to fail here and be re-measured, not silently re-accepted.
  describe('documented limits', () => {
    const atPace = () => measurements.filter((row) => row.speedMps === 3);
    const sigma = (value: number) => atPace().filter((row) => row.noiseSigmaM === value);
    const acceptance = (row: Measurement) => row.acceptedEdges / row.edges;

    it('has measured the full matrix, so the guards below are not vacuous', () => {
      expect(atPace()).toHaveLength(SITES.length * NOISE_SIGMAS_M.length);
      for (const value of NOISE_SIGMAS_M) expect(sigma(value)).toHaveLength(SITES.length);
    });

    it('keeps the display line within the 5 m tolerance of the recorded points at every site', () => {
      const deviations = measurements.flatMap((row) =>
        row.maxDeviationFromAcceptedM === null ? [] : [row.maxDeviationFromAcceptedM],
      );
      expect(deviations.length).toBeGreaterThan(0);
      expect(Math.max(...deviations)).toBeLessThanOrEqual(5.05);
    });

    it('accepts every edge up to 3 m of noise and rejects a growing share by speed before the accuracy cutoff', () => {
      for (const row of [...sigma(0), ...sigma(3)]) expect(acceptance(row), row.site).toBe(1);
      for (const row of sigma(8)) {
        expect(acceptance(row), row.site).toBeGreaterThan(0.75);
        expect(acceptance(row), row.site).toBeLessThan(0.95);
      }
      // 15 m of noise reports 22.5 m accuracy, inside the 30 m cutoff, yet about half the edges fail the speed rule.
      for (const row of sigma(15)) {
        expect(acceptance(row), row.site).toBeGreaterThan(0.2);
        expect(acceptance(row), row.site).toBeLessThan(0.65);
        expect(Object.keys(row.rejections), row.site).toEqual(['excessive_speed']);
      }
    });

    it('rejects everything once the reported accuracy exceeds 30 m', () => {
      for (const row of sigma(25)) {
        expect(row.acceptedEdges, row.site).toBe(0);
        expect(row.rejections, row.site).toEqual({ poor_accuracy: row.edges });
      }
    });

    it('overstates the distance with noise, because the summary sums unsimplified accepted edges', () => {
      for (const row of sigma(3)) {
        const truth = sigma(0).find((candidate) => candidate.site === row.site)?.acceptedLengthM ?? 0;
        expect(row.acceptedLengthM / truth, row.site).toBeGreaterThan(1.1);
        expect(row.acceptedLengthM / truth, row.site).toBeLessThan(1.5);
      }
    });

    it('accepts 11 m/s and rejects every edge at 13 m/s', () => {
      const fast = measurements.filter((row) => row.speedMps !== 3);
      const at = (speed: number) => fast.find((row) => row.speedMps === speed) as Measurement;
      expect(at(11).acceptedEdges).toBe(at(11).edges);
      expect(at(13).acceptedEdges).toBe(0);
      expect(at(13).rejections).toEqual({ excessive_speed: at(13).edges });
    });
  });
});
