import {
  MEAL_DRAFT_EXCERPT_MAX,
  MEAL_NUTRITION_FIELDS,
  MEAL_NUTRITION_MAX,
  MEAL_VALUE_DECIMALS,
  mealCarbohydrateGSchema,
  mealEnergyKcalSchema,
  mealFatGSchema,
  mealProteinGSchema,
  mealTitleSchema,
  type MealDraftClarificationReason,
  type MealDraftMealType,
  type MealDraftNutrition,
  type MealDraftNutritionResult,
  type MealDraftUnsupportedReason,
  type MealDraftWithheldReason,
  type MealNutritionField,
  type MealType,
} from '@running-tracker/contracts';
import type { z } from 'zod';

import type { MealDraftAbstention, MealDraftWireAnswer, NutrientClaim } from './meal-draft-wire.js';

// The grounding step of "Draft from text" (ADR-0092): deterministic code that decides what of a model's answer may be
// shown to the person as a proposal. The model only CLAIMS: "this excerpt of the text says protein 40 g". This module
// finds the excerpt in the text, finds the number in it with its own tokenizer, reads the sign before it in the ORIGINAL
// text, checks that the number is followed by the field's unit and attached to the field's nutrient, refuses a bound or
// negation in its clause, a range around the number in the original text (across line breaks) and a hedge anywhere,
// establishes that it is a whole-entry total (a per-portion qualifier or a nutrition label anywhere in the text requires
// the person's own summing phrase, such as "in total" or "итого", never a label's "total", because commas, lists, sentences
// and line breaks do not end a qualifier's scope), scans the text for a different value of the same nutrient under the
// same scope rule, and finally
// applies the meal contract (ADR-0083) to the exact decimal digits before any conversion to a number. It never computes a
// number: a proposed value is the number the person wrote, parsed exactly, or nothing.
//
// The rules are deliberately conservative. A false abstention costs the person one field to type; a false acceptance
// puts a number in their diary that they did not mean. When in doubt, the field is withheld.

export class UngroundedOutputError extends Error {
  public constructor() {
    super('The model answer is not grounded in the text');
    this.name = 'UngroundedOutputError';
  }
}

export type GroundedProposal =
  | { mealType: MealDraftMealType; nutrition: MealDraftNutrition; outcome: 'draft'; title: string }
  | { outcome: 'clarify'; reason: MealDraftClarificationReason }
  | { outcome: 'unsupported'; reason: MealDraftUnsupportedReason };

/** What happened to each field, for bounded logs and the evaluation. Never content. */
export type FieldDisposition = 'model_abstained' | 'not_stated' | 'proposed' | 'server_withheld';

export interface GroundingAudit {
  fields: Record<MealNutritionField, FieldDisposition> | null;
  /** The model answered with a draft, and the text names two different meals: the answer became a clarification. */
  multipleMealsOverride: boolean;
}

export interface GroundingResult {
  audit: GroundingAudit;
  proposal: GroundedProposal;
}

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary. English and Russian, matched case-insensitively and never inside a longer word.

const NOT_LETTER_BEFORE = '(?<![\\p{L}])';
const NOT_LETTER_AFTER = '(?![\\p{L}])';
const SPACE = '[ \\u00A0\\u202F]';

// Longest alternatives first: a regular expression alternation takes the first that matches.
const ENERGY_UNIT = '(?:kilocalories|kilocalorie|kcals|kcal|calories|calorie|cals|cal|килокалорий|килокалории|килокалория|ккал|калорий|калории|калория|кал)';
const GRAM_UNIT = '(?:grammes|gramme|grams|gram|gr|g|граммов|грамма|грамм|гр|г)';
const OTHER_UNIT = '(?:kj|кдж|mcg|мкг|mg|мг|kg|кг|oz|lbs|lb|ml|мл|l|л|%)';
// Words that name food energy as a unit when they come BEFORE the number ("Calories: 650", "ккал 650").
const ENERGY_UNIT_WORD_BEFORE = '(?:kcal|calories|калорий|калории|калорийность|ккал)';

const METRIC: Readonly<Record<Exclude<MealNutritionField, 'energyKcal'>, string>> = {
  carbohydrateG: '(?:carbohydrates|carbohydrate|carbs|carb|углеводов|углеводы|углевода|углевод)',
  fatG: '(?:fats|fat|жиров|жиры|жира|жир)',
  proteinG: '(?:proteins|protein|белков|белка|белки|белке|белком|белок|протеина|протеин)',
};

