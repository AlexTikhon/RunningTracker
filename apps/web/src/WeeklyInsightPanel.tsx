import type { WeeklyInsightOutput, WeeklyInsightView } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { readWeeklyInsight, requestWeeklyInsight, type CsrfCredentials } from './runner-api.js';
import {
  canGenerate,
  loadingInsight,
  WeeklyInsightController,
  type InsightPanelSnapshot,
} from './weekly-insight-controller.js';
import { formatWeek, recentWeeks, statusSentence } from './weekly-insight.js';

// The weekly Insights panel of the Check-in tab (ADR-0076). Numbers are computed by the server and rendered by code;
// a local AI model writes the prose around them, and that prose is labelled as such. Descriptive and non-medical.

export interface InsightContentProps {
  output: WeeklyInsightOutput;
}

/** A ready insight: AI prose, code-rendered facts, the suggestion with its source, and the data gaps. */
export function InsightContent({ output }: InsightContentProps) {
  return (
    <div className="insight-content">
      <p className="insight-content__ai-label">
        <span className="insight-badge">AI-generated text</span> Written by a local AI model from the numbers below.
        The numbers themselves are computed by the app, not by the model.
      </p>
      <p className="insight-content__summary">{output.summary}</p>
      {output.observations.length > 0 && (
        <ul aria-label="Observations" className="insight-observations">
          {output.observations.map((observation, index) => (
            <li key={index}>
              <p>{observation.text}</p>
              <ul aria-label="Facts from your data" className="insight-facts">
                {observation.facts.map((fact) => (
                  <li data-fact={fact.id} key={fact.id}>{fact.text}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <section aria-label="Suggestion" className="insight-suggestion">
        <h3>Suggestion</h3>
        <p>{output.suggestion.text}</p>
        <p className="insight-suggestion__source">
          {output.suggestion.source === 'approved'
            ? 'A standard suggestion chosen by the app for this week, not written by the model.'
            : 'Written by the AI model.'}
        </p>
      </section>
      {output.dataGaps.length > 0 && (
        <section aria-label="Data gaps and limitations" className="insight-gaps">
          <h3>Data gaps and limitations</h3>
          <ul>
            {output.dataGaps.map((gap) => (
              <li data-gap={gap.code} key={gap.code}>{gap.text}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function freshnessNotice(view: WeeklyInsightView): string | null {
  if (view.freshness === 'stale') {
    return 'Out of date: your data for this week changed after this insight was generated. It is shown as it was; regenerate to update it.';
  }
  if (view.freshness === 'outdated_policy') {
    return 'This insight was checked under older rules and is hidden. Regenerate to get one checked under the current rules.';
  }
  return null;
}

export interface InsightPanelViewProps {
  onCheckAgain: () => void;
  onGenerate: () => void;
  onRetryLoad: () => void;
  onSelectWeek: (weekStart: string) => void;
  snapshot: InsightPanelSnapshot;
  weeks: readonly { label: string; weekStart: string }[];
}

/** Everything the panel shows, from one snapshot. Pure, so every state is testable without a DOM. */
export function InsightPanelView({ onCheckAgain, onGenerate, onRetryLoad, onSelectWeek, snapshot, weeks }: InsightPanelViewProps) {
  const { load } = snapshot;
  const view = load.kind === 'view' ? load.view : null;
  const active = view !== null && (view.status === 'queued' || view.status === 'running');
  const offer = canGenerate(snapshot);
  const buttonLabel = load.kind === 'none' ? 'Generate insight' : 'Regenerate';
  const notice = view === null ? null : freshnessNotice(view);

  return (
    <section aria-labelledby="insight-title" className="insight-panel search-results">
      <div className="insight-panel__heading">
        <h2 id="insight-title">Weekly insight</h2>
        <p className="insight-panel__positioning">
          A short description of your week from your own check-ins, activities and GPS runs. It is not medical advice and
          it does not diagnose anything. Notes are never used. Only you can see it.
        </p>
      </div>
      <div className="insight-panel__controls">
        <label>
          Week
          <select
            disabled={snapshot.request === 'pending'}
            onChange={(event) => onSelectWeek(event.target.value)}
            value={snapshot.weekStart}
          >
            {weeks.map((week) => (
              <option key={week.weekStart} value={week.weekStart}>{week.label}</option>
            ))}
          </select>
        </label>
        {!snapshot.generationDisabled && (
          <button className="finish-action" disabled={!offer} onClick={onGenerate} type="button">
            {snapshot.request === 'pending' ? 'Asking…' : buttonLabel}
          </button>
        )}
      </div>
      {snapshot.generationDisabled && (
        <p className="insight-panel__disabled" role="status">Insight generation is turned off on this server. Stored insights are still shown.</p>
      )}
      {snapshot.request === 'failed' && snapshot.requestMessage !== null && (
        <p className="run-share__failure" role="alert">{snapshot.requestMessage}</p>
      )}

      <div aria-live="polite" className="insight-panel__body" data-insight-state={view?.status ?? load.kind}>
        {load.kind === 'loading' && <p className="search-results__loading">Loading the insight for {formatWeek(snapshot.weekStart)}…</p>}
        {(load.kind === 'error' || load.kind === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{load.message}</span>
            {load.kind === 'error' && <button onClick={onRetryLoad} type="button">Retry</button>}
          </div>
        )}
        {load.kind === 'none' && (
          <p className="insight-panel__empty">
            No insight for {formatWeek(snapshot.weekStart)}. It may never have been generated, or it was removed because
            one of the week&apos;s records was deleted or changed.
          </p>
        )}
        {view !== null && (
          <>
            {view.status !== 'ready' && (
              <p className={active ? 'insight-panel__progress' : 'insight-panel__problem'} role="status">
                {statusSentence(view)}
                {!active && view.retryable && ' You can try again.'}
                {!active && !view.retryable && view.freshness === 'current' &&
                  ' It is kept as it is until the week\'s data changes.'}
              </p>
            )}
            {active && snapshot.pollingExhausted && (
              <p className="insight-panel__progress">
                Still working after several minutes.{' '}
                <button onClick={onCheckAgain} type="button">Check again</button>
              </p>
            )}
            {notice !== null && <p className="insight-panel__stale" role="status">{notice}</p>}
            {view.output !== null && <InsightContent output={view.output} />}
            <p className="insight-panel__meta">
              Model {view.model} · generated {new Date(view.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · attempt{' '}
              {view.attempts}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export interface WeeklyInsightPanelProps {
  csrf: CsrfCredentials;
  orgId: string;
  /** Changes whenever a check-in of this person was saved or deleted: the panel reads its week again. */
  refreshKey: number;
  signal: AbortSignal;
  timeZone: string;
  today: string;
}

export function WeeklyInsightPanel({ csrf, orgId, refreshKey, signal, timeZone, today }: WeeklyInsightPanelProps) {
  const weeks = useMemo(() => recentWeeks(today), [today]);
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const controller = useRef<WeeklyInsightController | null>(null);
  const [snapshot, setSnapshot] = useState<InsightPanelSnapshot>(() => loadingInsight(weeks[0]!.weekStart));

  useEffect(() => {
    const next = new WeeklyInsightController({
      csrf: () => csrfRef.current,
      onChange: setSnapshot,
      orgId,
      read: readWeeklyInsight,
      request: requestWeeklyInsight,
      signal,
      timeZone,
      weekStart: weeks[0]!.weekStart,
    });
    controller.current = next;
    next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal, timeZone, weeks]);

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    controller.current?.refresh();
  }, [refreshKey]);

  return (
    <InsightPanelView
      onCheckAgain={() => controller.current?.refresh()}
      onGenerate={() => controller.current?.generate()}
      onRetryLoad={() => controller.current?.refresh()}
      onSelectWeek={(weekStart) => controller.current?.select(weekStart)}
      snapshot={snapshot}
      weeks={weeks}
    />
  );
}
