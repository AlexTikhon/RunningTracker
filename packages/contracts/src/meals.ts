import { z } from 'zod';

import { DAILY_METRICS_LOCAL_DATE_MIN, dailyMetricsLocalDateSchema } from './daily-metrics.js';
import { canonicalFiniteNumber, cursorSchema, ianaTimeZoneSchema, localDateSchema, timestampSchema, uuidSchema } from './primitives.js';

// The manual meal log of the signed-in person (ADR-0083). One entry per meal or snack the person logged by hand for one
// local calendar date. Owner-only like check-ins and movement: no request carries an owner, an organization or a
// source; the server takes the owner from the session, the organization from the path, the identity from the database,
// and the provenance is always manual entry.
//
// Nutrition values are the person's own totals for the WHOLE entry: not per 100 g, not per serving. Every one of them is
// optional: a title-only entry is valid (people often know what they ate but not its nutrition). Missing (omitted or
// null) is unknown; a recorded 0 is a value. Nothing is looked up, parsed, estimated or interpreted.
//
// The date rules are the check-in's (ADR-0074): the same lower bound and the same "not after today in the person's zone
// by the server's clock" rule (checked by the service). The date and the zone of the first write never change.
export const MEAL_LOCAL_DATE_MIN = DAILY_METRICS_LOCAL_DATE_MIN;
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;
export const MEAL_SOURCES = ['manual'] as const;
export const MEAL_TITLE_MAX_LENGTH = 120;
// Technical bounds, not dietary judgements: they refuse typing slips and overflow, never a plausible entry. The same
// numbers are CHECK constraints of `meals` (migration 0039), as is the precision rule below.
export const MEAL_ENERGY_KCAL_MAX = 20_000;
export const MEAL_MACRONUTRIENT_G_MAX = 2_000;
// Every value is kept to one decimal. A value with a meaningful second decimal is refused, never rounded, so what is
// stored is exactly what was sent (unconstrained numeric with range and precision CHECK constraints in the database).
export const MEAL_VALUE_DECIMALS = 1;
export const MEAL_PAGE_MAX = 50;
export const MEAL_PAGE_DEFAULT = 20;
export const MEAL_NOT_FOUND = 'MEAL_NOT_FOUND';
// `details` of a 409 MEAL_ALREADY_SAVED: the entry this form session's idempotency key already created.
export const MEAL_ALREADY_SAVED = 'MEAL_ALREADY_SAVED';

/** The nutrition fields, in display order. Each is optional and independent of the others. */
export const MEAL_NUTRITION_FIELDS = ['energyKcal', 'proteinG', 'carbohydrateG', 'fatG'] as const;
export type MealNutritionField = (typeof MEAL_NUTRITION_FIELDS)[number];

/** The upper bound of each nutrition field (inclusive). The lower bound of every field is 0 (inclusive). */
export const MEAL_NUTRITION_MAX: Readonly<Record<MealNutritionField, number>> = {
  carbohydrateG: MEAL_MACRONUTRIENT_G_MAX,
  energyKcal: MEAL_ENERGY_KCAL_MAX,
  fatG: MEAL_MACRONUTRIENT_G_MAX,
  proteinG: MEAL_MACRONUTRIENT_G_MAX,
};

export const mealTypeSchema = z.enum(MEAL_TYPES);
export const mealSourceSchema = z.enum(MEAL_SOURCES);
export const mealLocalDateSchema = dailyMetricsLocalDateSchema;

/** True for a finite number with at most one meaningful decimal (412.5 and 412.50 pass, 412.55 does not). */
export function hasAtMostOneDecimal(value: number): boolean {
  return Math.round(value * 10) / 10 === value;
}

function nutritionValueSchema(max: number, label: string) {
  // JSON has no NaN or Infinity (1e309 parses to Infinity, which `finite()` refuses), and -0 is stored as 0.
  return z
    .number()
    .finite()
    .min(0)
    .max(max)
    .refine(hasAtMostOneDecimal, `${label} allows at most one decimal`)
    .overwrite(canonicalFiniteNumber);
}

export const mealEnergyKcalSchema = nutritionValueSchema(MEAL_ENERGY_KCAL_MAX, 'Food energy');
export const mealProteinGSchema = nutritionValueSchema(MEAL_MACRONUTRIENT_G_MAX, 'Protein');
export const mealCarbohydrateGSchema = nutritionValueSchema(MEAL_MACRONUTRIENT_G_MAX, 'Carbohydrate');
export const mealFatGSchema = nutritionValueSchema(MEAL_MACRONUTRIENT_G_MAX, 'Fat');

