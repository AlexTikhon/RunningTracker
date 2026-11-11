import { z } from 'zod';

import {
  ACTIVITY_NOTES_MAX_LENGTH,
  activityDistanceSchema,
  activityDurationSchema,
  activityRpeSchema,
  activityTypeSchema,
} from './activities.js';
import { dailyMetricsLocalDateSchema } from './daily-metrics.js';
import { gpsQualitySchema } from './http.js';
import { cursorSchema, ianaTimeZoneSchema, timestampSchema, uuidSchema } from './primitives.js';

// The unified activity history (ADR-0087): one chronological, read-only list of the signed-in person's own manual
// activities, GPX-imported activities and finished recorded (GPS) runs. It is read from the existing tables on every
// request and never stored. Owner-only: no request carries an owner, and a run another person shared never appears.
//
// Each item says where it came from (`source`), and each source names its duration for what it is, so the three
// cannot be confused or added together by accident:
// - `manual`: `enteredDurationS`, what the person typed;
// - `gpx`: `elapsedDurationS`, first to last point of the file, pauses included (ADR-0086);
// - `recorded_run`: `observedDurationS`, the sum of accepted GPS edges, from a summary current for the run's data
//   (ADR-0013, ADR-0056), or no metric at all when that summary is missing or stale.
//
// Versions of the response's meaning:
// - `activity-history-1`: ADR-0087.
// - `activity-history-2`: ADR-0088 adds the optional local calendar day filter (`localDate` with `timeZone`) and echoes
//   it, with its UTC interval, as `applied.day` (null without the filter). Every item keeps its meaning.
export const ACTIVITY_HISTORY_VERSION = 'activity-history-2';
export const ACTIVITY_HISTORY_SOURCES = ['manual', 'gpx', 'recorded_run'] as const;
export const ACTIVITY_HISTORY_PAGE_MAX = 50;
export const ACTIVITY_HISTORY_PAGE_DEFAULT = 20;

export const activityHistorySourceSchema = z.enum(ACTIVITY_HISTORY_SOURCES);

// Filters are single-valued: omitted means every source or every type. A repeated parameter arrives as an array and is
// refused like any other invalid value. A recorded run is a run, so `type` other than `run` excludes recorded runs.
//
// The day filter (ADR-0088) is a pair: `localDate` (a real calendar date, 2000-01-01 or later) and the IANA `timeZone`
// it is read in. Both or neither: one without the other is refused, never completed with a default. With it, the page
// holds the items that STARTED in [start of that date, start of the next date) in that zone, Today's attribution rule
// (ADR-0082); without it, the whole history, as before.
export const activityHistoryQuerySchema = z
  .strictObject({
    cursor: cursorSchema.optional(),
    limit: z
      .string()
      .regex(/^\d+$/u)
      .transform(Number)
      .pipe(z.int().min(1).max(ACTIVITY_HISTORY_PAGE_MAX))
      .optional(),
    localDate: dailyMetricsLocalDateSchema.optional(),
    source: activityHistorySourceSchema.optional(),
    timeZone: ianaTimeZoneSchema.optional(),
    type: activityTypeSchema.optional(),
  })
  .refine((query) => (query.localDate === undefined) === (query.timeZone === undefined), {
    message: '`localDate` and `timeZone` must be given together or not at all',
    path: ['timeZone'],
  });

/**
 * The day a page of the history is filtered to (ADR-0088): the requested date, the zone in the server's canonical
 * spelling, and the half-open UTC interval it was read as. `endsAt` is the start of the next calendar date in the zone,
 * not `startsAt` plus 24 hours: 23 or 25 hours around a daylight saving change.
 */
export const activityHistoryDaySchema = z
  .strictObject({
    /** The first instant of the next date in `timeZone` (exclusive). */
    endsAt: timestampSchema,
    localDate: dailyMetricsLocalDateSchema,
    /** The first instant of the date in `timeZone` (inclusive). */
    startsAt: timestampSchema,
    timeZone: z.string().min(1).max(64),
  })
  .refine((day) => Date.parse(day.startsAt) <= Date.parse(day.endsAt), {
    message: 'the day cannot end before it starts',
    path: ['endsAt'],
  });

export const manualHistoryItemSchema = z.strictObject({
  activityId: uuidSchema,
  distanceM: activityDistanceSchema.nullable(),
  // The full duration the person entered.
  enteredDurationS: activityDurationSchema,
  notes: z.string().min(1).max(ACTIVITY_NOTES_MAX_LENGTH).nullable(),
  rpe: activityRpeSchema.nullable(),
  source: z.literal('manual'),
  startedAt: timestampSchema,
  type: activityTypeSchema,
});

