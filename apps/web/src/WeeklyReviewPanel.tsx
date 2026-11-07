import type { WeeklyReview, WeeklyReviewCoverage } from '@running-tracker/contracts';
import { useEffect, useRef, useState } from 'react';

import { readWeeklyReview } from './runner-api.js';
import { loadingReview, WeeklyReviewController, type ReviewSnapshot } from './weekly-review-controller.js';
import { formatWeek } from './weekly-insight.js';

// The Weekly review section of the Check-in tab: the primary, deterministic description of a week. Every sentence and
// number is computed by the app from the person's own records on each read; no AI model is involved. The optional AI
// insight is a separate section below it with its own lifecycle, so its failures never hide this one.

/** Coverage rows with their denominators spelled out. */
export function coverageRows(coverage: WeeklyReviewCoverage): { label: string; value: string }[] {
  const withValues = coverage.daysWithCheckInValues;
  const rows = [{ label: 'Days with check-in values', value: `${withValues} of ${coverage.daysInWeek}` }];
  if (coverage.noteOnlyDays > 0) {
    rows.push({ label: 'Days with only a note', value: `${coverage.noteOnlyDays} (not counted as days with values)` });
  }
  if (withValues > 0) {
    const ofValues = (days: number) => `${days} of ${withValues} ${withValues === 1 ? 'day' : 'days'} with values`;
    const { metrics } = coverage;
    rows.push(
      { label: 'Sleep duration', value: ofValues(metrics.sleepDuration.daysRecorded) },
      { label: 'Sleep quality', value: ofValues(metrics.sleepQuality.daysRecorded) },
      { label: 'Mood', value: ofValues(metrics.mood.daysRecorded) },
      { label: 'Soreness', value: ofValues(metrics.soreness.daysRecorded) },
      { label: 'Weight', value: ofValues(metrics.weight.daysRecorded) },
    );
  }
  const manual = coverage.manualActivities;
  rows.push({
    label: 'Manual activities',
    value: manual.count > 0 && manual.withDistance < manual.count ? `${manual.count} (distance entered for ${manual.withDistance})` : String(manual.count),
  });
  const gps = coverage.gpsRuns;
  rows.push({
    label: 'GPS runs',
    value: gps.withoutCurrentDistance > 0 ? `${gps.count} (${gps.withCurrentDistance} with a current distance)` : String(gps.count),
  });
  return rows;
}

function zoneLine(review: WeeklyReview): string {
  const { week } = review;
  return week.timeZoneSource === 'check_ins'
    ? `Days are read in ${week.timeZone}, the time zone of your check-ins this week.`
    : `Days are read in ${week.timeZone}, the time zone of this device (no check-in this week has one).`;
}

const isEmptyWeek = (review: WeeklyReview) =>
  review.coverage.daysWithCheckInRecord === 0 && review.coverage.manualActivities.count === 0 && review.coverage.gpsRuns.count === 0;

