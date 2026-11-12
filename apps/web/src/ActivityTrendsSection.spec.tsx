import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActivityTrendsView } from './ActivityTrendsSection.js';
import type { ActivityTrendMeasure } from './activity-trends.js';
import type { ActivityTrendsSnapshot } from './activity-trends-controller.js';
import { activityTrendsFixture } from './activity-trends-fixtures.js';

const noop = () => undefined;
const filters = { endDate: '2026-11-12', source: 'manual' as const, type: 'ride' as const };

function render(snapshot: Partial<ActivityTrendsSnapshot> = {}, measure: ActivityTrendMeasure = 'count'): string {
  return renderToStaticMarkup(
    <ActivityTrendsView
      measure={measure}
      onChooseMeasure={noop}
      onChooseSource={noop}
      onChooseType={noop}
      onRetry={noop}
      snapshot={{ filters, load: { kind: 'loading' }, ...snapshot }}
      timeZone="Europe/Warsaw"
    />,
  );
}

describe('Activity section of Trends', () => {
  it('shows loading, error with Retry and lost access', () => {
    expect(render()).toContain('data-activity-trends-state="loading"');
    const failed = render({ load: { kind: 'error', message: 'Database unavailable.' } });
    expect(failed).toContain('Database unavailable.');
    expect(failed).toContain('>Retry</button>');
    const denied = render({ load: { kind: 'access-denied', message: 'You no longer have access to this organization.' } });
    expect(denied).not.toContain('Retry');
  });

  it('labels the duration of each source and locks a recorded run’s type to run', () => {
    const trends = activityTrendsFixture({ days: { '2026-11-12': { count: 1 } } });
    const html = render({ load: { kind: 'ready', refreshing: false, trends } }, 'duration');
    expect(html).toContain('<th scope="col">Entered duration</th>');
    expect(html).toContain('checked="" value="duration"/>Entered duration');
    const runs = activityTrendsFixture({ source: 'recorded_run' });
    const runHtml = render({ filters: { ...filters, source: 'recorded_run', type: 'run' }, load: { kind: 'ready', refreshing: false, trends: runs } });
    expect(runHtml).toContain('<th scope="col">Observed duration</th>');
    expect(runHtml).toMatch(/<select disabled=""><option value="run" selected="">Run<\/option><\/select>/u);
    expect(runHtml).toContain('A recorded run is always a run.');
  });

  it('renders the chart, a table of every date and the computed line', () => {
    const trends = activityTrendsFixture({
      days: {
        '2026-11-10': { count: 1, distance: { totalM: 10_000, withValue: 1 } },
        '2026-11-11': { count: 1, distance: { totalM: 0, withValue: 1 } },
        '2026-11-12': { count: 2 },
      },
    });
    const html = render({ load: { kind: 'ready', refreshing: false, trends } }, 'distance');
    expect(html.match(/data-activity-date=/gu)).toHaveLength(28);
    expect(html).toContain('data-bar-date="2026-11-10"');
    expect(html).toContain('data-zero-date="2026-11-11"');
    expect(html).toContain('data-unknown-date="2026-11-12"');
    expect(html.match(/data-none-date=/gu)).toHaveLength(25);
    expect(html).toContain('role="img"');
    expect(html).toContain('The table below lists every date.');
    expect(html).toMatch(/Computed .+ \(activity-trends-1\); nothing is stored\./u);
    // The health series' attributes are not reused, so their selectors keep meaning the health table and chart.
    expect(html).not.toMatch(/data-date=|data-missing-date=/u);
  });

  it('says there is nothing to draw, and never calls an empty range inactivity', () => {
    const html = render({ load: { kind: 'ready', refreshing: false, trends: activityTrendsFixture() } }, 'duration');
    expect(html).toContain('No entered duration value to draw in this range.');
    expect(html).toContain('it does not mean you were inactive');
    expect(html).not.toMatch(/\b(goal|target|should|recommend|predict|streak|lazy|healthy)\w*/iu);
  });
});
