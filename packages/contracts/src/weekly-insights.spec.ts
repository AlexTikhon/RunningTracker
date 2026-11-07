import { describe, expect, it } from 'vitest';

import {
  WEEKLY_INSIGHT_NOT_FOUND,
  WEEKLY_INSIGHT_RETRY_LIMIT,
  WEEKLY_INSIGHTS_BUSY,
  WEEKLY_INSIGHTS_DISABLED,
  createWeeklyInsightRequestSchema,
  openApiDocument,
  weeklyInsightAcceptedSchema,
  weeklyInsightModelOutputSchema,
  weeklyInsightOutputSchema,
  weeklyInsightQuerySchema,
  weeklyInsightStatuses,
  weeklyInsightViewSchema,
} from './index.js';

const fact = {
  day: 'none',
  direction: 'none',
  id: 'sleep.average_minutes',
  label: 'Average sleep',
  text: 'Average sleep: 452 min',
  unit: 'minutes',
  value: 452,
} as const;

const output = {
  dataGaps: [{ code: 'missing_check_in_days', text: 'No check-in on 2 of 7 days.' }],
  observations: [{ facts: [fact], text: 'This is your average sleep for the nights you logged.' }],
  suggestion: { id: null, source: 'model', text: 'Keep a regular bedtime.' },
  summary: 'A calm week.',
};

const modelOutput = {
  observations: [
    { claims: [{ day: 'none', direction: 'none', factId: 'sleep.average_minutes', unit: 'minutes', value: 452 }], text: 'Your sleep.' },
  ],
  suggestion: null,
  summary: 'A calm week.',
};

const view = {
  attempts: 1,
  createdAt: '2026-11-02T08:00:00.123Z',
  failureReason: null,
  freshness: 'current',
  id: '0b8f1a5e-1c1d-4f57-9a65-35a3a1c0f2d1',
  model: 'qwen3:8b',
  output,
  policyVersion: 'weekly-insight-policy-2',
  promptVersion: 'weekly-insight-v2',
  retryable: false,
  status: 'ready',
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-11-02T08:01:00.000Z',
  weekStart: '2026-11-02',
};

const acceptsOutput = (value: unknown) => weeklyInsightOutputSchema.safeParse(value).success;
const acceptsModel = (value: unknown) => weeklyInsightModelOutputSchema.safeParse(value).success;

describe('weekly insight stored output contract', () => {
  it('accepts the documented shape, also with no observations and no data gaps', () => {
    expect(acceptsOutput(output)).toBe(true);
    expect(acceptsOutput({ ...output, dataGaps: [], observations: [] })).toBe(true);
    expect(acceptsOutput({ ...output, suggestion: { id: 'rest_and_recovery', source: 'approved', text: 'Rest.' } })).toBe(true);
  });

  it('bounds the summary at 400 characters and refuses blank or malformed text', () => {
    expect(acceptsOutput({ ...output, summary: 'x'.repeat(400) })).toBe(true);
    expect(acceptsOutput({ ...output, summary: 'x'.repeat(401) })).toBe(false);
    expect(acceptsOutput({ ...output, summary: '   ' })).toBe(false);
    expect(acceptsOutput({ ...output, summary: 'a\u0000b' })).toBe(false);
    expect(acceptsOutput({ ...output, suggestion: { ...output.suggestion, text: '\ud800' } })).toBe(false);
  });

  it('allows at most four observations, each with one to three code-written facts', () => {
    const observation = output.observations[0]!;
    expect(acceptsOutput({ ...output, observations: Array(4).fill(observation) })).toBe(true);
    expect(acceptsOutput({ ...output, observations: Array(5).fill(observation) })).toBe(false);
    expect(acceptsOutput({ ...output, observations: [{ ...observation, facts: [] }] })).toBe(false);
    expect(acceptsOutput({ ...output, observations: [{ ...observation, facts: Array(4).fill(fact) }] })).toBe(false);
    for (const id of ['sleep avg', 'sleep..avg', '.sleep', 'Sleep.Avg', 'sleep', 'a.b.c.d']) {
      expect(acceptsOutput({ ...output, observations: [{ ...observation, facts: [{ ...fact, id }] }] })).toBe(false);
    }
    expect(acceptsOutput({ ...output, observations: [{ ...observation, facts: [{ ...fact, value: -0.6 }] }] })).toBe(false);
  });

  it('refuses unknown fields and an unknown data gap code', () => {
    expect(acceptsOutput({ ...output, extra: true })).toBe(false);
    expect(acceptsOutput({ ...output, dataGaps: [{ code: 'other', text: 'x' }] })).toBe(false);
  });
});

