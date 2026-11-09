import type { DailyTrends, DailyTrendsMetric } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { loadingTrends, type TrendsSnapshot } from './daily-trends-controller.js';
import { sparseTrends, trendsFixture } from './daily-trends-fixtures.js';
import { TrendsContent, TrendsScreen, TrendsView } from './TrendsScreen.js';

const END = '2026-11-09';
const noop = () => undefined;

function render(snapshot: Partial<TrendsSnapshot> = {}, options: { endInput?: string; metric?: DailyTrendsMetric; today?: string } = {}): string {
  return renderToStaticMarkup(
    <TrendsView
      endInput={options.endInput ?? END}
      metric={options.metric ?? 'steps'}
      onChooseEnd={noop}
      onChooseMetric={noop}
      onOpenDay={noop}
      onRefresh={noop}
      snapshot={{ ...loadingTrends(END), ...snapshot }}
      timeZone="Europe/Warsaw"
      today={options.today ?? END}
    />,
  );
}

const ready = (trends: DailyTrends, metric: DailyTrendsMetric = 'steps', refreshing = false) =>
  render({ endDate: trends.range.endDate, load: { kind: 'ready', refreshing, trends } }, { endInput: trends.range.endDate, metric });

/** Invokes every button handler of rendered content through the React element tree. */
function pressAll(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(pressAll);
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const { props, type } = node as { props: { children?: unknown; onClick?: () => void }; type: unknown };
  if (type === 'button' && props.onClick) props.onClick();
  if (typeof type === 'function') {
    pressAll((type as (props: unknown) => unknown)(props));
    return;
  }
  pressAll(props.children);
}

