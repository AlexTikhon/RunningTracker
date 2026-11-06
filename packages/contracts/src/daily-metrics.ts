import { z } from 'zod';

import { ianaTimeZoneSchema, localDateSchema, parseLocalDate, timestampSchema, uuidSchema } from './primitives.js';

// Daily check-in values of the signed-in person (ADR-0074). Owner-only like activities: no request carries an owner or
// an organization; the server takes the owner from the session and the organization from the path. One record per
// person per local calendar date, replaced as a whole by PUT.
export const DAILY_METRICS_LOCAL_DATE_MIN = '2000-01-01';
export const DAILY_METRICS_RANGE_MAX_DAYS = 92;
export const DAILY_METRICS_WEIGHT_MIN_KG = 20;
export const DAILY_METRICS_WEIGHT_MAX_KG = 400;
export const DAILY_METRICS_SLEEP_MAX_MINUTES = 1_440;
export const DAILY_METRICS_SCALE_MIN = 1;
export const DAILY_METRICS_SCALE_MAX = 5;
export const DAILY_METRICS_SORENESS_MAX = 10;
export const DAILY_METRICS_NOTE_MAX_LENGTH = 500;
export const DAILY_METRICS_NOT_FOUND = 'DAILY_METRICS_NOT_FOUND';

/** The value fields, in a fixed order. A request must carry at least one of them as a non-null value. */
export const DAILY_METRICS_VALUE_FIELDS = ['weightKg', 'sleepMinutes', 'sleepQuality', 'mood', 'soreness', 'note'] as const;

const DAY_MS = 86_400_000;

function utcDayNumber(value: string): number {
  const parsed = parseLocalDate(value);
  if (parsed === null) throw new RangeError(`Not a calendar date: ${value}`);
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day) / DAY_MS;
}

/** Calendar arithmetic on YYYY-MM-DD dates; a calendar day is not a fixed number of hours anywhere but here. */
export function addLocalDays(value: string, days: number): string {
  return new Date((utcDayNumber(value) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Number of calendar days from `from` to `to`, both included (1 for the same date). */
export function localDateSpanDays(from: string, to: string): number {
  return utcDayNumber(to) - utcDayNumber(from) + 1;
}

// A date as the person read it on their calendar. YYYY-MM-DD compares correctly as text. The upper bound ("not after
// today in the person's zone") depends on the server's clock and is checked by the service only.
export const dailyMetricsLocalDateSchema = localDateSchema.refine(
  (value) => value >= DAILY_METRICS_LOCAL_DATE_MIN,
  `The date must not be before ${DAILY_METRICS_LOCAL_DATE_MIN}`,
);

// numeric(5,2) in the database: at most two decimals, so a value is stored exactly as sent.
export const dailyWeightKgSchema = z
  .number()
  .finite()
  .min(DAILY_METRICS_WEIGHT_MIN_KG)
  .max(DAILY_METRICS_WEIGHT_MAX_KG)
  .refine((value) => Math.round(value * 100) / 100 === value, 'Weight allows at most two decimals');
export const dailySleepMinutesSchema = z.int().min(0).max(DAILY_METRICS_SLEEP_MAX_MINUTES);
export const dailySleepQualitySchema = z.int().min(DAILY_METRICS_SCALE_MIN).max(DAILY_METRICS_SCALE_MAX);
export const dailyMoodSchema = z.int().min(DAILY_METRICS_SCALE_MIN).max(DAILY_METRICS_SCALE_MAX);
export const dailySorenessSchema = z.int().min(0).max(DAILY_METRICS_SORENESS_MAX);
// As for activity notes: no NUL (PostgreSQL text cannot hold it), no unpaired surrogate, and a length in UTF-16 code
// units, never fewer than the code points the database CHECK counts.
export const dailyNoteSchema = z
  .string()
  .min(1)
  .max(DAILY_METRICS_NOTE_MAX_LENGTH)
  .refine((value) => !value.includes('\u0000'), 'The note must not contain NUL characters')
  .refine((value) => !/\p{Cs}/u.test(value), 'The note must be well-formed Unicode text');

/**
 * A full replacement of one day's values. Omitted and null are the same: a field left out is cleared. `timeZone` is the
 * IANA zone the person is in now; the server uses it, with its own clock, to refuse a date after today, and stores it
 * only when the day is first written.
 */
export const putDailyMetricsRequestSchema = z
  .strictObject({
    mood: dailyMoodSchema.nullable().optional(),
    note: dailyNoteSchema.nullable().optional(),
    sleepMinutes: dailySleepMinutesSchema.nullable().optional(),
    sleepQuality: dailySleepQualitySchema.nullable().optional(),
    soreness: dailySorenessSchema.nullable().optional(),
    timeZone: ianaTimeZoneSchema,
    weightKg: dailyWeightKgSchema.nullable().optional(),
  })
  .refine(
    (request) => DAILY_METRICS_VALUE_FIELDS.some((field) => request[field] !== undefined && request[field] !== null),
    'At least one of weightKg, sleepMinutes, sleepQuality, mood, soreness or note is required',
  );

export const dailyMetricsViewSchema = z.strictObject({
  createdAt: timestampSchema,
  localDate: localDateSchema,
  mood: dailyMoodSchema.nullable(),
  note: z.string().min(1).max(DAILY_METRICS_NOTE_MAX_LENGTH).nullable(),
  sleepMinutes: dailySleepMinutesSchema.nullable(),
  sleepQuality: dailySleepQualitySchema.nullable(),
  soreness: dailySorenessSchema.nullable(),
  // The zone of the first write. Shape only: a client may not know every zone name the server's platform knows.
  timeZone: z.string().min(1).max(64),
  updatedAt: timestampSchema,
  weightKg: dailyWeightKgSchema.nullable(),
});

export const dailyMetricsPathSchema = z.strictObject({ localDate: dailyMetricsLocalDateSchema, orgId: uuidSchema });

// Both bounds are inclusive local dates; at most DAILY_METRICS_RANGE_MAX_DAYS days per request.
export const dailyMetricsListQuerySchema = z
  .strictObject({ from: dailyMetricsLocalDateSchema, to: dailyMetricsLocalDateSchema })
  .refine((query) => query.from <= query.to, { message: '`from` must not be after `to`', path: ['to'] })
  .refine(
    (query) =>
      parseLocalDate(query.from) === null ||
      parseLocalDate(query.to) === null ||
      query.from > query.to ||
      localDateSpanDays(query.from, query.to) <= DAILY_METRICS_RANGE_MAX_DAYS,
    {
      message: `At most ${DAILY_METRICS_RANGE_MAX_DAYS} days per request`,
      path: ['to'],
    },
  );

// Days that have values only, ordered by date ascending. A day without a record is absent, not null.
export const dailyMetricsListResponseSchema = z.strictObject({
  items: z.array(dailyMetricsViewSchema).max(DAILY_METRICS_RANGE_MAX_DAYS),
});

export type PutDailyMetricsRequest = z.infer<typeof putDailyMetricsRequestSchema>;
export type DailyMetricsView = z.infer<typeof dailyMetricsViewSchema>;
export type DailyMetricsPath = z.infer<typeof dailyMetricsPathSchema>;
export type DailyMetricsListQuery = z.infer<typeof dailyMetricsListQuerySchema>;
export type DailyMetricsListResponse = z.infer<typeof dailyMetricsListResponseSchema>;
