import { describe, expect, it } from 'vitest';

import { fromLocalMetres, geodesicDistanceM, toLocalMetres } from './geodesy.js';

// Geodetic Survey of Australia reference line used to validate Vincenty's formulae (Vincenty 1975).
const flindersPeak = { latitude: -(37 + 57 / 60 + 3.7203 / 3600), longitude: 144 + 25 / 60 + 29.5244 / 3600 };
const buninyong = { latitude: -(37 + 39 / 60 + 10.1561 / 3600), longitude: 143 + 55 / 60 + 35.3839 / 3600 };

describe('WGS84 geodesy for the GPS trace tools', () => {
  it('reproduces the published distance of the Flinders Peak to Buninyong line to a millimetre', () => {
    expect(geodesicDistanceM(flindersPeak, buninyong)).toBeCloseTo(54972.271, 3);
  });

  it('puts a point due east of the origin at positive x and due north at positive y', () => {
    const origin = { latitude: 50, longitude: 10 };
    const east = fromLocalMetres(origin, { xM: 100, yM: 0 });
    const north = fromLocalMetres(origin, { xM: 0, yM: 100 });
    expect(east.longitude).toBeGreaterThan(10);
    expect(east.latitude).toBeCloseTo(50, 5);
    expect(north.latitude).toBeGreaterThan(50);
    expect(north.longitude).toBeCloseTo(10, 9);
  });

  it('reports the origin itself as exactly (0, 0)', () => {
    expect(toLocalMetres(flindersPeak, flindersPeak)).toEqual({ xM: 0, yM: 0 });
  });

  it('round-trips local metres through any origin to well under a millimetre', () => {
    for (const origin of [
      { latitude: 0, longitude: 0 },
      { latitude: 50, longitude: 10 },
      { latitude: -77.85, longitude: 166.67 },
      { latitude: 69.65, longitude: 179.9995 },
    ]) {
      for (const offset of [
        { xM: 1.234, yM: -5.678 },
        { xM: 2500, yM: 1800 },
        { xM: -20_000, yM: 12_000 },
      ]) {
        const geographic = fromLocalMetres(origin, offset);
        const back = toLocalMetres(origin, geographic);
        expect(Math.abs(back.xM - offset.xM)).toBeLessThan(1e-4);
        expect(Math.abs(back.yM - offset.yM)).toBeLessThan(1e-4);
      }
    }
  });

  it('keeps longitudes in range across the antimeridian', () => {
    const point = fromLocalMetres({ latitude: 65, longitude: 179.999 }, { xM: 5000, yM: 0 });
    expect(point.longitude).toBeGreaterThanOrEqual(-180);
    expect(point.longitude).toBeLessThanOrEqual(180);
    expect(point.longitude).toBeLessThan(0);
    const back = toLocalMetres({ latitude: 65, longitude: 179.999 }, point);
    expect(back.xM).toBeCloseTo(5000, 3);
  });

  it('preserves the distance between two points that are away from the origin to better than 1e-5 within 10 km', () => {
    // The projection is exact for distances from the origin; between other points the error grows with the square
    // of the extent. 10 km is far beyond a run, and the relative error stays below 1e-5.
    const origin = { latitude: 50, longitude: 10 };
    const a = { xM: 6000, yM: 4000 };
    const b = { xM: 6030, yM: 4040 };
    const planar = Math.hypot(b.xM - a.xM, b.yM - a.yM);
    const geodesic = geodesicDistanceM(fromLocalMetres(origin, a), fromLocalMetres(origin, b));
    expect(Math.abs(geodesic - planar) / planar).toBeLessThan(1e-5);
  });
});
