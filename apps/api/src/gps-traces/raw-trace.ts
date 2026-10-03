// A raw device trace in memory: absolute position and time, so it is private. It exists only between the file
// reader and the sanitizer and is never serialized. Messages name a point by position and a field by name, and
// never carry a coordinate or a time, so an error can be pasted into an issue without leaking the route.

export interface RawPoint {
  readonly accuracyM?: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeMs: number;
}

export interface RawTrace {
  readonly points: readonly RawPoint[];
}

export const MAX_RAW_POINTS = 500_000;

export class RawTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawTraceError';
  }
}

/**
 * Checks what the sanitizer relies on. It never repairs: a corrupt trace is rejected so that the owner fixes the
 * export, instead of a silent fix changing what the evaluator is measured on.
 */
export function validateRawTrace(points: readonly RawPoint[], label = 'point'): void {
  if (points.length > MAX_RAW_POINTS) {
    throw new RawTraceError(`The trace has more than ${String(MAX_RAW_POINTS)} points; trim it before sanitizing`);
  }
  if (points.length < 2) {
    throw new RawTraceError(`The trace needs at least 2 ${label}s with a time; it has ${String(points.length)}`);
  }
  let withAccuracy = 0;
  points.forEach((point, index) => {
    const name = `${label} #${String(index + 1)}`;
    if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
      throw new RawTraceError(`${name}: latitude is not finite or is outside the range -90 to 90`);
    }
    if (!Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
      throw new RawTraceError(`${name}: longitude is not finite or is outside the range -180 to 180`);
    }
    if (point.latitude === 0 && point.longitude === 0) {
      throw new RawTraceError(`${name}: the position is exactly 0, 0, which receivers report when they have no fix`);
    }
    if (!Number.isFinite(point.timeMs)) {
      throw new RawTraceError(`${name}: time is not a finite instant`);
    }
    if (point.accuracyM !== undefined) {
      if (!Number.isFinite(point.accuracyM) || point.accuracyM < 0) {
        throw new RawTraceError(`${name}: accuracy must be a finite number of metres, zero or more`);
      }
      withAccuracy += 1;
    }
    const previous = points[index - 1];
    if (previous !== undefined) {
      const previousName = `${label} #${String(index)}`;
      if (point.timeMs === previous.timeMs) {
        throw new RawTraceError(`${name}: has the same time as ${previousName}; timestamps must be unique`);
      }
      if (point.timeMs < previous.timeMs) {
        throw new RawTraceError(`${name}: time is before ${previousName}; points must be in time order`);
      }
    }
  });
  if (withAccuracy !== 0 && withAccuracy !== points.length) {
    throw new RawTraceError('accuracy must be present on every point or none');
  }
}
