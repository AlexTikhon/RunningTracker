import type { WeeklyInsightClaim, WeeklyInsightFact, WeeklyInsightModelOutput } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { assertedDirections, checkGrounding } from './grounding.js';
import { buildFacts } from './insight-facts.js';
import { aggregateWeek, resolveWeekWindow, type CheckInRecord } from './weekly-aggregate.js';

const WEEK = '2026-11-02';

function weekWith(checkIns: Partial<CheckInRecord>[]) {
  const records: CheckInRecord[] = checkIns.map((values, index) => ({
    localDate: `2026-11-0${2 + index}`,
    mood: null,
    sleepMinutes: null,
    sleepQuality: null,
    soreness: null,
    timeZone: 'Europe/Warsaw',
    weightKg: null,
    ...values,
  }));
  const window = resolveWeekWindow({ checkIns: records, requestTimeZone: 'Europe/Warsaw', weekStart: WEEK });
  return aggregateWeek({ activities: [], checkIns: records, gpsRuns: [], todayLocalDate: '2026-11-20', window });
}

// Monday 420 min, Tuesday 480 min, Wednesday 410 min: average 437 min = 7.3 h; shortest Wednesday, longest Tuesday.
// Weight 72.4 (Monday) -> 71.8 (Wednesday): a change of 0.6 kg, down. Soreness peaks at 6 on Tuesday.
const aggregate = weekWith([
  { mood: 4, sleepMinutes: 420, soreness: 2, weightKg: 72.4 },
  { mood: 3, sleepMinutes: 480, soreness: 6 },
  { mood: 4, sleepMinutes: 410, soreness: 3, weightKg: 71.8 },
]);
const facts = buildFacts(aggregate);
const fact = (id: string): WeeklyInsightFact => {
  const found = facts.find((entry) => entry.id === id);
  if (!found) throw new Error(`no fact ${id}`);
  return found;
};
const claim = (id: string, override: Partial<WeeklyInsightClaim> = {}): WeeklyInsightClaim => {
  const target = fact(id);
  return { day: target.day, direction: target.direction, factId: target.id, unit: target.unit, value: target.value, ...override };
};

const base: WeeklyInsightModelOutput = {
  observations: [{ claims: [claim('sleep.average_hours')], text: 'This is your average sleep for the nights you logged.' }],
  suggestion: 'Keep a regular bedtime.',
  summary: 'A calm week with steady check-ins.',
};

const withClaim = (value: WeeklyInsightClaim, text = 'Here is one part of your week.') =>
  checkGrounding({ ...base, observations: [{ claims: [value], text }] }, facts);
const kinds = (output: WeeklyInsightModelOutput) => checkGrounding(output, facts).map((violation) => violation.kind);

describe('weekly insight facts used by grounding', () => {
  it('computes the facts the negative cases below rely on', () => {
    expect(fact('sleep.average_minutes')).toMatchObject({ unit: 'minutes', value: 437 });
    expect(fact('sleep.average_hours')).toMatchObject({ unit: 'hours', value: 7.3 });
    expect(fact('sleep.shortest')).toMatchObject({ day: 'Wednesday', value: 410 });
    expect(fact('sleep.longest')).toMatchObject({ day: 'Tuesday', value: 480 });
    expect(fact('weight.first')).toMatchObject({ day: 'Monday', value: 72.4 });
    expect(fact('weight.last')).toMatchObject({ day: 'Wednesday', value: 71.8 });
    expect(fact('weight.change')).toMatchObject({ direction: 'down', unit: 'kg', value: 0.6 });
    expect(fact('check_ins.days_missing').value).toBe(4);
  });
});

