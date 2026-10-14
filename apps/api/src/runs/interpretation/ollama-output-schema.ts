import {
  distanceUnitSchema,
  runSearchClarificationReasonSchema,
  runSearchPresetSchema,
  runSearchSortSchema,
  runSearchUnsupportedReasonSchema,
} from '@running-tracker/contracts';
import { z } from 'zod';

import type { ProviderProposal } from './interpretation-schema.js';

// What the local model is asked to return. The OpenAI wire schema is one flat object that has to allow every
// combination of its ten fields, which is why a local model could answer "clarify, conflicting_conditions" with a
// period and a distance next to it and still be schema-valid. Ollama's `format` takes a full JSON Schema, so here each
// outcome has its own object shape and "outcome" comes first: once the model has written `"outcome":"clarify"` the
// only keys it can still write are `clarificationReason`, and it cannot attach a filter.
//
// This is a wire shape, not the domain contract. `proposalFromOllamaWire` maps it, field for field and without any
// interpretation, into the same ProviderProposal the OpenAI adapter returns, and that is then checked by the
// canonical `providerProposalSchema` and normalised exactly as before. Nothing is repaired, inferred or dropped: an
// answer the wire schema does not describe is a failed call.
//
// Schema validity says the answer has a legal shape, not that it means what the person wrote.

export const OLLAMA_OUTPUT_SCHEMA_NAME = 'run_search_interpretation_ollama';

const decimal = z.string().nullable();

// The optional filters, shared by both kinds of search, in the order they are written.
const optionalFilters = {
  minDistance: decimal,
  maxDistance: decimal,
  distanceUnit: distanceUnitSchema.nullable(),
  sort: runSearchSortSchema.nullable(),
};

const presetSearch = z.strictObject({
  outcome: z.literal('search'),
  period: runSearchPresetSchema,
  ...optionalFilters,
});

const datesSearch = z.strictObject({
  outcome: z.literal('search'),
  period: z.literal('dates'),
  fromDate: z.string(),
  toDate: z.string(),
  ...optionalFilters,
});

const clarification = z.strictObject({
  outcome: z.literal('clarify'),
  clarificationReason: runSearchClarificationReasonSchema,
});

const unsupportedAnswer = z.strictObject({
  outcome: z.literal('unsupported'),
  unsupportedReason: runSearchUnsupportedReasonSchema,
});

// Four shapes, mutually exclusive by construction: no object can satisfy two of them (the first two differ in
// `period`, the other two in `outcome`), so the union has no order that matters.
export const ollamaWireSchema = z.union([presetSearch, datesSearch, clarification, unsupportedAnswer]);

export type OllamaWireAnswer = z.infer<typeof ollamaWireSchema>;

/**
 * Deterministic and total over the wire shapes: every wire field lands in the same-named proposal field, and every
 * proposal field the wire shape does not have is null. No value is computed, defaulted or corrected.
 */
export function proposalFromOllamaWire(wire: OllamaWireAnswer): ProviderProposal {
  const empty = {
    clarificationReason: null,
    distanceUnit: null,
    fromDate: null,
    maxDistance: null,
    minDistance: null,
    period: null,
    sort: null,
    toDate: null,
    unsupportedReason: null,
  } as const;

  switch (wire.outcome) {
    case 'clarify':
      return { ...empty, clarificationReason: wire.clarificationReason, outcome: 'clarify' };
    case 'unsupported':
      return { ...empty, outcome: 'unsupported', unsupportedReason: wire.unsupportedReason };
    case 'search':
      return {
        ...empty,
        distanceUnit: wire.distanceUnit,
        fromDate: wire.period === 'dates' ? wire.fromDate : null,
        maxDistance: wire.maxDistance,
        minDistance: wire.minDistance,
        outcome: 'search',
        period: wire.period,
        sort: wire.sort,
        toDate: wire.period === 'dates' ? wire.toDate : null,
      };
  }
}

const nullableEnum = (values: readonly string[], description: string) => ({
  description,
  enum: [...values, null],
  type: ['string', 'null'],
});

const nullableString = (description: string) => ({ description, type: ['string', 'null'] });

const fixed = (value: string, description: string) => ({ description, enum: [value], type: 'string' });

const distanceProperties = {
  minDistance: nullableString(
    'Inclusive lower bound as a plain decimal string with at most three decimals, such as "5" or "0.5". Null if none.',
  ),
  maxDistance: nullableString(
    'Inclusive upper bound as a plain decimal string with at most three decimals, such as "10" or "12.5". Null if none.',
  ),
  distanceUnit: nullableEnum(
    distanceUnitSchema.options,
    'The unit of minDistance and maxDistance: km or mi. Null exactly when both bounds are null.',
  ),
  sort: nullableEnum(
    runSearchSortSchema.options,
    'newest, longest or shortest, only if the request names an order. Null if it does not.',
  ),
} as const;

const distanceKeys = ['minDistance', 'maxDistance', 'distanceUnit', 'sort'] as const;

// Written out rather than generated, so exactly what is sent is visible in review; the specification pins it against
// `ollamaWireSchema` by validating the same answers with both. No $ref, no $defs, no format, no pattern: only the
// keywords the runtime's schema-to-grammar conversion is known to take (type, enum, properties, required,
// additionalProperties, oneOf). `outcome` is the first property of every shape.
export const ollamaOutputJsonSchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        outcome: fixed('search', 'A search that the form can express exactly.'),
        period: {
          description: 'this-month or previous-month for a calendar month.',
          enum: [...runSearchPresetSchema.options],
          type: 'string',
        },
        ...distanceProperties,
      },
      required: ['outcome', 'period', ...distanceKeys],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: fixed('search', 'A search that the form can express exactly.'),
        period: fixed('dates', 'An explicit date range, written in fromDate and toDate.'),
        fromDate: { description: 'First calendar date, inclusive, as YYYY-MM-DD.', type: 'string' },
        toDate: { description: 'Last calendar date, inclusive, as YYYY-MM-DD.', type: 'string' },
        ...distanceProperties,
      },
      required: ['outcome', 'period', 'fromDate', 'toDate', ...distanceKeys],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: fixed('clarify', 'Information is missing or ambiguous. No filter is proposed.'),
        clarificationReason: {
          description: 'The one reason that applies first in the documented precedence.',
          enum: [...runSearchClarificationReasonSchema.options],
          type: 'string',
        },
      },
      required: ['outcome', 'clarificationReason'],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: fixed('unsupported', 'The request needs something this search cannot do. No filter is proposed.'),
        unsupportedReason: {
          description: 'The reason that best names the unsupported condition.',
          enum: [...runSearchUnsupportedReasonSchema.options],
          type: 'string',
        },
      },
      required: ['outcome', 'unsupportedReason'],
      type: 'object',
    },
  ],
} as const;
