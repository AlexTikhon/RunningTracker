import type { WeeklyInsightOutput } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { insightView } from './weekly-insight-fixtures.js';
import { loadingInsight, type InsightPanelSnapshot } from './weekly-insight-controller.js';
import { InsightPanelView } from './WeeklyInsightPanel.js';
import { formatWeek, mondayOf, recentWeeks } from './weekly-insight.js';

const WEEK = '2026-11-02';
const weeks = recentWeeks('2026-11-11');
const noop = () => undefined;

const output: WeeklyInsightOutput = {
  dataGaps: [{ code: 'missing_check_in_days', text: 'No check-in on 4 of 7 days; averages use the days that have one.' }],
  observations: [
    {
      facts: [{ day: 'none', direction: 'none', id: 'sleep.average_minutes', label: 'Average sleep', text: 'Average sleep: 437 min', unit: 'minutes', value: 437 }],
      text: 'This is your average sleep for the nights you logged.',
    },
  ],
  suggestion: { id: null, source: 'model', text: 'Keep a regular bedtime.' },
  summary: 'A calm look at your week.',
};

function render(snapshot: Partial<InsightPanelSnapshot>): string {
  return renderToStaticMarkup(
    <InsightPanelView
      onCheckAgain={noop}
      onGenerate={noop}
      onRetryLoad={noop}
      onSelectWeek={noop}
      snapshot={{ ...loadingInsight(WEEK), ...snapshot }}
      weeks={weeks}
    />,
  );
}

describe('weekly insight panel', () => {
  it('offers the recent weeks, current first, Monday to Sunday', () => {
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(weeks[0]).toEqual({ label: 'This week: 9 Nov – 15 Nov 2026', weekStart: '2026-11-09' });
    expect(weeks).toHaveLength(8);
    expect(formatWeek('2026-12-28')).toBe('28 Dec – 3 Jan 2027');
  });

  it('states its non-medical, descriptive positioning in every state', () => {
    expect(render({})).toContain('It is not medical advice and it does not diagnose anything');
  });

  it('renders the no-insight state with Generate, and explains a deleted insight', () => {
    const html = render({ load: { kind: 'none' } });
    expect(html).toContain('Generate insight');
    expect(html).toContain('removed because one of the week&#x27;s records was deleted or changed');
  });

  it('renders a ready insight: AI label, AI prose, code-rendered facts, suggestion source and data gaps', () => {
    const html = render({ load: { kind: 'view', view: insightView({ output, status: 'ready' }) } });
    expect(html).toContain('AI-generated text');
    expect(html).toContain('The numbers themselves are computed by the app, not by the model.');
    expect(html).toContain('data-fact="sleep.average_minutes">Average sleep: 437 min</li>');
    expect(html).toContain('Written by the AI model.');
    expect(html).toContain('data-gap="missing_check_in_days"');
    // Ready and current: nothing to regenerate.
    expect(html).toContain('<button class="finish-action" disabled="" type="button">Regenerate</button>');
  });

  it('marks a stale insight as out of date and offers Regenerate', () => {
    const html = render({ load: { kind: 'view', view: insightView({ freshness: 'stale', output, retryable: true, status: 'ready' }) } });
    expect(html).toContain('Out of date: your data for this week changed');
    expect(html).toContain('<button class="finish-action" type="button">Regenerate</button>');
  });

  it('labels an approved suggestion as chosen by the app', () => {
    const approved = { ...output, suggestion: { id: 'rest_and_recovery', source: 'approved' as const, text: 'Consider keeping this week light.' } };
    expect(render({ load: { kind: 'view', view: insightView({ output: approved, status: 'ready' }) } })).toContain('chosen by the app');
  });

  it('renders queued, running, failed, interrupted and outdated states without model text', () => {
    expect(render({ load: { kind: 'view', view: insightView({ status: 'queued' }) } })).toContain('Queued: generation starts');
    const running = render({ load: { kind: 'view', view: insightView({ status: 'running' }) }, pollingExhausted: true });
    expect(running).toContain('Generating: the local model is writing');
    expect(running).toContain('Check again');
    expect(running).toContain('<button class="finish-action" disabled="" type="button">Regenerate</button>');
    const failed = render({ load: { kind: 'view', view: insightView({ failureReason: 'timeout', retryable: true, status: 'generation_failed' }) } });
    expect(failed).toContain('did not answer in time');
    expect(failed).toContain('You can try again.');
    expect(render({ load: { kind: 'view', view: insightView({ failureReason: 'lease_expired', retryable: true, status: 'interrupted' }) } })).toContain(
      'Generation was interrupted',
    );
    const grounding = render({ load: { kind: 'view', view: insightView({ failureReason: 'claim_value_mismatch', status: 'failed_grounding' }) } });
    expect(grounding).toContain('did not match your numbers exactly');
    expect(grounding).toContain('kept as it is until the week&#x27;s data changes');
    expect(render({ load: { kind: 'view', view: insightView({ freshness: 'outdated_policy', retryable: true, status: 'ready' }) } })).toContain(
      'checked under older rules and is hidden',
    );
  });

  it('hides the button when generation is off and shows request failures', () => {
    const off = render({ generationDisabled: true, load: { kind: 'none' } });
    expect(off).toContain('turned off on this server');
    expect(off).not.toContain('Generate insight');
    expect(render({ load: { kind: 'none' }, request: 'failed', requestMessage: 'The insight generator is busy right now.' })).toContain(
      'role="alert">The insight generator is busy right now.',
    );
  });
});