export const gpxHistoryItemSchema = z.strictObject({
  activityId: uuidSchema,
  // Computed by the server from the file at import (gpx-summary-1).
  distanceM: activityDistanceSchema.nullable(),
  // From the first to the last point, pauses and gaps included: elapsed time, not moving time.
  elapsedDurationS: activityDurationSchema,
  source: z.literal('gpx'),
  startedAt: timestampSchema,
  type: activityTypeSchema,
});

// A published summary whose source revision equals the run's current data revision (the check of ADR-0015 used by
// run search, run details and Today). Only then are metrics returned.
export const currentRunSummarySchema = z.strictObject({
  distanceM: z.number().finite().nonnegative(),
  gpsQuality: gpsQualitySchema,
  // The sum of the durations of accepted GPS edges: excludes pauses, gaps and rejected stretches; not moving time.
  observedDurationS: z.number().finite().nonnegative(),
  state: z.literal('current'),
});

// `pending`: no summary has been published yet. `stale`: the published summary was made for an older data revision.
// Either way the metrics are unknown, never zero and never the old values.
export const unknownRunSummarySchema = z.strictObject({ state: z.enum(['pending', 'stale']) });

export const recordedRunHistoryItemSchema = z.strictObject({
  // Which capture source (device GPS or the simulator) recorded the run is chosen and kept in the browser only
  // (ADR-0011, ADR-0047); the server has never stored it, so it is null: unknown, never guessed from the points.
  captureSource: z.null(),
  finishedAt: timestampSchema,
  runId: uuidSchema,
  source: z.literal('recorded_run'),
  startedAt: timestampSchema,
  summary: z.discriminatedUnion('state', [currentRunSummarySchema, unknownRunSummarySchema]),
  type: z.literal('run'),
});

export const activityHistoryItemSchema = z.discriminatedUnion('source', [
  manualHistoryItemSchema,
  gpxHistoryItemSchema,
  recordedRunHistoryItemSchema,
]);

export const activityHistoryResponseSchema = z.strictObject({
  // The filters the page belongs to; null means not filtered.
  applied: z.strictObject({
    day: activityHistoryDaySchema.nullable(),
    source: activityHistorySourceSchema.nullable(),
    type: activityTypeSchema.nullable(),
  }),
  // Newest start first; at an equal start a recorded run before an activity; then by id, descending.
  items: z.array(activityHistoryItemSchema).max(ACTIVITY_HISTORY_PAGE_MAX),
  nextCursor: cursorSchema.nullable(),
  provenance: z.strictObject({
    historyVersion: z.literal(ACTIVITY_HISTORY_VERSION),
    persisted: z.literal(false),
    snapshot: z.literal('single_read_only_transaction'),
  }),
});

// The keyset start of a cursor: microsecond precision, as PostgreSQL stores it, so the keyset comparison is exact. It
// is kept as the string the server wrote and sent to PostgreSQL as is, never converted through a JavaScript Date (which
// would drop the microseconds). The shared timestamp check refuses impossible calendar dates (February 30, February 29
// of a common year, April 31) and clock values (24:00, :60), which Date.parse would quietly roll over and PostgreSQL
// would refuse with an error. On top of it: exactly six fraction digits and UTC `Z`, and no year 0000, which the ISO
// check allows and PostgreSQL rejects.
export const activityHistoryCursorStartedAtSchema = timestampSchema
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u, 'Expected a UTC timestamp with six fraction digits')
  .refine((value) => !value.startsWith('0000-'), 'Expected a year from 0001, as PostgreSQL accepts');

// The decoded content of `nextCursor`. Opaque to clients; documented so the server's checks are explicit. `kind` and
// `id` break ties between items that started at the same microsecond, also between an activity and a run that happen
// to share an id. `context` is a digest of the person, the organization, both filters and, when there is one, the day
// filter (date and canonical zone), so a cursor from another person, organization, filter, date or zone is refused.
export const activityHistoryCursorSchema = z.strictObject({
  context: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  id: uuidSchema,
  kind: z.enum(['activity', 'run']),
  startedAt: activityHistoryCursorStartedAtSchema,
  version: z.literal(1),
});

export type ActivityHistorySource = z.infer<typeof activityHistorySourceSchema>;
export type ActivityHistoryQuery = z.infer<typeof activityHistoryQuerySchema>;
export type ActivityHistoryItem = z.infer<typeof activityHistoryItemSchema>;
export type ManualHistoryItem = z.infer<typeof manualHistoryItemSchema>;
export type GpxHistoryItem = z.infer<typeof gpxHistoryItemSchema>;
export type RecordedRunHistoryItem = z.infer<typeof recordedRunHistoryItemSchema>;
export type ActivityHistoryDay = z.infer<typeof activityHistoryDaySchema>;
export type ActivityHistoryResponse = z.infer<typeof activityHistoryResponseSchema>;
export type ActivityHistoryCursor = z.infer<typeof activityHistoryCursorSchema>;
