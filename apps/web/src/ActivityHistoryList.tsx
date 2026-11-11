import {
  ACTIVITY_TYPES,
  DAILY_METRICS_LOCAL_DATE_MIN,
  dailyMetricsLocalDateSchema,
  type ActivityHistoryItem,
  type ActivityHistorySource,
  type ActivityType,
  type DistanceUnit,
  type GpsQuality,
  type RecordedRunHistoryItem,
} from '@running-tracker/contracts';
import { useState, type ReactNode } from 'react';

import type { ActivityDeletionSnapshot } from './activity-controller.js';
import { activityTypeLabels } from './activity-form.js';
import { historyItemKey, type ActivityHistoryFilters, type ActivityHistorySnapshot } from './activity-history-controller.js';
import { formatCheckInDate } from './daily-checkin.js';
import { dayLengthNote } from './daily-overview.js';
import { formatDistance, formatDuration, formatStartedAt } from './run-search.js';

// The provenance of every item, said explicitly on every card (ADR-0087).
export const historySourceLabels: Record<ActivityHistorySource, string> = {
  gpx: 'GPX import',
  manual: 'Entered manually',
  recorded_run: 'Recorded run',
};

const gpsQualityLabels: Record<GpsQuality, string> = {
  good: 'Good',
  insufficient: 'Insufficient data',
  poor: 'Poor',
};

export function describeHistoryItem(item: ActivityHistoryItem, timeZone: string): string {
  return `${activityTypeLabels[item.type].toLowerCase()} of ${formatStartedAt(item.startedAt, timeZone)}`;
}

export interface HistoryDeletion {
  activityId: string;
  snapshot: ActivityDeletionSnapshot;
}

/** The zone the list's times are shown in: the day filter's zone when there is one, otherwise the device's. */
export const historyDisplayZone = (filters: ActivityHistoryFilters, deviceTimeZone: string): string =>
  filters.day?.timeZone ?? deviceTimeZone;

/**
 * The day input. It keeps what is being typed locally and applies only a complete, real date (2000-01-01 or later); an
 * empty or partial value changes nothing, so typing never resets the list. "All dates" is the explicit way back to the
 * whole history. Keyed by the applied day, so a change made elsewhere (All dates, a Today action) shows at once.
 */
function DayFilter({ day, onChoose }: { day: ActivityHistoryFilters['day']; onChoose: (localDate: string) => void }) {
  const [value, setValue] = useState(day?.localDate ?? '');
  return (
    <label>
      Day
      <input
        min={DAILY_METRICS_LOCAL_DATE_MIN}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          if (dailyMetricsLocalDateSchema.safeParse(next).success && next !== day?.localDate) onChoose(next);
        }}
        type="date"
        value={value}
      />
    </label>
  );
}

export interface ActivityHistoryListProps {
  // Opened from Today (ADR-0088): the date "Back to Today" returns to, or null.
  backToToday: { localDate: string; onBack: () => void } | null;
  deletion: HistoryDeletion | null;
  filters: ActivityHistoryFilters;
  history: ActivityHistorySnapshot;
  notice: string | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onDelete: (activityId: string, label: string) => void;
  onFiltersChange: (filters: ActivityHistoryFilters) => void;
  onLoadMore: () => void;
  onOpenRun: (runId: string) => void;
  onRefresh: () => void;
  onRetry: () => void;
  // The device's zone: times are shown in it without a day filter, and a day chosen here without one is read in it.
  timeZone: string;
  unit: DistanceUnit;
}

function unknownSummary(item: RecordedRunHistoryItem): string {
  return item.summary.state === 'pending'
    ? 'Distance and observed duration are not known yet: this run’s summary is still being prepared.'
    : 'Distance and observed duration are not known right now: new GPS data arrived and this run’s summary is being updated.';
}

