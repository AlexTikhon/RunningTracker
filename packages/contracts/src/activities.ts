import { z } from 'zod';

import { canonicalFiniteNumber, cursorSchema, timestampSchema, uuidSchema } from './primitives.js';

// Activities of the signed-in person (ADR-0072): entered manually, or imported from a GPX (ADR-0086) or TCX (ADR-0091)
// file. Owner-only:
// no request carries an owner, an organization or a source; the server takes the owner from the session, the
// organization from the path and the source from the route that created the activity.
export const ACTIVITY_TYPES = ['run', 'walk', 'ride', 'hike', 'swim', 'strength', 'other'] as const;
// `manual`: entered in the form (PUT /activities/{id}). `gpx`: imported from a GPX file (ADR-0086); its `durationS` is the
// elapsed time from the first to the last point, pauses included, and its `distanceM` was computed by the server. `tcx`:
// imported from a TCX file (ADR-0091); its `durationS` is the REPORTED duration, the sum of the laps' TotalTimeSeconds
// rounded once (neither elapsed nor moving time), and its `distanceM` the sum of the laps' DistanceMeters rounded once.
export const ACTIVITY_SOURCES = ['manual', 'gpx', 'tcx'] as const;
export const ACTIVITY_DURATION_MAX_S = 172_800;
export const ACTIVITY_DISTANCE_MAX_M = 1_000_000;
export const ACTIVITY_NOTES_MAX_LENGTH = 1_000;
export const ACTIVITY_RPE_MIN = 1;
export const ACTIVITY_RPE_MAX = 10;
// A static lower bound, also a database CHECK. The "not too far in the future" rule depends on the server clock and
// is applied by the service only (ADR-0072): a CHECK using now() would be revalidated against another clock on restore.
export const ACTIVITY_STARTED_AT_MIN = '2000-01-01T00:00:00.000Z';
export const ACTIVITY_FUTURE_SKEW_MS = 24 * 60 * 60 * 1_000;
export const ACTIVITY_PAGE_MAX = 50;
export const ACTIVITY_PAGE_DEFAULT = 20;

export const activityTypeSchema = z.enum(ACTIVITY_TYPES);
export const activitySourceSchema = z.enum(ACTIVITY_SOURCES);

const startedAtMinMs = Date.parse(ACTIVITY_STARTED_AT_MIN);

export const activityStartedAtSchema = timestampSchema.refine(
  (value) => Date.parse(value) >= startedAtMinMs,
  `startedAt must not be before ${ACTIVITY_STARTED_AT_MIN}`,
);
export const activityDurationSchema = z.int().min(1).max(ACTIVITY_DURATION_MAX_S);
export const activityDistanceSchema = z
  .number()
  .finite()
  .min(0)
  .max(ACTIVITY_DISTANCE_MAX_M)
  .overwrite(canonicalFiniteNumber);
export const activityRpeSchema = z.int().min(ACTIVITY_RPE_MIN).max(ACTIVITY_RPE_MAX);
// PostgreSQL text cannot hold NUL, and an unpaired surrogate would be stored as U+FFFD, not as sent. The length is in
// UTF-16 code units, never fewer than the code points the database CHECK counts, so this bound is the stricter one.
export const activityNotesSchema = z
  .string()
  .min(1)
  .max(ACTIVITY_NOTES_MAX_LENGTH)
  .refine((value) => !value.includes('\u0000'), 'Notes must not contain NUL characters')
  .refine((value) => !/\p{Cs}/u.test(value), 'Notes must be well-formed Unicode text');

// Omitted and null are the same value for the optional fields. `idempotencyKey` (ADR-0073) is one client-generated UUID
// per form session: a second save from the same session never creates a second activity. It is not part of the
// activity's details and is not returned.
export const createActivityRequestSchema = z.strictObject({
  distanceM: activityDistanceSchema.nullable().optional(),
  durationS: activityDurationSchema,
  idempotencyKey: uuidSchema,
  notes: activityNotesSchema.nullable().optional(),
  rpe: activityRpeSchema.nullable().optional(),
  startedAt: activityStartedAtSchema,
  type: activityTypeSchema,
});

export const activityViewSchema = z.strictObject({
  activityId: uuidSchema,
  createdAt: timestampSchema,
  distanceM: activityDistanceSchema.nullable(),
  durationS: activityDurationSchema,
  notes: z.string().min(1).max(ACTIVITY_NOTES_MAX_LENGTH).nullable(),
  rpe: activityRpeSchema.nullable(),
  source: activitySourceSchema,
  startedAt: timestampSchema,
  type: activityTypeSchema,
});

export const activityPathSchema = z.strictObject({ activityId: uuidSchema, orgId: uuidSchema });

// `details` of a 409 ACTIVITY_ALREADY_SAVED: the activity that the same idempotency key already created, so the client
// can tell the person their earlier save went through and open it.
export const ACTIVITY_ALREADY_SAVED = 'ACTIVITY_ALREADY_SAVED';
export const activityAlreadySavedDetailsSchema = z.strictObject({ activityId: uuidSchema });

export const activityListQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.int().min(1).max(ACTIVITY_PAGE_MAX))
    .optional(),
});

export const activityListResponseSchema = z.strictObject({
  items: z.array(activityViewSchema).max(ACTIVITY_PAGE_MAX),
  nextCursor: cursorSchema.nullable(),
});

// The decoded content of `nextCursor`. Opaque to clients; documented so the server's checks are explicit. `context`
// is a digest of the person and the organization, so a cursor from another person or organization is refused.
export const activityCursorSchema = z.strictObject({
  activityId: uuidSchema,
  context: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  // Microsecond precision, as PostgreSQL stores it, so the keyset comparison is exact.
  startedAt: timestampSchema,
  version: z.literal(1),
});

export type ActivityType = z.infer<typeof activityTypeSchema>;
export type ActivitySource = z.infer<typeof activitySourceSchema>;
export type CreateActivityRequest = z.infer<typeof createActivityRequestSchema>;
export type ActivityView = z.infer<typeof activityViewSchema>;
export type ActivityPath = z.infer<typeof activityPathSchema>;
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
export type ActivityListResponse = z.infer<typeof activityListResponseSchema>;
export type ActivityCursor = z.infer<typeof activityCursorSchema>;
export type ActivityAlreadySavedDetails = z.infer<typeof activityAlreadySavedDetailsSchema>;
