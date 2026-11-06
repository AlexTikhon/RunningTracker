import { weeklyInsightOutputSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { FakeProvider, aggregateFromPrompt, fakeProviderModes } from './fake-provider.js';
import { checkGrounding } from './grounding.js';
import { buildWeeklyInsightPrompt } from './insight-prompt.js';
import { checkSafety } from './safety.js';
import { aggregateWeek, resolveWeekWindow } from './weekly-aggregate.js';

const aggregate = aggregateWeek({
  activities: [],
  checkIns: [{ localDate: '2026-11-03', mood: 2, sleepMinutes: 200, sleepQuality: 2, soreness: 9, timeZone: 'UTC', weightKg: 80 }],
  gpsRuns: [],
  todayLocalDate: '2026-11-20',
  window: resolveWeekWindow({ checkIns: [], requestTimeZone: 'UTC', weekStart: '2026-11-02' }),
});
const prompt = buildWeeklyInsightPrompt(aggregate);
const options = { maxOutputTokens: 100, timeoutMs: 1_000 };

describe('fake provider (ADR-0076)', () => {
  it('reads the aggregate back out of the prompt and refuses a prompt without one', () => {
    expect(aggregateFromPrompt(prompt.user)).toEqual(aggregate);
    expect(() => aggregateFromPrompt('hello')).toThrow(/does not carry/u);
  });

  it('answers deterministically: a grounded, safe, schema-valid answer even for an extreme week', async () => {
    const first = await new FakeProvider().generateStructured(prompt, {}, options);
    const second = await new FakeProvider().generateStructured(prompt, {}, options);
    expect(second).toEqual(first);
    const output = weeklyInsightOutputSchema.parse(first.value);
    expect(checkGrounding(output, aggregate)).toEqual([]);
    expect(checkSafety(output, aggregate)).toEqual([]);
  });

  it('has a mode for every negative test and records every call', async () => {
    expect(fakeProviderModes).toContain('hallucinated_number');
    const provider = new FakeProvider({ mode: 'invalid_schema' });
    const answer = await provider.generateStructured(prompt, {}, options);
    expect(weeklyInsightOutputSchema.safeParse(answer.value).success).toBe(false);
    expect(provider.calls).toEqual([prompt]);
  });

  it('waits for a held answer', async () => {
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
  });
});