function details(item: ActivityHistoryItem, unit: DistanceUnit): ReactNode {
  const distance = (metres: number | null) => (metres === null ? 'Not recorded' : formatDistance(metres, unit));
  switch (item.source) {
    case 'manual':
      return (
        <dl>
          <div><dt>Duration</dt><dd>{formatDuration(item.enteredDurationS)}</dd></div>
          <div><dt>Distance</dt><dd>{distance(item.distanceM)}</dd></div>
          <div><dt>Effort</dt><dd>{item.rpe === null ? '—' : `${item.rpe}/10`}</dd></div>
          <div><dt>Source</dt><dd>{historySourceLabels.manual}</dd></div>
        </dl>
      );
    case 'gpx':
      return (
        <dl>
          <div><dt>Elapsed time</dt><dd>{formatDuration(item.elapsedDurationS)}</dd></div>
          <div><dt>Distance</dt><dd>{distance(item.distanceM)}</dd></div>
          <div><dt>Source</dt><dd>{historySourceLabels.gpx}</dd></div>
        </dl>
      );
    case 'recorded_run':
      return (
        <>
          <dl>
            {item.summary.state === 'current' && (
              <>
                <div><dt>Distance</dt><dd>{formatDistance(item.summary.distanceM, unit)}</dd></div>
                <div><dt>Observed duration</dt><dd>{formatDuration(item.summary.observedDurationS)}</dd></div>
                <div><dt>GPS quality</dt><dd>{gpsQualityLabels[item.summary.gpsQuality]}</dd></div>
              </>
            )}
            <div><dt>Source</dt><dd>{historySourceLabels.recorded_run}</dd></div>
            <div><dt>Capture source</dt><dd>Not recorded</dd></div>
          </dl>
          {item.summary.state !== 'current' && <p className="activity-card__notes" role="note">{unknownSummary(item)}</p>}
        </>
      );
  }
}

