import {
  MEAL_DRAFT_TEXT_MAX,
  MEAL_NUTRITION_FIELDS,
  type MealDraftClarificationReason,
  type MealDraftNutritionResult,
  type MealDraftProposalResponse,
  type MealDraftUnsupportedReason,
  type MealDraftWithheldReason,
} from '@running-tracker/contracts';

import type { MealDraft } from './meal-log.js';

// "Draft from text" in the Meal log (ADR-0092). Pure functions: every sentence the panel shows, and how a proposal
// becomes the editable form. The server returns only bounded codes and excerpts of the person's own text, so nothing a
// model wrote in its own words is ever shown.

export const MEAL_DRAFT_INPUT_MAX = MEAL_DRAFT_TEXT_MAX;

export type MealDraftProposal = Extract<MealDraftProposalResponse, { outcome: 'draft' }>;

export const MEAL_DRAFT_DISCLOSURE =
  'Only the text you type here is sent to the local AI model on this server: not the date, your entries or anything else about you. A value is only taken from a number you wrote next to its unit and nutrient; nothing is estimated, looked up or calculated. Nothing is saved until you press "Add entry".';

const withheldSentences: Readonly<Record<MealDraftWithheldReason, string>> = {
  ambiguous: 'Not filled in: the value is approximate, a range or a limit, or could be read in two ways.',
  conflicting: 'Not filled in: your text gives different values for it.',
  negated: 'Not filled in: your text says it was not this value.',
  outside_contract: 'Not filled in: it has more than one decimal or is outside what the meal log accepts. It is never rounded.',
  per_portion: 'Not filled in: your text gives it per 100 g, per serving or per piece, or it would need multiplying. Only totals for the whole entry are used.',
  unit_not_supported: 'Not filled in: the unit is missing or is not kcal or grams. Units are never guessed or converted.',
  unverified: 'Not filled in: the evidence for it did not match your text.',
};

/** What the panel says about one nutrition field of a proposal. */
export function describeNutritionResult(result: MealDraftNutritionResult): string {
  switch (result.status) {
    case 'proposed':
      return `From your text: “${result.excerpt}”`;
    case 'not_stated':
      return 'Not in your text; it stays empty (unknown).';
    case 'withheld':
      return withheldSentences[result.reason];
  }
}

const clarifications: Readonly<Record<MealDraftClarificationReason, string>> = {
  multiple_meals: 'Your text seems to describe more than one meal. Describe one meal at a time, or fill in the form yourself.',
  no_food_named: 'Your text does not say what you ate. Add the food to your text, or fill in the form yourself.',
};

const unsupportedReasons: Readonly<Record<MealDraftUnsupportedReason, string>> = {
  estimate_requested:
    'Drafts only use numbers you wrote yourself: nothing is estimated or looked up. Write the values you know, or leave them empty.',
  not_a_meal: 'This does not look like a description of a meal you ate. Describe one meal, or fill in the form yourself.',
};

export const describeDraftClarification = (reason: MealDraftClarificationReason): string => clarifications[reason];
export const describeDraftUnsupported = (reason: MealDraftUnsupportedReason): string => unsupportedReasons[reason];

export type MealDraftErrorKind = 'access' | 'busy' | 'failed' | 'in_progress' | 'network' | 'rate_limited' | 'timeout';

function wait(retryAfterMs: number | null): string {
  if (retryAfterMs === null) return 'in a minute';
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  return seconds >= 120 ? `in about ${Math.ceil(seconds / 60)} minutes` : `in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export function describeDraftError(kind: MealDraftErrorKind, retryAfterMs: number | null): string {
  switch (kind) {
    case 'access':
      return 'You no longer have access to this organization.';
    case 'busy':
      return `The local model is busy right now. Try again ${wait(retryAfterMs)}, or fill in the form yourself.`;
    case 'failed':
      return 'No draft could be made from this text. Try again, reword it, or fill in the form yourself.';
    case 'in_progress':
      return 'Your previous draft is still being made. Try again in a moment.';
    case 'network':
      return 'Could not reach the server. Check your connection and try again; the form below still works.';
    case 'rate_limited':
      return `Too many drafts in a short time. Try again ${wait(retryAfterMs)}, or fill in the form yourself.`;
    case 'timeout':
      return 'The local model took too long to answer. Try again, or fill in the form yourself.';
  }
}

export const MEAL_DRAFT_DISABLED_NOTICE = 'Drafting from text is not turned on for this server. The form below works as always.';

/** Why this text cannot be sent, or null. Mirrors the server's contract so a request that would be refused is not sent. */
export function draftTextProblem(text: string): string | null {
  if (text.trim() === '') return 'Describe one meal, for example "Dinner: chicken and rice, 650 kcal, protein 40 g".';
  if ([...text].length > MEAL_DRAFT_INPUT_MAX) return `Use at most ${MEAL_DRAFT_INPUT_MAX} characters; nothing is cut off for you.`;
  for (const character of text) {
    const code = character.charCodeAt(0);
    const whitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !whitespace) || (code >= 0x7f && code <= 0x9f)) return 'The text contains a character that cannot be sent.';
  }
  return null;
}

/** Whether the form holds details the person typed or applied and has not saved (the meal type alone does not count). */
export function hasUnsavedDetails(draft: MealDraft): boolean {
  return draft.title.trim() !== '' || MEAL_NUTRITION_FIELDS.some((field) => draft[field].trim() !== '');
}

/**
 * The form after applying a proposal: a full replacement of the title and the four values (a value that is not proposed
 * becomes empty, which is "not recorded"), never a merge with what was there. The meal type changes only when the text
 * named one. The result is an ordinary editable draft: the person can change anything before saving.
 */
export function applyProposalToDraft(proposal: MealDraftProposal, current: MealDraft): MealDraft {
  const value = (result: MealDraftNutritionResult): string => (result.status === 'proposed' ? String(result.value) : '');
  return {
    carbohydrateG: value(proposal.nutrition.carbohydrateG),
    energyKcal: value(proposal.nutrition.energyKcal),
    fatG: value(proposal.nutrition.fatG),
    mealType: proposal.mealType.status === 'proposed' ? proposal.mealType.value : current.mealType,
    proteinG: value(proposal.nutrition.proteinG),
    title: proposal.title,
  };
}
