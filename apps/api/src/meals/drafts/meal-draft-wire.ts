import { MEAL_DRAFT_CLARIFICATION_REASONS, MEAL_DRAFT_UNSUPPORTED_REASONS } from '@running-tracker/contracts';
import { z } from 'zod';

// What the local model is asked to return (ADR-0092). A WIRE shape, not the domain contract: it carries the model's
// claims (a title, a meal type word, and per nutrient a number as written plus the excerpt it says holds it, or an
// abstention code). The grounding step (meal-draft-grounding.ts) checks every claim against the person's text and is the
// only thing that turns a claim into a proposal. Schema validity says the answer has a legal shape, not that it is true.
//
// As in the run-search Ollama schema (ADR-0057), each outcome has its own object and `outcome` comes first, so once the
// model has written "clarify" it cannot attach a field.

export const MEAL_DRAFT_WIRE_SCHEMA_NAME = 'meal_draft_evidence_v1';

/** Why the model did not give a value. `not_stated` is the only one that is not a reason to look closer. */
export const MEAL_DRAFT_ABSTENTIONS = [
  'not_stated',
  'per_portion',
  'conflicting',
  'negated',
  'not_exact',
  'unit_not_supported',
] as const;
export type MealDraftAbstention = (typeof MEAL_DRAFT_ABSTENTIONS)[number];

export const WIRE_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

// Bounded so that a runaway answer is refused by the shape, not by the grounding: the text itself is at most 500 code
// points, so no honest excerpt is longer.
const claimText = z.string().max(600);

const nutrientClaim = z.strictObject({
  value: claimText.nullable(),
  evidence: claimText.nullable(),
  abstain: z.enum(MEAL_DRAFT_ABSTENTIONS).nullable(),
});
export type NutrientClaim = z.infer<typeof nutrientClaim>;

const draftAnswer = z.strictObject({
  outcome: z.literal('draft'),
  title: claimText,
  mealType: z.enum(WIRE_MEAL_TYPES).nullable(),
  mealTypeEvidence: claimText.nullable(),
  energyKcal: nutrientClaim,
  proteinG: nutrientClaim,
  carbohydrateG: nutrientClaim,
  fatG: nutrientClaim,
});

const clarifyAnswer = z.strictObject({
  outcome: z.literal('clarify'),
  reason: z.enum(MEAL_DRAFT_CLARIFICATION_REASONS),
});

const unsupportedAnswer = z.strictObject({
  outcome: z.literal('unsupported'),
  reason: z.enum(MEAL_DRAFT_UNSUPPORTED_REASONS),
});

export const mealDraftWireSchema = z.discriminatedUnion('outcome', [draftAnswer, clarifyAnswer, unsupportedAnswer]);
export type MealDraftWireAnswer = z.infer<typeof mealDraftWireSchema>;
export type MealDraftWireDraft = z.infer<typeof draftAnswer>;

const nullableString = (description: string) => ({ description, type: ['string', 'null'] });

const nutrientJson = (description: string) => ({
  additionalProperties: false,
  description,
  properties: {
    value: nullableString('The number exactly as the text writes it, such as "650" or "12,5". Null unless the text states this total.'),
    evidence: nullableString('The shortest exact copy of the part of the text that contains this nutrient or its unit and the number. Null when value is null.'),
    abstain: {
      description: 'Null when value is given; otherwise why not.',
      enum: [...MEAL_DRAFT_ABSTENTIONS, null],
      type: ['string', 'null'],
    },
  },
  required: ['value', 'evidence', 'abstain'],
  type: 'object',
});

// Written out rather than generated, so exactly what is sent is visible in review; the specification pins it against
// `mealDraftWireSchema` by validating the same answers with both. Only keywords the runtime's schema-to-grammar
// conversion is known to take (type, enum, properties, required, additionalProperties, oneOf).
export const mealDraftWireJsonSchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        outcome: { description: 'The text describes exactly one meal or snack and names the food.', enum: ['draft'], type: 'string' },
        title: { description: 'The words naming the food, copied exactly from the text.', type: 'string' },
        mealType: {
          description: 'Only if the text names the meal.',
          enum: [...WIRE_MEAL_TYPES, null],
          type: ['string', 'null'],
        },
        mealTypeEvidence: nullableString('The word naming the meal, copied exactly. Null when mealType is null.'),
        energyKcal: nutrientJson('Food energy in kcal for the whole meal.'),
        proteinG: nutrientJson('Protein in grams for the whole meal.'),
        carbohydrateG: nutrientJson('Carbohydrate in grams for the whole meal.'),
        fatG: nutrientJson('Fat in grams for the whole meal.'),
      },
      required: ['outcome', 'title', 'mealType', 'mealTypeEvidence', 'energyKcal', 'proteinG', 'carbohydrateG', 'fatG'],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: { description: 'The text cannot become one draft yet.', enum: ['clarify'], type: 'string' },
        reason: { enum: [...MEAL_DRAFT_CLARIFICATION_REASONS], type: 'string' },
      },
      required: ['outcome', 'reason'],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: { description: 'The text is not a description of one meal eaten.', enum: ['unsupported'], type: 'string' },
        reason: { enum: [...MEAL_DRAFT_UNSUPPORTED_REASONS], type: 'string' },
      },
      required: ['outcome', 'reason'],
      type: 'object',
    },
  ],
} as const;
