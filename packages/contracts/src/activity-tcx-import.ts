import { z } from 'zod';

import { ACTIVITY_DISTANCE_MAX_M, ACTIVITY_DURATION_MAX_S, activityTypeSchema } from './activities.js';
import { timestampSchema, uuidSchema } from './primitives.js';

// TCX import into an owner-only activity (ADR-0091). The person uploads one Training Center Database v2 file, sees a
// preview the server computed from it (nothing is written), chooses the activity type and confirms by uploading the same
// file again: the server parses and computes everything again on confirmation and never accepts a total, a time or a
// source from the client. The stored activity is a summary only (start, reported duration, distance); no lap, trackpoint,
// position, heart rate, calories, creator, notes or file is kept.
//
// The supported subset (`tcx-summary-1`; anything else is refused with a reason, never repaired, reordered or truncated):
// - UTF-8 (a byte-order mark is allowed), at most TCX_IMPORT_MAX_BYTES bytes; no DOCTYPE or other markup declaration;
//   entity references are never expanded and nothing referenced is fetched;
// - root <TrainingCenterDatabase> in the TCD v2 namespace (any prefix); depth at most TCX_IMPORT_MAX_DEPTH, at most
//   TCX_IMPORT_MAX_ELEMENTS elements;
// - at most one <Activities> with exactly one <Activity> and no <MultiSportSession>; the activity has exactly one <Id>
//   (a timestamp with a zone, checked and not stored) and 1 to TCX_IMPORT_MAX_LAPS <Lap> children;
// - every lap has a StartTime attribute with a zone and at most millisecond precision, starts strictly increase, and the
//   lap has exactly one <TotalTimeSeconds> and one <DistanceMeters>: decimal digits, an optional fraction and an optional
//   leading "+" (no minus sign, exponent, NaN or INF), at most TCX_IMPORT_MAX_TEXT_LENGTH characters;
// - GPS positions are never needed or read; tracks, heart rate, cadence, calories, notes, creator, author, courses,
//   workouts, folders and extensions are not read.

/** The largest accepted file, in bytes, before any decoding. The upload's request body is exactly the file. */
export const TCX_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const TCX_IMPORT_MAX_LAPS = 1_000;
/** The deepest element nesting accepted (the root is depth 1); a trackpoint extension value is about depth 9. */
export const TCX_IMPORT_MAX_DEPTH = 32;
/** Elements counted while reading, the root included; a 10 MiB file with heart rate and cadence has about 270 000. */
export const TCX_IMPORT_MAX_ELEMENTS = 500_000;
/** The longest value the reader keeps (Id, StartTime, TotalTimeSeconds, DistanceMeters), in characters. */
export const TCX_IMPORT_MAX_TEXT_LENGTH = 64;
/** The only accepted request Content-Type of the two upload routes (the IANA-registered TCX media type). */
export const TCX_IMPORT_CONTENT_TYPE = 'application/vnd.garmin.tcx+xml';
export const TCX_NAMESPACE_V2 = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';
/** The summary rules of ADR-0091. Change it when a definition below changes. */
export const TCX_IMPORT_METRICS_VERSION = 'tcx-summary-1';

/** Stable reasons for 422 TCX_UNSUPPORTED. A client may rely on a reason's meaning; the message may be reworded. */
export const TCX_UNSUPPORTED_REASONS = [
  'not_utf8',
  'not_xml',
  'malformed_xml',
  'declaration',
  'not_tcx',
  'not_tcx_v2',
  'too_deep',
  'too_many_elements',
  'structure',
  'activity_count',
  'multisport',
  'activity_id',
  'no_laps',
  'too_many_laps',
  'start_time_missing',
  'start_time_invalid',
  'lap_order',
  'field_missing',
  'field_duplicate',
  'number_invalid',
  'text_too_long',
  'start_before_minimum',
  'start_in_future',
  'duration_out_of_range',
  'distance_out_of_range',
] as const;
export const tcxUnsupportedReasonSchema = z.enum(TCX_UNSUPPORTED_REASONS);

export const TCX_UNSUPPORTED = 'TCX_UNSUPPORTED';
export const TCX_FILE_TOO_LARGE = 'TCX_FILE_TOO_LARGE';
export const TCX_ALREADY_IMPORTED = 'TCX_ALREADY_IMPORTED';

/** `details` of a 422 TCX_UNSUPPORTED. */
export const tcxUnsupportedDetailsSchema = z.strictObject({ reason: tcxUnsupportedReasonSchema });
/** `details` of a 413 TCX_FILE_TOO_LARGE. */
export const tcxFileTooLargeDetailsSchema = z.strictObject({ maxBytes: z.literal(TCX_IMPORT_MAX_BYTES) });
/**
 * `details` of a 409 TCX_ALREADY_IMPORTED: an existing TCX import of this person in this organization has the same laps
 * (starts, reported total times and distances; see the fingerprint in ADR-0091). Never a GPX import, a manual entry or a
 * recorded run. Deleting that activity frees the file for a new import.
 */
