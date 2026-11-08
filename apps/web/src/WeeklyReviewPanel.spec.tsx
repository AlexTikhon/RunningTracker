import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { insightView } from './weekly-insight-fixtures.js';
import { loadingInsight } from './weekly-insight-controller.js';
import { recentWeeks } from './weekly-insight.js';
import { InsightPanelView } from './WeeklyInsightPanel.js';
import { loadingReview, type ReviewSnapshot } from './weekly-review-controller.js';
import { movementFixture, reviewFixture } from './weekly-review-fixtures.js';
import { coverageRows, formatReviewDay, isEmptyWeek, movementTotalRows, ReviewPanelView } from './WeeklyReviewPanel.js';

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
    expect(aiSection).not.toContain('Steps and active energy');
  });
});

describe('weekly review section: movement (ADR-0079)', () => {
  // The required regression: Monday steps 0, Tuesday both values, Wednesday energy only (saved in another zone).
  const regression = movementFixture([
    { activeEnergyKcal: null, offset: 0, steps: 0 },
    { activeEnergyKcal: 412.5, offset: 1, steps: 8042 },
    { activeEnergyKcal: 250, offset: 2, steps: null, timeZone: 'America/New_York' },
  ]);
  const ready = (review = reviewFixture()) => render({ load: { kind: 'ready', refreshing: false, review } });

  it('shows recorded totals with their coverage, every day, missing values and the manual source', () => {
    const html = ready(reviewFixture({ movement: regression }));
    expect(html).toContain('<h3 id="review-movement-title">Steps and active energy</h3>');
    expect(html).toContain('aria-labelledby="review-movement-title"');
    expect(html).toContain('<dt>Days with movement</dt><dd>3 of 7</dd>');
    expect(html).toContain('<dt>Steps, recorded total</dt><dd>8,042 steps on 2 of 7 days</dd>');
    expect(html).toContain('<dt>Active energy, recorded total</dt><dd>662.5 kcal on 2 of 7 days</dd>');
    expect(html).toContain('<span class="review-badge">Manually entered</span>');
    expect(html).toContain('not added to activities or GPS runs. A day without a value is unknown, not zero.');
    const start = html.indexOf('aria-label="Movement by day"');
    const days = html.slice(start, html.indexOf('</ul>', start));
    expect(days.match(/<li /gu)).toHaveLength(7);
    expect(days).toContain('<time dateTime="2026-11-02">Mon 2 Nov</time><dl><div><dt>Steps</dt><dd>0 steps</dd></div><div><dt>Active energy</dt><dd>Not recorded</dd></div>');
    expect(days).toContain('<dd>8,042 steps</dd></div><div><dt>Active energy</dt><dd>412.5 kcal</dd>');
    expect(days).toContain('<dt>Steps</dt><dd>Not recorded</dd></div><div><dt>Active energy</dt><dd>250 kcal</dd>');
    expect(days.match(/<dd>Manually entered<\/dd>/gu)).toHaveLength(3);
    // The stored zone is named only where it differs from the zone the week is read in.
    expect(days.match(/<dt>Saved in<\/dt>/gu)).toHaveLength(1);
    expect(days).toContain('<dt>Saved in</dt><dd>America/New_York</dd>');
    expect(days.match(/<p>No movement recorded<\/p>/gu)).toHaveLength(4);
    expect(days).toContain('<time dateTime="2026-11-08">Sun 8 Nov</time><p>No movement recorded</p>');
  });

  it('says a metric was not recorded instead of showing 0, and shows a recorded zero total as 0', () => {
    expect(movementTotalRows(movementFixture([]))).toEqual([
      { label: 'Days with movement', value: '0 of 7' },
      { label: 'Steps, recorded total', value: 'Not recorded on any day' },
      { label: 'Active energy, recorded total', value: 'Not recorded on any day' },
    ]);
    expect(movementTotalRows(movementFixture([{ activeEnergyKcal: null, offset: 0, steps: 0 }, { activeEnergyKcal: null, offset: 3, steps: 0 }]))).toEqual([
      { label: 'Days with movement', value: '2 of 7' },
      { label: 'Steps, recorded total', value: '0 steps on 2 of 7 days' },
      { label: 'Active energy, recorded total', value: 'Not recorded on any day' },
    ]);
    expect(movementTotalRows(movementFixture([{ activeEnergyKcal: 0.1, offset: 0, steps: null }, { activeEnergyKcal: 0.2, offset: 1, steps: null }]))[2]).toEqual({
      label: 'Active energy, recorded total',
      value: '0.3 kcal on 2 of 7 days',
    });
  });

  it('treats a movement-only week, even one of recorded zeros, as not empty; an empty week still says so', () => {
    const emptyCoverage = {
      ...reviewFixture().coverage,
      daysWithCheckInRecord: 0,
      daysWithCheckInValues: 0,
      gpsRuns: { count: 0, withCurrentDistance: 0, withoutCurrentDistance: 0 },
      manualActivities: { count: 0, withDistance: 0 },
      metrics: { mood: { daysRecorded: 0 }, sleepDuration: { daysRecorded: 0 }, sleepQuality: { daysRecorded: 0 }, soreness: { daysRecorded: 0 }, weight: { daysRecorded: 0 } },
      noteOnlyDays: 0,
    };
    const nothing = reviewFixture({ coverage: emptyCoverage });
    const zeroOnly = reviewFixture({ coverage: emptyCoverage, movement: movementFixture([{ activeEnergyKcal: null, offset: 4, steps: 0 }]) });
    expect(isEmptyWeek(nothing)).toBe(true);
    expect(isEmptyWeek(zeroOnly)).toBe(false);
    expect(ready(nothing)).toContain('Nothing is recorded for 2 Nov – 8 Nov 2026 yet.');
    const html = ready(zeroOnly);
    expect(html).not.toContain('Nothing is recorded');
    expect(html).toContain('<dt>Steps, recorded total</dt><dd>0 steps on 1 of 7 days</dd>');
  });

  it('keeps the movement of the shown review while refreshing, and shows none while loading or after an error', () => {
    const review = reviewFixture({ movement: regression });
    expect(render({ load: { kind: 'ready', refreshing: true, review } })).toContain('8,042 steps on 2 of 7 days');
    expect(render({})).not.toContain('Steps and active energy');
    expect(render({ load: { kind: 'error', message: 'The review could not be loaded.' } })).not.toContain('Steps and active energy');
  });

  it('formats a calendar date without shifting it by a zone', () => {
    expect(['2026-11-02', '2026-03-29', '2026-10-25'].map(formatReviewDay)).toEqual(['Mon 2 Nov', 'Sun 29 Mar', 'Sun 25 Oct']);
  });
});
