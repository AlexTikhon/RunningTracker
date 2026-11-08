import { DAILY_METRICS_LOCAL_DATE_MIN, isEmptyDailyOverview, type DailyOverview } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { checkInDateProblem, formatCheckInDate, localDateIn } from './daily-checkin.js';
import {
  checkInRows,
  computedLine,
  dayLengthNote,
  gpsDistanceText,
  gpsRunsSummary,
  isNoteOnlyCheckIn,
  manualActivityRows,
  manualActivitiesSummary,
  movementRows,
  storedZoneNote,
  type LabelledValue,
  type TodayAction,
} from './daily-overview.js';
import { DailyOverviewController, loadingOverview, type OverviewReader, type OverviewSnapshot } from './daily-overview-controller.js';
import { movementSourceLabel } from './daily-movement.js';
import { readDailyOverview } from './runner-api.js';

// The Today screen (ADR-0082): a read-only overview of one day of the person's own records, recomputed by the server on
// every read. It shows what was recorded and nothing else: no target, judgement, trend or recommendation. Editing happens
// in the existing editors, which the actions open for the selected date.

function Rows({ label, rows }: { label: string; rows: LabelledValue[] }) {
  return (
    <dl aria-label={label} className="today-rows">
      {rows.map((row) => (
        <div className={row.value === 'Not recorded' ? 'today-rows__missing' : undefined} key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A loaded overview: the four sources, each in its own section, with its action. */
export function OverviewContent({ onAction, overview }: { onAction: (action: TodayAction) => void; overview: DailyOverview }) {
  const { checkIn, day, gpsRuns, manualActivities, movement } = overview;
  const dateLabel = formatCheckInDate(day.localDate);
  const lengthNote = dayLengthNote(day);
  const checkInZone = checkIn.recorded ? storedZoneNote(checkIn, day, 'check-in') : null;
  const movementZone = movement.recorded ? storedZoneNote(movement, day, 'movement') : null;
  const distance = gpsDistanceText(gpsRuns);
  return (
    <div className="today-content">
      {isEmptyDailyOverview(overview) && <p className="today-empty">Nothing is recorded for {dateLabel} yet.</p>}
      {day.inProgress && <p className="today-note">The day is still in progress; Refresh shows what was added since.</p>}
      {lengthNote !== null && <p className="today-note">{lengthNote}</p>}

      <section aria-labelledby="today-checkin-title" className="today-card">
        <h2 id="today-checkin-title">Check-in</h2>
        {!checkIn.recorded && <p className="today-missing">No check-in for this day.</p>}
        {checkIn.recorded && isNoteOnlyCheckIn(checkIn) && (
          <p>Only a note was saved for this day; it has no sleep, mood, soreness or weight values. Open the check-in to read it.</p>
        )}
        {checkIn.recorded && !isNoteOnlyCheckIn(checkIn) && (
          <>
            <Rows label="Check-in values" rows={checkInRows(checkIn)} />
            {checkIn.hasNote && <p className="today-note">A note is saved with this check-in; open the check-in to read it.</p>}
          </>
        )}
        {checkInZone !== null && <p className="today-note">{checkInZone}</p>}
        <button aria-label={`${checkIn.recorded ? 'Edit' : 'Add'} check-in for ${dateLabel}`} onClick={() => onAction({ kind: 'check-in', localDate: day.localDate })} type="button">
          {checkIn.recorded ? 'Edit check-in' : 'Add check-in'}
        </button>
      </section>

      <section aria-labelledby="today-movement-title" className="today-card">
        <h2 id="today-movement-title">Steps and active energy</h2>
        <p>
          <span className="review-badge">{movementSourceLabel('manual')}</span> What you entered by hand for this day. Shown on
          its own, not added to activities or GPS runs, and nothing is estimated.
        </p>
        {movement.recorded ? <Rows label="Movement values" rows={movementRows(movement)} /> : <p className="today-missing">No movement recorded for this day.</p>}
        {movementZone !== null && <p className="today-note">{movementZone}</p>}
        <button aria-label={`${movement.recorded ? 'Edit' : 'Add'} movement for ${dateLabel}`} onClick={() => onAction({ kind: 'movement', localDate: day.localDate })} type="button">
          {movement.recorded ? 'Edit movement' : 'Add movement'}
        </button>
      </section>

      <section aria-labelledby="today-activities-title" className="today-card">
        <h2 id="today-activities-title">Manual activities</h2>
        <p className={manualActivities.count === 0 ? 'today-missing' : undefined}>{manualActivitiesSummary(overview)}</p>
        {manualActivities.count > 0 && <Rows label="Manual activities by type" rows={manualActivityRows(overview)} />}
        <p className="today-note">
          An activity counts in full on the day it started in {day.timeZone}, also when it continued past midnight.
        </p>
        <button onClick={() => onAction({ kind: 'activities' })} type="button">Open Activities</button>
      </section>

      <section aria-labelledby="today-gps-title" className="today-card">
        <h2 id="today-gps-title">GPS runs</h2>
        <p className={gpsRuns.count === 0 ? 'today-missing' : undefined}>{gpsRunsSummary(gpsRuns)}</p>
        {distance !== null && <p>{distance}</p>}
        <p className="today-note">Only your own finished runs, counted on the day they started in {day.timeZone}.</p>
        {manualActivities.count > 0 && gpsRuns.count > 0 && (
          <p className="today-note">Manual activities and GPS runs are shown separately and never added together: one may describe the other.</p>
        )}
        <button onClick={() => onAction({ kind: 'runner' })} type="button">Open Runner</button>
      </section>

      <p className="today-meta">{computedLine(overview)}</p>
    </div>
  );
}

export interface TodayViewProps {
  dateInput: string;
  onAction: (action: TodayAction) => void;
  onChooseDate: (value: string) => void;
  onRefresh: () => void;
  snapshot: OverviewSnapshot;
  timeZone: string;
  today: string;
}

/** Everything the screen shows, from one snapshot. Pure, so every state is testable without a DOM. */
export function TodayView({ dateInput, onAction, onChooseDate, onRefresh, snapshot, timeZone, today }: TodayViewProps) {
  const { load } = snapshot;
  const busy = load.kind === 'loading' || (load.kind === 'ready' && load.refreshing);
  const state = load.kind === 'ready' && load.refreshing ? 'refreshing' : load.kind;
  const dateProblem = checkInDateProblem(dateInput, today);
  const dateLabel = formatCheckInDate(snapshot.localDate);
  return (
    <section aria-labelledby="today-title" className="activity-shell today-shell">
      <div className="search-panel__heading">
        <p className="eyebrow">Daily overview</p>
        <h1 id="today-title" tabIndex={-1}>Today</h1>
        <p>
          What your own check-in, movement, manual activities and GPS runs hold for one day, read again each time you open
          this view or press Refresh. It describes what was recorded; it sets no targets and gives no advice. Only you can see
          it.
        </p>
      </div>

      <div className="today-controls">
        <label>
          Date
          <input
            max={today}
            min={DAILY_METRICS_LOCAL_DATE_MIN}
            onChange={(event) => onChooseDate(event.target.value)}
            type="date"
            value={dateInput}
          />
        </label>
        <button disabled={snapshot.localDate === today && dateProblem === null} onClick={() => onChooseDate(today)} type="button">
          Go to today
        </button>
        <button disabled={busy} onClick={onRefresh} type="button">{busy ? 'Updating…' : 'Refresh'}</button>
      </div>
      {dateProblem !== null && <p className="activity-form__failure" role="alert">{dateProblem}</p>}
      <p className="today-day">
        Showing <strong>{dateLabel}</strong>{snapshot.localDate === today ? ' (today)' : ''} in the time zone {timeZone}.
      </p>

      <div aria-busy={busy} aria-live="polite" className="today-body" data-overview-state={state}>
        {load.kind === 'loading' && <p className="search-results__loading">Loading {dateLabel}…</p>}
        {(load.kind === 'error' || load.kind === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{load.message}</span>
            {load.kind === 'error' && <button onClick={onRefresh} type="button">Retry</button>}
          </div>
        )}
        {load.kind === 'ready' && <OverviewContent onAction={onAction} overview={load.overview} />}
      </div>
    </section>
  );
}

export interface TodayScreenProps {
  onAction: (action: TodayAction) => void;
  /** Called with every valid date the person selects, so the parent can keep it during ordinary navigation. */
  onSelectDate: (localDate: string) => void;
  orgId: string;
  /** The date to open with (kept by the parent); null or a date after today opens today. */
  selectedDate: string | null;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
  timeZone: string;
  // For tests: the instant whose date in `timeZone` is "today". Defaults to the time the screen opens.
  nowMs?: number;
  read?: OverviewReader;
}

// The parent keys this screen by session, person and organization and mounts it only while Today is open, so each
// opening reads the day again (after an edit or a deletion elsewhere too) and no answer crosses a change of scope.
export function TodayScreen({ nowMs, onAction, onSelectDate, orgId, read = readDailyOverview, selectedDate, signal, timeZone }: TodayScreenProps) {
  const today = useMemo(() => localDateIn(timeZone, nowMs ?? Date.now()), [nowMs, timeZone]);
  const initialDate = selectedDate !== null && checkInDateProblem(selectedDate, today) === null ? selectedDate : today;
  const initialRef = useRef(initialDate);
  const readRef = useRef(read);
  const [dateInput, setDateInput] = useState(initialDate);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>(() => loadingOverview(initialDate));
  const controller = useRef<DailyOverviewController | null>(null);

  useEffect(() => {
    const next = new DailyOverviewController({ localDate: initialRef.current, onChange: setSnapshot, orgId, read: readRef.current, signal, timeZone });
    controller.current = next;
    setSnapshot(next.snapshot);
    next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal, timeZone]);

  const chooseDate = (value: string) => {
    setDateInput(value);
    if (checkInDateProblem(value, today) !== null) return;
    onSelectDate(value);
    controller.current?.select(value);
  };

  return (
    <TodayView
      dateInput={dateInput}
      onAction={onAction}
      onChooseDate={chooseDate}
      onRefresh={() => controller.current?.refresh()}
      snapshot={snapshot}
      timeZone={timeZone}
      today={today}
    />
  );
}
