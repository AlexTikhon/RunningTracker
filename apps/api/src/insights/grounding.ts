import type { WeeklyInsightOutput } from '@running-tracker/contracts';

import { datesOf, metricKeysOf, numbersOf, type WeeklyAggregate } from './weekly-aggregate.js';

// Grounding check (ADR-0076): the text of an answer may contain only numbers that are in the computed aggregate, and
// may cite only metric keys that exist in it. A violation discards the whole answer.
//
// Rules, in the order they are applied to each text field (summary, every observation, suggestion, every data gap):
//
// 1. Calendar dates written as YYYY-MM-DD are allowed only when they are one of the aggregate's dates (the week's first
//    and last day); a date is checked as a whole and its parts are not read as numbers. Any other date is a violation.
// 2. Every other run of digits is a number: `452`, `7.5`, `1,500` (a comma followed by exactly three digits groups
//    thousands; any other comma separates two numbers). Digits glued to letters still count (`5km` is 5, `2nd` is 2),
//    and a range `6-8` is two numbers, 6 and 8. Signs are ignored: `-0.8` and `0.8` are both checked as 0.8, because a
//    change is often described in words ("lost 0.8 kg").
// 3. Number words are numbers too: zero, two to twenty, twice (2) and dozen (12). "one" and "once" are not checked:
//    they are far more often a pronoun or an adverb than a count.
// 4. A number written with d decimal places (as written: `7.50` has two) is grounded when some number V in the
//    aggregate, taken without its sign, equals it after rounding V to d places, half away from zero, or after cutting
//    V to d places. So 452 grounds `452`; 7.5 grounds `7.5`, `7.50`, `8` (rounded) and `7` (cut); 72.45 grounds
//    `72.5` and `72.4`. Nothing else is tolerated: no relative error, no unit conversion. The aggregate already holds
//    the converted values the model may want (minutes and hours of sleep, kilometres, a coverage percentage).
//
// Known limit: small integers (1 to 10) are often present in the aggregate as a count or a scale value, so a wrong
// small number can be grounded by coincidence. The check proves that every number is one the data contains, not that
// it is attached to the right metric.

export type GroundingField = 'dataGaps' | 'observations' | 'suggestion' | 'summary';

export interface GroundingViolation {
  /** The offending number or date as written, or the unknown metric key. Never surrounding prose. */
  detail: string;
  field: GroundingField;
  kind: 'ungrounded_date' | 'ungrounded_number' | 'unknown_metric_key';
}

const numberWords: Readonly<Record<string, number>> = {
  dozen: 12,
  eight: 8,
  eighteen: 18,
  eleven: 11,
  fifteen: 15,
  five: 5,
  four: 4,
  fourteen: 14,
  nine: 9,
  nineteen: 19,
  seven: 7,
  seventeen: 17,
  six: 6,
  sixteen: 16,
  ten: 10,
  thirteen: 13,
  three: 3,
  twelve: 12,
  twenty: 20,
  twice: 2,
  two: 2,
  zero: 0,
};

const isoDatePattern = /\b\d{4}-\d{2}-\d{2}\b/gu;
// Thousands groups first, so `1,500` is one number; then plain decimals.
const numberPattern = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/gu;
const wordPattern = new RegExp(`\\b(${Object.keys(numberWords).join('|')})\\b`, 'giu');

export interface WrittenNumber {
  decimals: number;
  text: string;
  value: number;
}

/** The dates and numbers a text contains, by the rules above. Exported for tests. */
export function extractNumbers(text: string): { dates: string[]; numbers: WrittenNumber[] } {
  const dates = [...text.matchAll(isoDatePattern)].map((match) => match[0]);
  const withoutDates = text.replace(isoDatePattern, ' ');
  const numbers: WrittenNumber[] = [];
  for (const match of withoutDates.matchAll(numberPattern)) {
    const written = match[0];
    const plain = written.replaceAll(',', '');
    const decimals = plain.includes('.') ? plain.length - plain.indexOf('.') - 1 : 0;
    numbers.push({ decimals, text: written, value: Number(plain) });
  }
  for (const match of withoutDates.matchAll(wordPattern)) {
    numbers.push({ decimals: 0, text: match[0], value: numberWords[match[0].toLowerCase()]! });
  }
  return { dates, numbers };
}

function roundHalfAway(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor + 1e-9) / factor;
}

function cut(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor + 1e-9) / factor;
}

const same = (left: number, right: number) => Math.abs(left - right) < 1e-9;

/** True when `written` is grounded by one of `values` (rule 4). Exported for tests. */
export function isGrounded(written: WrittenNumber, values: readonly number[]): boolean {
  return values.some((candidate) => {
    const magnitude = Math.abs(candidate);
    return same(roundHalfAway(magnitude, written.decimals), written.value) || same(cut(magnitude, written.decimals), written.value);
  });
}

function textsOf(output: WeeklyInsightOutput): { field: GroundingField; text: string }[] {
  return [
    { field: 'summary', text: output.summary },
    ...output.observations.map((observation) => ({ field: 'observations' as const, text: observation.text })),
    { field: 'suggestion', text: output.suggestion },
    ...output.dataGaps.map((gap) => ({ field: 'dataGaps' as const, text: gap })),
  ];
}

/** Every grounding violation of a schema-valid answer; empty when it is grounded. */
export function checkGrounding(output: WeeklyInsightOutput, aggregate: WeeklyAggregate): GroundingViolation[] {
  const values = numbersOf(aggregate);
  const dates = new Set(datesOf(aggregate));
  const keys = new Set(metricKeysOf(aggregate));
  const violations: GroundingViolation[] = [];

  for (const { field, text } of textsOf(output)) {
    const found = extractNumbers(text);
    for (const date of found.dates) {
      if (!dates.has(date)) violations.push({ detail: date, field, kind: 'ungrounded_date' });
    }
    for (const written of found.numbers) {
      if (!isGrounded(written, values)) violations.push({ detail: written.text, field, kind: 'ungrounded_number' });
    }
  }
  for (const observation of output.observations) {
    for (const key of observation.metricKeys) {
      if (!keys.has(key)) violations.push({ detail: key, field: 'observations', kind: 'unknown_metric_key' });
    }
  }
  return violations;
}
