import { z } from 'zod';

import {
  MEAL_NUTRITION_FIELDS,
  mealCarbohydrateGSchema,
  mealEnergyKcalSchema,
  mealFatGSchema,
  mealLocalDateSchema,
  mealProteinGSchema,
  mealTitleSchema,
  mealTypeSchema,
  type MealNutritionField,
} from './meals.js';
import { hasControlCharacter, ianaTimeZoneSchema } from './primitives.js';

// "Draft from text" for the Meal log (ADR-0092). The person describes ONE meal in their own words; a local language
// model extracts EVIDENCE from that text, the server checks every piece of it deterministically, and the answer is a
// proposal for the existing meal form. Nothing is stored: the person reviews the proposal, may apply it to the form,
// edits it, and saves through the existing create endpoint (ADR-0083), whose provenance stays `manual`.
//
// What the model may never do, and the server enforces: choose or change the date or the zone (they are the form's,
// sent here only so the server applies its date rules and binds the answer to them; the model never sees them), estimate
// or look up nutrition, multiply, convert units, derive energy from macronutrients, or round. A proposed value is a
// number that the person wrote, next to its unit and its nutrient, in an excerpt of their own text that the server found
// and parsed itself. Anything else is not proposed: missing stays null, and an explicit 0 stays 0.

/** The version of this request/proposal pair. A new shape gets a new version; nothing is silently reinterpreted. */
export const MEAL_DRAFT_CONTRACT_VERSION = 'meal-draft-1';
/** At most this many Unicode code points of text. Nothing is cut off: longer text is refused. */
export const MEAL_DRAFT_TEXT_MAX = 500;
/**
 * The longest deadline a server may give the model call (its MEAL_DRAFTS_TIMEOUT_MS is at most this). A client waits
 * this plus a margin for the answer, so the server's 504 arrives before the client gives up. A local model on a CPU needs
 * far longer than the 15 s an ordinary request gets.
 */
export const MEAL_DRAFT_DEADLINE_MAX_MS = 55_000;
/** How long a client waits for one proposal: the deadline above plus time to check access and answer. */
export const MEAL_DRAFT_CLIENT_WAIT_MS = MEAL_DRAFT_DEADLINE_MAX_MS + 5_000;
/** The longest evidence excerpt the server returns (code points). */
export const MEAL_DRAFT_EXCERPT_MAX = 160;

const mealDraftTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'The text must not be empty')
  .refine((value) => [...value].length <= MEAL_DRAFT_TEXT_MAX, `The text must not exceed ${MEAL_DRAFT_TEXT_MAX} characters`)
  .refine((value) => !hasControlCharacter(value), 'The text must not contain control characters')
  .refine((value) => !/\p{Cs}/u.test(value), 'The text must be well-formed Unicode text');

/**
 * One proposal request. `localDate` and `timeZone` are the form's: the server applies the meal log's date rules to them
 * (not before 2000-01-01, not after today in the zone by the server clock) and echoes them, canonical, in the answer, so
 * a client can refuse an answer made for another date. Unknown fields are refused.
 */
export const mealDraftProposalRequestSchema = z.strictObject({
  localDate: mealLocalDateSchema,
  text: mealDraftTextSchema,
  timeZone: ianaTimeZoneSchema,
  version: z.literal(MEAL_DRAFT_CONTRACT_VERSION),
});

/** An exact excerpt of the person's text, as the server located it there. Never text the model wrote. */
export const mealDraftExcerptSchema = z.string().min(1).max(MEAL_DRAFT_EXCERPT_MAX);

/**
 * Why a nutrition field is not proposed although the text may mention it. Bounded codes; the screen owns the wording.
 *
 * - `per_portion`: given per 100 g, per serving, per piece, "each", or it would need multiplying or adding;
 * - `conflicting`: the text gives different values for it;
 * - `negated`: the text says it is not, or was not, that value;
 * - `ambiguous`: approximate, a range, a bound, or a number that could be read two ways (1,200);
 * - `unit_not_supported`: another unit (kJ, mg, oz, %) or no unit, which is never guessed;
 * - `outside_contract`: more than one decimal, negative, or beyond the meal log's bounds; never rounded or clamped;
 * - `unverified`: the model's evidence did not check out against the text (not an excerpt, another number, a food
 *   quantity rather than the nutrient, no unit next to the number).
 */
export const MEAL_DRAFT_WITHHELD_REASONS = [
  'per_portion',
  'conflicting',
  'negated',
  'ambiguous',
  'unit_not_supported',
  'outside_contract',
  'unverified',
] as const;
export const mealDraftWithheldReasonSchema = z.enum(MEAL_DRAFT_WITHHELD_REASONS);

