import type { WeeklyInsightClaim, WeeklyInsightFact, WeeklyInsightModelOutput } from '@running-tracker/contracts';

// Grounding check (ADR-0076, policy 2). The model writes two separate things, and each is checked differently:
//
// 1. CLAIMS (structured). Each observation cites one to three facts of the week's catalogue (insight-facts.ts). A
//    claim is accepted only when its fact id exists and its value, unit, direction and day all equal the fact's. So a
//    value that exists only under another fact, a value in the wrong unit, a reversed change, a first/last or min/max
//    swap, a wrong rounding and a wrong day are all refused. Nothing is tolerated: the facts are already rounded by
//    code, and the claim must repeat them exactly (to 1e-9).
//
// 2. PROSE (summary, observation text, the model's suggestion). Prose may contain no number at all, so no number the
//    person reads ever comes from the model; numbers are rendered from the cited facts by code. Refused in prose:
//    - any digit (every Unicode decimal digit), and number words: zero, two to twenty, the tens, hundred, thousand, million,
//      dozen, twice, thrice, half, double, triple, and the ordinals third to twentieth;
//    - weekday and month names and calendar dates (days come from the facts);
//    - change verbs ("increased", "dropped", "went up", ...) that the cited facts do not support: an observation that
//      uses one must cite a change fact with that direction; the summary may use one only when the week has a change
//      fact with that direction. A heuristic over a short verb list, not an understanding of the sentence.
//
// What this proves: every number shown came from code; every claim the model made names an existing fact with its
// exact value, unit, direction and day; the prose carries no numbers, days or dates. What it does NOT prove: that the
// prose means what the claims say. "You slept well" next to a short-sleep fact, a comparison between two facts, or a
// qualitative judgement ("a strong week") is not verified. Known gaps of the prose rules: "one", "once", "first" and
// "second" are allowed (pronouns and ordinary words far more often than counts), and comparatives such as "more" or
// "lower" are not treated as change claims.

export type GroundingField = 'observations' | 'suggestion' | 'summary';

export type GroundingKind =
  | 'claim_day_mismatch'
  | 'claim_direction_mismatch'
  | 'claim_unit_mismatch'
  | 'claim_value_mismatch'
  | 'date_in_prose'
  | 'day_in_prose'
  | 'number_in_prose'
  | 'unknown_fact'
  | 'unsupported_direction';

export interface GroundingViolation {
  /** The fact id, or the offending token as written. Never surrounding prose. */
  detail: string;
  field: GroundingField;
  kind: GroundingKind;
}

const numberWords = [
  'zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety', 'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'dozen', 'dozens', 'twice', 'thrice',
  'half', 'double', 'triple', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh',
  'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
  'twentieth', 'percent',
];
const weekdayWords = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekend'];
const monthWords = [
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
];

const digitPattern = /\p{Nd}+/gu;
const numberWordPattern = new RegExp(`\\b(?:${numberWords.join('|')})\\b`, 'giu');
const weekdayPattern = new RegExp(`\\b(?:${weekdayWords.join('|')})s?\\b`, 'giu');
// "May" is a month and a modal verb: only "in May"/"May <digit>" would be a date, and digits are refused anyway.
const monthPattern = new RegExp(`\\b(?:${monthWords.join('|')})\\b`, 'giu');
const dateWordPattern = /\b(?:yesterday|tomorrow)\b/giu;

