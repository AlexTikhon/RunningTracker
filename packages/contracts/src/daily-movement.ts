import { z } from 'zod';

import {
  DAILY_METRICS_LOCAL_DATE_MIN,
  DAILY_METRICS_RANGE_MAX_DAYS,
  dailyMetricsLocalDateSchema,
  localDateSpanDays,
} from './daily-metrics.js';
import { ianaTimeZoneSchema, localDateSchema, parseLocalDate, timestampSchema, uuidSchema } from './primitives.js';

// Daily movement of the signed-in person (ADR-0078): steps and active energy entered by hand for one local calendar
// date. Owner-only like check-ins: no request carries an owner, an organization or a source; the server takes the
// owner from the session, the organization from the path, and the provenance is always manual entry. One manual record
// per person per local date, replaced as a whole by PUT. Separate from daily metrics, whose PUT replaces the check-in.
//
// The date rules are the check-in's (ADR-0074), shared on purpose: the same lower bound, the same range cap and the
// same "not after today in the person's zone by the server's clock" rule (checked by the service).
export const DAILY_MOVEMENT_LOCAL_DATE_MIN = DAILY_METRICS_LOCAL_DATE_MIN;
export const DAILY_MOVEMENT_RANGE_MAX_DAYS = DAILY_METRICS_RANGE_MAX_DAYS;
// Technical bounds, not health judgements: they refuse typing slips and overflow, never a plausible day. The same
// numbers are CHECK constraints of daily_movement (migration 0033).
export const DAILY_MOVEMENT_STEPS_MAX = 200_000;
export const DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL = 20_000;
// Active energy is kept to 0.1 kcal. A value with more decimals is refused, never rounded, so what is stored is exactly
// what was sent. The database states the same rule (migration 0035: an unconstrained numeric with range and precision
// CHECK constraints, because a numeric(6,1) column rounded a value before its CHECK constraints ran).
export const DAILY_MOVEMENT_ACTIVE_ENERGY_DECIMALS = 1;
export const DAILY_MOVEMENT_NOT_FOUND = 'DAILY_MOVEMENT_NOT_FOUND';

/** Where the values came from. Only manual entry exists; it is set by the server, never by a request. */
export const dailyMovementSources = ['manual'] as const;
export type DailyMovementSource = (typeof dailyMovementSources)[number];

/** The value fields, in a fixed order. A request must carry at least one of them as a non-null value. */
export const DAILY_MOVEMENT_VALUE_FIELDS = ['steps', 'activeEnergyKcal'] as const;

export const dailyMovementLocalDateSchema = dailyMetricsLocalDateSchema;

// A recorded 0 is a value ("I did not walk"); null is unknown.
export const dailyStepsSchema = z.int().min(0).max(DAILY_MOVEMENT_STEPS_MAX);

// User-reported active energy in kilocalories: not resting energy, total expenditure or food intake. JSON has no NaN
// or Infinity, and `finite()` refuses them for any other caller.
export const dailyActiveEnergyKcalSchema = z
  .number()
  .finite()
  .min(0)
  .max(DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL)
  .refine((value) => Math.round(value * 10) / 10 === value, 'Active energy allows at most one decimal');

/**
 * A full replacement of one day's manual movement. Omitted and null are the same: a field left out is cleared.
 * `timeZone` is the IANA zone the person is in now; the server uses it, with its own clock, to refuse a date after
 * today, and stores it only when the day is first written. Unknown fields (an owner, a source, a date) are refused.
 */
export const putDailyMovementRequestSchema = z
  .strictObject({
    activeEnergyKcal: dailyActiveEnergyKcalSchema.nullable().optional(),
    steps: dailyStepsSchema.nullable().optional(),
    timeZone: ianaTimeZoneSchema,
  })
  .refine(
    (request) => DAILY_MOVEMENT_VALUE_FIELDS.some((field) => request[field] !== undefined && request[field] !== null),
    'At least one of steps or activeEnergyKcal is required',
  );

export const dailyMovementViewSchema = z
  .strictObject({
    activeEnergyKcal: dailyActiveEnergyKcalSchema.nullable(),
    createdAt: timestampSchema,
    localDate: localDateSchema,
    // Server-owned provenance.
    source: z.enum(dailyMovementSources),
    steps: dailyStepsSchema.nullable(),
    // The zone of the first write. Shape only: a client may not know every zone name the server's platform knows.
    timeZone: z.string().min(1).max(64),
    updatedAt: timestampSchema,
  })
  .refine((view) => view.steps !== null || view.activeEnergyKcal !== null, 'A stored day has at least one value');

export const dailyMovementPathSchema = z.strictObject({ localDate: dailyMovementLocalDateSchema, orgId: uuidSchema });

// Both bounds are inclusive local dates; at most DAILY_MOVEMENT_RANGE_MAX_DAYS days per request.
export const dailyMovementListQuerySchema = z
  .strictObject({ from: dailyMovementLocalDateSchema, to: dailyMovementLocalDateSchema })
  .refine((query) => query.from <= query.to, { message: '`from` must not be after `to`', path: ['to'] })
  .refine(
    (query) =>
      parseLocalDate(query.from) === null ||
      parseLocalDate(query.to) === null ||
      query.from > query.to ||
      localDateSpanDays(query.from, query.to) <= DAILY_MOVEMENT_RANGE_MAX_DAYS,
    {
      message: `At most ${DAILY_MOVEMENT_RANGE_MAX_DAYS} days per request`,
      path: ['to'],
    },
  );

// Days that have a record only, ordered by date ascending. A day without a record is absent, not null.
export const dailyMovementListResponseSchema = z.strictObject({
  items: z.array(dailyMovementViewSchema).max(DAILY_MOVEMENT_RANGE_MAX_DAYS),
});

export type PutDailyMovementRequest = z.infer<typeof putDailyMovementRequestSchema>;
export type DailyMovementView = z.infer<typeof dailyMovementViewSchema>;
export type DailyMovementPath = z.infer<typeof dailyMovementPathSchema>;
export type DailyMovementListQuery = z.infer<typeof dailyMovementListQuerySchema>;
export type DailyMovementListResponse = z.infer<typeof dailyMovementListResponseSchema>;
