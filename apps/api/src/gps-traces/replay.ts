import { pointInputSchema, type PointInput } from '@running-tracker/contracts';

import { fromLocalMetres } from './geodesy.js';
import type { SanitizedTrace } from './trace-schema.js';

// Replay input. A sanitized trace has no position and no clock, but the production code path needs WGS84 points
// with absolute times. They are supplied here, deterministically and publicly:
//  - position: the local metric offsets are placed around a fixed synthetic anchor, a round-number coordinate in
//    central Europe that identifies nobody. The metric geometry is what the evaluator measures, so the anchor does
//    not change its verdicts; it does mean replay says nothing about behaviour at other places on the globe, which
//    the synthetic worldwide test (docs/reports/d10-gps-tolerances.md) covers;
//  - time: a fixed epoch plus the elapsed milliseconds.

export const REPLAY_ANCHOR = { latitude: 50, longitude: 10 } as const;
export const REPLAY_EPOCH_MS = Date.UTC(2000, 0, 1);
/** Used when a fixture carries no accuracy. A report states when this was used. */
export const ASSUMED_ACCURACY_M = 5;

const COORDINATE_STEP = 1e-9;

// About 0.1 mm. Trigonometry can differ in the last bit between platforms; rounding keeps replay reproducible.
const roundCoordinate = (value: number): number => Math.round(value / COORDINATE_STEP) * COORDINATE_STEP;

export function anchorTrace(trace: SanitizedTrace): PointInput[] {
  return trace.points.map((point, index) => {
    const geographic = fromLocalMetres(REPLAY_ANCHOR, point);
    return pointInputSchema.parse({
      accuracyM: point.accuracyM ?? ASSUMED_ACCURACY_M,
      latitude: roundCoordinate(geographic.latitude),
      longitude: roundCoordinate(geographic.longitude),
      recordedAt: new Date(REPLAY_EPOCH_MS + point.elapsedMs).toISOString(),
      segmentId: 0,
      seq: String(index + 1),
    });
  });
}