const MEAL_TYPE_WORDS: Readonly<Record<Exclude<MealType, 'other'>, string>> = {
  breakfast: '(?:breakfast\\p{L}*|позавтрака\\p{L}*|завтрак\\p{L}*)',
  dinner: '(?:dinner\\p{L}*|supper\\p{L}*|поужина\\p{L}*|ужин\\p{L}*)',
  lunch: '(?:lunch\\p{L}*|пообеда\\p{L}*|обед\\p{L}*)',
  snack: '(?:snack\\p{L}*|перекуси\\p{L}*|перекус\\p{L}*|полдник\\p{L}*)',
};

const word = (alternatives: string) => new RegExp(`${NOT_LETTER_BEFORE}${alternatives}${NOT_LETTER_AFTER}`, 'iu');

// Minus signs. ASCII hyphen-minus, the Unicode minus and their hyphen-like variants are a sign whenever they stand before
// a number that does not follow another number (that is a range). The en dash is a sign only directly before the digits;
// spaced, it is the usual separator ("Soup – 300 kcal"), as the em dash always is ("Белки — 35 г").
const MINUS = /[-‐‑‒−﹣－]/u;
const MINUS_OR_DASH = '[\\u002D\\u2010-\\u2014\\u2212\\uFE63\\uFF0D]';

