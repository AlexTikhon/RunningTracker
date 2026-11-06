import { describe, expect, it } from 'vitest';

import {
  WEEKLY_INSIGHT_NOT_FOUND,
  WEEKLY_INSIGHTS_BUSY,
  WEEKLY_INSIGHTS_DISABLED,
  createWeeklyInsightRequestSchema,
  openApiDocument,
  weeklyInsightAcceptedSchema,
  weeklyInsightOutputSchema,
  weeklyInsightQuerySchema,
  weeklyInsightStatuses,
  weeklyInsightViewSchema,
} from './index.js';

const output = {
  dataGaps: ['No weight on 5 days'],
  observations: [{ metricKeys: ['sleep.avgMinutes'], text: 'You slept 452 minutes on average.' }],
  suggestion: 'Keep a regular bedtime.',
  summary: 'You checked in on 5 of 7 days.',
};

const view = {
  createdAt: '2026-11-02T08:00:00.123Z',
  id: '0b8f1a5e-1c1d-4f57-9a65-35a3a1c0f2d1',
  model: 'qwen2.5:3b',
  output,
  promptVersion: 'weekly-insight-v1',
  status: 'ready',
  timeZone: 'Europe/Warsaw',
  weekStart: '2026-11-02',
};

const acceptsOutput = (value: unknown) => weeklyInsightOutputSchema.safeParse(value).success;

describe('weekly insight output contract', () => {
  it('accepts the documented shape, also with no observations and no data gaps', () => {
    expect(acceptsOutput(output)).toBe(true);
    expect(acceptsOutput({ ...output, dataGaps: [], observations: [] })).toBe(true);
  });

  it('bounds the summary at 600 characters and refuses blank or malformed text', () => {
    expect(acceptsOutput({ ...output, summary: 'x'.repeat(600) })).toBe(true);
    expect(acceptsOutput({ ...output, summary: 'x'.repeat(601) })).toBe(false);
    expect(acceptsOutput({ ...output, summary: '   ' })).toBe(false);
    expect(acceptsOutput({ ...output, summary: 'a\u0000b' })).toBe(false);
    expect(acceptsOutput({ ...output, suggestion: '\ud800' })).toBe(false);
    expect(acceptsOutput({ ...output, suggestion: '' })).toBe(false);
  });

  it('allows at most four observations, each with one to six well-formed metric keys', () => {
    const observation = output.observations[0]!;
    expect(acceptsOutput({ ...output, observations: Array(4).fill(observation) })).toBe(true);
    expect(acceptsOutput({ ...output, observations: Array(5).fill(observation) })).toBe(false);
    expect(acceptsOutput({ ...output, observations: [{ ...observation, metricKeys: [] }] })).toBe(false);
    expect(acceptsOutput({ ...output, observations: [{ ...observation, metricKeys: Array(7).fill('mood.average') }] })).toBe(false);
    for (const key of ['sleep avg', 'sleep..avg', '.sleep', 'sleep.', '1sleep', 'sleep.byDay[0]']) {
      expect(acceptsOutput({ ...output, observations: [{ ...observation, metricKeys: [key] }] })).toBe(false);
    }
  });

  it('refuses unknown fields, a missing suggestion and too many data gaps', () => {
    expect(acceptsOutput({ ...output, extra: true })).toBe(false);
    expect(acceptsOutput({ ...output, observations: [{ ...output.observations[0], confidence: 1 }] })).toBe(false);
    const withoutSuggestion: Partial<typeof output> = { ...output };
    delete withoutSuggestion.suggestion;
    expect(acceptsOutput(withoutSuggestion)).toBe(false);
    expect(acceptsOutput({ ...output, dataGaps: Array(7).fill('gap') })).toBe(false);
  });
});

describe('weekly insight requests and views', () => {
  it('accepts a Monday week start with an IANA zone and refuses any other day', () => {
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-02' }).success).toBe(true);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-03' }).success).toBe(false);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-08' }).success).toBe(false);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: '+01:00', weekStart: '2026-11-02' }).success).toBe(false);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'UTC', weekStart: '1999-12-27' }).success).toBe(false);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'UTC', weekStart: '2026-11-02', extra: 1 }).success).toBe(false);
    expect(weeklyInsightQuerySchema.safeParse({ weekStart: '2026-11-02' }).success).toBe(true);
    expect(weeklyInsightQuerySchema.safeParse({ weekStart: '2026-02-30' }).success).toBe(false);
  });

  it('carries output exactly when the status is ready', () => {
    expect(weeklyInsightViewSchema.safeParse(view).success).toBe(true);
    expect(weeklyInsightViewSchema.safeParse({ ...view, output: null }).success).toBe(false);
    for (const status of weeklyInsightStatuses.filter((name) => name !== 'ready')) {
      expect(weeklyInsightViewSchema.safeParse({ ...view, output: null, status }).success).toBe(true);
      expect(weeklyInsightViewSchema.safeParse({ ...view, status }).success).toBe(false);
    }
    expect(weeklyInsightAcceptedSchema.safeParse({ id: view.id, status: 'pending' }).success).toBe(true);
    expect(weeklyInsightAcceptedSchema.safeParse({ id: view.id, status: 'queued' }).success).toBe(false);
  });

  it('names its error codes and documents both operations in OpenAPI', () => {
    expect([WEEKLY_INSIGHT_NOT_FOUND, WEEKLY_INSIGHTS_DISABLED, WEEKLY_INSIGHTS_BUSY]).toEqual([
      'WEEKLY_INSIGHT_NOT_FOUND',
      'WEEKLY_INSIGHTS_DISABLED',
      'WEEKLY_INSIGHTS_BUSY',
    ]);
    const path = openApiDocument.paths['/api/orgs/{orgId}/insights/weekly'];
    expect(Object.keys(path).sort()).toEqual(['get', 'post']);
    expect(Object.keys(path.post.responses)).toContain('202');
    expect(openApiDocument.components.schemas.WeeklyInsightView).toBeDefined();
    expect(openApiDocument.components.schemas.WeeklyInsightOutput).toBeDefined();
  });
});
