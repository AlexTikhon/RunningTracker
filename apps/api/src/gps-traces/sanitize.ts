import { toLocalMetres } from './geodesy.js';
import { RawTraceError, validateRawTrace, type RawTrace } from './raw-trace.js';
import {
  MAX_EXTENT_M,
  MAX_POINTS,
  parseSanitizedTrace,
  type SanitizedPoint,
  type SanitizedTrace,
  type Scenario,
} from './trace-schema.js';

// The privacy transform. A raw trace has an absolute position and an absolute time; the fixture keeps neither:
//  - position: each fix becomes its east/north offset in metres from the FIRST fix (a geodesic azimuthal-equidistant
//    frame on WGS84), so the first point is (0, 0) and the real origin is not stored anywhere;
//  - time: milliseconds since the first fix;
//  - everything else a file can carry (names, device, waypoints, elevation) never reaches this function.
// Segment lengths, point order, elapsed time and so derived speeds are kept; the rounding is 1 mm.
// This removes the location and the clock, not the shape of the route.

const MAX_ORIGIN_LATITUDE = 85;

const roundTo = (value: number, step: number): number => {
  const rounded = Math.round(value / step) * step;
  // Round again through the decimal places so that 0.1 steps do not leave 0.30000000000000004 in the file.
  const digits = Math.round(-Math.log10(step));
  const text = Number(rounded.toFixed(digits));
  return text === 0 ? 0 : text;
};

export interface SanitizeOptions {
  /** An independently measured length of the route, if one exists. Not required and never inferred. */
  readonly referenceDistanceM?: number;
  readonly scenario: Scenario;
}

export function sanitizeRawTrace(raw: RawTrace, options: SanitizeOptions): SanitizedTrace {
  validateRawTrace(raw.points);
  if (raw.points.length > MAX_POINTS) {
    throw new RawTraceError(
      `A fixture holds at most ${String(MAX_POINTS)} points; the trace has ${String(raw.points.length)}. Trim or split the recording and sanitize each part`,
    );
  }
  const origin = raw.points[0];
  if (origin === undefined) {
    throw new RawTraceError('The trace has no points');
  }
  if (Math.abs(origin.latitude) > MAX_ORIGIN_LATITUDE) {
    throw new RawTraceError(`The trace starts beyond ${String(MAX_ORIGIN_LATITUDE)} degrees of latitude, which the local metric frame does not support`);
  }

  const points: SanitizedPoint[] = raw.points.map((point, index) => {
    const local = toLocalMetres(origin, point);
    if (Math.hypot(local.xM, local.yM) > MAX_EXTENT_M) {
      throw new RawTraceError(
        `point #${String(index + 1)} is farther than ${String(MAX_EXTENT_M)} m from the first point; split the recording`,
      );
    }
    return {
      ...(point.accuracyM === undefined ? {} : { accuracyM: roundTo(point.accuracyM, 0.01) }),
      elapsedMs: point.timeMs - origin.timeMs,
      xM: roundTo(local.xM, 0.001),
      yM: roundTo(local.yM, 0.001),
    };
  });

  return parseSanitizedTrace({
    points,
    ...(options.referenceDistanceM === undefined ? {} : { referenceDistanceM: options.referenceDistanceM }),
    scenario: options.scenario,
    schemaVersion: 1,
    source: 'real-device-sanitized',
  });
}
