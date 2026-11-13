import type { ActivityHistoryItem } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { loadingActivityHistory, noHistoryFilters } from './activity-history-controller.js';
import {
  activitySummaryLines,
  activityTrendDurationExplanations,
  activityTrendMeasureLabels,
  activityTrendSourceOptions,
  displayDays,
  selectionLabel,
} from './activity-trends.js';
import { activityTrendsFixture } from './activity-trends-fixtures.js';
import { ActivityHistoryList, historySourceLabels } from './ActivityHistoryList.js';
import { loadingOverview } from './daily-overview-controller.js';
import { overviewFixture } from './daily-overview-fixtures.js';
import { TodayView } from './TodayScreen.js';
import { loadingReview } from './weekly-review-controller.js';
import { reviewFixture } from './weekly-review-fixtures.js';
import { recentWeeks } from './weekly-insight.js';
import { isEmptyWeek, ReviewPanelView } from './WeeklyReviewPanel.js';

// ADR-0091: TCX imports keep their own source label and their own duration name ("Reported duration") in every view, and
// are never presented as a GPX import, a manual entry or a recorded run.
const noop = () => undefined;
const tcxItem: ActivityHistoryItem = {
  activityId: 'ad000000-0000-4000-8000-000000000009',
  distanceM: 1_500,
  reportedDurationS: 2_400,
  source: 'tcx',
  startedAt: '2026-10-02T06:00:00.000Z',
  type: 'swim',
};

describe('TCX in the activity history', () => {
  it('labels the card as a TCX import with its reported duration, offers Delete, and filters by TCX', () => {
    const markup = renderToStaticMarkup(
      <ActivityHistoryList
        backToToday={null}
        deletion={null}
        filters={noHistoryFilters}
        history={{ ...loadingActivityHistory(noHistoryFilters), items: [tcxItem], status: 'ready' }}
        notice={null}
        onCancelDelete={noop}
        onConfirmDelete={noop}
        onDelete={noop}
        onFiltersChange={noop}
        onLoadMore={noop}
        onOpenRun={noop}
        onRefresh={noop}
        onRetry={noop}
        timeZone="Europe/Warsaw"
        unit="km"
      />,
    );
    const card = markup.split('<li class="run-card').slice(1)[0]!;
    expect(card).toContain('<dt>Reported duration</dt><dd>40:00</dd>');
    expect(card).toContain('<dt>Distance</dt><dd>1.50 km</dd>');
    expect(card).toContain('<dt>Source</dt><dd>TCX import</dd>');
    expect(card).not.toMatch(/Elapsed time|GPX import|Entered manually|Observed duration/u);
    expect(card).toContain('>Delete</button>');
    expect(markup).toContain('<option value="tcx">TCX import</option>');
    expect(historySourceLabels.tcx).toBe('TCX import');
  });
});

describe('TCX on Today', () => {
  it('shows its own card with the reported duration, apart from GPX imports', () => {
    const overview = overviewFixture({
      tcxImportedActivities: { byType: [{ count: 1, reportedDurationS: 2_400, type: 'swim' }], count: 1, reportedDurationS: 2_400, source: 'tcx' },
    });
    const markup = renderToStaticMarkup(
      <TodayView
        dateInput="2026-11-05"
        onAction={noop}
        onChooseDate={noop}
        onRefresh={noop}
        snapshot={{ ...loadingOverview('2026-11-05'), load: { kind: 'ready', overview, refreshing: false } }}
        timeZone="Europe/Warsaw"
        today="2026-11-08"
      />,
    );
    expect(markup).toContain('<h2 id="today-tcx-title">Imported from TCX</h2>');
    expect(markup).toContain('1 activity imported from TCX started on this day, 40 min reported by their laps in total.');
    expect(markup).toMatch(/Reported duration is what each file’s laps report|Reported duration is what each file&#x27;s laps report/u);
    expect(markup).toContain('aria-label="Show in history: your TCX imports of');
    expect(markup).not.toContain('Imported from GPX');
  });

  it('shows no TCX card for a day without TCX imports', () => {
    const markup = renderToStaticMarkup(
      <TodayView
        dateInput="2026-11-05"
        onAction={noop}
        onChooseDate={noop}
        onRefresh={noop}
        snapshot={{ ...loadingOverview('2026-11-05'), load: { kind: 'ready', overview: overviewFixture(), refreshing: false } }}
        timeZone="Europe/Warsaw"
        today="2026-11-08"
      />,
    );
    expect(markup).not.toContain('today-tcx-title');
  });
});

describe('TCX in the weekly review', () => {
  it('shows a TCX part with the reported duration, and a week with only a TCX import is not empty', () => {
    const tcxImportedActivities = { byType: [{ count: 1, distanceM: 1_500, reportedDurationS: 2_400, type: 'swim' as const }], count: 1, distanceM: 1_500, reportedDurationS: 2_400, source: 'tcx' as const };
    const review = reviewFixture({ tcxImportedActivities });
    const markup = renderToStaticMarkup(
      <ReviewPanelView onRefresh={noop} onSelectWeek={noop} snapshot={{ ...loadingReview('2026-11-02'), load: { kind: 'ready', refreshing: false, review } }} weeks={recentWeeks('2026-11-11')} />,
    );
    expect(markup).toContain('<h3 id="review-tcx-imports-title">Imported from TCX</h3>');
    expect(markup).toContain('<dt>Reported duration</dt><dd>40:00</dd>');
    expect(markup).toContain('aria-label="TCX imports by type"');
    const empty = reviewFixture({
      coverage: { ...review.coverage, daysWithCheckInRecord: 0, gpsRuns: { count: 0, withCurrentDistance: 0, withoutCurrentDistance: 0 }, manualActivities: { count: 0, withDistance: 0 } },
    });
    expect(isEmptyWeek(empty)).toBe(true);
    expect(isEmptyWeek({ ...empty, tcxImportedActivities })).toBe(false);
  });
});

describe('TCX in activity trends', () => {
  it('is a source option with its own measure names and explanation', () => {
    expect(activityTrendSourceOptions.map((option) => option.source)).toEqual(['manual', 'gpx', 'tcx', 'recorded_run']);
    expect(activityTrendMeasureLabels('tcx')).toEqual({ count: 'Imports', distance: 'Distance', duration: 'Reported duration' });
    expect(activityTrendDurationExplanations.tcx).toMatch(/neither elapsed time nor moving time/u);
    expect(selectionLabel('tcx', 'swim')).toBe('TCX imports of type swim');
  });

  it('reads the reported duration of TCX days and summaries', () => {
    const trends = activityTrendsFixture({
      days: { '2026-11-10': { count: 2, distance: { totalM: 3_000, withValue: 2 }, duration: { totalS: 3_600, withValue: 2 } } },
      source: 'tcx',
      type: 'swim',
    });
    expect(trends.source).toBe('tcx');
    expect(displayDays(trends).find((day) => day.localDate === '2026-11-10')).toMatchObject({ count: 2, duration: { total: 3_600, withValue: 2 } });
    const lines = activitySummaryLines(trends).join(' ');
    expect(lines).toMatch(/^2 imports on 1 of 28 days/u);
    expect(lines).toMatch(/Reported duration: 1:00:00 in total, from all 2 imports\./u);
    expect(lines).not.toMatch(/Elapsed time|Entered duration|Observed duration/u);
  });
});
