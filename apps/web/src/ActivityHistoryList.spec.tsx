import type { ActivityHistoryItem } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { confirmingActivityDeletion } from './activity-controller.js';
import { loadingActivityHistory, noHistoryFilters, type ActivityHistoryFilters, type ActivityHistorySnapshot } from './activity-history-controller.js';
import { ActivityHistoryList, type HistoryDeletion } from './ActivityHistoryList.js';

const timeZone = 'Europe/Warsaw';
const items: ActivityHistoryItem[] = [
  {
    captureSource: null,
    finishedAt: '2026-10-05T07:00:00.000Z',
    runId: 'a0000000-0000-4000-8000-000000000001',
    source: 'recorded_run',
    startedAt: '2026-10-05T06:00:00.000Z',
    summary: { distanceM: 5_012.4, gpsQuality: 'good', observedDurationS: 1_805, state: 'current' },
    type: 'run',
  },
  {
    captureSource: null,
    finishedAt: '2026-10-04T07:00:00.000Z',
    runId: 'a0000000-0000-4000-8000-000000000002',
    source: 'recorded_run',
    startedAt: '2026-10-04T06:00:00.000Z',
    summary: { state: 'pending' },
    type: 'run',
  },
  {
    captureSource: null,
    finishedAt: '2026-10-03T07:00:00.000Z',
    runId: 'a0000000-0000-4000-8000-000000000003',
    source: 'recorded_run',
    startedAt: '2026-10-03T06:00:00.000Z',
    summary: { state: 'stale' },
    type: 'run',
  },
  {
    activityId: 'ad000000-0000-4000-8000-000000000004',
    distanceM: 10_400,
    elapsedDurationS: 4_000,
    source: 'gpx',
    startedAt: '2026-10-02T06:00:00.000Z',
    type: 'hike',
  },
  {
    activityId: 'ad000000-0000-4000-8000-000000000005',
    distanceM: null,
    enteredDurationS: 3_600,
    notes: 'Hilly loop',
    rpe: 7,
    source: 'manual',
    startedAt: '2026-10-01T06:00:00.000Z',
    type: 'ride',
  },
];

const ready = (list: ActivityHistoryItem[], patch: Partial<ActivityHistorySnapshot> = {}, filters: ActivityHistoryFilters = noHistoryFilters): ActivityHistorySnapshot => ({
  ...loadingActivityHistory(filters),
  items: list,
  status: 'ready',
  ...patch,
});

function render(
  history: ActivityHistorySnapshot,
  options: { backToToday?: string; deletion?: HistoryDeletion | null; filters?: ActivityHistoryFilters } = {},
): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <ActivityHistoryList
      backToToday={options.backToToday === undefined ? null : { localDate: options.backToToday, onBack: noop }}
      deletion={options.deletion ?? null}
      filters={options.filters ?? noHistoryFilters}
      history={history}
      notice={null}
      onCancelDelete={noop}
      onConfirmDelete={noop}
      onDelete={noop}
      onFiltersChange={noop}
      onLoadMore={noop}
      onOpenRun={noop}
      onRefresh={noop}
      onRetry={noop}
      timeZone={timeZone}
      unit="km"
    />,
  );
}

function cards(markup: string): string[] {
  return markup.split('<li class="run-card').slice(1);
}