// A per-portion qualifier: a value per something, or one that needs a multiplication to become a total. It can stand
// before or after the values it governs, in another clause, in a heading above a list or in a later sentence, so its
// presence ANYWHERE in the text means a value's whole-entry scope must be established explicitly (see `wholeEntryScoped`).
const PER_PORTION = new RegExp(
  [
    `${NOT_LETTER_BEFORE}(?:per|each|apiece|serving|servings|portion|portions|piece|pieces|pcs|pc|кажд\\p{L}*|порци\\p{L}*|штук\\p{L}*|шт)${NOT_LETTER_AFTER}`,
    // "по 70 ккал", "по 2 штуки": по before a number. Not "по-домашнему" or "по вкусу".
    `${NOT_LETTER_BEFORE}по${SPACE}*\\d`,
    // "in 100 g", "for 100", "на 100 г", "в 100 мл", "для 30 г".
    `${NOT_LETTER_BEFORE}(?:in|for|на|в|за|для)${SPACE}*100(?!\\d)`,
    `${NOT_LETTER_BEFORE}(?:in|for|на|в|за|для)${SPACE}*\\d+(?:[.,]\\d+)?${SPACE}*(?:grams|gram|gr|g|ml|граммов|грамма|грамм|гр|г|мл)${NOT_LETTER_AFTER}`,
    // "kcal/100 g", "g/serving": a slash after a unit. Not a date such as 14/11.
    '\\p{L}\\s*\\/\\s*[\\p{L}\\p{N}]',
    '\\d\\s*[x×*]\\s*\\d',
    `${NOT_LETTER_BEFORE}[x×]\\s*\\d`,
    '\\d\\s*[x×](?![\\p{L}\\p{N}])',
    `${NOT_LETTER_BEFORE}(?:twice|double|triple|times|дважды|раза)${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

// A nutrition label or its heading: the values under it are per serving or per 100 g, a basis the text may not state.
const NUTRITION_LABEL = new RegExp(
  `${NOT_LETTER_BEFORE}(?:nutrition facts|nutrition(?:al)? (?:information|info|values?|label)|label|этикетк\\p{L}*|на упаковке|пищев\\p{L}* ценност\\p{L}*|энергетическ\\p{L}* ценност\\p{L}*)${NOT_LETTER_AFTER}`,
  'iu',
);

// The person's own summing phrase: the only wording that ties a value to the entry when the text also carries a label or
// a per-portion qualifier (see `wholeEntryScoped`). Deliberately ONLY adverbial phrases that sum up what was eaten. Never
// a word a nutrition label prints or that also reads as an adjective in front of a nutrient, wherever it stands: "total"
// and "totals" ("Total fat 5 g", "Fat 4 g total", "Total: fat 4 g"), "overall" ("Overall fat"), and in Russian "всего"
// (also "only", and a label's "всего") or "целиком" (describes the food, not a figure). Those words are not refused; they
// simply prove nothing about scope, so a value they introduce stays under the label or qualifier.
const ENTRY_SUM = new RegExp(
  `${NOT_LETTER_BEFORE}(?:in${SPACE}+total|altogether|all${SPACE}+together|итого|в${SPACE}+сумме|суммарно|в${SPACE}+общей${SPACE}+сложности)${NOT_LETTER_AFTER}`,
  'iu',
);

// A food quantity's unit: mass or volume. A number with one of these that is not a macronutrient statement is an amount
// of food ("I ate 200 g"), so a summing phrase beside it may sum the food rather than the nutrients.
const QUANTITY_UNIT = new RegExp(`^${SPACE}?(?:${GRAM_UNIT}|kg|кг|oz|lbs|lb|ml|мл|l|л)${NOT_LETTER_AFTER}`, 'iu');

// The unit right after a number, by kind, for telling a range ("500 - 600 kcal") from two statements of different units
// ("300 kcal - 5 g protein").
const UNIT_KIND = `(?:(?<energy>${ENERGY_UNIT})|(?<gram>${GRAM_UNIT})|(?<other>${OTHER_UNIT}))${NOT_LETTER_AFTER}`;
// What joins the two endpoints of a range: any minus or dash, "to", "or", "до", "или". Only whitespace (ordinary, no-break,
// narrow no-break, line breaks) may stand around it; any punctuation between the numbers makes them separate statements.
const RANGE_SEPARATOR = `(?:${MINUS_OR_DASH}|${NOT_LETTER_BEFORE}(?:to|or|до|или)${NOT_LETTER_AFTER})`;
// The lower endpoint (its last digit) and the separator, directly before a number (matched against the text BEFORE it).
const RANGE_BEFORE = new RegExp(`\\d(?:\\s*${UNIT_KIND})?\\s*${RANGE_SEPARATOR}\\s*$`, 'iu');
// The separator and the upper endpoint, directly after a number and its own optional unit (matched against the text
// AFTER it). `lead` is everything before the upper endpoint's digits, so its position in the text is known.
const RANGE_AFTER = new RegExp(
  `^(?<lead>(?:\\s*(?:${ENERGY_UNIT}|${GRAM_UNIT}|${OTHER_UNIT})${NOT_LETTER_AFTER})?\\s*${RANGE_SEPARATOR}\\s*)\\d+(?:[.,]\\d+)?(?:\\s*${UNIT_KIND})?`,
  'iu',
);

// A hedge makes every number the person wrote an estimate, wherever it stands ("These are estimates, 500 kcal").
const HEDGE = new RegExp(
  `${NOT_LETTER_BEFORE}(?:about|around|approx\\p{L}*|roughly|nearly|almost|maybe|probably|perhaps|possibly|estimat\\p{L}*|guess\\p{L}*|ish|or so|около|примерно|приблизительно|где-?то|вроде|наверное|наверно|может|возможно|кажется|почти|оцен\\p{L}*)${NOT_LETTER_AFTER}`,
  'iu',
);

// A bound, a range, an approximation sign or a question in the value's own clause.
const AMBIGUOUS = new RegExp(
  [
    `${NOT_LETTER_BEFORE}(?:at least|at most|up to|less than|more than|over|under|below|above|менее|более|меньше|больше|свыше|минимум|максимум)${NOT_LETTER_AFTER}`,
    '[~≈±<>≤≥?]',
    `\\d\\s*(?:${MINUS_OR_DASH}|to|or|или|до)\\s*\\d`,
  ].join('|'),
  'iu',
);

const NEGATED = new RegExp(
  `${NOT_LETTER_BEFORE}(?:no|not|without|never|none|не|без|нет|ни)${NOT_LETTER_AFTER}|n['’]t${NOT_LETTER_AFTER}`,
  'iu',
);

// A number as people write it: digits, optionally one decimal separator and more digits. Never directly after a letter
// or a digit (B12, x2), never after a separator that follows a digit (the tail of 1.5).
const NUMBER = /(?<![\p{L}\p{N}_])(?<!\d[.,])\d+(?:[.,]\d+)?(?!\p{N})/gu;

// ---------------------------------------------------------------------------------------------------------------
// Tokens and mentions.

interface NumberToken {
  end: number;
  start: number;
  text: string;
}

function numberTokens(text: string, from = 0, to = text.length): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start >= from && end <= to) tokens.push({ end, start, text: match[0] });
  }
  return tokens;
}

/**
 * A decimal exactly as written, normalised without any arithmetic: no leading zeros in the integer part (except a lone
 * 0) and no trailing zeros in the fraction. "12.50", "12,5" and "012.5" are one value; "12.5000000000000001" is not 12.5.
 */
interface ExactDecimal {
  fraction: string;
  integer: string;
}

function exactDecimal(digits: string): ExactDecimal {
  const [integer = '0', fraction = ''] = digits.split(/[.,]/u);
  return { fraction: fraction.replace(/0+$/u, ''), integer: integer.replace(/^0+(?=\d)/u, '') };
}

const sameDecimal = (left: ExactDecimal, right: ExactDecimal): boolean => left.integer === right.integer && left.fraction === right.fraction;