/** A computed review: statements, coverage, numbers, data gaps and where it comes from. */
export function ReviewContent({ review }: { review: WeeklyReview }) {
  return (
    <div className="review-content">
      {isEmptyWeek(review) && <p className="review-panel__empty">Nothing is recorded for {formatWeek(review.week.start)} yet.</p>}
      <ul aria-label="What your records show" className="review-statements">
        {review.statements.map((statement) => (
          <li data-statement={statement.code} key={statement.code}>{statement.text}</li>
        ))}
      </ul>
      <section aria-label="Coverage" className="review-coverage">
        <h3>Coverage</h3>
        <dl>
          {coverageRows(review.coverage).map((row) => (
            <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
          ))}
        </dl>
      </section>
      {review.facts.length > 0 && (
        <section aria-label="Numbers" className="review-numbers">
          <h3>Numbers</h3>
          <ul aria-label="Numbers from your data" className="insight-facts">
            {review.facts.map((fact) => (
              <li data-fact={fact.id} key={fact.id}>{fact.text}</li>
            ))}
          </ul>
        </section>
      )}
      {review.dataGaps.length > 0 && (
        <section aria-label="Data gaps and limitations" className="insight-gaps">
          <h3>Data gaps and limitations</h3>
          <ul>
            {review.dataGaps.map((gap) => (
              <li data-gap={gap.code} key={gap.code}>{gap.text}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="review-panel__meta">
        {zoneLine(review)} Computed {review.provenance.computedAt.slice(0, 16).replace('T', ' ')} UTC from your current data; not
        stored.
      </p>
    </div>
  );
}

export interface ReviewPanelViewProps {
  onRefresh: () => void;
  onSelectWeek: (weekStart: string) => void;
  snapshot: ReviewSnapshot;
  weeks: readonly { label: string; weekStart: string }[];
}

/** Everything the section shows, from one snapshot. Pure, so every state is testable without a DOM. */
export function ReviewPanelView({ onRefresh, onSelectWeek, snapshot, weeks }: ReviewPanelViewProps) {
  const { load } = snapshot;
  const busy = load.kind === 'loading' || (load.kind === 'ready' && load.refreshing);
  const state = load.kind === 'ready' && load.refreshing ? 'refreshing' : load.kind;
  return (
    <section aria-labelledby="review-title" className="review-panel search-results">
      <div className="insight-panel__heading">
        <h2 id="review-title">Weekly review</h2>
        <p className="insight-panel__positioning">
          <span className="review-badge">Computed by the app</span> Counted from your own check-ins, manual activities and GPS
          runs each time you open it. No AI model writes this section. It describes what was recorded; it is not medical
          advice. Only you can see it.
        </p>
      </div>
      <div className="insight-panel__controls">
        <label>
          Week
          <select onChange={(event) => onSelectWeek(event.target.value)} value={snapshot.weekStart}>
            {weeks.map((week) => (
              <option key={week.weekStart} value={week.weekStart}>{week.label}</option>
            ))}
          </select>
        </label>
        <button disabled={busy} onClick={onRefresh} type="button">{busy ? 'Updating…' : 'Refresh'}</button>
      </div>
      <div aria-busy={busy} aria-live="polite" className="insight-panel__body" data-review-state={state}>
        {load.kind === 'loading' && <p className="search-results__loading">Loading the review for {formatWeek(snapshot.weekStart)}…</p>}
        {(load.kind === 'error' || load.kind === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{load.message}</span>
            {load.kind === 'error' && <button onClick={onRefresh} type="button">Retry</button>}
          </div>
        )}
        {load.kind === 'ready' && <ReviewContent review={load.review} />}
      </div>
    </section>
  );
}

export interface WeeklyReviewPanelProps {
  onSelectWeek: (weekStart: string) => void;
  orgId: string;
  /** Changes whenever a check-in of this person was saved or deleted: the section reads its week again. */
  refreshKey: number;
  signal: AbortSignal;
  timeZone: string;
  weekStart: string;
  weeks: readonly { label: string; weekStart: string }[];
}

export function WeeklyReviewPanel({ onSelectWeek, orgId, refreshKey, signal, timeZone, weekStart, weeks }: WeeklyReviewPanelProps) {
  const controller = useRef<WeeklyReviewController | null>(null);
  const weekRef = useRef(weekStart);
  weekRef.current = weekStart;
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>(() => loadingReview(weekStart));

  useEffect(() => {
    const next = new WeeklyReviewController({ onChange: setSnapshot, orgId, read: readWeeklyReview, signal, timeZone, weekStart: weekRef.current });
    controller.current = next;
    setSnapshot(next.snapshot);
    next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal, timeZone]);

  useEffect(() => {
    controller.current?.select(weekStart);
  }, [weekStart]);

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    controller.current?.refresh();
  }, [refreshKey]);

  return <ReviewPanelView onRefresh={() => controller.current?.refresh()} onSelectWeek={onSelectWeek} snapshot={snapshot} weeks={weeks} />;
}
