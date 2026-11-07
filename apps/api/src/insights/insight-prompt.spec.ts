import { weeklyInsightModelOutputSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { buildFacts } from './insight-facts.js';
import {
  buildWeeklyInsightPrompt,
  weeklyInsightOutputJsonSchema,
  WEEKLY_INSIGHT_PROMPT_VERSION,
  WEEKLY_INSIGHT_SUGGESTION_NULL,
  WEEKLY_INSIGHT_SYSTEM_PROMPT,
} from './insight-prompt.js';
import { OllamaProvider } from './ollama-provider.js';
import { aggregateWeek, resolveWeekWindow } from './weekly-aggregate.js';

// A fixed week: three check-ins, a manual run that overlaps a GPS run, a strength session.
const window = resolveWeekWindow({
  checkIns: [{ localDate: '2026-11-02', timeZone: 'Europe/Warsaw' }],
  requestTimeZone: 'UTC',
  weekStart: '2026-11-02',
});
const aggregate = aggregateWeek({
  activities: [
    { distanceM: 5000, durationS: 1560, startedAtMs: Date.parse('2026-11-03T06:00:00Z'), type: 'run' },
    { distanceM: null, durationS: 2700, startedAtMs: Date.parse('2026-11-05T17:00:00Z'), type: 'strength' },
  ],
  checkIns: [
    { localDate: '2026-11-02', mood: 4, sleepMinutes: 450, sleepQuality: 4, soreness: 2, timeZone: 'Europe/Warsaw', weightKg: 72.4 },
    { localDate: '2026-11-04', mood: 3, sleepMinutes: 405, sleepQuality: null, soreness: 5, timeZone: 'Europe/Warsaw', weightKg: null },
    { localDate: '2026-11-07', mood: 4, sleepMinutes: 510, sleepQuality: 5, soreness: 1, timeZone: 'Europe/Warsaw', weightKg: 72.1 },
  ],
  gpsRuns: [{ distanceM: 5034.2, finishedAtMs: Date.parse('2026-11-03T06:27:00Z'), startedAtMs: Date.parse('2026-11-03T06:01:00Z') }],
  todayLocalDate: '2026-11-20',
  window,
});
const facts = buildFacts(aggregate);

describe('weekly insight prompt (ADR-0076)', () => {
  it('is versioned', () => {
    expect(WEEKLY_INSIGHT_PROMPT_VERSION).toBe('weekly-insight-v2');
  });

  it('keeps the system message independent of the person and the week', () => {
    expect(buildWeeklyInsightPrompt(aggregate, facts).system).toBe(WEEKLY_INSIGHT_SYSTEM_PROMPT);
    expect(WEEKLY_INSIGHT_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });

  it('pins the exact model input text', async () => {
    const prompt = buildWeeklyInsightPrompt(aggregate, facts);
    await expect(`=== system ===\n${prompt.system}\n=== user ===\n${prompt.user}\n`).toMatchFileSnapshot(
      './__snapshots__/weekly-insight-prompt.txt',
    );
  });

  it('pins the exact Ollama request body, schema and generation settings included', async () => {
    let sent = '';
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: (_url, init) => {
        sent = init?.body as string;
        return Promise.resolve(new Response('{}', { status: 500 }));
      },
      maxResponseBytes: 65_536,
      model: 'qwen3:4b',
    });
    await provider
      .generateStructured(buildWeeklyInsightPrompt(aggregate, facts), weeklyInsightOutputJsonSchema(facts), {
        maxOutputTokens: 800,
        timeoutMs: 1_000,
      })
      .catch(() => undefined);
    await expect(`${JSON.stringify(JSON.parse(sent), null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/weekly-insight-ollama-request.json');
  });

  it('describes the same fields as the contract schema, with fact ids restricted to the week', () => {
    const schema = weeklyInsightOutputJsonSchema(facts) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(weeklyInsightModelOutputSchema.shape).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(weeklyInsightModelOutputSchema.shape).sort());
    expect(JSON.stringify(schema)).toContain('"sleep.average_minutes"');
    expect(JSON.stringify(schema)).not.toContain('"sleep.rem_minutes"');
  });

  it('carries the facts and flags but no note text, coordinates or identifiers', () => {
    const { user } = buildWeeklyInsightPrompt(aggregate, facts);
    expect(user).toContain('"id":"sleep.average_minutes"');
    expect(user).toContain('"value":455');
    expect(user).toContain('manual_and_gps_runs_may_overlap');
    expect(user).not.toMatch(/note|latitude|longitude|geom/iu);
    expect(user).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it('tells the model to write no suggestion in an extreme week', () => {
    const sore = aggregateWeek({
      activities: [],
      checkIns: [{ localDate: '2026-11-02', mood: null, sleepMinutes: null, sleepQuality: null, soreness: 9, timeZone: 'UTC', weightKg: null }],
      gpsRuns: [],
      todayLocalDate: '2026-11-20',
      window: resolveWeekWindow({ checkIns: [], requestTimeZone: 'UTC', weekStart: '2026-11-02' }),
    });
    expect(buildWeeklyInsightPrompt(sore, buildFacts(sore)).user).toContain(WEEKLY_INSIGHT_SUGGESTION_NULL);
    expect(buildWeeklyInsightPrompt(aggregate, facts).user).not.toContain(WEEKLY_INSIGHT_SUGGESTION_NULL);
  });
});