export const tcxAlreadyImportedDetailsSchema = z.strictObject({ activityId: uuidSchema });

/**
 * A non-negative decimal in canonical form: no sign, no leading zeros (except a single 0 before the point), no exponent,
 * and a fraction only when it has a non-zero last digit. An exact sum of lap values, never a binary approximation.
 */
export const tcxCanonicalDecimalSchema = z
  .string()
  .max(96)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u, 'Expected a canonical non-negative decimal');

/**
 * A canonical non-negative decimal rounded to the nearest integer, halves up (ADR-0091): the integer part plus one when
 * the first fraction digit is 5 or more. Exact for any length, because no binary conversion happens before rounding.
 */
export function tcxRoundHalfUp(decimal: string): number {
  const [whole, fraction = ''] = decimal.split('.');
  const value = Number(whole) + (fraction !== '' && fraction.charCodeAt(0) >= 0x35 ? 1 : 0);
  if (!Number.isSafeInteger(value)) throw new RangeError('The rounded value is too large');
  return value;
}

const roundsTo = (decimal: string, rounded: number) => {
  try {
    return tcxRoundHalfUp(decimal) === rounded;
  } catch {
    return false;
  }
};

/**
 * What the server computed from a file. Definitions (ADR-0091, `tcx-summary-1`):
 * - `startedAt`: the first lap's StartTime (UTC, millisecond precision). There is deliberately no end time: the laps report
 *   durations, not a span of the clock.
 * - `lapTotals.totalTimeSeconds`: the exact decimal sum of every lap's TotalTimeSeconds.
 * - `reportedDurationS`: that sum rounded once to the nearest second, halves up. It is the duration the laps REPORT: not
 *   GPX elapsed time, not a recorded run's observed duration, and not moving time (the format does not say whether pauses
 *   were excluded). Stored as the activity's `durationS`.
 * - `lapTotals.distanceMeters`: the exact decimal sum of every lap's DistanceMeters; `distanceM` is that sum rounded once
 *   to the nearest metre, halves up. Trackpoint positions and distances are never used.
 * - `lapCount`: the number of laps read.
 */
export const tcxImportSummarySchema = z
  .strictObject({
    distanceM: z.int().min(0).max(ACTIVITY_DISTANCE_MAX_M),
    lapCount: z.int().min(1).max(TCX_IMPORT_MAX_LAPS),
    lapTotals: z.strictObject({ distanceMeters: tcxCanonicalDecimalSchema, totalTimeSeconds: tcxCanonicalDecimalSchema }),
    metricsVersion: z.literal(TCX_IMPORT_METRICS_VERSION),
    reportedDurationS: z.int().min(1).max(ACTIVITY_DURATION_MAX_S),
    startedAt: timestampSchema,
  })
  .refine((summary) => roundsTo(summary.lapTotals.totalTimeSeconds, summary.reportedDurationS), {
    message: 'the reported duration is the lap time sum rounded half up',
    path: ['reportedDurationS'],
  })
  .refine((summary) => roundsTo(summary.lapTotals.distanceMeters, summary.distanceM), {
    message: 'the distance is the lap distance sum rounded half up',
    path: ['distanceM'],
  });

/**
 * 200 answer of the preview. Nothing was written. `duplicateOf` names an existing TCX import with the same laps at the
 * time of the preview (null when none); confirmation checks again, so it is advisory. It never names a GPX import, a
 * manual entry or a recorded run: a TCX import is not compared with them.
 */
export const tcxImportPreviewSchema = z.strictObject({
  duplicateOf: tcxAlreadyImportedDetailsSchema.nullable(),
  summary: tcxImportSummarySchema,
});

/**
 * Query of the confirmation `PUT /activities/{activityId}/tcx-import`. The body is the file itself. `idempotencyKey` is
 * one client-generated UUID per import attempt (ADR-0073), kept until a confirmed outcome; `type` is the person's choice
 * (the file's Sport is never used). Nothing else is accepted: no source, total or time.
 */
export const tcxImportConfirmQuerySchema = z.strictObject({
  idempotencyKey: uuidSchema,
  type: activityTypeSchema,
});

export type TcxUnsupportedReason = z.infer<typeof tcxUnsupportedReasonSchema>;
export type TcxImportSummary = z.infer<typeof tcxImportSummarySchema>;
export type TcxImportPreview = z.infer<typeof tcxImportPreviewSchema>;
export type TcxImportConfirmQuery = z.infer<typeof tcxImportConfirmQuerySchema>;
export type TcxAlreadyImportedDetails = z.infer<typeof tcxAlreadyImportedDetailsSchema>;