const upVerbs = /\b(?:increas(?:e|ed|es|ing)|rose|risen|rising|gain(?:ed|s|ing)?|climb(?:ed|s|ing)?|went up|gone up|go up|going up)\b/iu;
const downVerbs = /\b(?:decreas(?:e|ed|es|ing)|dropp?(?:ed|s|ing)?|fell|fallen|falling|declin(?:e|ed|es|ing)|lost|los(?:e|es|ing)|went down|gone down|go down|going down|reduc(?:e|ed|es|ing))\b/iu;
const sameWords = /\b(?:unchanged|stayed the same|no change|did not change|didn't change)\b/iu;

function proseViolations(text: string, field: GroundingField): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  const normalized = text.normalize('NFKC');
  for (const match of normalized.matchAll(digitPattern)) violations.push({ detail: match[0], field, kind: 'number_in_prose' });
  for (const match of normalized.matchAll(numberWordPattern)) violations.push({ detail: match[0], field, kind: 'number_in_prose' });
  for (const match of normalized.matchAll(weekdayPattern)) violations.push({ detail: match[0], field, kind: 'day_in_prose' });
  for (const match of normalized.matchAll(monthPattern)) violations.push({ detail: match[0], field, kind: 'date_in_prose' });
  for (const match of normalized.matchAll(dateWordPattern)) violations.push({ detail: match[0], field, kind: 'date_in_prose' });
  return violations;
}

/** The change directions a text asserts by verb ('up', 'down', 'same'). Exported for tests. */
export function assertedDirections(text: string): Set<'down' | 'same' | 'up'> {
  const normalized = text.normalize('NFKC');
  const found = new Set<'down' | 'same' | 'up'>();
  if (upVerbs.test(normalized)) found.add('up');
  if (downVerbs.test(normalized)) found.add('down');
  if (sameWords.test(normalized)) found.add('same');
  return found;
}

const sameNumber = (left: number, right: number) => Math.abs(left - right) < 1e-9;

/** The violations of one claim against the catalogue; empty when it equals its fact. */
export function checkClaim(claim: WeeklyInsightClaim, facts: ReadonlyMap<string, WeeklyInsightFact>): GroundingViolation[] {
  const target = facts.get(claim.factId);
  const field: GroundingField = 'observations';
  if (!target) return [{ detail: claim.factId, field, kind: 'unknown_fact' }];
  const violations: GroundingViolation[] = [];
  if (!sameNumber(claim.value, target.value)) violations.push({ detail: claim.factId, field, kind: 'claim_value_mismatch' });
  if (claim.unit !== target.unit) violations.push({ detail: claim.factId, field, kind: 'claim_unit_mismatch' });
  if (claim.direction !== target.direction) violations.push({ detail: claim.factId, field, kind: 'claim_direction_mismatch' });
  if (claim.day !== target.day) violations.push({ detail: claim.factId, field, kind: 'claim_day_mismatch' });
  return violations;
}

/** Every grounding violation of a schema-valid model answer; empty when it is grounded. */
export function checkGrounding(output: WeeklyInsightModelOutput, facts: readonly WeeklyInsightFact[]): GroundingViolation[] {
  const catalogue = new Map(facts.map((entry) => [entry.id, entry]));
  const violations: GroundingViolation[] = [];

  violations.push(...proseViolations(output.summary, 'summary'));
  const weekDirections = new Set(facts.filter((entry) => entry.direction !== 'none').map((entry) => entry.direction));
  for (const direction of assertedDirections(output.summary)) {
    if (!weekDirections.has(direction)) violations.push({ detail: direction, field: 'summary', kind: 'unsupported_direction' });
  }

  for (const observation of output.observations) {
    violations.push(...proseViolations(observation.text, 'observations'));
    for (const claim of observation.claims) violations.push(...checkClaim(claim, catalogue));
    const cited = new Set(
      observation.claims.flatMap((claim) => {
        const target = catalogue.get(claim.factId);
        return target && target.direction !== 'none' && target.direction === claim.direction ? [target.direction] : [];
      }),
    );
    for (const direction of assertedDirections(observation.text)) {
      if (!cited.has(direction)) violations.push({ detail: direction, field: 'observations', kind: 'unsupported_direction' });
    }
  }

  if (output.suggestion !== null) {
    violations.push(...proseViolations(output.suggestion, 'suggestion'));
  }
  return violations;
}
