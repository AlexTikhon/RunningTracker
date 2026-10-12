import { z } from 'zod';

import {
  distanceBoundSchema,
  distanceUnitSchema,
  runSearchPresetSchema,
  runSearchSortSchema,
  validateInclusiveDateRange,
} from './http.js';
import { ianaTimeZoneSchema, localDateSchema } from './primitives.js';

// Natural language in, the same filters the "My runs" form already has out (ADR-0057). The server never searches
// on the strength of this answer: the person reviews the proposal and applies it through the existing search.

export const RUN_SEARCH_INTERPRETATION_TEXT_MAX = 500;

// Everything below the space that is not a line break, a carriage return or a tab, plus DEL and the C1 range. Text
// is data for a model, so no character that could be read as part of a terminal or protocol sequence is accepted.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !allowedWhitespace) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

const interpretationTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'The text must not be empty')
  .refine(
    (value) => [...value].length <= RUN_SEARCH_INTERPRETATION_TEXT_MAX,
    `The text must not exceed ${RUN_SEARCH_INTERPRETATION_TEXT_MAX} characters`,
  )
  .refine((value) => !hasControlCharacter(value), 'The text must not contain control characters');

// The zone is the person's (validated), never the model's: the server resolves dates in it.
export const runSearchInterpretationRequestSchema = z.strictObject({
  text: interpretationTextSchema,
  timeZone: ianaTimeZoneSchema,
});

// Why a request cannot become filters yet. Bounded codes only: the screen owns the wording, so nothing a model
// wrote is ever shown. Clarifications are things the person can fix by rewording; unsupported requests name
// something "My runs" cannot filter on, so nothing is silently dropped.
export const runSearchClarificationReasonSchema = z.enum([
  'period_missing',
  'period_ambiguous',
  'distance_unit_missing',
  'distance_unit_mixed',
  'distance_ambiguous',
  'distance_too_precise',
  'distance_boundary_strict',
  'conflicting_conditions',
]);
export const runSearchUnsupportedReasonSchema = z.enum([
  'location',
  'pace_or_speed',
  'duration',
  'workout_or_segments',
  'other_attributes',
  'comparison_or_analysis',
  'exclusion',
  'other_people',
  'sort_order',
  'not_a_run_search',
]);

const proposedPeriodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preset'), preset: runSearchPresetSchema }),
  z
    .strictObject({ fromDate: localDateSchema, kind: z.literal('dates'), toDate: localDateSchema })
    .superRefine((period, context) => validateInclusiveDateRange(period.fromDate, period.toDate, context)),
]);

// A complete replacement for the form, never a patch: every field is present. No owner, organization, status,
// cursor or page size can appear here, so a proposal cannot widen what the search is allowed to read.
export const runSearchProposedFiltersSchema = z
  .strictObject({
    distanceUnit: distanceUnitSchema.nullable(),
    maxDistance: distanceBoundSchema.nullable(),
    minDistance: distanceBoundSchema.nullable(),
    period: proposedPeriodSchema,
    sort: runSearchSortSchema,
    timeZone: ianaTimeZoneSchema,
  })
  .superRefine((filters, context) => {
    const hasBound = filters.minDistance !== null || filters.maxDistance !== null;
    if (hasBound && filters.distanceUnit === null) {
      context.addIssue({ code: 'custom', message: 'A distance bound needs an explicit `distanceUnit`' });
    }
    if (!hasBound && filters.distanceUnit !== null) {
      context.addIssue({ code: 'custom', message: '`distanceUnit` needs a distance bound' });
    }
    if (
      filters.minDistance !== null &&
      filters.maxDistance !== null &&
      Number(filters.minDistance) > Number(filters.maxDistance)
    ) {
      context.addIssue({ code: 'custom', message: '`minDistance` must not exceed `maxDistance`' });
    }
  });

export const runSearchInterpretationResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ filters: runSearchProposedFiltersSchema, outcome: z.literal('search') }),
  z.strictObject({ outcome: z.literal('clarify'), reason: runSearchClarificationReasonSchema }),
  z.strictObject({ outcome: z.literal('unsupported'), reason: runSearchUnsupportedReasonSchema }),
]);

// Why an interpretation failed as a service, as opposed to an answer. Carried in `details.reason` of the error.
export const runSearchInterpretationFailureReasonSchema = z.enum([
  'incomplete',
  'invalid_output',
  'oversized',
  'provider_error',
  'provider_rate_limited',
  'refusal',
]);

export type RunSearchInterpretationRequest = z.infer<typeof runSearchInterpretationRequestSchema>;
export type RunSearchInterpretationResponse = z.infer<typeof runSearchInterpretationResponseSchema>;
export type RunSearchProposedFilters = z.infer<typeof runSearchProposedFiltersSchema>;
export type RunSearchClarificationReason = z.infer<typeof runSearchClarificationReasonSchema>;
export type RunSearchUnsupportedReason = z.infer<typeof runSearchUnsupportedReasonSchema>;
export type RunSearchInterpretationFailureReason = z.infer<
  typeof runSearchInterpretationFailureReasonSchema
>;