type ParsedNumber = { kind: 'ambiguous' } | { kind: 'negative' } | { decimal: ExactDecimal; kind: 'value' };

type SignBefore = 'ambiguous' | 'negative' | 'none';

/**
 * What stands before the number in the ORIGINAL text, whatever the excerpt includes: a minus sign directly before it
 * (negative), a minus sign separated from it by whitespace (ordinary, no-break, narrow no-break or any other space: it may
 * be a sign or a stray dash, so it is ambiguous), or nothing. A minus that follows another number is the dash of a range,
 * which the clause check refuses on its own.
 */
function signBefore(text: string, start: number): SignBefore {
  let index = start;
  while (index > 0 && /\s/u.test(text[index - 1]!)) index -= 1;
  const spaced = index < start;
  const sign = text[index - 1] ?? '';
  const enDash = sign === '–';
  if (!MINUS.test(sign) && !enDash) return 'none';
  let before = index - 1;
  while (before > 0 && /\s/u.test(text[before - 1]!)) before -= 1;
  if (/\d/u.test(text[before - 1] ?? '')) return 'none';
  if (enDash) return spaced ? 'none' : 'negative';
  return spaced ? 'ambiguous' : 'negative';
}

/** The number a token denotes, exactly, or why it does not denote exactly one non-negative number. */
function parseToken(text: string, token: NumberToken): ParsedNumber {
  const separator = /[.,]/u.exec(token.text);
  // 1,200 or 1.200: a thousands separator in one convention, a decimal in another. Never guessed.
  if (separator !== null && token.text.length - separator.index - 1 === 3) return { kind: 'ambiguous' };
  // 1 200 (space-grouped thousands) seen from either side.
  if (new RegExp(`\\d${SPACE}$`, 'u').test(text.slice(Math.max(0, token.start - 2), token.start))) return { kind: 'ambiguous' };
  if (new RegExp(`^${SPACE}\\d{3}(?!\\d)`, 'u').test(text.slice(token.end, token.end + 5))) return { kind: 'ambiguous' };
  const sign = signBefore(text, token.start);
  if (sign === 'negative') return { kind: 'negative' };
  if (sign === 'ambiguous') return { kind: 'ambiguous' };
  return { decimal: exactDecimal(token.text), kind: 'value' };
}

/** The model's value as an exact decimal, or null when it is anything else ("about 600", "-30", "6e2", "650 kcal"). */
function parseClaimedValue(value: string): ExactDecimal | null {
  const trimmed = value.trim();
  if (!/^\d+(?:[.,]\d+)?$/u.test(trimmed)) return null;
  return exactDecimal(trimmed);
}

/**
 * The public number for an exact decimal, only after the meal contract's rules held on the exact digits: at most
 * MEAL_VALUE_DECIMALS meaningful decimals and at most the field's maximum, compared in integer tenths (BigInt), so no
 * floating-point conversion can round a refused value into an accepted one. Null when the contract refuses it.
 */
function contractValue(decimal: ExactDecimal, field: MealNutritionField): number | null {
  if (decimal.fraction.length > MEAL_VALUE_DECIMALS) return null;
  const scale = 10n ** BigInt(MEAL_VALUE_DECIMALS);
  const scaled = BigInt(decimal.integer) * scale + BigInt(decimal.fraction.padEnd(MEAL_VALUE_DECIMALS, '0'));
  if (scaled > BigInt(MEAL_NUTRITION_MAX[field]) * scale) return null;
  // Exact now: at most five integer digits and one decimal, which a double represents as the decimal it is written as.
  const value = Number(decimal.fraction === '' ? decimal.integer : `${decimal.integer}.${decimal.fraction}`);
  const accepted = fieldSchemas[field].safeParse(value);
  return accepted.success ? accepted.data : null;
}

type MentionCheck =
  | { kind: 'mention'; end: number; start: number }
  | { kind: 'no_unit' }
  | { kind: 'other_unit' }
  | { kind: 'not_attached' };

/**
 * Whether the number token is a statement of `field`: followed by the field's unit (energy may name its unit before the
 * number instead), and for a macronutrient attached to its name on either side ("protein 40 g", "40 g of protein",
 * "белок 40 г", "40 г белка"). A grams figure next to anything else is a food quantity, never a nutrient.
 */
