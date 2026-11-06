import type { WeeklyInsightOutput } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { checkSafety } from './safety.js';

const calm = { flags: [] };
const sore = { flags: ['extreme_soreness' as const] };
const shortSleep = { flags: ['extreme_short_sleep' as const] };
const longSleep = { flags: ['extreme_long_sleep' as const] };

const output = (overrides: Partial<WeeklyInsightOutput> = {}): WeeklyInsightOutput => ({
  dataGaps: ['No weight on most days.'],
  observations: [{ metricKeys: ['sleep.avgMinutes'], text: 'Sleep was steady across the week.' }],
  suggestion: 'Keep a regular bedtime and check in each evening.',
  summary: 'A balanced week with regular check-ins and two runs.',
  ...overrides,
});

const rulesOf = (value: WeeklyInsightOutput, aggregate: { flags: readonly string[] } = calm) =>
  checkSafety(value, aggregate as { flags: never[] }).map((violation) => `${violation.field}:${violation.rule}`);

describe('safety check (ADR-0076)', () => {
  it('passes plain descriptive text and a non-medical habit', () => {
    expect(rulesOf(output())).toEqual([]);
    expect(rulesOf(output({ summary: 'You lowered the risk of injury by keeping runs short.' }))).toEqual([]);
    expect(rulesOf(output({ summary: 'Your weight went down a little and mood stayed stable.' }))).toEqual([]);
  });

  it('refuses diagnoses and named conditions in any field', () => {
    expect(rulesOf(output({ summary: 'This pattern suggests insomnia.' }))).toEqual(['summary:condition-sleep']);
    expect(rulesOf(output({ observations: [{ metricKeys: ['mood.average'], text: 'Low mood may mean depression.' }] }))).toEqual([
      'observations:condition-mental',
    ]);
    expect(rulesOf(output({ dataGaps: ['We cannot diagnose anything from 2 days.'] }))).toEqual(['dataGaps:diagnose']);
    expect(rulesOf(output({ summary: 'You may have an injury in your knee.' }))).toEqual(['summary:condition-injury']);
    expect(rulesOf(output({ summary: 'High soreness can be a sign of overtraining.' }))).toEqual(['summary:condition-musculoskeletal']);
    expect(rulesOf(output({ summary: 'Your weight puts you in the obese range.' }))).toEqual(['summary:condition-metabolic']);
  });

  it('refuses medication, supplements and doses', () => {
    expect(rulesOf(output({ suggestion: 'Take ibuprofen after long runs.' }))).toEqual(['suggestion:medication-named']);
    expect(rulesOf(output({ suggestion: 'Try melatonin before bed.' }))).toEqual(['suggestion:medication-named']);
    expect(rulesOf(output({ suggestion: 'Consider a vitamin supplement.' }))).toEqual(['suggestion:medication-generic']);
    expect(rulesOf(output({ suggestion: 'A 200 mg dose helps.' }))).toEqual([
      'suggestion:medication-generic',
      'suggestion:medication-amount',
    ]);
  });

  it('refuses treatment, cold therapy, diet and escalation instructions', () => {
    expect(rulesOf(output({ suggestion: 'Ice the sore muscles twice a day.' }))).toEqual(['suggestion:cold-compression']);
    expect(rulesOf(output({ suggestion: 'Start a calorie deficit to lose weight.' }))).toEqual(['suggestion:diet']);
    expect(rulesOf(output({ suggestion: 'Book physiotherapy for your calf.' }))).toEqual(['suggestion:treatment']);
    expect(rulesOf(output({ suggestion: 'Go to the emergency room if it hurts.' }))).toEqual(['suggestion:escalation']);
  });

  it('normalises case, compatibility forms and typographic punctuation before matching', () => {
    expect(rulesOf(output({ suggestion: 'TAKE IBUPROFEN.' }))).toEqual(['suggestion:medication-named']);
    expect(rulesOf(output({ suggestion: 'Ｍｅｌａｔｏｎｉｎ helps.' }))).toEqual(['suggestion:medication-named']);
  });

  it('limits the suggestion of an extreme week to rest or a professional in generic terms', () => {
    for (const aggregate of [sore, shortSleep, longSleep]) {
      expect(rulesOf(output({ suggestion: 'Take a rest day and let your body recover.' }), aggregate)).toEqual([]);
      expect(rulesOf(output({ suggestion: 'If it continues, talk to a healthcare professional.' }), aggregate)).toEqual([]);
      expect(rulesOf(output({ suggestion: 'Keep a regular bedtime and check in each evening.' }), aggregate)).toEqual([
        'suggestion:extreme-requires-rest-or-professional',
      ]);
      expect(rulesOf(output({ suggestion: 'Rest, then add an extra interval session.' }), aggregate)).toEqual([
        'suggestion:extreme-forbids-training',
      ]);
      expect(rulesOf(output({ suggestion: 'Recover with a gentle walk each day.' }), aggregate)).toEqual([
        'suggestion:extreme-forbids-training',
      ]);
      expect(rulesOf(output({ suggestion: 'Sleep well, then go for a short run.' }), aggregate)).toEqual([
        'suggestion:extreme-forbids-training',
      ]);
    }
    // The same training suggestion is fine in an ordinary week.
    expect(rulesOf(output({ suggestion: 'Add an extra interval session.' }), calm)).toEqual([]);
  });

  it('applies the medical rules on top of the extreme-week rule', () => {
    expect(rulesOf(output({ suggestion: 'Rest and take painkillers.' }), sore)).toEqual(['suggestion:medication-generic']);
  });
});
