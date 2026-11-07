import { ACTIVITY_TYPES, weeklyInsightModelOutputSchema } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { checkGrounding } from './grounding.js';
import { buildFacts } from './insight-facts.js';
import { validateModelOutput } from './insight-generator.js';
import {
  buildWeeklyInsightPrompt,
  weeklyInsightOutputJsonSchema,
  WEEKLY_INSIGHT_EXAMPLE_AGGREGATE,
  WEEKLY_INSIGHT_EXAMPLE_ANSWER,
  WEEKLY_INSIGHT_PROMPT_VERSION,
  WEEKLY_INSIGHT_SUGGESTION_NULL,
  WEEKLY_INSIGHT_SYSTEM_PROMPT,
  WEEKLY_INSIGHT_SYSTEM_PROMPTS,
  type WeeklyInsightPromptVersion,
} from './insight-prompt.js';
import { OllamaProvider } from './ollama-provider.js';
import { checkSafety } from './safety.js';
import { aggregateWeek, canonicalJson, resolveWeekWindow } from './weekly-aggregate.js';

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
    expect(WEEKLY_INSIGHT_PROMPT_VERSION).toBe('weekly-insight-v4');
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

  describe('kept versions and the candidates of the prompt experiment', () => {
    const versions = Object.keys(WEEKLY_INSIGHT_SYSTEM_PROMPTS) as WeeklyInsightPromptVersion[];

    it('keeps every measured version, differing only in the system message', () => {
      expect(versions).toEqual(['weekly-insight-v2', 'weekly-insight-v3', 'weekly-insight-v4']);
      expect(new Set(versions.map((version) => WEEKLY_INSIGHT_SYSTEM_PROMPTS[version])).size).toBe(versions.length);
      const users = versions.map((version) => buildWeeklyInsightPrompt(aggregate, facts, version).user);
      expect(new Set(users).size).toBe(1);
      expect(buildWeeklyInsightPrompt(aggregate, facts).system).toBe(WEEKLY_INSIGHT_SYSTEM_PROMPTS[WEEKLY_INSIGHT_PROMPT_VERSION]);
      expect(WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v4'].startsWith(`${WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v3']}\n`)).toBe(true);
      for (const version of versions) expect(WEEKLY_INSIGHT_SYSTEM_PROMPTS[version]).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    });

    it('pins the exact text of the candidate system messages', async () => {
      await expect(`=== weekly-insight-v3 ===\n${WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v3']}\n=== weekly-insight-v4 ===\n${WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v4']}\n`).toMatchFileSnapshot(
        './__snapshots__/weekly-insight-candidate-prompts.txt',
      );
    });

    it('has a worked example that passes the production schema, claim grounding, prose rules and safety screen', () => {
      const parsed = weeklyInsightModelOutputSchema.parse(WEEKLY_INSIGHT_EXAMPLE_ANSWER);
      expect(validateModelOutput(parsed, WEEKLY_INSIGHT_EXAMPLE_AGGREGATE)).toMatchObject({ status: 'ready' });
      expect(checkSafety(parsed, WEEKLY_INSIGHT_EXAMPLE_AGGREGATE)).toEqual([]);
      // Its facts are the production catalogue of a week in neither evaluation set, with the fields the model sees.
      expect(WEEKLY_INSIGHT_EXAMPLE_AGGREGATE.week.start).toBe('2026-09-14');
      const exampleFacts = buildFacts(WEEKLY_INSIGHT_EXAMPLE_AGGREGATE);
      expect(WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v4']).toContain(
        `Facts: ${canonicalJson(exampleFacts.map(({ day, direction, id, label, unit, value }) => ({ day, direction, id, label, unit, value })))}`,
      );
      expect(WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v4']).toContain(`Answer: ${JSON.stringify(WEEKLY_INSIGHT_EXAMPLE_ANSWER)}`);
    });

    it('keeps the production prompt of the busiest possible week inside the model window with room for a full answer', () => {
      // num_ctx is 4,096 tokens and an answer may use up to 800. Measured in the Ollama server log during the experiment
      // (qwen3): the v4 system message is ~1,630 tokens (6,416 characters) and the largest measured v4 prompt, 9,610
      // characters, was 2,483 tokens: about 3.7 to 3.9 characters per token. A week with every metric, every activity
      // type and every flag (44 facts) is ~11,800 characters, so ~3,100 tokens + 800 < 4,096. A character bound is a proxy
      // for tokens, not a guarantee; the provider still refuses an answer whose window was full ('incomplete').
      const days = [0, 1, 2, 3, 4, 5, 6].map((offset) => ({
        localDate: `2026-11-0${2 + offset}`,
        mood: 3,
        sleepMinutes: 200 + offset * 100,
        sleepQuality: 3,
        soreness: 9,
        timeZone: offset % 2 === 0 ? 'Asia/Tokyo' : 'Europe/Warsaw',
        weightKg: 70 + offset,
      }));
      const busiest = aggregateWeek({
        activities: ACTIVITY_TYPES.map((type, index) => ({ distanceM: 12_345, durationS: 3_600 + index, startedAtMs: Date.parse('2026-11-03T06:00:00Z') + index * 3_600_000, type })),
        checkIns: days,
        gpsRuns: [
          { distanceM: 10_123, finishedAtMs: Date.parse('2026-11-04T07:00:00Z'), startedAtMs: Date.parse('2026-11-04T06:00:00Z') },
          { distanceM: null, finishedAtMs: Date.parse('2026-11-05T07:00:00Z'), startedAtMs: Date.parse('2026-11-05T06:00:00Z') },
        ],
        todayLocalDate: '2026-11-05',
        window: resolveWeekWindow({ checkIns: days, requestTimeZone: 'Europe/Warsaw', weekStart: '2026-11-02' }),
      });
      const busiestFacts = buildFacts(busiest);
      expect(busiestFacts).toHaveLength(44);
      const prompt = buildWeeklyInsightPrompt(busiest, busiestFacts);
      expect(prompt.system.length + prompt.user.length).toBeLessThanOrEqual(12_000);
    });

    it('gives only "right" example sentences that the unchanged prose rules and safety screen accept', () => {
      const right = [...WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v3'].matchAll(/Right: "([^"]+)"/gu)].map((match) => match[1]!);
      const wrong = [...WEEKLY_INSIGHT_SYSTEM_PROMPTS['weekly-insight-v3'].matchAll(/Wrong: "([^"]+)"/gu)].map((match) => match[1]!);
      expect(right).toHaveLength(5);
      expect(wrong).toHaveLength(5);
      const withChange = buildFacts(WEEKLY_INSIGHT_EXAMPLE_AGGREGATE);
      for (const sentence of right) {
        const output = { observations: [], suggestion: null, summary: sentence };
        expect(checkGrounding(output, withChange)).toEqual([]);
        expect(checkSafety(output, WEEKLY_INSIGHT_EXAMPLE_AGGREGATE)).toEqual([]);
      }
      // ...and every "wrong" one is refused by them, so the examples teach the rule that is enforced.
      for (const sentence of wrong) {
        expect(checkGrounding({ observations: [], suggestion: null, summary: sentence }, withChange).length).toBeGreaterThan(0);
      }
    });
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