describe('weekly insight model output contract', () => {
  it('accepts claims and a null suggestion, and refuses unknown fields or too many claims', () => {
    expect(acceptsModel(modelOutput)).toBe(true);
    expect(acceptsModel({ ...modelOutput, suggestion: 'Keep a regular bedtime.' })).toBe(true);
    expect(acceptsModel({ ...modelOutput, dataGaps: [] })).toBe(false);
    const claim = modelOutput.observations[0]!.claims[0]!;
    expect(acceptsModel({ ...modelOutput, observations: [{ claims: Array(4).fill(claim), text: 'x' }] })).toBe(false);
    expect(acceptsModel({ ...modelOutput, observations: [{ claims: [{ ...claim, unit: 'stone' }], text: 'x' }] })).toBe(false);
    expect(acceptsModel({ ...modelOutput, observations: [{ claims: [{ ...claim, day: 'Someday' }], text: 'x' }] })).toBe(false);
  });
});

describe('weekly insight requests and views', () => {
  it('accepts a Monday week start with an IANA zone and refuses any other day', () => {
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-02' }).success).toBe(true);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-03' }).success).toBe(false);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: '+01:00', weekStart: '2026-11-02' }).success).toBe(false);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'UTC', weekStart: '1999-12-27' }).success).toBe(false);
    expect(createWeeklyInsightRequestSchema.safeParse({ timeZone: 'UTC', weekStart: '2026-11-02', extra: 1 }).success).toBe(false);
    expect(weeklyInsightQuerySchema.safeParse({ weekStart: '2026-11-02' }).success).toBe(true);
    expect(weeklyInsightQuerySchema.safeParse({ weekStart: '2026-02-30' }).success).toBe(false);
  });

  it('carries output exactly when the status is ready and the policy is current', () => {
    expect(weeklyInsightViewSchema.safeParse(view).success).toBe(true);
    expect(weeklyInsightViewSchema.safeParse({ ...view, freshness: 'stale' }).success).toBe(true);
    expect(weeklyInsightViewSchema.safeParse({ ...view, output: null }).success).toBe(false);
    expect(weeklyInsightViewSchema.safeParse({ ...view, freshness: 'outdated_policy' }).success).toBe(false);
    expect(weeklyInsightViewSchema.safeParse({ ...view, freshness: 'outdated_policy', output: null }).success).toBe(true);
    for (const status of weeklyInsightStatuses.filter((name) => name !== 'ready')) {
      expect(weeklyInsightViewSchema.safeParse({ ...view, output: null, status }).success).toBe(true);
      expect(weeklyInsightViewSchema.safeParse({ ...view, status }).success).toBe(false);
    }
    expect(weeklyInsightViewSchema.safeParse({ ...view, failureReason: 'Model said: no' }).success).toBe(false);
    expect(weeklyInsightAcceptedSchema.safeParse({ id: view.id, status: 'queued' }).success).toBe(true);
    expect(weeklyInsightAcceptedSchema.safeParse({ id: view.id, status: 'pending' }).success).toBe(false);
  });

  it('names its error codes and documents both operations in OpenAPI', () => {
    expect([WEEKLY_INSIGHT_NOT_FOUND, WEEKLY_INSIGHTS_DISABLED, WEEKLY_INSIGHTS_BUSY, WEEKLY_INSIGHT_RETRY_LIMIT]).toEqual([
      'WEEKLY_INSIGHT_NOT_FOUND',
      'WEEKLY_INSIGHTS_DISABLED',
      'WEEKLY_INSIGHTS_BUSY',
      'WEEKLY_INSIGHT_RETRY_LIMIT',
    ]);
    const path = openApiDocument.paths['/api/orgs/{orgId}/insights/weekly'];
    expect(Object.keys(path).sort()).toEqual(['get', 'post']);
    expect(Object.keys(path.post.responses)).toContain('202');
    expect(openApiDocument.components.schemas.WeeklyInsightView).toBeDefined();
    expect(openApiDocument.components.schemas.WeeklyInsightOutput).toBeDefined();
  });
});
