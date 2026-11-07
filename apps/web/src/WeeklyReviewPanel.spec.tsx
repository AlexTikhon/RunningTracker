import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { insightView } from './weekly-insight-fixtures.js';
import { loadingInsight } from './weekly-insight-controller.js';
import { recentWeeks } from './weekly-insight.js';
import { InsightPanelView } from './WeeklyInsightPanel.js';
import { loadingReview, type ReviewSnapshot } from './weekly-review-controller.js';
import { reviewFixture } from './weekly-review-fixtures.js';
import { coverageRows, ReviewPanelView } from './WeeklyReviewPanel.js';

const WEEK = '2026-11-02';
const weeks = recentWeeks('2026-11-11');
const noop = () => undefined;

function render(snapshot: Partial<ReviewSnapshot>): string {
  return renderToStaticMarkup(
    <ReviewPanelView onRefresh={noop} onSelectWeek={noop} snapshot={{ ...loadingReview(WEEK), ...snapshot }} weeks={weeks} />,
  );
}

describe('weekly review section', () => {
  it('is labelled as computed by the app, not AI, in every state, and offers the week picker', () => {
    for (const html of [render({}), render({ load: { kind: 'ready', refreshing: false, review: reviewFixture() } })]) {
      expect(html).toContain('<h2 id="review-title">Weekly review</h2>');
      expect(html).toContain('Computed by the app');
      expect(html).toContain('No AI model writes this section.');
      expect(html).not.toContain('AI-generated');
      expect(html).toContain('This week: 9 Nov – 15 Nov 2026');
    }
  });

  it('renders loading, error with Retry, and access denied', () => {
    expect(render({})).toContain('Loading the review for 2 Nov – 8 Nov 2026…');
    expect(render({})).toContain('data-review-state="loading"');
    const error = render({ load: { kind: 'error', message: 'The review could not be loaded.' } });
    expect(error).toContain('role="alert"><span>The review could not be loaded.</span><button type="button">Retry</button>');
    const denied = render({ load: { kind: 'access-denied', message: 'You no longer have access to this organization.' } });
    expect(denied).toContain('You no longer have access');
    expect(denied).not.toContain('>Retry<');
  });

  it('renders the statements, coverage with denominators, numbers, gaps, zone and provenance', () => {
    const html = render({ load: { kind: 'ready', refreshing: false, review: reviewFixture() } });
    expect(html).toContain('data-statement="sleep_duration.coverage">Sleep duration was recorded on 3 of 4 days with check-in values.</li>');
    expect(html).toContain('data-statement="check_ins.note_only_days"');
    expect(html).toContain('<dt>Days with check-in values</dt><dd>4 of 7</dd>');
    expect(html).toContain('<dt>Sleep duration</dt><dd>3 of 4 days with values</dd>');
    expect(html).toContain('<dt>Days with only a note</dt><dd>1 (not counted as days with values)</dd>');
    expect(html).toContain('<dt>GPS runs</dt><dd>2 (1 with a current distance)</dd>');
    expect(html).toContain('data-fact="sleep.average_minutes">Average sleep: 403 min</li>');
    expect(html).toContain('data-gap="missing_check_in_days"');
    expect(html).toContain('Days are read in Europe/Warsaw, the time zone of your check-ins this week.');
    expect(html).toContain('Computed 2026-11-09 08:00 UTC from your current data; not stored.');
    expect(html).not.toMatch(/every check-in day/iu);
  });

  it('says when nothing is recorded and when the zone came from this device', () => {
    const empty = reviewFixture({
      coverage: {
        ...reviewFixture().coverage,
        daysWithCheckInRecord: 0,
        daysWithCheckInValues: 0,
        gpsRuns: { count: 0, withCurrentDistance: 0, withoutCurrentDistance: 0 },
        manualActivities: { count: 0, withDistance: 0 },
        metrics: { mood: { daysRecorded: 0 }, sleepDuration: { daysRecorded: 0 }, sleepQuality: { daysRecorded: 0 }, soreness: { daysRecorded: 0 }, weight: { daysRecorded: 0 } },
        noteOnlyDays: 0,
      },
      week: { ...reviewFixture().week, timeZone: 'America/New_York', timeZoneSource: 'request', zonesOnCheckIns: [] },
    });
    const html = render({ load: { kind: 'ready', refreshing: false, review: empty } });
    expect(html).toContain('Nothing is recorded for 2 Nov – 8 Nov 2026 yet.');
    expect(html).toContain('the time zone of this device (no check-in this week has one)');
    expect(html).not.toContain('<dt>Sleep duration</dt>');
  });

  it('keeps the shown review while refreshing and disables Refresh', () => {
    const html = render({ load: { kind: 'ready', refreshing: true, review: reviewFixture() } });
    expect(html).toContain('data-review-state="refreshing"');
    expect(html).toContain('<button disabled="" type="button">Updating…</button>');
    expect(html).toContain('data-statement="check_ins.coverage"');
  });

  it('lists manual distance coverage only when partial', () => {
    const rows = (manual: { count: number; withDistance: number }) =>
      coverageRows({ ...reviewFixture().coverage, manualActivities: manual }).find((row) => row.label === 'Manual activities')?.value;
    expect(rows({ count: 3, withDistance: 3 })).toBe('3');
    expect(rows({ count: 3, withDistance: 1 })).toBe('3 (distance entered for 1)');
    expect(rows({ count: 0, withDistance: 0 })).toBe('0');
  });

  it('renders independently of the AI section: an AI failure leaves the review intact', () => {
    const page = renderToStaticMarkup(
      <>
        <ReviewPanelView onRefresh={noop} onSelectWeek={noop} snapshot={{ load: { kind: 'ready', refreshing: false, review: reviewFixture() }, weekStart: WEEK }} weeks={weeks} />
        <InsightPanelView
          onCheckAgain={noop}
          onGenerate={noop}
          onRetryLoad={noop}
          snapshot={{ ...loadingInsight(WEEK), load: { kind: 'view', view: insightView({ failureReason: 'timeout', retryable: true, status: 'generation_failed' }) } }}
        />
      </>,
    );
    expect(page).toContain('data-statement="sleep_duration.coverage"');
    expect(page).toContain('did not answer in time');
    // The AI section shows no current review facts: its facts come only from its own stored output.
    const aiSection = page.slice(page.indexOf('id="insight-title"'));
    expect(aiSection).not.toContain('data-fact=');
    expect(aiSection).not.toContain('data-statement=');
  });
});
