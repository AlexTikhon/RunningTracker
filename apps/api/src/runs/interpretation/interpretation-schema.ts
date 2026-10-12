import {
  distanceUnitSchema,
  runSearchClarificationReasonSchema,
  runSearchPresetSchema,
  runSearchSortSchema,
  runSearchUnsupportedReasonSchema,
} from '@running-tracker/contracts';
import { z } from 'zod';

// What the model is asked to return, and the local check of what it did return. The provider's Structured Outputs
// accept a root object (not a root `anyOf`), every property required, and `additionalProperties: false`, so the
// application's discriminated union is flattened into one object whose optional values are nullable. The local
// schema below restores the union's rules and is the authority: a response the provider calls schema-valid is still
// checked here before anything is used.
//
// There is deliberately no field for a person, an organization, SQL, a cursor, a time zone, a page size or a count.

export const INTERPRETATION_SCHEMA_NAME = 'run_search_interpretation';

const outcomes = ['search', 'clarify', 'unsupported'] as const;
const periods = ['dates', ...runSearchPresetSchema.options] as const;

const nullableDecimal = z.string().nullable();

export const providerProposalSchema = z
  .strictObject({
    clarificationReason: runSearchClarificationReasonSchema.nullable(),
    distanceUnit: distanceUnitSchema.nullable(),
    fromDate: z.string().nullable(),
    maxDistance: nullableDecimal,
    minDistance: nullableDecimal,
    outcome: z.enum(outcomes),
    period: z.enum(periods).nullable(),
    sort: runSearchSortSchema.nullable(),
    toDate: z.string().nullable(),
    unsupportedReason: runSearchUnsupportedReasonSchema.nullable(),
  })
  .superRefine((proposal, context) => {
    const issue = (message: string, path: string): void => {
      context.addIssue({ code: 'custom', message, path: [path] });
    };
    const filterFields = {
      distanceUnit: proposal.distanceUnit,
      fromDate: proposal.fromDate,
      maxDistance: proposal.maxDistance,
      minDistance: proposal.minDistance,
      period: proposal.period,
      sort: proposal.sort,
      toDate: proposal.toDate,
    };

    if (proposal.outcome === 'search') {
      if (proposal.clarificationReason !== null) issue('A search carries no clarification reason', 'clarificationReason');
      if (proposal.unsupportedReason !== null) issue('A search carries no unsupported reason', 'unsupportedReason');
      if (proposal.period === null) {
        issue('A search needs a period', 'period');
      } else if (proposal.period === 'dates') {
        if (proposal.fromDate === null || proposal.toDate === null) {
          issue('Explicit dates need both ends', 'fromDate');
        }
      } else if (proposal.fromDate !== null || proposal.toDate !== null) {
        issue('A preset period carries no dates', 'fromDate');
      }
      return;
    }

    for (const [name, value] of Object.entries(filterFields)) {
      if (value !== null) {
        issue(`${proposal.outcome} proposes no filters`, name);
      }
    }
    if (proposal.outcome === 'clarify') {
      if (proposal.clarificationReason === null) issue('A clarification needs a reason', 'clarificationReason');
      if (proposal.unsupportedReason !== null) issue('A clarification carries no unsupported reason', 'unsupportedReason');
    } else {
      if (proposal.unsupportedReason === null) issue('An unsupported answer needs a reason', 'unsupportedReason');
      if (proposal.clarificationReason !== null) issue('An unsupported answer carries no clarification reason', 'clarificationReason');
    }
  });

export type ProviderProposal = z.infer<typeof providerProposalSchema>;

const nullableEnum = (values: readonly string[], description: string) => ({
  description,
  enum: [...values, null],
  type: ['string', 'null'],
});

const nullableString = (description: string) => ({ description, type: ['string', 'null'] });

// Written out rather than generated, so exactly what is sent is visible in review and pinned by a test.
export const providerOutputJsonSchema = {
  additionalProperties: false,
  properties: {
    clarificationReason: nullableEnum(
      runSearchClarificationReasonSchema.options,
      'Only when outcome is clarify: the one reason that applies first in the documented precedence. Otherwise null.',
    ),
    distanceUnit: nullableEnum(
      distanceUnitSchema.options,
      'The unit of minDistance and maxDistance: km or mi. Null exactly when both bounds are null.',
    ),
    fromDate: nullableString(
      'First calendar date, inclusive, as YYYY-MM-DD, only when period is dates. Otherwise null.',
    ),
    maxDistance: nullableString(
      'Inclusive upper bound as a plain decimal string with at most three decimals, such as "10" or "12.5". Null if none.',
    ),
    minDistance: nullableString(
      'Inclusive lower bound as a plain decimal string with at most three decimals, such as "5" or "0.5". Null if none.',
    ),
    outcome: {
      description: 'search: filters could be built exactly. clarify: information is missing or ambiguous. unsupported: the request needs something this search cannot do.',
      enum: [...outcomes],
      type: 'string',
    },
    period: nullableEnum(
      periods,
      'this-month or previous-month for calendar months, dates for an explicit range. Null unless outcome is search.',
    ),
    sort: nullableEnum(
      runSearchSortSchema.options,
      'newest, longest or shortest, only if the request names an order. Null if it does not.',
    ),
    toDate: nullableString(
      'Last calendar date, inclusive, as YYYY-MM-DD, only when period is dates. Otherwise null.',
    ),
    unsupportedReason: nullableEnum(
      runSearchUnsupportedReasonSchema.options,
      'Only when outcome is unsupported: the reason that best names the unsupported condition. Otherwise null.',
    ),
  },
  required: [
    'outcome',
    'period',
    'fromDate',
    'toDate',
    'minDistance',
    'maxDistance',
    'distanceUnit',
    'sort',
    'clarificationReason',
    'unsupportedReason',
  ],
  type: 'object',
} as const;
