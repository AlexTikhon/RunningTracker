import type { WeeklyInsightModelOutput } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { assembleOutput } from './insight-generator.js';
import { buildFacts } from './insight-facts.js';
import { APPROVED_SUGGESTIONS, approvedSuggestionFor, checkSafety, normalizeForSafety, screenText } from './safety.js';
import { aggregateWeek, resolveWeekWindow, type CheckInRecord, type WeeklyFlag } from './weekly-aggregate.js';

const ordinary = { flags: [] as WeeklyFlag[] };
const sore = { flags: ['extreme_soreness'] as WeeklyFlag[] };
const output = (patch: Partial<WeeklyInsightModelOutput>): WeeklyInsightModelOutput => ({
  observations: [],
  suggestion: 'Keep a regular bedtime.',
  summary: 'A calm week.',
  ...patch,
});
const rules = (text: string, extreme = false) => screenText(text, extreme).map((match) => match.rule);

describe('weekly insight safety: code-selected suggestion in extreme weeks', () => {
  it('selects an approved suggestion for each extreme flag and none for an ordinary week', () => {
    expect(approvedSuggestionFor(ordinary)).toBeUndefined();
    expect(approvedSuggestionFor(sore)).toEqual({
      id: 'rest_and_recovery',
      text: `${APPROVED_SUGGESTIONS.rest_and_recovery} ${APPROVED_SUGGESTIONS.check_in_with_professional}`,
    });
    expect(approvedSuggestionFor({ flags: ['extreme_short_sleep'] })?.id).toBe('rest_and_sleep_routine');
    expect(approvedSuggestionFor({ flags: ['extreme_long_sleep'] })?.id).toBe('rest_and_sleep_routine');
    expect(approvedSuggestionFor({ flags: ['extreme_long_sleep', 'extreme_soreness'] })?.id).toBe('rest_and_recovery');
  });

  it('never shows the model\'s suggestion in an extreme week, whatever it says (the two Stop 1 failures included)', () => {
    const records: CheckInRecord[] = [
      { localDate: '2026-11-02', mood: 3, sleepMinutes: 400, sleepQuality: null, soreness: 9, timeZone: 'UTC', weightKg: null },
    ];
    const window = resolveWeekWindow({ checkIns: records, requestTimeZone: 'UTC', weekStart: '2026-11-02' });
    const aggregate = aggregateWeek({ activities: [], checkIns: records, gpsRuns: [], todayLocalDate: '2026-11-20', window });
    for (const suggestion of ['Rest and ignore severe pain.', 'Rest and do not tell a professional about worsening pain.']) {
      const assembled = assembleOutput(output({ suggestion }), aggregate, buildFacts(aggregate));
      expect(assembled.suggestion).toEqual({ id: 'rest_and_recovery', source: 'approved', text: approvedSuggestionFor(sore)!.text });
      expect(JSON.stringify(assembled)).not.toContain(suggestion);
      // It is not screened either: it is never shown.
      expect(checkSafety(output({ suggestion }), sore)).toEqual([]);
    }
  });

  it('the approved suggestions pass the screen themselves', () => {
    for (const text of Object.values(APPROVED_SUGGESTIONS)) {
      expect(screenText(text, true)).toEqual([]);
    }
  });
});

describe('weekly insight safety: heuristic prose screen', () => {
  it('refuses the two Stop 1 sentences wherever they appear in shown prose', () => {
    expect(rules('Rest and ignore severe pain.', true)).toEqual(['dismiss-symptom']);
    expect(rules('Rest and do not tell a professional about worsening pain.', true)).toEqual(['avoid-help']);
    expect(checkSafety(output({ summary: 'Rest and ignore severe pain.' }), sore)).toEqual([
      { field: 'summary', kind: 'dismiss_symptom', rule: 'dismiss-symptom' },
    ]);
    expect(checkSafety(output({ suggestion: 'Rest and ignore severe pain.' }), ordinary)).toEqual([
      { field: 'suggestion', kind: 'dismiss_symptom', rule: 'dismiss-symptom' },
    ]);
  });

  it('screens summary and observations in every week, and the suggestion only in ordinary weeks', () => {
    const unsafe = output({
      observations: [{ claims: [{ day: 'none', direction: 'none', factId: 'mood.average', unit: 'score_1_5', value: 3 }], text: 'Take melatonin.' }],
      summary: 'Signs of insomnia.',
    });
    expect(checkSafety(unsafe, ordinary).map((violation) => [violation.field, violation.rule])).toEqual([
      ['summary', 'condition-sleep'],
      ['observations', 'medication-named'],
    ]);
  });

  it('refuses training escalation in prose only in extreme weeks', () => {
    expect(rules('Keep the intensity high this week.', true)).toEqual(['extreme-forbids-training']);
    expect(rules('Keep the intensity high this week.', false)).toEqual([]);
  });

  it('keeps harmless rest, sleep and recovery wording, double negatives included', () => {
    expect(rules('Rest well and protect your sleep.', true)).toEqual([]);
    expect(rules("Don't hesitate to talk to a healthcare professional if something feels off.", true)).toEqual([]);
    expect(rules('There is no need to rush; keep the week relaxed.', true)).toEqual([]);
  });

  it('normalises typography before matching', () => {
    expect(normalizeForSafety('Don’t  TELL a professional')).toBe("don't tell a professional");
    expect(rules('Don’t tell a professional about the pain.', true)).toEqual(['avoid-help']);
  });
});