describe('ActivityHistoryList', () => {
  const markup = render(ready(items, { hasMore: true }));
  const [current, pending, stale, gpx, manual] = cards(markup);

  it('says each item’s provenance', () => {
    expect(current).toContain('<dt>Source</dt><dd>Recorded run</dd>');
    expect(gpx).toContain('<dt>Source</dt><dd>GPX import</dd>');
    expect(manual).toContain('<dt>Source</dt><dd>Entered manually</dd>');
  });

  it('labels each duration for what it is', () => {
    expect(manual).toContain('<dt>Duration</dt><dd>1:00:00</dd>');
    expect(gpx).toContain('<dt>Elapsed time</dt><dd>1:06:40</dd>');
    expect(current).toContain('<dt>Observed duration</dt><dd>30:05</dd>');
    expect(current).toContain('<dt>Distance</dt><dd>5.01 km</dd>');
    expect(current).toContain('<dt>GPS quality</dt><dd>Good</dd>');
    expect(manual).toContain('<dt>Distance</dt><dd>Not recorded</dd>');
    expect(manual).toContain('Hilly loop');
    expect(markup).toContain('not moving time');
    expect(markup).toContain('never added');
  });

  it('keeps missing and stale run metrics unknown, never zero or old values', () => {
    expect(pending).not.toContain('Distance</dt>');
    expect(pending).not.toContain('Observed duration</dt>');
    expect(pending).toContain('still being prepared');
    expect(stale).not.toContain('Distance</dt>');
    expect(stale).toContain('summary is being updated');
    expect(markup).not.toContain('0.00 km');
  });

  it('says the capture source of a recorded run is not recorded, rather than guessing it', () => {
    for (const run of [current, pending, stale]) expect(run).toContain('<dt>Capture source</dt><dd>Not recorded</dd>');
    expect(markup).not.toMatch(/Simulator|Device GPS/u);
  });

  it('offers run details for recorded runs and deletion for activities only', () => {
    expect(current).toContain('aria-label="Run details of your run of 5 Oct 2026, 08:00"');
    expect(current).not.toContain('Delete');
    expect(gpx).toContain('aria-label="Delete your hike of 2 Oct 2026, 08:00"');
    expect(manual).toContain('aria-label="Delete your ride of 1 Oct 2026, 08:00"');
    expect(gpx).not.toContain('Run details');
    expect(markup).toContain('>Load more</button>');
  });

  it('confirms one deletion in place', () => {
    const confirming = render(ready(items), { deletion: { activityId: 'ad000000-0000-4000-8000-000000000004', snapshot: confirmingActivityDeletion } });
    expect(confirming).toContain('aria-label="Delete your hike of 2 Oct 2026, 08:00?"');
    expect(confirming).toContain('Confirm delete');
  });

  it('distinguishes an empty history from an empty filter result', () => {
    expect(render(ready([]))).toContain('No activities yet.');
    const gpxOnly = { day: null, source: 'gpx', type: null } as const;
    const filtered = render(ready([], {}, gpxOnly), { filters: gpxOnly });
    expect(filtered).toContain('Nothing in your history matches these filters.');
    expect(filtered).toContain('<option value="gpx" selected="">GPX import</option>');
  });

  describe('day filter (ADR-0088)', () => {
    const tokyo = { day: { localDate: '2026-10-05', timeZone: 'Asia/Tokyo' }, source: null, type: null };
    const appliedTokyo = { endsAt: '2026-10-05T15:00:00.000Z', localDate: '2026-10-05', startsAt: '2026-10-04T15:00:00.000Z', timeZone: 'Asia/Tokyo' };

    it('offers a day input and an explicit All dates action, disabled without a day', () => {
      expect(markup).toMatch(/<label>Day<input min="2000-01-01" type="date" value=""\/><\/label>/u);
      expect(markup).toContain('<button disabled="" type="button">All dates</button>');
      expect(markup).not.toContain('Showing what started on');
      const html = render(ready(items, { appliedDay: appliedTokyo }, tokyo), { filters: tokyo });
      expect(html).toMatch(/<label>Day<input min="2000-01-01" type="date" value="2026-10-05"\/><\/label>/u);
      expect(html).toContain('<button type="button">All dates</button>');
    });

    it('shows the active day and zone, and every time in that zone rather than the device’s', () => {
      const html = render(ready(items, { appliedDay: appliedTokyo }, tokyo), { filters: tokyo });
      expect(html).toContain('Showing what started on <strong>Mon, 5 Oct 2026</strong> in the time zone Asia/Tokyo');
      expect(html).toContain('listed on the day it started');
      expect(html).toContain('Times are shown in Asia/Tokyo.');
      // 06:00 UTC is 15:00 in Tokyo (and 08:00 in the device's Warsaw).
      expect(html).toContain('aria-label="Run details of your run of 5 Oct 2026, 15:00"');
      expect(html).not.toContain('5 Oct 2026, 08:00');
      expect(html).not.toContain('hours in Asia/Tokyo');
    });

    it('says when the applied day is not 24 hours long, from the server’s interval', () => {
      const warsaw = { day: { localDate: '2026-03-29', timeZone: timeZone }, source: 'recorded_run', type: null } as const;
      const applied = { endsAt: '2026-03-29T22:00:00.000Z', localDate: '2026-03-29', startsAt: '2026-03-28T23:00:00.000Z', timeZone };
      const html = render(ready([], { appliedDay: applied }, warsaw), { filters: warsaw });
      expect(html).toContain('This date has 23 hours in Europe/Warsaw because the clocks change.');
      expect(html).toContain('Nothing in your history matches these filters on Sun, 29 Mar 2026 in Europe/Warsaw.');
      // An interval for another day is never described as this one's.
      const other = render(ready([], { appliedDay: { ...applied, localDate: '2026-03-30' } }, warsaw), { filters: warsaw });
      expect(other).not.toContain('23 hours');
    });

    it('words an empty day without other filters', () => {
      const html = render(ready([], { appliedDay: appliedTokyo }, tokyo), { filters: tokyo });
      expect(html).toContain('Nothing in your history started on Mon, 5 Oct 2026 in Asia/Tokyo.');
    });

    it('offers Back to Today on the originating date only when opened from Today', () => {
      expect(markup).not.toContain('Back to Today');
      const html = render(ready(items, { appliedDay: appliedTokyo }, tokyo), { backToToday: '2026-10-05', filters: tokyo });
      expect(html).toContain('aria-label="Back to Today on Mon, 5 Oct 2026" type="button">Back to Today</button>');
    });
  });

  it('shows loading, error with Retry, and lost access', () => {
    expect(render(loadingActivityHistory(noHistoryFilters))).toContain('Loading your activity history…');
    const failed = render({ ...loadingActivityHistory(noHistoryFilters), message: 'Broken.', status: 'error' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Broken.');
    expect(failed).toContain('>Retry</button>');
    const denied = render({ ...loadingActivityHistory(noHistoryFilters), message: 'You no longer have access to your activity history in this organization.', status: 'access-denied' });
    expect(denied).toContain('You no longer have access');
    expect(denied).not.toContain('run-card');
  });

  it('shows no identifiers', () => {
    for (const item of items) {
      expect(markup).not.toContain(item.source === 'recorded_run' ? item.runId : item.activityId);
    }
  });
});