function nutritionResultSchema(valueSchema: z.ZodType<number>) {
  return z.discriminatedUnion('status', [
    z.strictObject({ excerpt: mealDraftExcerptSchema, status: z.literal('proposed'), value: valueSchema }),
    z.strictObject({ status: z.literal('not_stated') }),
    z.strictObject({ reason: mealDraftWithheldReasonSchema, status: z.literal('withheld') }),
  ]);
}

/** Per field, independently: a proposed value with the excerpt that holds it, not stated, or withheld with a reason. */
export const mealDraftNutritionSchema = z.strictObject({
  carbohydrateG: nutritionResultSchema(mealCarbohydrateGSchema),
  energyKcal: nutritionResultSchema(mealEnergyKcalSchema),
  fatG: nutritionResultSchema(mealFatGSchema),
  proteinG: nutritionResultSchema(mealProteinGSchema),
});

/** A meal type only when the text names one, with the word it names it by. */
export const mealDraftMealTypeSchema = z.discriminatedUnion('status', [
  z.strictObject({ excerpt: mealDraftExcerptSchema, status: z.literal('proposed'), value: mealTypeSchema }),
  z.strictObject({ status: z.literal('not_stated') }),
]);

/** Why the text cannot become one draft yet; the person can reword it, or fill the form by hand. */
export const MEAL_DRAFT_CLARIFICATION_REASONS = ['multiple_meals', 'no_food_named'] as const;
/** Why the text is not something this feature does at all. */
export const MEAL_DRAFT_UNSUPPORTED_REASONS = ['estimate_requested', 'not_a_meal'] as const;
export const mealDraftClarificationReasonSchema = z.enum(MEAL_DRAFT_CLARIFICATION_REASONS);
export const mealDraftUnsupportedReasonSchema = z.enum(MEAL_DRAFT_UNSUPPORTED_REASONS);

const scope = {
  // The request's date and the canonical spelling of its zone: never the model's.
  localDate: mealLocalDateSchema,
  timeZone: z.string().min(1).max(64),
  version: z.literal(MEAL_DRAFT_CONTRACT_VERSION),
};

/**
 * The answer. `draft` holds a title that is an exact excerpt of the text (so it is also its own evidence), a meal type
 * only if the text names one, and the four nutrition fields one by one. `clarify` and `unsupported` carry only a
 * bounded reason and never a field. A draft with every nutrition field not stated is a title-only draft, which the meal
 * log accepts.
 */
export const mealDraftProposalResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...scope,
    mealType: mealDraftMealTypeSchema,
    nutrition: mealDraftNutritionSchema,
    outcome: z.literal('draft'),
    title: mealTitleSchema,
  }),
  z.strictObject({ ...scope, outcome: z.literal('clarify'), reason: mealDraftClarificationReasonSchema }),
  z.strictObject({ ...scope, outcome: z.literal('unsupported'), reason: mealDraftUnsupportedReasonSchema }),
]);

/** Why the service, not the text, failed. Carried in `details.reason` of 502 MEAL_DRAFT_FAILED. */
export const MEAL_DRAFT_FAILURE_REASONS = [
  'incomplete',
  'invalid_output',
  'oversized',
  'provider_error',
  'provider_unavailable',
  'ungrounded_output',
] as const;
export const mealDraftFailureReasonSchema = z.enum(MEAL_DRAFT_FAILURE_REASONS);

export const MEAL_DRAFT_ERROR_CODES = {
  aborted: 'MEAL_DRAFT_ABORTED',
  budgetExhausted: 'MEAL_DRAFT_BUDGET_EXHAUSTED',
  busy: 'MEAL_DRAFT_BUSY',
  disabled: 'MEAL_DRAFT_DISABLED',
  failed: 'MEAL_DRAFT_FAILED',
  inProgress: 'MEAL_DRAFT_IN_PROGRESS',
  rateLimited: 'MEAL_DRAFT_RATE_LIMITED',
  timeout: 'MEAL_DRAFT_TIMEOUT',
} as const;

/** The nutrition fields of a draft, in the meal log's display order. */
export const MEAL_DRAFT_NUTRITION_FIELDS: readonly MealNutritionField[] = MEAL_NUTRITION_FIELDS;

export type MealDraftProposalRequest = z.infer<typeof mealDraftProposalRequestSchema>;
export type MealDraftProposalResponse = z.infer<typeof mealDraftProposalResponseSchema>;
export type MealDraftNutrition = z.infer<typeof mealDraftNutritionSchema>;
export type MealDraftNutritionResult = MealDraftNutrition[MealNutritionField];
export type MealDraftMealType = z.infer<typeof mealDraftMealTypeSchema>;
export type MealDraftWithheldReason = z.infer<typeof mealDraftWithheldReasonSchema>;
export type MealDraftClarificationReason = z.infer<typeof mealDraftClarificationReasonSchema>;
export type MealDraftUnsupportedReason = z.infer<typeof mealDraftUnsupportedReasonSchema>;
export type MealDraftFailureReason = z.infer<typeof mealDraftFailureReasonSchema>;