describe('weekly insight claim grounding', () => {
  it('accepts claims that equal their facts in every field', () => {
    expect(checkGrounding(base, facts)).toEqual([]);
    expect(withClaim(claim('weight.change'), 'Your weight went down a little.')).toEqual([]);
    expect(withClaim(claim('sleep.shortest'))).toEqual([]);
  });

  it('refuses a value that exists only under another fact ("average sleep was 2 hours")', () => {
    // 2 is a value of the week (soreness on Monday, a count), but not of average sleep (7.3 h).
    expect(withClaim(claim('sleep.average_hours', { value: 2 }))).toEqual([
      { detail: 'sleep.average_hours', field: 'observations', kind: 'claim_value_mismatch' },
    ]);
    // 4 is the number of days without a check-in, not the average mood... which is 3.7.
    expect(withClaim(claim('mood.average', { value: 4 })).map((violation) => violation.kind)).toEqual(['claim_value_mismatch']);
  });

  it('refuses a wrong unit ("shortest sleep was 420 hours")', () => {
    expect(withClaim(claim('sleep.shortest', { unit: 'hours' })).map((violation) => violation.kind)).toEqual(['claim_unit_mismatch']);
    expect(withClaim(claim('sleep.average_minutes', { unit: 'hours', value: 437 })).map((violation) => violation.kind)).toEqual([
      'claim_unit_mismatch',
    ]);
  });

  it('refuses a reversed change direction ("weight increased by 0.6 kg")', () => {
    expect(withClaim(claim('weight.change', { direction: 'up' }))).toEqual([
      { detail: 'weight.change', field: 'observations', kind: 'claim_direction_mismatch' },
    ]);
    // A signed value is not a way around it: a change is a magnitude.
    expect(withClaim(claim('weight.change', { value: -0.6 })).map((violation) => violation.kind)).toEqual(['claim_value_mismatch']);
  });

  it('refuses swapped first/last and min/max values or days', () => {
    expect(withClaim(claim('weight.first', { value: 71.8 })).map((violation) => violation.kind)).toEqual(['claim_value_mismatch']);
    expect(withClaim(claim('weight.last', { day: 'Monday' })).map((violation) => violation.kind)).toEqual(['claim_day_mismatch']);
    expect(withClaim(claim('sleep.shortest', { day: 'Tuesday', value: 480 })).map((violation) => violation.kind)).toEqual([
      'claim_value_mismatch',
      'claim_day_mismatch',
    ]);
  });

  it('refuses an incorrect rounding and a wrong day', () => {
    expect(withClaim(claim('sleep.average_hours', { value: 7.28 })).map((violation) => violation.kind)).toEqual(['claim_value_mismatch']);
    expect(withClaim(claim('sleep.average_hours', { value: 7 })).map((violation) => violation.kind)).toEqual(['claim_value_mismatch']);
    expect(withClaim(claim('soreness.highest', { day: 'Monday' })).map((violation) => violation.kind)).toEqual(['claim_day_mismatch']);
    expect(withClaim(claim('sleep.average_minutes', { day: 'Monday' })).map((violation) => violation.kind)).toEqual(['claim_day_mismatch']);
  });

  it('keeps missing values missing: a fact that was not recorded cannot be claimed, not even as zero', () => {
    expect(facts.some((entry) => entry.id === 'sleep.quality_average')).toBe(false);
    expect(withClaim({ day: 'none', direction: 'none', factId: 'sleep.quality_average', unit: 'score_1_5', value: 0 })).toEqual([
      { detail: 'sleep.quality_average', field: 'observations', kind: 'unknown_fact' },
    ]);
    const empty = buildFacts(weekWith([]));
    expect(empty.map((entry) => entry.id).filter((id) => id.startsWith('sleep.'))).toEqual([]);
    expect(
      checkGrounding(
        { ...base, observations: [{ claims: [{ day: 'none', direction: 'none', factId: 'sleep.average_minutes', unit: 'minutes', value: 0 }], text: 'Sleep.' }] },
        empty,
      ).map((violation) => violation.kind),
    ).toEqual(['unknown_fact']);
  });
});

describe('weekly insight prose rules', () => {
  it('refuses any number in prose, in digits or words, in every field', () => {
    expect(kinds({ ...base, summary: 'Your average sleep was 2 hours.' })).toEqual(['number_in_prose']);
    expect(kinds({ ...base, summary: 'You slept seven hours on average.' })).toEqual(['number_in_prose']);
    expect(kinds({ ...base, suggestion: 'Sleep half an hour more.' })).toEqual(['number_in_prose']);
    expect(kinds({ ...base, observations: [{ claims: [claim('sleep.average_hours')], text: 'About ٧ hours.' }] })).toEqual(['number_in_prose']);
    expect(kinds({ ...base, summary: 'Coverage was high, around ninety percent.' })).toEqual(['number_in_prose', 'number_in_prose']);
    // Found by the qwen3:8b evaluation (ADR-0076): "zero" was missing from the list and passed.
    expect(kinds({ ...base, summary: 'The check-in coverage was zero.' })).toEqual(['number_in_prose']);
  });

  it('refuses weekdays, months and dates in prose: days come from the facts', () => {
    expect(kinds({ ...base, summary: 'Your shortest night was on Tuesday.' })).toEqual(['day_in_prose']);
    expect(kinds({ ...base, summary: 'A quiet weekend.' })).toEqual(['day_in_prose']);
    expect(kinds({ ...base, summary: 'A good start to November.' })).toEqual(['date_in_prose']);
    expect(kinds({ ...base, summary: 'Since 2026-11-02 things were calm.' })).toEqual(['number_in_prose', 'number_in_prose', 'number_in_prose']);
    expect(kinds({ ...base, summary: 'Better than yesterday.' })).toEqual(['date_in_prose']);
  });

  it('refuses a change verb the cited facts do not support', () => {
    // Weight went down this week; prose that says it went up is refused even without a number.
    expect(kinds({ ...base, observations: [{ claims: [claim('weight.change')], text: 'Your weight increased.' }] })).toEqual([
      'unsupported_direction',
    ]);
    expect(kinds({ ...base, observations: [{ claims: [claim('sleep.average_hours')], text: 'Your sleep dropped.' }] })).toEqual([
      'unsupported_direction',
    ]);
    expect(kinds({ ...base, summary: 'Your weight went up this week.' })).toEqual(['unsupported_direction']);
    expect(kinds({ ...base, summary: 'Your weight went down a little.' })).toEqual([]);
    expect(assertedDirections('It stayed the same and then rose.')).toEqual(new Set(['same', 'up']));
  });

  it('documents what it does not catch: qualitative prose next to a correct claim', () => {
    // The claim is exact and the prose has no number, day or change verb, so the check passes although "plenty of
    // sleep" is a judgement nobody verified. ADR-0076 states this limit.
    expect(kinds({ ...base, observations: [{ claims: [claim('sleep.shortest')], text: 'You got plenty of sleep.' }] })).toEqual([]);
  });
});
