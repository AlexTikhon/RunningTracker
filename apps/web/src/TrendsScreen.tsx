import { DAILY_METRICS_LOCAL_DATE_MIN, DAILY_TRENDS_RANGE_DAYS, dailyTrendsRangeOf, isEmptyDailyTrends, type DailyTrends, type DailyTrendsMetric } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { checkInDateProblem, localDateIn } from './daily-checkin.js';
import {
  chartDescription,
  chartGeometry,
  computedLine,
  coverageLine,
  missingExplanation,
  rangeLabel,
  summaryLines,
  tableRows,
  trendMetricOptions,
  trendMetricSpecs,
  type TrendChartGeometry,
} from './daily-trends.js';
import { DailyTrendsController, loadingTrends, type TrendsReader, type TrendsSnapshot } from './daily-trends-controller.js';
import { readDailyTrends } from './runner-api.js';

// The Trends screen (ADR-0084): 28 calendar dates of four of the person's own daily series, recomputed by the server on
// every read. It shows what was recorded and how much of the range that covers, and nothing else: no target, judgement,
// prediction, correlation or advice. A date without a value is a gap in the chart and "Not recorded" in the table.

/** A simple line chart of one series: a point per recorded date, a line only between consecutive recorded dates. */
export function TrendChart({ description, geometry }: { description: string; geometry: TrendChartGeometry }) {
  const { missing, plot, points, segments, xLabels, yTicks } = geometry;
  return (
    <figure className="trends-chart">
      <svg aria-label={description} role="img" viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
        <line className="trends-chart__grid" x1={plot.left} x2={plot.right} y1={plot.top} y2={plot.top} />
        <line className="trends-chart__axis" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
        {yTicks.map((tick) => (
          <text className="trends-chart__tick" dominantBaseline="middle" key={`${tick.y}`} textAnchor="end" x={plot.left - 8} y={tick.y}>
            {tick.label}
          </text>
        ))}
        {xLabels.map((label) => (
          <text className="trends-chart__tick" key={label.text + label.anchor} textAnchor={label.anchor} x={label.x} y={geometry.height - 6}>
            {label.text}
          </text>
        ))}
        {missing.map((gap) => (
          <line className="trends-chart__gap" data-missing-date={gap.localDate} key={gap.localDate} x1={gap.x} x2={gap.x} y1={plot.bottom + 5} y2={plot.bottom + 11} />
        ))}
        {segments
          .filter((segment) => segment.length > 1)
          .map((segment) => (
            <polyline
              className="trends-chart__line"
              data-segment={`${segment[0]!.localDate}..${segment.at(-1)!.localDate}`}
              fill="none"
              key={segment[0]!.localDate}
              points={segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}
            />
          ))}
        {points.map((point) => (
          <circle className="trends-chart__point" cx={point.x.toFixed(1)} cy={point.y.toFixed(1)} data-date={point.localDate} key={point.localDate} r={5}>
            <title>{point.label}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="trends-chart__key">
        Each dot is a recorded value. A line joins only dates next to each other that both have a value; a short mark under the
        axis is a date with no value.
      </figcaption>
    </figure>
  );
}

/** A loaded range for one metric: coverage, summary, chart and the table of every date. */
export function TrendsContent({
  metric,
  onOpenDay,
  timeZone,
  trends,
}: {
  metric: DailyTrendsMetric;
  onOpenDay: (localDate: string) => void;
  timeZone: string;
  trends: DailyTrends;
}) {
  const spec = trendMetricSpecs[metric];
  const rows = tableRows(trends, metric);
  const geometry = chartGeometry(trends, metric);
  const manual = metric === 'steps' || metric === 'foodEnergyKcal';
  return (
    <div className="trends-content">
      {isEmptyDailyTrends(trends) && <p className="today-empty">Nothing is recorded for these dates yet.</p>}
      {trends.range.includesToday && <p className="today-note">The range ends today; Refresh shows what was added since.</p>}

      <section aria-labelledby="trends-series-title" className="today-card trends-card">
        <h2 id="trends-series-title">{spec.title}</h2>
        <p>
          {manual && <span className="review-badge">Manually entered</span>} {spec.source}
        </p>
        <p className="trends-coverage">{coverageLine(trends, metric)}</p>
        <ul className="trends-summary">
          {summaryLines(trends, metric).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {geometry.points.length > 0 ? (
          <TrendChart description={chartDescription(trends, metric)} geometry={geometry} />
        ) : (
          <p className="today-missing">No value to draw for this series in this range.</p>
        )}
        <p className="today-note">{missingExplanation(metric)}</p>
      </section>

      <section aria-labelledby="trends-table-title" className="today-card trends-card">
        <h2 id="trends-table-title">Every date</h2>
        <p className="today-note">Newest first. Open a date to see everything recorded for it on Today.</p>
        <table className="trends-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">{spec.label}</th>
              <th scope="col"><span className="visually-hidden">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className={row.recorded ? undefined : 'trends-table__missing'} data-date={row.localDate} key={row.localDate}>
                <th scope="row">{row.dateLabel}</th>
                <td>
                  <span className="trends-table__value">{row.value}</span>
                  {row.detail !== null && <span className="trends-table__detail">{row.detail}</span>}
                </td>
                <td>
                  <button aria-label={`Open Today on ${row.dateLabel}`} onClick={() => onOpenDay(row.localDate)} type="button">
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="today-meta">{computedLine(trends, timeZone)}</p>
    </div>
  );
}

export interface TrendsViewProps {
  endInput: string;
  metric: DailyTrendsMetric;
  onChooseEnd: (value: string) => void;
  onChooseMetric: (metric: DailyTrendsMetric) => void;
  onOpenDay: (localDate: string) => void;
  onRefresh: () => void;
  snapshot: TrendsSnapshot;
  timeZone: string;
  today: string;
}

/** Everything the screen shows, from one snapshot. Pure, so every state is testable without a DOM. */
export function TrendsView({ endInput, metric, onChooseEnd, onChooseMetric, onOpenDay, onRefresh, snapshot, timeZone, today }: TrendsViewProps) {
  const { load } = snapshot;
  const busy = load.kind === 'loading' || (load.kind === 'ready' && load.refreshing);
  const state = load.kind === 'ready' && load.refreshing ? 'refreshing' : load.kind;
  const dateProblem = checkInDateProblem(endInput, today);
  // The range is calendar arithmetic, the same function the server uses, so it can be named before the answer arrives.
  const range = load.kind === 'ready' ? load.trends.range : { ...dailyTrendsRangeOf(snapshot.endDate), requestedDays: DAILY_TRENDS_RANGE_DAYS };
  return (
    <section aria-labelledby="trends-title" className="activity-shell today-shell trends-shell">
      <div className="search-panel__heading">
        <p className="eyebrow">28-day view</p>
        <h1 id="trends-title" tabIndex={-1}>Trends</h1>
        <p>
          Your recorded weight, sleep duration, steps and food energy for the 28 calendar dates ending on the date you choose,
          read again each time you open this view or press Refresh. It shows what was recorded and how much of the range that
          covers; it sets no targets, makes no predictions and gives no advice. Only you can see it.
        </p>
      </div>

      <div className="today-controls">
        <label>
          End date
          <input max={today} min={DAILY_METRICS_LOCAL_DATE_MIN} onChange={(event) => onChooseEnd(event.target.value)} type="date" value={endInput} />
        </label>
        <button disabled={snapshot.endDate === today && dateProblem === null} onClick={() => onChooseEnd(today)} type="button">
          End today
        </button>
        <button disabled={busy} onClick={onRefresh} type="button">{busy ? 'Updating…' : 'Refresh'}</button>
      </div>
      {dateProblem !== null && <p className="activity-form__failure" role="alert">{dateProblem}</p>}

      <fieldset className="trends-metrics">
        <legend>Series</legend>
        {trendMetricOptions.map((option) => (
          <label key={option.metric}>
            <input checked={option.metric === metric} name="trends-metric" onChange={() => onChooseMetric(option.metric)} type="radio" value={option.metric} />
            {option.label}
          </label>
        ))}
      </fieldset>

      <p className="today-day">
        Range: <strong>{rangeLabel(range)}</strong>{snapshot.endDate === today ? ', ending today' : ''}. Every record counts on the
        calendar date it was saved for; the time zone {timeZone} only decides which date is today.
      </p>

      <div aria-busy={busy} aria-live="polite" className="today-body" data-trends-state={state}>
        {load.kind === 'loading' && <p className="search-results__loading">Loading these dates…</p>}
        {(load.kind === 'error' || load.kind === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{load.message}</span>
            {load.kind === 'error' && <button onClick={onRefresh} type="button">Retry</button>}
          </div>
        )}
        {load.kind === 'ready' && <TrendsContent metric={metric} onOpenDay={onOpenDay} timeZone={timeZone} trends={load.trends} />}
      </div>
    </section>
  );
}

export interface TrendsScreenProps {
  /** The series to show first (kept by the parent). */
  initialMetric: DailyTrendsMetric;
  /** Called with every series the person selects, so the parent can keep it during ordinary navigation. */
  onChooseMetric: (metric: DailyTrendsMetric) => void;
  /** Opens Today on a date of the range. */
  onOpenDay: (localDate: string) => void;
  /** Called with every valid end date the person selects, so the parent can keep the range. */
  onSelectEndDate: (endDate: string) => void;
  orgId: string;
  /** The end date to open with (kept by the parent); null or a date after today opens the range ending today. */
  selectedEndDate: string | null;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
  timeZone: string;
  // For tests: the instant whose date in `timeZone` is "today". Defaults to the time the screen opens.
  nowMs?: number;
  read?: TrendsReader;
}

// The parent keys this screen by session, person and organization and mounts it only while Trends is open, so each
// opening reads the range again (after an edit or a deletion elsewhere too) and no answer crosses a change of scope.
export function TrendsScreen({
  initialMetric,
  nowMs,
  onChooseMetric,
  onOpenDay,
  onSelectEndDate,
  orgId,
  read = readDailyTrends,
  selectedEndDate,
  signal,
  timeZone,
}: TrendsScreenProps) {
  const today = useMemo(() => localDateIn(timeZone, nowMs ?? Date.now()), [nowMs, timeZone]);
  const initialEnd = selectedEndDate !== null && checkInDateProblem(selectedEndDate, today) === null ? selectedEndDate : today;
  const initialRef = useRef(initialEnd);
  const readRef = useRef(read);
  const [endInput, setEndInput] = useState(initialEnd);
  const [metric, setMetric] = useState<DailyTrendsMetric>(initialMetric);
  const [snapshot, setSnapshot] = useState<TrendsSnapshot>(() => loadingTrends(initialEnd));
  const controller = useRef<DailyTrendsController | null>(null);

  useEffect(() => {
    const next = new DailyTrendsController({ endDate: initialRef.current, onChange: setSnapshot, orgId, read: readRef.current, signal, timeZone });
    controller.current = next;
    setSnapshot(next.snapshot);
    next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal, timeZone]);

  const chooseEnd = (value: string) => {
    setEndInput(value);
    if (checkInDateProblem(value, today) !== null) return;
    onSelectEndDate(value);
    controller.current?.select(value);
  };

  const chooseMetric = (next: DailyTrendsMetric) => {
    setMetric(next);
    onChooseMetric(next);
  };

  return (
    <TrendsView
      endInput={endInput}
      metric={metric}
      onChooseEnd={chooseEnd}
      onChooseMetric={chooseMetric}
      onOpenDay={onOpenDay}
      onRefresh={() => controller.current?.refresh()}
      snapshot={snapshot}
      timeZone={timeZone}
      today={today}
    />
  );
}
