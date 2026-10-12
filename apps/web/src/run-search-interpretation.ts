import {
  RUN_SEARCH_INTERPRETATION_TEXT_MAX,
  type RunSearchClarificationReason,
  type RunSearchProposedFilters,
  type RunSearchUnsupportedReason,
} from '@running-tracker/contracts';

import type { RunSearchDraft } from './run-search.js';

// Everything the screen says about "describe your search in words", and how a proposal becomes the editable form.
// The wording is fixed here: the server returns only bounded reason codes, so nothing a model wrote is ever shown.

export const INTERPRETATION_TEXT_MAX = RUN_SEARCH_INTERPRETATION_TEXT_MAX;

export const INTERPRETATION_DISCLOSURE =
  'The text you enter here is sent to OpenAI, which turns it into filters. Nothing else about you or your runs is sent. Do not write addresses or other private details.';

// A complete replacement for the form (never a patch), so nothing of an older draft survives into it.
export function proposalToDraft(filters: RunSearchProposedFilters): RunSearchDraft {
  return {
    maxDistance: filters.maxDistance ?? '',
    minDistance: filters.minDistance ?? '',
    period: filters.period,
    sort: filters.sort,
    unit: filters.distanceUnit ?? 'km',
  };
}

const clarifications: Record<RunSearchClarificationReason, string> = {
  conflicting_conditions:
    'Parts of your text contradict each other, for example two different periods, two orders, or a minimum above the maximum. Say which you mean, or set the filters yourself.',
  distance_ambiguous:
    'A distance in your text is not exact enough ("about", "long", or a number that could be thousands). Give a number such as 5 or 12.5 with km or miles, or set the filters yourself.',
  distance_boundary_strict:
    'Distance limits here include the number you give, so "more than 5 km" or "under 10 km" cannot be expressed exactly. Say "at least 5 km" or "at most 10 km" instead, or set the distance yourself.',
  distance_too_precise:
    'Distances can have at most three decimals, and nothing is rounded for you. Give a number such as 5.25, or set the distance yourself.',
  distance_unit_missing:
    'A distance in your text has no unit. Say km or miles after the number, or set the distance yourself.',
  distance_unit_mixed:
    'Your text uses both kilometres and miles. Use one unit for both limits, or set the distance yourself.',
  period_ambiguous:
    'I could not turn the period into this month, last month, or exact dates with a year (at most 366 days). Say it that way, or choose the period yourself.',
  period_missing:
    'Your text does not say when. Name this month, last month, or exact dates with a year, or choose the period yourself.',
};

const unsupportedReasons: Record<RunSearchUnsupportedReason, string> = {
  comparison_or_analysis:
    'My runs can only list your runs. Comparisons, totals, trends and advice are not part of this search.',
  duration:
    'My runs cannot filter by how long a run took or when in the day it happened. You can filter by period and distance.',
  exclusion:
    'My runs cannot leave a period or a distance range out. Ask for the period or range you do want.',
  location:
    'My runs cannot filter by place or route. You can filter by period and distance.',
  not_a_run_search:
    'I can only turn a description of your own runs into filters: a period, a distance range and an order.',
  other_attributes:
    'My runs cannot filter by heart rate, elevation, weather, shoes or other details. You can filter by period and distance.',
  other_people:
    'This list has only runs you recorded yourself. Other people\'s runs and shared runs are not searched here.',
  pace_or_speed:
    'My runs cannot filter or sort by pace or speed. You can filter by period and distance.',
  sort_order:
    'My runs can be ordered newest first, longest first or shortest first. Other orders are not available.',
  workout_or_segments:
    'My runs cannot filter by workouts, intervals, splits or laps. You can filter by period and distance.',
};

export function describeClarification(reason: RunSearchClarificationReason): string {
  return clarifications[reason];
}

export function describeUnsupported(reason: RunSearchUnsupportedReason): string {
  return unsupportedReasons[reason];
}

export type InterpretationErrorKind =
  | 'access'
  | 'busy'
  | 'disabled'
  | 'failed'
  | 'in_progress'
  | 'network'
  | 'rate_limited'
  | 'timeout';

function secondsText(retryAfterMs: number | null): string {
  if (retryAfterMs === null) {
    return 'in a minute';
  }
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  if (seconds >= 120) {
    return `in about ${Math.ceil(seconds / 60)} minutes`;
  }
  return `in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export function describeInterpretationError(
  kind: InterpretationErrorKind,
  retryAfterMs: number | null,
): string {
  switch (kind) {
    case 'access':
      return 'You no longer have access to this organization.';
    case 'busy':
      return `The interpreter is busy or unavailable right now. Try again ${secondsText(retryAfterMs)}, or use the filters below.`;
    case 'disabled':
      return 'Describing a search in words is not turned on for this server. The filters below still work.';
    case 'failed':
      return 'Your text could not be turned into filters. Try again, reword it, or use the filters below.';
    case 'in_progress':
      return 'Your previous request is still finishing. Try again in a moment.';
    case 'network':
      return 'Could not reach the server. Check your connection and try again; the filters below still work.';
    case 'rate_limited':
      return `Too many requests. Try again ${secondsText(retryAfterMs)}, or use the filters below.`;
    case 'timeout':
      return 'The interpreter took too long to answer. Try again, or use the filters below.';
  }
}

/** Why this text cannot be sent, or null. Mirrors the server's contract so a request that would be refused is not sent. */
export function interpretationTextProblem(text: string): string | null {
  if (text.trim() === '') {
    return 'Describe the runs you want, for example "runs of at least 5 km from last month, longest first".';
  }
  if ([...text].length > INTERPRETATION_TEXT_MAX) {
    return `Use at most ${INTERPRETATION_TEXT_MAX} characters; nothing is cut off for you.`;
  }
  for (const character of text) {
    const code = character.charCodeAt(0);
    const whitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !whitespace) || (code >= 0x7f && code <= 0x9f)) {
      return 'The text contains a character that cannot be sent.';
    }
  }
  return null;
}