describe('Trends screen', () => {
  it('has an accessible heading, an end-date control limited to today, a series selector, Refresh and the range in every state', () => {
    for (const html of [render(), ready(sparseTrends())]) {
      expect(html).toContain('<h1 id="trends-title" tabindex="-1">Trends</h1>');
      expect(html).toContain('aria-labelledby="trends-title"');
      expect(html).toMatch(/<label>End date<input max="2026-11-09" min="2000-01-01" type="date" value="2026-11-09"\/><\/label>/u);
      expect(html).toContain('<legend>Series</legend>');
      expect(html).toContain('checked="" value="steps"/>Steps');
      expect(html).toContain('Range: <strong>28 days, Tue, 13 Oct 2026 to Mon, 9 Nov 2026</strong>, ending today.');
      expect(html).toContain('the time zone Europe/Warsaw only decides which date is today');
      expect(html).toContain('it sets no targets, makes no predictions and gives no advice');
    }
    expect(ready(sparseTrends())).toContain('<button type="button">Refresh</button>');
  });

  it('shows loading, refreshing, error with Retry and access denied', () => {
    expect(render()).toContain('data-trends-state="loading"');
    expect(render()).toContain('Loading these dates…');
    expect(render()).toContain('<button disabled="" type="button">Updating…</button>');
    const refreshing = ready(sparseTrends(), 'steps', true);
    expect(refreshing).toContain('data-trends-state="refreshing"');
    expect(refreshing).toContain('Recorded total 13,042 steps');
    const failed = render({ load: { kind: 'error', message: 'Database unavailable.' } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('>Retry</button>');
    expect(failed).not.toContain('Every date');
    const denied = render({ load: { kind: 'access-denied', message: 'You no longer have access to this organization.' } });
    expect(denied).toContain('You no longer have access to this organization.');
    expect(denied).not.toContain('>Retry</button>');
  });

  it('names a range before its answer arrives, also when the lower bound shortened it', () => {
    const html = render({ endDate: '2000-01-05' }, { endInput: '2000-01-05' });
    expect(html).toContain('Range: <strong>5 days, Sat, 1 Jan 2000 to Wed, 5 Jan 2000 (shortened from 28: records start on 1 January 2000)</strong>.');
    expect(html).toContain('>End today</button>');
  });

  it('refuses a date after today in the date control without changing the range', () => {
    const html = render({}, { endInput: '2026-11-10' });
    expect(html).toContain('The date cannot be after today.');
  });

  it('says when nothing is recorded, and still lists every date as Not recorded', () => {
    const html = ready(trendsFixture(END));
    expect(html).toContain('Nothing is recorded for these dates yet.');
    expect(html).toContain('No value to draw for this series in this range.');
    expect(html.match(/>Not recorded</gu)).toHaveLength(28);
    expect(html).not.toContain('<svg');
  });

  it('draws recorded values with gaps, a recorded zero as a point, and the same values in the table', () => {
    const html = ready(sparseTrends(), 'steps');
    expect(html).toContain('<h2 id="trends-series-title">Manually entered steps</h2>');
    expect(html).toContain('Manually entered</span>');
    expect(html).toContain('Recorded on 3 of 28 days. The other 25 days have no value: unknown, not zero.');
    expect(html.match(/<circle /gu)).toHaveLength(3);
    expect(html).toContain('data-date="2026-10-14"'); // the recorded zero
    // One line, between the two consecutive recorded dates; 2026-11-02 stands alone.
    expect(html.match(/<polyline /gu)).toHaveLength(1);
    expect(html).toContain('data-segment="2026-10-13..2026-10-14"');
    expect(html.match(/data-missing-date=/gu)).toHaveLength(25);
    expect(html).toContain('<title>Wed, 14 Oct 2026: 0 steps</title>');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Manually entered steps, 28 days, Tue, 13 Oct 2026 to Mon, 9 Nov 2026: 3 of 28 days have a value. The table below lists every date."');
    expect(html).toContain('<th scope="col">Steps</th>');
    expect(html).toMatch(/<tr data-date="2026-10-14"><th scope="row">Wed, 14 Oct 2026<\/th><td><span class="trends-table__value">0 steps<\/span><\/td>/u);
    expect(html).toMatch(/<tr class="trends-table__missing" data-date="2026-11-09">/u);
    expect(html).toContain('aria-label="Open Today on Mon, 9 Nov 2026"');
  });

  it('shows food energy with both coverage levels and entry details, and never as a complete diary', () => {
    const html = ready(sparseTrends(), 'foodEnergyKcal');
    expect(html).toContain('Food energy recorded (kcal)</h2>');
    expect(html).toContain('Energy is recorded on 2 of 5 logged entries.');
    expect(html).toContain('2 of 3 entries with energy');
    expect(html).toContain('2 entries logged, no energy recorded');
    expect(html).toContain('it is not a complete food diary');
    expect(html).not.toContain('Manually entered steps');
  });

  it('shows a single weight without a change, and two recorded dates with the exact difference', () => {
    expect(ready(trendsFixture(END, { '2026-11-01': { weightKg: 70 } }), 'weightKg')).toContain('A change needs a weight on at least two dates');
    const html = ready(sparseTrends(), 'weightKg');
    expect(html).toContain('Difference between those two dates: −0.05 kg (2 dates have a weight).');
    expect(html).not.toContain('Manually entered</span>');
  });

  it('opens Today on the date of a table row', () => {
    const opened: string[] = [];
    pressAll(TrendsContent({ metric: 'steps', onOpenDay: (localDate) => opened.push(localDate), timeZone: 'Europe/Warsaw', trends: sparseTrends() }));
    expect(opened).toHaveLength(28);
    expect(opened[0]).toBe(END);
    expect(opened.at(-1)).toBe('2026-10-13');
  });

  it('never writes judgements, targets, predictions, correlations or advice', () => {
    const html = (['weightKg', 'sleepMinutes', 'steps', 'foodEnergyKcal'] as const)
      .map((metric) => ready(sparseTrends(), metric))
      .join('')
      .replaceAll('it sets no targets, makes no predictions and gives no advice', '');
    expect(html).not.toMatch(
      /\b(goal|target|should|great|well done|too (little|much)|healthy|unhealthy|recommend|consider|try to|predict|forecast|correlat|deficit|surplus|balance|requirement|lost|gained|improv)\w*/iu,
    );
  });

  it('opens on the kept end date, or on today when it is missing or later than today', () => {
    const read = vi.fn(() => new Promise<DailyTrends>(() => undefined));
    const open = (selectedEndDate: string | null) =>
      renderToStaticMarkup(
        <TrendsScreen
          initialMetric="sleepMinutes"
          nowMs={Date.parse('2026-11-09T10:00:00Z')}
          onChooseMetric={noop}
          onOpenDay={noop}
          onSelectEndDate={noop}
          orgId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          read={read}
          selectedEndDate={selectedEndDate}
          signal={new AbortController().signal}
          timeZone="Europe/Warsaw"
        />,
      );
    expect(open('2026-10-31')).toContain('value="2026-10-31"');
    expect(open('2026-11-10')).toContain('value="2026-11-09"');
    expect(open(null)).toContain('value="2026-11-09"');
    expect(open(null)).toContain('checked="" value="sleepMinutes"/>Sleep');
  });
});
