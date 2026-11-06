import { describe, expect, it } from 'vitest';

import { FAKE_HALLUCINATED_NUMBER, FakeProvider, aggregateFromPrompt, groundedAnswer, type FakeProviderMode } from './fake-provider.js';
import { generateWeeklyInsight } from './insight-generator.js';
import { buildWeeklyInsightPrompt } from './insight-prompt.js';
import type { LlmProvider } from './llm-provider.js';
import { aggregateWeek, resolveWeekWindow, type CheckInRecord, type WeeklyAggregate } from './weekly-aggregate.js';

function weekWith(checkIns: Partial<CheckInRecord>[]): WeeklyAggregate {
  const rows = checkIns.map((values, index) => ({
    localDate: `2026-11-0${2 + index}`,
    mood: null,
    sleepMinutes: null,
    sleepQuality: null,
    soreness: null,
    timeZone: 'Europe/Warsaw',
    weightKg: null,
    ...values,
  }));
  return aggregateWeek({
    activities: [],
    checkIns: rows,
    gpsRuns: [],
    todayLocalDate: '2026-11-20',
    window: resolveWeekWindow({ checkIns: rows, requestTimeZone: 'Europe/Warsaw', weekStart: '2026-11-02' }),
  });
}

const calm = weekWith([{ mood: 4, sleepMinutes: 450 }, { mood: 3, sleepMinutes: 420 }, { soreness: 2 }]);
const extreme = weekWith([{ soreness: 9, sleepMinutes: 450 }]);
const settings = { maxOutputTokens: 800, timeoutMs: 5_000 };

async function run(mode: FakeProviderMode, aggregate = calm) {
  const provider = new FakeProvider({ mode });
  const outcome = await generateWeeklyInsight(aggregate, provider, settings);
  return { calls: provider.calls.length, outcome };
}

describe('weekly insight generation (ADR-0076)', () => {
  it('stores a grounded, safe answer as ready after one call', async () => {
    const { calls, outcome } = await run('grounded');
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ generations: 1, status: 'ready' });
    expect(outcome.status === 'ready' && outcome.output.summary).toBe('You checked in on 3 of 7 days. Your average sleep was 435 minutes. You logged 0 manual activities and 0 GPS runs.');
  });

  it('passes the exact prompt for the aggregate to the provider', async () => {
    const provider = new FakeProvider();
    await generateWeeklyInsight(calm, provider, settings);
    expect(provider.calls).toEqual([buildWeeklyInsightPrompt(calm)]);
    expect(aggregateFromPrompt(provider.calls[0]!.user)).toEqual(calm);
  });

  it('regenerates once after a schema failure and accepts a valid second answer', async () => {
    const { calls, outcome } = await run('invalid_then_grounded');
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ generations: 2, status: 'ready' });
  });

  it('gives up as generation_failed after two schema failures', async () => {
    expect(await run('invalid_schema')).toEqual({ calls: 2, outcome: { generations: 2, reason: 'schema_invalid', status: 'generation_failed' } });
    expect(await run('not_json')).toEqual({ calls: 2, outcome: { generations: 2, reason: 'invalid_response', status: 'generation_failed' } });
  });

  it('does not regenerate after a provider failure: the provider already retried once', async () => {
    expect(await run('provider_error')).toEqual({ calls: 1, outcome: { generations: 1, reason: 'unavailable', status: 'generation_failed' } });
    expect(await run('timeout')).toEqual({ calls: 1, outcome: { generations: 1, reason: 'timeout', status: 'generation_failed' } });
  });

  it('discards a hallucinated number or an unknown metric key as failed_grounding, without regenerating', async () => {
    const hallucinated = await run('hallucinated_number');
    expect(hallucinated.calls).toBe(1);
    expect(hallucinated.outcome).toEqual({
      generations: 1,
      grounding: [{ detail: FAKE_HALLUCINATED_NUMBER, field: 'summary', kind: 'ungrounded_number' }],
      status: 'failed_grounding',
    });
    const unknownKey = await run('unknown_metric_key');
    expect(unknownKey.outcome).toMatchObject({
      grounding: [{ detail: 'sleep.remMinutes', kind: 'unknown_metric_key' }],
      status: 'failed_grounding',
    });
  });

  it('discards medical content as failed_safety, without regenerating', async () => {
    const diagnosis = await run('diagnosis');
    expect(diagnosis.outcome).toMatchObject({ safety: [{ kind: 'diagnosis', rule: 'condition-sleep' }], status: 'failed_safety' });
    expect((await run('unsafe_medication')).outcome).toMatchObject({ safety: [{ kind: 'medication' }], status: 'failed_safety' });
  });

  it('refuses a training suggestion only when the week has extreme values', async () => {
    expect((await run('unsafe_extreme', extreme)).outcome).toMatchObject({
      safety: [{ kind: 'extreme_values_suggestion', rule: 'extreme-requires-rest-or-professional' }, { rule: 'extreme-forbids-training' }],
      status: 'failed_safety',
    });
    expect((await run('unsafe_extreme', calm)).outcome.status).toBe('ready');
    expect((await run('grounded', extreme)).outcome.status).toBe('ready');
  });

  it('reports failed_safety when an answer fails both checks', async () => {
    const provider: LlmProvider = {
      generateStructured: (input) =>
        Promise.resolve({
          attempts: 1,
          value: { ...groundedAnswer(aggregateFromPrompt(input.user)), suggestion: 'Take 999 mg of ibuprofen.' },
        }),
      model: 'both',
    };
    const outcome = await generateWeeklyInsight(calm, provider, settings);
    expect(outcome.status).toBe('failed_safety');
    expect(outcome.status === 'failed_safety' && outcome.grounding.map((violation) => violation.detail)).toEqual(['999']);
  });

  it('treats an unexpected provider exception and a cancelled call as generation_failed', async () => {
    const throwing: LlmProvider = { generateStructured: () => Promise.reject(new Error('boom')), model: 'x' };
    expect(await generateWeeklyInsight(calm, throwing, settings)).toEqual({ generations: 1, reason: 'provider_error', status: 'generation_failed' });
    const controller = new AbortController();
    controller.abort();
    expect(await generateWeeklyInsight(calm, new FakeProvider(), { ...settings, signal: controller.signal })).toEqual({
      generations: 1,
      reason: 'aborted',
      status: 'generation_failed',
    });
  });
});
