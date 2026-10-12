import type {
  DistanceUnit,
  RunSearchInterpretationResponse,
  RunSearchPreset,
} from '@running-tracker/contracts';

import { distanceToMetres } from '../runs/run-search-query.js';
import { resolveSearchPeriod } from '../runs/run-search-period.js';
import type { EvaluationExpectation } from './run-search-evaluation-dataset.js';

export const FILTER_FIELDS = ['period', 'minDistance', 'maxDistance', 'sort'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface ScoreContext {
  now: Date;
  timeZone: string;
}

export interface CaseScore {
  actualOutcome: RunSearchInterpretationResponse['outcome'];
  actualReason: string | null;
  /** Fields that differ, in the order of FILTER_FIELDS; empty unless a search was expected and answered. */
  fieldErrors: FilterField[];
  /** null unless a search was expected. */
  filtersExact: boolean | null;
  outcomeCorrect: boolean;
  /** null unless a clarification or unsupported answer was expected. */
  reasonCorrect: boolean | null;
}

type Period =
  | { kind: 'preset'; preset: RunSearchPreset }
  | { fromDate: string; kind: 'dates'; toDate: string };

// A period is compared as the instants the search would use, so "this month" and the explicit dates of this month
// are the same meaning, and two spellings of the same range are not an error.
function resolvedPeriod(period: Period, context: ScoreContext): string {
  const resolved = resolveSearchPeriod(
    period.kind === 'preset' ? { preset: period.preset } : { fromDate: period.fromDate, toDate: period.toDate },
    context.timeZone,
    context.now,
  );
  return `${resolved.from.toISOString()}..${resolved.to.toISOString()}`;
}

function metresOf(value: string | null, unit: DistanceUnit | null): number | null {
  if (value === null) {
    return null;
  }
  // A bound without a unit has no meaning; NaN never equals anything, so it can only count as an error.
  return unit === null ? Number.NaN : distanceToMetres(value, unit);
}

export function scoreCase(
  expected: EvaluationExpectation,
  actual: RunSearchInterpretationResponse,
  context: ScoreContext,
): CaseScore {
  const outcomeCorrect = expected.outcome === actual.outcome;
  const actualReason = actual.outcome === 'search' ? null : actual.reason;

  if (expected.outcome !== 'search') {
    return {
      actualOutcome: actual.outcome,
      actualReason,
      fieldErrors: [],
      filtersExact: null,
      outcomeCorrect,
      reasonCorrect: outcomeCorrect && actualReason === expected.reason,
    };
  }

  if (actual.outcome !== 'search') {
    return {
      actualOutcome: actual.outcome,
      actualReason,
      fieldErrors: [],
      filtersExact: false,
      outcomeCorrect: false,
      reasonCorrect: null,
    };
  }

  const { filters } = actual;
  const wrong: Record<FilterField, boolean> = {
    maxDistance:
      metresOf(expected.maxDistance, expected.distanceUnit) !== metresOf(filters.maxDistance, filters.distanceUnit),
    minDistance:
      metresOf(expected.minDistance, expected.distanceUnit) !== metresOf(filters.minDistance, filters.distanceUnit),
    period: resolvedPeriod(expected.period, context) !== resolvedPeriod(filters.period, context),
    sort: (expected.sort ?? 'newest') !== filters.sort,
  };
  const fieldErrors = FILTER_FIELDS.filter((field) => wrong[field]);
  return {
    actualOutcome: 'search',
    actualReason: null,
    fieldErrors,
    filtersExact: fieldErrors.length === 0,
    outcomeCorrect: true,
    reasonCorrect: null,
  };
}
