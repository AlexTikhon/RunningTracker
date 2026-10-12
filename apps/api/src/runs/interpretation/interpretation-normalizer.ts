import {
  runSearchInterpretationResponseSchema,
  runSearchProposedFiltersSchema,
  runSearchQuerySchema,
  type RunSearchInterpretationResponse,
} from '@running-tracker/contracts';

import { normalizeRunSearch } from '../run-search-query.js';
import type { ProviderProposal } from './interpretation-schema.js';

/** The model's answer is well-formed but cannot be a valid "My runs" search. Not an application outcome. */
export class ProposalRejectedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProposalRejectedError';
  }
}

export interface NormalizeContext {
  /** The server clock, used only to prove that a preset resolves; the search resolves it again when it runs. */
  now: Date;
  /** The person's zone, validated by the request contract. The model has no say in it. */
  timeZone: string;
}

// Exactly the same number, spelled the way the search contract spells it. Trailing zeros of the fraction go; a
// value with more than three decimals is left as it is and fails the contract below, because rounding someone's
// boundary would silently change which runs match.
function canonicalDecimal(value: string): string {
  const match = /^(\d+)\.(\d+)$/u.exec(value);
  if (!match) {
    return value;
  }
  const fraction = match[2]!.replace(/0+$/u, '');
  return fraction === '' ? match[1]! : `${match[1]!}.${fraction}`;
}

/**
 * The domain check behind the schema check: the proposal is turned into the very query the search endpoint accepts
 * and put through that contract and the search's own period and distance logic. Whatever passes here the search
 * endpoint will also accept.
 */
export function normalizeProposal(
  proposal: ProviderProposal,
  context: NormalizeContext,
): RunSearchInterpretationResponse {
  if (proposal.outcome === 'clarify') {
    return runSearchInterpretationResponseSchema.parse({
      outcome: 'clarify',
      reason: proposal.clarificationReason,
    });
  }
  if (proposal.outcome === 'unsupported') {
    return runSearchInterpretationResponseSchema.parse({
      outcome: 'unsupported',
      reason: proposal.unsupportedReason,
    });
  }

  const minDistance = proposal.minDistance === null ? null : canonicalDecimal(proposal.minDistance);
  const maxDistance = proposal.maxDistance === null ? null : canonicalDecimal(proposal.maxDistance);
  const hasBound = minDistance !== null || maxDistance !== null;
  if (hasBound && proposal.distanceUnit === null) {
    throw new ProposalRejectedError('A distance bound has no unit');
  }

  const query = runSearchQuerySchema.safeParse({
    ...(hasBound ? { distanceUnit: proposal.distanceUnit } : {}),
    ...(proposal.period === 'dates'
      ? { fromDate: proposal.fromDate, toDate: proposal.toDate }
      : { preset: proposal.period }),
    ...(maxDistance === null ? {} : { maxDistance }),
    ...(minDistance === null ? {} : { minDistance }),
    sort: proposal.sort ?? 'newest',
    timeZone: context.timeZone,
  });
  if (!query.success) {
    throw new ProposalRejectedError('The proposal is not a valid search');
  }

  let resolved;
  try {
    resolved = normalizeRunSearch(query.data, context.now);
  } catch {
    throw new ProposalRejectedError('The proposal does not resolve to a period');
  }
  if (resolved.period.from.getTime() >= resolved.period.to.getTime()) {
    throw new ProposalRejectedError('The proposed period is empty in this time zone');
  }

  const period =
    query.data.preset !== undefined
      ? { kind: 'preset' as const, preset: query.data.preset }
      : {
          fromDate: query.data.fromDate as string,
          kind: 'dates' as const,
          toDate: query.data.toDate as string,
        };
  const filters = runSearchProposedFiltersSchema.safeParse({
    distanceUnit: hasBound ? (query.data.distanceUnit ?? null) : null,
    maxDistance,
    minDistance,
    period,
    sort: resolved.sort,
    timeZone: context.timeZone,
  });
  if (!filters.success) {
    throw new ProposalRejectedError('The proposal is not a valid filter set');
  }
  return { filters: filters.data, outcome: 'search' };
}