function checkMention(text: string, token: NumberToken, field: MealNutritionField): MentionCheck {
  const after = text.slice(token.end);
  const before = text.slice(0, token.start);
  if (new RegExp(`^${SPACE}?${OTHER_UNIT}${NOT_LETTER_AFTER}`, 'iu').test(after)) return { kind: 'other_unit' };

  if (field === 'energyKcal') {
    const unit = new RegExp(`^${SPACE}?${ENERGY_UNIT}${NOT_LETTER_AFTER}`, 'iu').exec(after);
    if (unit !== null) return { end: token.end + unit[0].length, kind: 'mention', start: token.start };
    const unitBefore = new RegExp(`${NOT_LETTER_BEFORE}${ENERGY_UNIT_WORD_BEFORE}${SPACE}*[:=\\-–—]?${SPACE}*$`, 'iu').exec(before);
    if (unitBefore !== null && !new RegExp(`^${SPACE}?${GRAM_UNIT}${NOT_LETTER_AFTER}`, 'iu').test(after)) {
      return { end: token.end, kind: 'mention', start: unitBefore.index };
    }
    return { kind: 'no_unit' };
  }

  const unit = new RegExp(`^${SPACE}?${GRAM_UNIT}${NOT_LETTER_AFTER}`, 'iu').exec(after);
  if (unit === null) return { kind: 'no_unit' };
  const unitEnd = token.end + unit[0].length;
  const metric = METRIC[field];
  const metricBefore = new RegExp(`${NOT_LETTER_BEFORE}${metric}${SPACE}*[:=\\-–—]?${SPACE}*$`, 'iu').exec(before);
  if (metricBefore !== null) return { end: unitEnd, kind: 'mention', start: metricBefore.index };
  const metricAfter = new RegExp(`^${SPACE}*(?:of${SPACE}+)?${metric}${NOT_LETTER_AFTER}`, 'iu').exec(text.slice(unitEnd));
  if (metricAfter !== null) return { end: unitEnd + metricAfter[0].length, kind: 'mention', start: token.start };
  return { kind: 'not_attached' };
}

/** The clause around [start, end): up to the nearest ; ! ? | line break, or a . or , that is not between two digits. */
function clauseAround(text: string, start: number, end: number): { closer: string; text: string } {
  const isBoundary = (index: number): boolean => {
    const character = text[index] ?? '';
    if (/[;!?|\n\r]/u.test(character)) return true;
    if (character === '.' || character === ',') {
      return !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''));
    }
    return false;
  };
  let left = start;
  while (left > 0 && !isBoundary(left - 1)) left -= 1;
  let right = end;
  while (right < text.length && !isBoundary(right)) right += 1;
  return { closer: text[right] ?? '', text: text.slice(left, right) };
}

/**
 * The sentences of the text: split at ; ! ? or a full stop that is not a decimal point. Commas, colons and line breaks do
 * NOT end a sentence, so a heading and the list below it, or a list and the qualifier after it, stay together.
 */
function sentences(text: string): Array<{ end: number; start: number; text: string }> {
  const found: Array<{ end: number; start: number; text: string }> = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index] ?? '';
    const boundary =
      index === text.length || /[;!?]/u.test(character) || (character === '.' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? '')));
    if (boundary) {
      found.push({ end: index, start, text: text.slice(start, index) });
      start = index + 1;
    }
  }
  return found;
}

const hasPortionQualifier = (fragment: string): boolean => PER_PORTION.test(fragment) || NUTRITION_LABEL.test(fragment);

/** Whether a stretch of the text states any nutrient at all (a number with a nutrient's unit and, for grams, its name). */
function statesAnyNutrient(text: string, start: number, end: number): boolean {
  return numberTokens(text, start, end).some((token) =>
    MEAL_NUTRITION_FIELDS.some((field) => {
      const mention = checkMention(text, token, field);
      return mention.kind === 'mention' && mention.end <= end;
    }),
  );
}

const MACRONUTRIENT_FIELDS = MEAL_NUTRITION_FIELDS.filter((field) => field !== 'energyKcal');

/** Whether a stretch of the text states an amount of food: a mass or volume that is not a macronutrient statement. */
function statesFoodQuantity(text: string, start: number, end: number): boolean {
  return numberTokens(text, start, end).some(
    (token) => QUANTITY_UNIT.test(text.slice(token.end)) && !MACRONUTRIENT_FIELDS.some((field) => checkMention(text, token, field).kind === 'mention'),
  );
}

