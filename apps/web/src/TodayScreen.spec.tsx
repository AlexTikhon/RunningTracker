import type { DailyOverview } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { TodayAction } from './daily-overview.js';
import { loadingOverview, type OverviewSnapshot } from './daily-overview-controller.js';
import { noteOnlyCheckIn, overviewFixture } from './daily-overview-fixtures.js';
import { OverviewContent, TodayScreen, TodayView } from './TodayScreen.js';

const DAY = '2026-11-05';
const TODAY = '2026-11-08';
const noop = () => undefined;

function render(snapshot: Partial<OverviewSnapshot> = {}, options: { dateInput?: string; today?: string } = {}): string {
  return renderToStaticMarkup(
    <TodayView
      dateInput={options.dateInput ?? DAY}
      onAction={noop}
      onChooseDate={noop}
      onRefresh={noop}
      snapshot={{ ...loadingOverview(DAY), ...snapshot }}
      timeZone="Europe/Warsaw"
      today={options.today ?? TODAY}
    />,
  );
}

const ready = (overview: DailyOverview, refreshing = false) => render({ load: { kind: 'ready', overview, refreshing } });

/** The actions a rendered overview offers, by invoking each button's handler through the React element tree. */
function actionsOf(overview: DailyOverview): TodayAction[] {
  const actions: TodayAction[] = [];
  const element = OverviewContent({ onAction: (action) => actions.push(action), overview });
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object' || !('props' in node) || !('type' in node)) return;
    const { props, type } = node as { props: { children?: unknown; onClick?: () => void }; type: unknown };
    if (type === 'button' && props.onClick) props.onClick();
    visit(props.children);
  };
  visit(element);
  return actions;
}

