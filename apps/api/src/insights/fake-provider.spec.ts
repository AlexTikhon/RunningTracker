import { weeklyInsightModelOutputSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { FakeProvider, factsFromPrompt, fakeProviderModes, weekOfPrompt } from './fake-provider.js';
import { checkGrounding } from './grounding.js';
import { buildFacts } from './insight-facts.js';
import { buildWeeklyInsightPrompt } from './insight-prompt.js';
import { LlmProviderError } from './llm-provider.js';
import { checkSafety } from './safety.js';
import { aggregateWeek, resolveWeekWindow } from './weekly-aggregate.js';

const aggregate = aggregateWeek({
  activities: [],
  checkIns: [{ localDate: '2026-11-03', mood: 2, sleepMinutes: 200, sleepQuality: 2, soreness: 9, timeZone: 'UTC', weightKg: 80 }],
  gpsRuns: [],
  todayLocalDate: '2026-11-20',
  window: resolveWeekWindow({ checkIns: [], requestTimeZone: 'UTC', weekStart: '2026-11-02' }),
});
const facts = buildFacts(aggregate);
const prompt = buildWeeklyInsightPrompt(aggregate, facts);
const options = { maxOutputTokens: 100, timeoutMs: 1_000 };

describe('fake provider (ADR-0076)', () => {
  it('reads the facts and the week back out of the prompt and refuses a prompt without them', () => {
    expect(factsFromPrompt(prompt.user).map((fact) => fact.id)).toEqual(facts.map((fact) => fact.id));
    expect(weekOfPrompt(prompt.user)).toBe('2026-11-02');
    expect(() => factsFromPrompt('hello')).toThrow(/does not carry/u);
    expect(() => weekOfPrompt('hello')).toThrow(/does not name/u);
  });

  it('answers deterministically: a grounded, safe, schema-valid answer even for an extreme week', async () => {
    const first = await new FakeProvider().generateStructured(prompt, {}, options);
    const second = await new FakeProvider().generateStructured(prompt, {}, options);
    expect(second).toEqual(first);
    const output = weeklyInsightModelOutputSchema.parse(first.value);
    expect(output.suggestion).toBeNull();
    expect(checkGrounding(output, facts)).toEqual([]);
    expect(checkSafety(output, aggregate)).toEqual([]);
  });

  it('has a mode for every negative test and records every call', async () => {
    expect(fakeProviderModes).toEqual(expect.arrayContaining(['unrelated_value', 'wrong_unit', 'swapped_min_max', 'unsafe_ignore_pain']));
    const provider = new FakeProvider({ mode: 'invalid_schema' });
    const answer = await provider.generateStructured(prompt, {}, options);
    expect(weeklyInsightModelOutputSchema.safeParse(answer.value).success).toBe(false);
    expect(provider.calls).toEqual([prompt]);
  });

  it('fails every attempt for a configured week, as a retryable unavailability (end-to-end failure scenarios)', async () => {
    await expect(new FakeProvider({ failingWeeks: ['2026-11-02'] }).generateStructured(prompt, {}, options)).rejects.toMatchObject({
      reason: 'unavailable',
      retryable: true,
    });
    await expect(new FakeProvider({ failingWeeks: ['2026-11-09'] }).generateStructured(prompt, {}, options)).resolves.toBeDefined();
  });

  it('waits for a held answer, and a cancellation ends the wait', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = new FakeProvider({ beforeAnswer: () => gate }).generateStructured(prompt, {}, options).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);

    const controller = new AbortController();
    const cancelled = new FakeProvider({ beforeAnswer: () => new Promise(() => undefined) }).generateStructured(prompt, {}, {
      ...options,
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(LlmProviderError);
  });
});