/**
 * Whether the value at [start, end) is a total for the whole entry. With no per-portion qualifier or nutrition label
 * anywhere in the text, it is. Otherwise the label or qualifier stays in force across commas, lists, sentences, line
 * breaks and the model's excerpt until the person resolves it for this value, which takes ALL of:
 *
 * - the value's sentence carries the person's own summing phrase (`ENTRY_SUM`: "in total", "altogether", "итого", "в
 *   сумме"…). A label's "total" ("Total protein 4 g", "Fat 4 g total", "Total: fat 4 g"), "overall" or "всего" is not
 *   one, so it never establishes the amount eaten;
 * - that sentence carries no qualifier or label itself, and states no amount of food ("I ate 200 g in total, protein
 *   8 g": the phrase may sum the food, and the 8 g may still be per 100 g);
 * - no qualifier in the text floats free of values (a value-less sentence such as "Values are per 100 g." may refer to
 *   any sentence).
 *
 * Sentences end only at . ; ! ? (not at commas, colons or line breaks), so a heading and the lines below it stay one
 * sentence and keep their qualifier. Nothing is multiplied or inferred either way.
 */
function wholeEntryScoped(text: string, start: number, end: number): boolean {
  if (!hasPortionQualifier(text)) return true;
  const all = sentences(text);
  const own = all.find((sentence) => start >= sentence.start && end <= sentence.end);
  if (own === undefined || hasPortionQualifier(own.text) || !ENTRY_SUM.test(own.text) || statesFoodQuantity(text, own.start, own.end)) return false;
  return all.every((sentence) => !hasPortionQualifier(sentence.text) || statesAnyNutrient(text, sentence.start, sentence.end));
}

type UnitKind = 'energy' | 'gram' | 'none' | 'other';

const unitKind = (groups: Record<string, string | undefined> | undefined): UnitKind =>
  groups?.energy !== undefined ? 'energy' : groups?.gram !== undefined ? 'gram' : groups?.other !== undefined ? 'other' : 'none';

/**
 * Whether the number token is one endpoint of a range in the ORIGINAL text, whatever the excerpt or the clause shows:
 * another number directly before it or directly after it (and its own unit), joined only by whitespace (line breaks
 * included) and a minus, a dash, "to", "or", "до" or "или". Both directions are checked, so a range is seen from either
 * endpoint. Two numbers are NOT a range when anything else stands between them (a full stop, a semicolon, a comma: they
 * are separate statements), when the other number carries a different kind of unit ("300 kcal – 5 g protein", "200 ml –
 * 120 kcal"), or when the other number is itself a statement of a different nutrient ("protein 30 g – 5 g fat").
 */
function inRange(text: string, token: NumberToken, field: MealNutritionField): boolean {
  const own: UnitKind = field === 'energyKcal' ? 'energy' : 'gram';
  const tokens = numberTokens(text);
  const joins = (other: NumberToken | undefined, kind: UnitKind): boolean => {
    if (kind !== own && kind !== 'none') return false;
    return other === undefined || !MEAL_NUTRITION_FIELDS.some((candidate) => candidate !== field && checkMention(text, other, candidate).kind === 'mention');
  };
  const before = RANGE_BEFORE.exec(text.slice(0, token.start));
  if (before !== null && joins(tokens.find((other) => other.end === before.index + 1), unitKind(before.groups))) return true;
  const after = RANGE_AFTER.exec(text.slice(token.end));
  if (after === null) return false;
  const upperStart = token.end + (after.groups?.lead ?? '').length;
  return joins(
    tokens.find((other) => other.start === upperStart),
    unitKind(after.groups),
  );
}

/**
 * Why the value at [start, end) (the number `token` with its unit and nutrient) cannot be proposed as stated, or null:
 * its clause, a range around the number in the original text, a hedge anywhere, then its scope.
 */
function scopeReason(text: string, start: number, end: number, token: NumberToken, field: MealNutritionField): MealDraftWithheldReason | null {
  const clause = clauseAround(text, start, end);
  if (hasPortionQualifier(clause.text)) return 'per_portion';
  if (AMBIGUOUS.test(clause.text) || clause.closer === '?' || inRange(text, token, field)) return 'ambiguous';
  if (NEGATED.test(clause.text)) return 'negated';
  if (HEDGE.test(text)) return 'ambiguous';
  if (!wholeEntryScoped(text, start, end)) return 'per_portion';
  return null;
}

/**
 * Every value the text states for `field` with whole-entry scope (the same rule as for a proposal); more than one is a
 * conflict. A mention whose sign or notation is not one plain number counts as a value of its own, so "500 kcal" next to
 * "-500 kcal" or "1,200 kcal" is a conflict, never a quiet choice.
 */