// As for activity notes and check-in notes: no NUL (PostgreSQL text cannot hold it) and no unpaired surrogate (it would
// be stored as U+FFFD, not as sent). Zod measures a string's length in Unicode code points, exactly as the database's
// char_length does, so both bounds agree (an emoji is one of the 120). A title must also say something: one of only
// whitespace is refused (any Unicode whitespace here; ASCII whitespace in the database, so this rule is the stricter).
export const mealTitleSchema = z
  .string()
  .min(1)
  .max(MEAL_TITLE_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, 'The title must not be blank')
  .refine((value) => !value.includes('\u0000'), 'The title must not contain NUL characters')
  .refine((value) => !/\p{Cs}/u.test(value), 'The title must be well-formed Unicode text');

const nutritionShape = {
  carbohydrateG: mealCarbohydrateGSchema.nullable().optional(),
  energyKcal: mealEnergyKcalSchema.nullable().optional(),
  fatG: mealFatGSchema.nullable().optional(),
  proteinG: mealProteinGSchema.nullable().optional(),
};

/**
 * A new entry. `localDate` must not be after today in `timeZone` by the server's clock; the zone is stored as the zone
 * of the first write. `idempotencyKey` is one client-generated UUID per form session (ADR-0073 pattern): the same key
 * with the same request returns the entry it created (200), the same key with a different request is
 * 409 MEAL_ALREADY_SAVED and stores nothing. Omitted and null nutrition values are the same: unknown. Unknown fields (an
 * id, an owner, an organization, a source) are refused.
 */
export const createMealRequestSchema = z.strictObject({
  ...nutritionShape,
  idempotencyKey: uuidSchema,
  localDate: mealLocalDateSchema,
  mealType: mealTypeSchema,
  timeZone: ianaTimeZoneSchema,
  title: mealTitleSchema,
});

/**
 * A full replacement of the editable fields: meal type, title and the four values (omitted = null = unknown). The date,
 * the zone, the identity and the creation instant cannot be changed, so a request naming them is refused.
 */
export const updateMealRequestSchema = z.strictObject({
  ...nutritionShape,
  mealType: mealTypeSchema,
  title: mealTitleSchema,
});

export const mealViewSchema = z.strictObject({
  carbohydrateG: mealCarbohydrateGSchema.nullable(),
  createdAt: timestampSchema,
  energyKcal: mealEnergyKcalSchema.nullable(),
  fatG: mealFatGSchema.nullable(),
  localDate: localDateSchema,
  mealId: uuidSchema,
  mealType: mealTypeSchema,
  proteinG: mealProteinGSchema.nullable(),
  // Server-owned provenance.
  source: mealSourceSchema,
  // The zone of the first write. Shape only: a client may not know every zone name the server's platform knows.
  timeZone: z.string().min(1).max(64),
  title: z.string().min(1).max(MEAL_TITLE_MAX_LENGTH),
  updatedAt: timestampSchema,
});

export const mealPathSchema = z.strictObject({ mealId: uuidSchema, orgId: uuidSchema });

/** One local date's entries, oldest first (the order they were logged), a bounded page at a time. */
export const mealListQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.int().min(1).max(MEAL_PAGE_MAX))
    .optional(),
  localDate: mealLocalDateSchema,
});

export const mealListResponseSchema = z.strictObject({
  items: z.array(mealViewSchema).max(MEAL_PAGE_MAX),
  nextCursor: cursorSchema.nullable(),
});

// The decoded content of `nextCursor`. Opaque to clients; documented so the server's checks are explicit. `context` is
// a digest of the person, the organization and the date, so a cursor from another person, organization or date is
// refused.
export const mealCursorSchema = z.strictObject({
  context: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  // Microsecond precision, as PostgreSQL stores it, so the keyset comparison is exact.
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
  mealId: uuidSchema,
  version: z.literal(1),
});

export const mealAlreadySavedDetailsSchema = z.strictObject({ mealId: uuidSchema });

export type MealType = z.infer<typeof mealTypeSchema>;
export type MealSource = z.infer<typeof mealSourceSchema>;
export type CreateMealRequest = z.infer<typeof createMealRequestSchema>;
export type UpdateMealRequest = z.infer<typeof updateMealRequestSchema>;
export type MealView = z.infer<typeof mealViewSchema>;
export type MealPath = z.infer<typeof mealPathSchema>;
export type MealListQuery = z.infer<typeof mealListQuerySchema>;
export type MealListResponse = z.infer<typeof mealListResponseSchema>;
export type MealCursor = z.infer<typeof mealCursorSchema>;
export type MealAlreadySavedDetails = z.infer<typeof mealAlreadySavedDetailsSchema>;
