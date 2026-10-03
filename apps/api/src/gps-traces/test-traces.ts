import { fromLocalMetres, type LocalPoint } from './geodesy.js';
import type { RawPoint, RawTrace } from './raw-trace.js';

// Synthetic raw traces for tests. The "private" origin and instant below are obviously fake values chosen so the
// privacy tests can search serialized output for them; they are not anyone's real location or time.

export const FAKE_PRIVATE_ORIGIN = { latitude: 12.345678, longitude: 98.765432 } as const;
export const FAKE_PRIVATE_START_MS = Date.UTC(2031, 6, 15, 4, 56, 7, 123);

export interface Waypoint extends LocalPoint {
  readonly accuracyM?: number;
  readonly elapsedMs: number;
}

/** A raw trace placed at the fake private origin from local metric waypoints. */
export function rawFromLocal(waypoints: readonly Waypoint[]): RawTrace {
  const points: RawPoint[] = waypoints.map((waypoint) => {
    const geographic = fromLocalMetres(FAKE_PRIVATE_ORIGIN, waypoint);
    return {
      ...(waypoint.accuracyM === undefined ? {} : { accuracyM: waypoint.accuracyM }),
      latitude: geographic.latitude,
      longitude: geographic.longitude,
      timeMs: FAKE_PRIVATE_START_MS + waypoint.elapsedMs,
    };
  });
  return { points };
}

/** `count` fixes one second apart that move `speedMps` along a bearing, starting at local (0, 0). */
export function straightLine(count: number, speedMps: number, bearingRad = Math.PI / 4, accuracyM?: number): Waypoint[] {
  return Array.from({ length: count }, (_, index) => ({
    ...(accuracyM === undefined ? {} : { accuracyM }),
    elapsedMs: index * 1000,
    xM: Math.sin(bearingRad) * speedMps * index,
    yM: Math.cos(bearingRad) * speedMps * index,
  }));
}

/** GPX text for a raw trace, in the shape a phone export has, including private metadata the reader must drop. */
export function gpxFromRaw(trace: RawTrace): string {
  const points = trace.points
    .map((point) => {
      const accuracy =
        point.accuracyM === undefined ? '' : `<extensions><accuracy>${String(point.accuracyM)}</accuracy></extensions>`;
      return `<trkpt lat="${point.latitude.toFixed(8)}" lon="${point.longitude.toFixed(8)}"><ele>12</ele><time>${new Date(point.timeMs).toISOString()}</time>${accuracy}</trkpt>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Fake Watch 9000 serial SN-0042" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>Jane Q. Example home loop</name></metadata>
<trk><name>Jane Q. Example home loop</name><trkseg>
${points}
</trkseg></trk></gpx>`;
}
