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

function render(history: ActivityHistorySnapshot, options: { deletion?: HistoryDeletion | null; filters?: ActivityHistoryFilters } = {}): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <ActivityHistoryList
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
    const filtered = render(ready([], {}, { source: 'gpx', type: null }), { filters: { source: 'gpx', type: null } });
    expect(filtered).toContain('Nothing in your history matches these filters.');
    expect(filtered).toContain('<option value="gpx" selected="">GPX import</option>');
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