describe('Today screen', () => {
  it('has an accessible heading, date control limited to today, Refresh and the view zone in every state', () => {
    for (const html of [render(), ready(overviewFixture())]) {
      expect(html).toContain('<h1 id="today-title" tabindex="-1">Today</h1>');
      expect(html).toContain('aria-labelledby="today-title"');
      expect(html).toMatch(/<label>Date<input max="2026-11-08" min="2000-01-01" type="date" value="2026-11-05"\/><\/label>/u);
      expect(html).toContain('Showing <strong>Thu, 5 Nov 2026</strong> in the time zone Europe/Warsaw.');
      expect(html).toContain('it sets no targets and gives no advice');
      expect(html).toContain('>Go to today</button>');
    }
    expect(ready(overviewFixture())).toContain('<button type="button">Refresh</button>');
  });

  it('labels today and disables "Go to today" there', () => {
    const html = renderToStaticMarkup(
      <TodayView dateInput={TODAY} onAction={noop} onChooseDate={noop} onRefresh={noop} snapshot={loadingOverview(TODAY)} timeZone="Europe/Warsaw" today={TODAY} />,
    );
    expect(html).toContain('Showing <strong>Sun, 8 Nov 2026</strong> (today) in the time zone Europe/Warsaw.');
    expect(html).toContain('<button disabled="" type="button">Go to today</button>');
  });

  it('renders loading, refreshing, error with Retry and access denied', () => {
    const loading = render();
    expect(loading).toContain('data-overview-state="loading"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Loading Thu, 5 Nov 2026…');
    expect(loading).toContain('<button disabled="" type="button">Updating…</button>');
    const refreshing = ready(overviewFixture(), true);
    expect(refreshing).toContain('data-overview-state="refreshing"');
    expect(refreshing).toContain('Nothing is recorded for Thu, 5 Nov 2026 yet.');
    const error = render({ load: { kind: 'error', message: 'This day could not be loaded.' } });
    expect(error).toContain('role="alert"><span>This day could not be loaded.</span><button type="button">Retry</button>');
    const denied = render({ load: { kind: 'access-denied', message: 'You no longer have access to this organization.' } });
    expect(denied).toContain('You no longer have access to this organization.');
    expect(denied).not.toContain('>Retry<');
    expect(denied).not.toContain('today-card');
  });

  it('shows an invalid date without asking for it', () => {
    expect(render({}, { dateInput: '2026-11-09' })).toMatch(/role="alert">[^<]+<\/p>/u);
  });

  it('says an empty day is empty, and offers to add a check-in and movement', () => {
    const html = ready(overviewFixture());
    expect(html).toContain('Nothing is recorded for Thu, 5 Nov 2026 yet.');
    expect(html).toContain('No check-in for this day.');
    expect(html).toContain('No movement recorded for this day.');
    expect(html).toContain('No manual activity started on this day.');
    expect(html).toContain('No finished GPS run started on this day.');
    expect(html).toContain('aria-label="Add check-in for Thu, 5 Nov 2026"');
    expect(html).toContain('aria-label="Add movement for Thu, 5 Nov 2026"');
    expect(html).toContain('Computed 2026-11-08 10:00 UTC from your current data; not stored.');
  });

  it('treats a note-only check-in as a record, never as an empty day, and never shows the note', () => {
    const html = ready(overviewFixture({ checkIn: noteOnlyCheckIn }));
    expect(html).not.toContain('Nothing is recorded');
    expect(html).toContain('Only a note was saved for this day');
    expect(html).toContain('aria-label="Edit check-in for Thu, 5 Nov 2026"');
    expect(html).not.toContain('Check-in values');
  });

  it('treats a movement-only day with recorded zeros as a record and shows zeros as zeros', () => {
    const html = ready(overviewFixture({ movement: { activeEnergyKcal: 0, recorded: true, source: 'manual', steps: 0, timeZone: 'Europe/Warsaw' } }));
    expect(html).not.toContain('Nothing is recorded');
    expect(html).toContain('<span class="review-badge">Manually entered</span>');
    expect(html).toContain('<dt>Steps</dt><dd>0 steps</dd>');
    expect(html).toContain('<dt>Active energy</dt><dd>0 kcal</dd>');
    expect(html).toContain('No check-in for this day.');
    expect(html).toContain('aria-label="Edit movement for Thu, 5 Nov 2026"');
  });

  it('shows a partially recorded day with explicit "Not recorded" values and a saved-note hint', () => {
    const html = ready(
      overviewFixture({
        checkIn: { ...noteOnlyCheckIn, mood: 4, soreness: 0 },
        movement: { activeEnergyKcal: 412.5, recorded: true, source: 'manual', steps: null, timeZone: 'Europe/Warsaw' },
      }),
    );
    expect(html).toContain('<div><dt>Mood</dt><dd>4 of 5</dd></div>');
    expect(html).toContain('<div><dt>Soreness</dt><dd>0 of 10</dd></div>');
    expect(html).toContain('<div class="today-rows__missing"><dt>Sleep</dt><dd>Not recorded</dd></div>');
    expect(html).toContain('<div class="today-rows__missing"><dt>Steps</dt><dd>Not recorded</dd></div>');
    expect(html).toContain('A note is saved with this check-in; open the check-in to read it.');
  });

  it('explains stored zones that differ from the view zone, and a 25-hour date', () => {
    const html = ready(
      overviewFixture({
        checkIn: { ...noteOnlyCheckIn, mood: 3, timeZone: 'Asia/Tokyo' },
        day: { endsAt: '2026-10-25T23:00:00.000Z', inProgress: false, localDate: '2026-10-25', startsAt: '2026-10-24T22:00:00.000Z', timeZone: 'Europe/Warsaw' },
        movement: { activeEnergyKcal: null, recorded: true, source: 'manual', steps: 10, timeZone: 'Pacific/Kiritimati' },
      }),
    );
    expect(html).toContain('This check-in was saved in Asia/Tokyo. It belongs to this calendar date in any time zone');
    expect(html).toContain('This movement day was saved in Pacific/Kiritimati.');
    expect(html).toContain('This date has 25 hours in Europe/Warsaw because the clocks change.');
  });

  it('keeps manual activities and GPS runs apart, with a partial distance that names its runs', () => {
    const html = ready(
      overviewFixture({
        gpsRuns: { count: 2, currentDistanceM: 5012, withCurrentDistance: 1, withoutCurrentDistance: 1 },
        manualActivities: { byType: [{ count: 1, enteredDurationS: 10_800, type: 'run' }], count: 1, enteredDurationS: 10_800 },
      }),
    );
    expect(html).toContain('1 activity started on this day, 3 h 00 min entered in total.');
    expect(html).toContain('<dt>Run</dt><dd>1 · 3 h 00 min entered</dd>');
    expect(html).toContain('also when it continued past midnight');
    expect(html).toContain('2 finished GPS runs started on this day.');
    expect(html).toContain('Distance: 5.01 km from 1 of 2 runs; 1 run has no distance yet, so the total is partial.');
    expect(html).toContain('shown separately and never added together');
  });

  it('notes a day in progress', () => {
    expect(ready(overviewFixture({ day: { ...overviewFixture().day, inProgress: true } }))).toContain('The day is still in progress');
  });

  it('never writes judgements, targets or advice', () => {
    const html = ready(
      overviewFixture({
        checkIn: { ...noteOnlyCheckIn, mood: 1, sleepMinutes: 120, soreness: 10 },
        gpsRuns: { count: 1, currentDistanceM: 42_195, withCurrentDistance: 1, withoutCurrentDistance: 0 },
        movement: { activeEnergyKcal: 0, recorded: true, source: 'manual', steps: 0, timeZone: 'Europe/Warsaw' },
      }),
    ).replace('it sets no targets and gives no advice', '');
    expect(html).not.toMatch(/\b(goal|target|should|great|well done|too (little|much)|healthy|unhealthy|recommend|consider|try to|trend)\b/iu);
  });

  it('opens the editors with the selected date, and Activities and Runner without one', () => {
    expect(actionsOf(overviewFixture())).toEqual([
      { kind: 'check-in', localDate: DAY },
      { kind: 'movement', localDate: DAY },
      { kind: 'activities' },
      { kind: 'runner' },
    ]);
  });

  it('opens on the kept date, or on today when none is kept or the kept date is in the future', () => {
    const read = vi.fn(() => new Promise<DailyOverview>(noop));
    const nowMs = Date.parse('2026-11-08T10:00:00Z');
    const signal = new AbortController().signal;
    const screen = (selectedDate: string | null) =>
      renderToStaticMarkup(
        <TodayScreen nowMs={nowMs} onAction={noop} onSelectDate={noop} orgId="org" read={read} selectedDate={selectedDate} signal={signal} timeZone="Europe/Warsaw" />,
      );
    expect(screen(DAY)).toContain('value="2026-11-05"');
    expect(screen(null)).toContain('value="2026-11-08"');
    expect(screen('2026-11-09')).toContain('value="2026-11-08"');
    expect(read).not.toHaveBeenCalled(); // server rendering runs no effect: nothing is read before the screen mounts
  });
});
