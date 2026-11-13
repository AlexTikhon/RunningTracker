import type { ActivityHistorySource, ActivityTrends, ActivityType } from '@running-tracker/contracts';

import { activityTypeLabels } from './activity-form.js';
import {
  ACTIVITY_TREND_MEASURES,
  activityChartDescription,
  activityComparisonView,
  activityChartGeometry,
  activityComputedLine,
  activitySummaryLines,
  activityTableRows,
  activityTrendDurationExplanations,
  activityTrendDurationLabels,
  activityTrendMeasureLabels,
  activityTrendSourceOptions,
  activityTrendTypesFor,
  dayLengthNotes,
  type ActivityChartGeometry,
  type ActivityTrendMeasure,
} from './activity-trends.js';
import type { ActivityTrendsSnapshot } from './activity-trends-controller.js';

// The Activity section of Trends (ADR-0089): one source and one activity type over the same 28 local dates as the
// health series, each item on the date it started in the viewer's zone. Pure: every state renders from one snapshot.

/** One bar per date with a value; a dot on the baseline for a recorded 0; an open marker for an unknown value. */
export function ActivityTrendChart({ description, geometry }: { description: string; geometry: ActivityChartGeometry }) {
  const { marks, plot, xLabels, yTicks } = geometry;
  return (
    <figure className="activity-chart">
      <svg aria-label={description} role="img" viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
        <line className="trends-chart__grid" x1={plot.left} x2={plot.right} y1={plot.top} y2={plot.top} />
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
        {marks.map((mark) => {
          switch (mark.kind) {
            case 'bar':
              return (
                <path className="activity-chart__bar" d={mark.path} data-bar-date={mark.localDate} key={mark.localDate}>
                  <title>{mark.label}</title>
                </path>
              );
            case 'zero':
              return (
                <circle className="activity-chart__zero" cx={mark.x.toFixed(1)} cy={plot.bottom} data-zero-date={mark.localDate} key={mark.localDate} r={4}>
                  <title>{mark.label}</title>
                </circle>
              );
            case 'unknown':
              return (
                <circle className="activity-chart__unknown" cx={mark.x.toFixed(1)} cy={plot.bottom - 12} data-unknown-date={mark.localDate} key={mark.localDate} r={4}>
                  <title>{mark.label}</title>
                </circle>
              );
            case 'none':
              return (
                <line className="trends-chart__gap" data-none-date={mark.localDate} key={mark.localDate} x1={mark.x} x2={mark.x} y1={plot.bottom + 5} y2={plot.bottom + 11}>
                  <title>{mark.label}</title>
                </line>
              );
          }
        })}
        <line className="trends-chart__axis" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
      </svg>
      <figcaption className="trends-chart__key">
        A bar is a date&apos;s recorded total. A dot on the axis is a recorded 0. An open circle is a date with items whose value is
        unknown. A short mark under the axis is a date with nothing logged.
      </figcaption>
    </figure>
  );
}

/**
 * The comparison with the previous 28 dates (ADR-0090): both periods, each measure's server-computed values with their
 * coverage, and a signed change with its percentage, or "Not compared" with the reasons. Nothing here computes a number.
 */