/** The unified history of the person's own activities and recorded runs (ADR-0087). Presentational: state is the screen's. */
export function ActivityHistoryList({
  backToToday,
  deletion,
  filters,
  history,
  notice,
  onCancelDelete,
  onConfirmDelete,
  onDelete,
  onFiltersChange,
  onLoadMore,
  onOpenRun,
  onRefresh,
  onRetry,
  timeZone: deviceTimeZone,
  unit,
}: ActivityHistoryListProps) {
  const filtered = filters.source !== null || filters.type !== null;
  const deletionPending = deletion !== null && deletion.snapshot.phase === 'pending';
  const day = filters.day;
  const timeZone = historyDisplayZone(filters, deviceTimeZone);
  const dayLabel = day === null ? null : formatCheckInDate(day.localDate);
  // The server's interval for the applied day, once it has answered for exactly this day.
  const applied =
    day !== null && history.appliedDay?.localDate === day.localDate && history.appliedDay.timeZone === day.timeZone ? history.appliedDay : null;
  const lengthNote = applied === null ? null : dayLengthNote(applied);
  return (
    <section aria-labelledby="activity-history-title" className="search-results">
      <h2 id="activity-history-title" tabIndex={-1}>Your activity history</h2>
      {backToToday !== null && (
        <div className="run-card__actions">
          <button
            aria-label={`Back to Today on ${formatCheckInDate(backToToday.localDate)}`}
            onClick={backToToday.onBack}
            type="button"
          >
            Back to Today
          </button>
        </div>
      )}
      <p className="search-results__note">
        Manual entries, GPX imports and the runs you recorded here, newest first. Times are shown in {timeZone}. Distances
        in {unit === 'km' ? 'kilometres' : 'miles'}. Each source keeps its own measure: a manual entry shows the duration you
        entered; a GPX import shows its elapsed time, pauses included, not moving time; a recorded run shows the observed
        duration of its accepted GPS measurements once its summary is ready. Sources are listed side by side and never added
        together, so the same outing entered, imported and recorded appears more than once. Only you can see this history.
      </p>
      <form aria-label="History filters" className="search-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Source
          <select
            onChange={(event) => onFiltersChange({ ...filters, source: event.target.value === '' ? null : (event.target.value as ActivityHistorySource) })}
            value={filters.source ?? ''}
          >
            <option value="">All sources</option>
            <option value="manual">{historySourceLabels.manual}</option>
            <option value="gpx">{historySourceLabels.gpx}</option>
            <option value="recorded_run">{historySourceLabels.recorded_run}</option>
          </select>
        </label>
        <label>
          Activity type
          <select
            onChange={(event) => onFiltersChange({ ...filters, type: event.target.value === '' ? null : (event.target.value as ActivityType) })}
            value={filters.type ?? ''}
          >
            <option value="">All types</option>
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>{activityTypeLabels[type]}</option>
            ))}
          </select>
        </label>
        <DayFilter
          day={day}
          key={day === null ? '*' : `${day.localDate}@${day.timeZone}`}
          onChoose={(localDate) => onFiltersChange({ ...filters, day: { localDate, timeZone: day?.timeZone ?? deviceTimeZone } })}
        />
        <button disabled={day === null} onClick={() => onFiltersChange({ ...filters, day: null })} type="button">All dates</button>
        <button disabled={history.status === 'loading'} onClick={onRefresh} type="button">Refresh history</button>
      </form>
      {day !== null && (
        <p className="search-results__note" role="note">
          Showing what started on <strong>{dayLabel}</strong> in the time zone {day.timeZone}, from its midnight to the next
          midnight there. An activity that continued past midnight is listed on the day it started.
          {lengthNote !== null && <> {lengthNote}</>}
        </p>
      )}
      <p className="search-panel__notice" role="status">{notice ?? ''}</p>
      {history.status === 'loading' && <p className="search-results__loading">Loading your activity history…</p>}
      {(history.status === 'error' || history.status === 'access-denied') && (
        <div className="run-share__failure" role="alert">
          <span>{history.message}</span>
          <button onClick={onRetry} type="button">Retry</button>
        </div>
      )}
      {history.status === 'ready' && history.items.length === 0 && (
        <p className="search-results__empty">
          {day !== null
            ? `Nothing in your history ${filtered ? 'matches these filters' : 'started'} on ${dayLabel ?? day.localDate} in ${day.timeZone}.`
            : filtered
              ? 'Nothing in your history matches these filters.'
              : 'No activities yet. Activities you enter or import and runs you record here appear in this history, newest first.'}
        </p>
      )}
      {history.status === 'ready' && history.items.length > 0 && (
        <ul aria-label="Your activity history" className="run-cards">
          {history.items.map((item) => {
            const label = describeHistoryItem(item, timeZone);
            const confirming = item.source !== 'recorded_run' && deletion?.activityId === item.activityId;
            return (
              <li className={confirming ? 'run-card run-card--deleting' : 'run-card'} key={historyItemKey(item)}>
                <h3>{activityTypeLabels[item.type]}</h3>
                <time dateTime={item.startedAt}>{formatStartedAt(item.startedAt, timeZone)}</time>
                {details(item, unit)}
                {item.source === 'manual' && item.notes !== null && <p className="activity-card__notes">{item.notes}</p>}
                {item.source === 'recorded_run' && (
                  <div className="run-card__actions">
                    <button aria-label={`Run details of your run of ${formatStartedAt(item.startedAt, timeZone)}`} onClick={() => onOpenRun(item.runId)} type="button">
                      Run details
                    </button>
                  </div>
                )}
                {item.source !== 'recorded_run' && !confirming && (
                  <div className="run-card__actions">
                    <button
                      aria-label={`Delete your ${label}`}
                      disabled={deletionPending}
                      onClick={() => onDelete(item.activityId, label)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                )}
                {confirming && deletion !== null && (
                  <section aria-label={`Delete your ${label}?`} className="run-delete">
                    <h4>Delete this activity?</h4>
                    <p className="run-delete__warning">It is removed permanently. This cannot be undone.</p>
                    {deletion.snapshot.message !== null && <p className="run-delete__failure" role="alert">{deletion.snapshot.message}</p>}
                    <div className="run-delete__actions">
                      <button
                        className="finish-action"
                        disabled={deletionPending || deletion.snapshot.phase === 'unavailable'}
                        onClick={onConfirmDelete}
                        type="button"
                      >
                        {deletionPending ? 'Deleting…' : 'Confirm delete'}
                      </button>
                      <button disabled={deletionPending} onClick={onCancelDelete} type="button">Cancel</button>
                    </div>
                  </section>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {history.status === 'ready' && history.moreMessage !== null && (
        <div className="run-share__failure" role="alert">
          <span>{history.moreMessage}</span>
          <button onClick={onRetry} type="button">{history.outdated ? 'Refresh' : 'Retry'}</button>
        </div>
      )}
      {history.status === 'ready' && history.hasMore && history.moreMessage === null && (
        <button disabled={history.loadingMore} onClick={onLoadMore} type="button">
          {history.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