function distinctStatedValues(text: string, field: MealNutritionField): Set<string> {
  const values = new Set<string>();
  for (const token of numberTokens(text)) {
    const mention = checkMention(text, token, field);
    if (mention.kind !== 'mention') continue;
    if (hasPortionQualifier(clauseAround(text, mention.start, mention.end).text) || !wholeEntryScoped(text, mention.start, mention.end)) continue;
    const parsed = parseToken(text, token);
    values.add(parsed.kind === 'value' ? `${parsed.decimal.integer}.${parsed.decimal.fraction}` : `${parsed.kind}@${token.start}`);
  }
  return values;
}

/** Where the claimed excerpt is in the text: exactly, or else ignoring case, as the text spells it. */
function locate(text: string, excerpt: string): { end: number; start: number } | null {
  const claimed = excerpt.trim();
  if (claimed === '') return null;
  const exact = text.indexOf(claimed);
  if (exact !== -1) return { end: exact + claimed.length, start: exact };
  const escaped = claimed.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const folded = new RegExp(escaped, 'iu').exec(text);
  return folded === null ? null : { end: folded.index + folded[0].length, start: folded.index };
}

const fieldSchemas: Readonly<Record<MealNutritionField, z.ZodType<number>>> = {
  carbohydrateG: mealCarbohydrateGSchema,
  energyKcal: mealEnergyKcalSchema,
  fatG: mealFatGSchema,
  proteinG: mealProteinGSchema,
};

const abstentionReason: Readonly<Record<Exclude<MealDraftAbstention, 'not_stated'>, MealDraftWithheldReason>> = {
  conflicting: 'conflicting',
  negated: 'negated',
  not_exact: 'ambiguous',
  per_portion: 'per_portion',
  unit_not_supported: 'unit_not_supported',
};

interface FieldOutcome {
  disposition: FieldDisposition;
  result: MealDraftNutritionResult;
}

const withheld = (reason: MealDraftWithheldReason): FieldOutcome => ({
  disposition: 'server_withheld',
  result: { reason, status: 'withheld' },
});

/** One field's claim against the text. Exported for its specification. */
export function groundNutrient(text: string, field: MealNutritionField, claim: NutrientClaim): FieldOutcome {
  // An abstention is taken as it is: it proposes nothing. Its reason only chooses the sentence the screen shows.
  if (claim.value === null && claim.evidence === null && claim.abstain !== null) {
    return claim.abstain === 'not_stated'
      ? { disposition: 'not_stated', result: { status: 'not_stated' } }
      : { disposition: 'model_abstained', result: { reason: abstentionReason[claim.abstain], status: 'withheld' } };
  }
  if (claim.value === null || claim.evidence === null || claim.abstain !== null) return withheld('unverified');

  const claimed = parseClaimedValue(claim.value);
  const span = locate(text, claim.evidence);
  if (claimed === null || span === null) return withheld('unverified');
  const excerpt = text.slice(span.start, span.end);
  if ([...excerpt].length > MEAL_DRAFT_EXCERPT_MAX) return withheld('unverified');

  // The excerpt's own numbers, read by this tokenizer; the one that states the claimed value for this field.
  const tokens = numberTokens(text, span.start, span.end);
  let diagnosis: MealDraftWithheldReason = 'unverified';
  let chosen: { decimal: ExactDecimal; end: number; start: number; token: NumberToken } | null = null;
  for (const token of tokens) {
    const parsed = parseToken(text, token);
    if (parsed.kind === 'ambiguous') {
      diagnosis = 'ambiguous';
      continue;
    }
    if (parsed.kind === 'negative') {
      diagnosis = 'outside_contract';
      continue;
    }
    // Exact decimal equality: a claim of 12.5 is not the text's 12.5000000000000001.
    if (!sameDecimal(parsed.decimal, claimed)) continue;
    const mention = checkMention(text, token, field);
    if (mention.kind === 'other_unit' || mention.kind === 'no_unit') {
      diagnosis = 'unit_not_supported';
      continue;
    }
    if (mention.kind === 'not_attached') continue;
    // The value, its unit and its nutrient must all be inside the excerpt the model pointed at.
    if (mention.start < span.start || mention.end > span.end) continue;
    chosen = { decimal: parsed.decimal, end: mention.end, start: mention.start, token };
    break;
  }
  if (chosen === null) return withheld(diagnosis);

  const scope = scopeReason(text, chosen.start, chosen.end, chosen.token, field);
  if (scope !== null) return withheld(scope);
  if (distinctStatedValues(text, field).size > 1) return withheld('conflicting');

  // The contract's precision and bounds on the exact digits; only then the public number.
  const value = contractValue(chosen.decimal, field);
  if (value === null) return withheld('outside_contract');
  return { disposition: 'proposed', result: { excerpt, status: 'proposed', value } };
}

