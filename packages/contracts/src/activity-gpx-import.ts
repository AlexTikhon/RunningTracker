import { z } from 'zod';

import {
  ACTIVITY_DISTANCE_MAX_M,
  ACTIVITY_DURATION_MAX_S,
  activityTypeSchema,
} from './activities.js';
import { timestampSchema, uuidSchema } from './primitives.js';

// GPX import into an owner-only activity (ADR-0086). The person uploads one GPX file, sees a preview the server computed
// from it (nothing is written), chooses the activity type and confirms by uploading the same file again: the server
// parses and computes everything again on confirmation and never accepts a total, a time or a source from the client.
// The stored activity is a summary only (start, elapsed duration, distance); no point, route, name or file is kept.
//
// The supported subset (anything else is refused with a reason, never repaired or truncated):
// - UTF-8 (a byte-order mark is allowed), at most GPX_IMPORT_MAX_BYTES bytes, root <gpx> in the GPX 1.1 namespace;
// - no DOCTYPE or other markup declaration; entity references are never expanded and nothing referenced is fetched;
// - exactly one <trk> with 1 to GPX_IMPORT_MAX_SEGMENTS <trkseg>, each with at least one <trkpt>, at least 2 and at
//   most GPX_IMPORT_MAX_POINTS points in total;
// - every point has decimal lat (-90..90) and lon (-180..180), not exactly 0,0, and one <time> with a zone (Z or
//   ±hh:mm); times strictly increase within a segment and from one segment to the next (segments do not overlap);
// - waypoints, routes, elevation, names, descriptions, links and extensions (heart rate, cadence, power) are not read.

/** The largest accepted file, in bytes, before any decoding. The upload's request body is exactly the file. */
export const GPX_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const GPX_IMPORT_MAX_POINTS = 100_000;
export const GPX_IMPORT_MAX_SEGMENTS = 1_000;
/**
 * Two consecutive points of one segment that are further apart than this speed allows (metres per second) make the file
 * unsupported: such a jump is a recording fault or a teleport, and silently counting or dropping it would invent a
 * distance. 100 m/s is 360 km/h, far beyond any activity type the app records.
 */
export const GPX_IMPORT_MAX_EDGE_SPEED_M_S = 100;
/** The only accepted request Content-Type of the two upload routes. */
export const GPX_IMPORT_CONTENT_TYPE = 'application/gpx+xml';
export const GPX_NAMESPACE_1_1 = 'http://www.topografix.com/GPX/1/1';
/** The summary rules of ADR-0086. Change it when a definition below changes. */
export const GPX_IMPORT_METRICS_VERSION = 'gpx-summary-1';

/** Stable reasons for 422 GPX_UNSUPPORTED. A client may rely on a reason's meaning; the message may be reworded. */
export const GPX_UNSUPPORTED_REASONS = [
  'not_utf8',
  'not_xml',
  'malformed_xml',
  'declaration',
  'not_gpx',
  'not_gpx_1_1',
  'track_count',
  'structure',
  'empty_segment',
  'too_many_segments',
  'too_many_points',
  'too_few_points',
  'coordinates',
  'time_missing',
  'time_invalid',
  'time_order',
  'implausible_speed',
  'start_before_minimum',
  'start_in_future',
  'duration_out_of_range',
  'distance_out_of_range',
] as const;
export const gpxUnsupportedReasonSchema = z.enum(GPX_UNSUPPORTED_REASONS);

export const GPX_UNSUPPORTED = 'GPX_UNSUPPORTED';
export const GPX_FILE_TOO_LARGE = 'GPX_FILE_TOO_LARGE';
export const GPX_ALREADY_IMPORTED = 'GPX_ALREADY_IMPORTED';

/** `details` of a 422 GPX_UNSUPPORTED. */
export const gpxUnsupportedDetailsSchema = z.strictObject({ reason: gpxUnsupportedReasonSchema });
/** `details` of a 413 GPX_FILE_TOO_LARGE. */
export const gpxFileTooLargeDetailsSchema = z.strictObject({ maxBytes: z.literal(GPX_IMPORT_MAX_BYTES) });
/**
 * `details` of a 409 GPX_ALREADY_IMPORTED: an existing activity of this person in this organization was imported from
 * the same track (same points, times and segments; see `fingerprint` in ADR-0086). Deleting that activity frees the
 * track for a new import.
 */
export const gpxAlreadyImportedDetailsSchema = z.strictObject({ activityId: uuidSchema });

/**
 * What the server computed from a file. Definitions (ADR-0086):
 * - `startedAt`: the time of the first point; `endedAt`: the time of the last point (UTC, millisecond precision).
 * - `elapsedDurationS`: `endedAt - startedAt` rounded to the nearest second (half up). It includes every pause and every
 *   gap between segments: it is elapsed time, NOT moving time. Stored as the activity's `durationS`.
 * - `distanceM`: the sum of WGS84 geodesic distances between consecutive points of the same segment, rounded to the
 *   nearest metre. Nothing is added across a segment boundary; elevation is ignored; nothing is smoothed or filtered.
 * - `pointCount`, `segmentCount`: what was read.
 */
export const gpxImportSummarySchema = z
  .strictObject({
    distanceM: z.int().min(0).max(ACTIVITY_DISTANCE_MAX_M),
    elapsedDurationS: z.int().min(1).max(ACTIVITY_DURATION_MAX_S),
    endedAt: timestampSchema,
    metricsVersion: z.literal(GPX_IMPORT_METRICS_VERSION),
    pointCount: z.int().min(2).max(GPX_IMPORT_MAX_POINTS),
    segmentCount: z.int().min(1).max(GPX_IMPORT_MAX_SEGMENTS),
    startedAt: timestampSchema,
  })
  .refine((summary) => Date.parse(summary.startedAt) < Date.parse(summary.endedAt), {
    message: 'the last point is after the first',
    path: ['endedAt'],
  });

/**
 * 200 answer of the preview. Nothing was written. `duplicateOf` names an existing activity imported from the same track
 * at the time of the preview (null when none); confirmation checks again, so it is advisory. It says nothing about GPS
 * runs recorded in the app: an import is never compared with them.
 */
export const gpxImportPreviewSchema = z.strictObject({
  duplicateOf: gpxAlreadyImportedDetailsSchema.nullable(),
  summary: gpxImportSummarySchema,
});

/**
 * Query of the confirmation `PUT /activities/{activityId}/gpx-import`. The body is the file itself. `idempotencyKey` is
 * one client-generated UUID per import attempt (ADR-0073), kept until a confirmed outcome; `type` is the person's choice.
 * Nothing else is accepted: no source, total or time.
 */
export const gpxImportConfirmQuerySchema = z.strictObject({
  idempotencyKey: uuidSchema,
  type: activityTypeSchema,
});

export type GpxUnsupportedReason = z.infer<typeof gpxUnsupportedReasonSchema>;
export type GpxImportSummary = z.infer<typeof gpxImportSummarySchema>;
export type GpxImportPreview = z.infer<typeof gpxImportPreviewSchema>;
export type GpxImportConfirmQuery = z.infer<typeof gpxImportConfirmQuerySchema>;
export type GpxAlreadyImportedDetails = z.infer<typeof gpxAlreadyImportedDetailsSchema>;