export function ActivityTrendsComparison({ trends }: { trends: ActivityTrends }) {
  const view = activityComparisonView(trends);
  if (view === null) return null;
  return (
    <section aria-labelledby="activity-comparison-title" className="activity-comparison" data-activity-comparison="">
      <h3 id="activity-comparison-title">Compared with the previous 28 days</h3>
      <dl className="activity-comparison__periods">
        <div>
          <dt>This period</dt>
          <dd>{view.periods.current}</dd>
        </div>
        <div>
          <dt>Previous period</dt>
          <dd>{view.periods.previous}</dd>
        </div>
      </dl>
      {view.notes.map((note) => (
        <p className="today-note" key={note}>{note}</p>
      ))}
      <table className="trends-table activity-comparison-table">
        <caption className="visually-hidden">Each measure in this period and the previous one, and the change between them</caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">This period</th>
            <th scope="col">Previous</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr data-comparison-measure={row.measure} key={row.measure}>
              <th scope="row">{row.label}</th>
              <td>
                <span className="trends-table__value">{row.current.value}</span>
                {row.current.detail !== null && <span className="trends-table__detail">{row.current.detail}</span>}
              </td>
              <td>
                <span className="trends-table__value">{row.previous.value}</span>
                {row.previous.detail !== null && <span className="trends-table__detail">{row.previous.detail}</span>}
              </td>
              <td data-change-status={row.change.status}>
                <span className="trends-table__value">{row.change.value}</span>
                {row.change.detail !== null && <span className="trends-table__detail">{row.change.detail}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ActivityTrendsContent({ measure, trends }: { measure: ActivityTrendMeasure; trends: ActivityTrends }) {
  const source = trends.source;
  const labels = activityTrendMeasureLabels(source);
  const geometry = activityChartGeometry(trends, measure);
  const drawable = geometry.marks.some((mark) => mark.kind === 'bar' || mark.kind === 'zero');
  return (
    <div className="activity-trends-content">
      <ul className="trends-summary activity-trends__summary">
        {activitySummaryLines(trends).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="today-note">{activityTrendDurationExplanations[source]}</p>
      {dayLengthNotes(trends).map((note) => (
        <p className="today-note" key={note}>{note}</p>
      ))}
      <ActivityTrendsComparison trends={trends} />
      {drawable ? (
        <ActivityTrendChart description={activityChartDescription(trends, measure)} geometry={geometry} />
      ) : (
        <p className="today-missing">No {labels[measure].toLowerCase()} value to draw in this range.</p>
      )}
      <table className="trends-table activity-trends-table">
        <caption className="visually-hidden">Every date of the range, newest first, for the selected source and type</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">{labels.count}</th>
            <th scope="col">{activityTrendDurationLabels[source]}</th>
            <th scope="col">Distance</th>
          </tr>
        </thead>
        <tbody>
          {activityTableRows(trends).map((row) => (
            <tr className={row.logged ? undefined : 'trends-table__missing'} data-activity-date={row.localDate} key={row.localDate}>
              <th scope="row">{row.dateLabel}</th>
              <td>
                <span className="trends-table__value">{row.count}</span>
                {row.summaryDetail !== null && <span className="trends-table__detail">{row.summaryDetail}</span>}
              </td>
              <td>
                <span className="trends-table__value">{row.duration}</span>
                {row.durationDetail !== null && <span className="trends-table__detail">{row.durationDetail}</span>}
              </td>
              <td>
                <span className="trends-table__value">{row.distance}</span>
                {row.distanceDetail !== null && <span className="trends-table__detail">{row.distanceDetail}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="today-meta">{activityComputedLine(trends)}</p>
    </div>
  );
}

export interface ActivityTrendsViewProps {
  measure: ActivityTrendMeasure;
  onChooseMeasure: (measure: ActivityTrendMeasure) => void;
  onChooseSource: (source: ActivityHistorySource) => void;
  onChooseType: (type: ActivityType) => void;
  onRetry: () => void;
  snapshot: ActivityTrendsSnapshot;
  timeZone: string;
}

export function ActivityTrendsView({ measure, onChooseMeasure, onChooseSource, onChooseType, onRetry, snapshot, timeZone }: ActivityTrendsViewProps) {
  const { filters, load } = snapshot;
  const busy = load.kind === 'loading' || (load.kind === 'ready' && load.refreshing);
  const state = load.kind === 'ready' && load.refreshing ? 'refreshing' : load.kind;
  const labels = activityTrendMeasureLabels(filters.source);
  const types = activityTrendTypesFor(filters.source);
  return (
    <section aria-labelledby="activity-trends-title" className="today-card trends-card activity-trends">
      <h2 id="activity-trends-title">Activity</h2>
      <p>
        What you logged of one source and one activity type on each date of the same range. An item counts on the date it
        started in {timeZone}, from that date&apos;s midnight to the next midnight there, with its whole duration. Sources are never
        added together.
      </p>
      <div className="today-controls activity-trends__filters">
        <label>
          Source
          <select onChange={(event) => onChooseSource(event.target.value as ActivityHistorySource)} value={filters.source}>
            {activityTrendSourceOptions.map((option) => (
              <option key={option.source} value={option.source}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Activity type
          <select disabled={types.length === 1} onChange={(event) => onChooseType(event.target.value as ActivityType)} value={filters.type}>
            {types.map((type) => (
              <option key={type} value={type}>{activityTypeLabels[type]}</option>
            ))}
          </select>
        </label>
      </div>
      {filters.source === 'recorded_run' && <p className="today-note">A recorded run is always a run.</p>}
      <fieldset className="trends-metrics">
        <legend>Measure</legend>
        {ACTIVITY_TREND_MEASURES.map((option) => (
          <label key={option}>
            <input checked={option === measure} name="activity-trends-measure" onChange={() => onChooseMeasure(option)} type="radio" value={option} />
            {labels[option]}
          </label>
        ))}
      </fieldset>
      <div aria-busy={busy} aria-live="polite" className="today-body" data-activity-trends-state={state}>
        {load.kind === 'loading' && <p className="search-results__loading">Loading activity for these dates…</p>}
        {(load.kind === 'error' || load.kind === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{load.message}</span>
            {load.kind === 'error' && <button onClick={onRetry} type="button">Retry</button>}
          </div>
        )}
        {load.kind === 'ready' && <ActivityTrendsContent measure={measure} trends={load.trends} />}
      </div>
    </section>
  );
}
