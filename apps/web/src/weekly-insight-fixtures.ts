import type { WeeklyInsightView } from '@running-tracker/contracts';

/** A weekly insight view for tests, queued by default. */
export function insightView(patch: Partial<WeeklyInsightView> = {}): WeeklyInsightView {
  return {
    attempts: 1,
    createdAt: '2026-11-09T08:00:00.000Z',
    failureReason: null,
    freshness: 'current',
    id: '0b8f1a5e-1c1d-4f57-9a65-35a3a1c0f2d1',
    model: 'fake',
    output: null,
    policyVersion: 'weekly-insight-policy-2',
    promptVersion: 'weekly-insight-v2',
    retryable: false,
    status: 'queued',
    timeZone: 'Europe/Warsaw',
    updatedAt: '2026-11-09T08:00:00.000Z',
    weekStart: '2026-11-02',
    ...patch,
  };
}