/** The meal types the text names (by their words), in a fixed order. */
export function mealTypesNamed(text: string): Exclude<MealType, 'other'>[] {
  return (Object.keys(MEAL_TYPE_WORDS) as Exclude<MealType, 'other'>[]).filter((type) => word(MEAL_TYPE_WORDS[type]).test(text));
}

function groundMealType(text: string, answer: { mealType: string | null; mealTypeEvidence: string | null }): MealDraftMealType {
  const type = answer.mealType as Exclude<MealType, 'other'> | null;
  if (type === null || answer.mealTypeEvidence === null || !(type in MEAL_TYPE_WORDS)) return { status: 'not_stated' };
  const span = locate(text, answer.mealTypeEvidence);
  if (span === null) return { status: 'not_stated' };
  const excerpt = text.slice(span.start, span.end);
  if ([...excerpt].length > MEAL_DRAFT_EXCERPT_MAX || !word(MEAL_TYPE_WORDS[type]).test(excerpt)) return { status: 'not_stated' };
  return { excerpt, status: 'proposed', value: type };
}

// A nutrition STATEMENT, not a nutrient word: "Protein bar" and "Low-fat yogurt" are titles, "Shake 30 g protein" and
// "Soup 300 kcal" are not.
const ANY_METRIC = `(?:${Object.values(METRIC).join('|')})`;
const NUTRITION_IN_TITLE = new RegExp(
  [
    `\\d${SPACE}?${ENERGY_UNIT}${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}${ENERGY_UNIT_WORD_BEFORE}${SPACE}*[:=\\-–—]?${SPACE}*\\d`,
    `${NOT_LETTER_BEFORE}${ANY_METRIC}${SPACE}*[:=\\-–—]?${SPACE}*\\d`,
    `\\d${SPACE}?${GRAM_UNIT}${SPACE}*(?:of${SPACE}+)?${ANY_METRIC}${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

/**
 * The title as the text spells it, or null. It must be an excerpt of the text, a valid meal title, say something beyond
 * the meal's name ("Dinner" alone is not a title), and carry no nutrition statement (a title is not evidence).
 */
export function groundTitle(text: string, claimed: string): string | null {
  const span = locate(text, claimed);
  if (span === null) return null;
  const title = text.slice(span.start, span.end);
  if (/[\n\r]/u.test(title) || !mealTitleSchema.safeParse(title).success || !/\p{L}/u.test(title)) return null;
  if (NUTRITION_IN_TITLE.test(title)) return null;
  const withoutMealWords = Object.values(MEAL_TYPE_WORDS).reduce(
    (rest, words) => rest.replace(new RegExp(`${NOT_LETTER_BEFORE}${words}${NOT_LETTER_AFTER}`, 'giu'), ''),
    title,
  );
  if (!/\p{L}/u.test(withoutMealWords)) return null;
  return title;
}

/**
 * The model's answer, grounded in the text. A clarification or an unsupported answer carries only its code. A draft is
 * rebuilt from what checks out: the title (or the whole answer is refused as ungrounded, because a draft without a
 * grounded title is not a draft of what the person wrote), a meal type the text names, and each nutrient on its own.
 * Throws UngroundedOutputError for a title that is not grounded.
 */
export function groundMealDraft(text: string, answer: MealDraftWireAnswer): GroundingResult {
  if (answer.outcome === 'clarify') {
    return { audit: { fields: null, multipleMealsOverride: false }, proposal: { outcome: 'clarify', reason: answer.reason } };
  }
  if (answer.outcome === 'unsupported') {
    return { audit: { fields: null, multipleMealsOverride: false }, proposal: { outcome: 'unsupported', reason: answer.reason } };
  }

  // Two different meals named in one text ("breakfast ... lunch ...") is never one entry, whatever the model said.
  if (mealTypesNamed(text).length > 1) {
    return { audit: { fields: null, multipleMealsOverride: true }, proposal: { outcome: 'clarify', reason: 'multiple_meals' } };
  }

  const title = groundTitle(text, answer.title);
  if (title === null) throw new UngroundedOutputError();

  const fields = {} as Record<MealNutritionField, FieldDisposition>;
  const nutrition = {} as Record<MealNutritionField, MealDraftNutritionResult>;
  for (const field of MEAL_NUTRITION_FIELDS) {
    const outcome = groundNutrient(text, field, answer[field]);
    fields[field] = outcome.disposition;
    nutrition[field] = outcome.result;
  }
  return {
    audit: { fields, multipleMealsOverride: false },
    proposal: {
      mealType: groundMealType(text, answer),
      nutrition,
      outcome: 'draft',
      title,
    },
  };
}
