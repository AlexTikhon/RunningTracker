import { DAILY_METRICS_LOCAL_DATE_MIN, DAILY_METRICS_NOTE_MAX_LENGTH } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  CheckInDayController,
  CheckInHistoryController,
  loadingCheckInDay,
  loadingCheckInHistory,
  type CheckInDaySnapshot,
  type CheckInDeletionPhase,
  type CheckInHistorySnapshot,
} from './daily-checkin-controller.js';
import {
  CHECKIN_HISTORY_DAYS,
  checkInDateProblem,
  draftFromView,
  emptyCheckInDraft,
  formatCheckInDate,
  localDateIn,
  summarizeCheckIn,
  validateCheckInDraft,
  type CheckInDraft,
} from './daily-checkin.js';
import { defaultTimeZone } from './run-search.js';
import { deleteDailyMetrics, listDailyMetrics, putDailyMetrics, readDailyMetrics, type CsrfCredentials } from './runner-api.js';
import { WeeklyInsightPanel } from './WeeklyInsightPanel.js';

export interface DailyCheckInScreenProps {
  csrf: CsrfCredentials;
  orgId: string;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
  // For tests: the instant whose date in the person's zone is "today". Defaults to the time the screen opens.
  nowMs?: number;
}

const scaleOptions = (low: number, high: number) =>
  Array.from({ length: high - low + 1 }, (_, index) => String(low + index));

export interface CheckInHistoryProps {
  disabled: boolean;
  onEdit: (localDate: string) => void;
  selectedDate: string;
  snapshot: CheckInHistorySnapshot;
  onRetry: () => void;
}

/** The last 14 days, newest first; a day without a check-in is shown as such, not left out. */
export function CheckInHistory({ disabled, onEdit, onRetry, selectedDate, snapshot }: CheckInHistoryProps) {
  return (
    <section aria-labelledby="checkin-history-title" className="search-results">
      <h2 id="checkin-history-title">Last {CHECKIN_HISTORY_DAYS} days</h2>
      {snapshot.status === 'loading' && <p className="search-results__loading">Loading your recent check-ins…</p>}
      {(snapshot.status === 'error' || snapshot.status === 'access-denied') && (
        <div className="run-share__failure" role="alert">
          <span>{snapshot.message}</span>
          <button onClick={onRetry} type="button">Retry</button>
        </div>
      )}
      {snapshot.status === 'ready' && (
        <ul aria-label={`Last ${CHECKIN_HISTORY_DAYS} days`} className="checkin-history">
          {snapshot.days.map(({ localDate, metrics }) => {
            const label = formatCheckInDate(localDate);
            const pieces = metrics === null ? [] : summarizeCheckIn(metrics);
            return (
              <li
                aria-current={localDate === selectedDate ? 'date' : undefined}
                className={metrics === null ? 'checkin-day checkin-day--empty' : 'checkin-day'}
                key={localDate}
              >
                <time dateTime={localDate}>{label}</time>
                {metrics === null ? (
                  <p className="checkin-day__empty">No check-in</p>
                ) : (
                  <>
                    {pieces.length > 0 && (
                      <dl>
                        {pieces.map((piece) => (
                          <div key={piece.label}><dt>{piece.label}</dt><dd>{piece.value}</dd></div>
                        ))}
                      </dl>
                    )}
                    {metrics.note !== null && <p className="activity-card__notes">{metrics.note}</p>}
                  </>
                )}
                <button
                  aria-label={`${metrics === null ? 'Add a check-in for' : 'Edit the check-in of'} ${label}`}
                  disabled={disabled || localDate === selectedDate}
                  onClick={() => onEdit(localDate)}
                  type="button"
                >
                  {metrics === null ? 'Add' : 'Edit'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface CheckInDeletionProps {
  confirming: boolean;
  // The day in words, as the form's status line shows it.
  dateLabel: string;
  disabled: boolean;
  // Why the last attempt failed; shown only while confirming.
  failure: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onStart: () => void;
  phase: CheckInDeletionPhase;
}

/** Deleting the day shown in the form, behind an explicit confirmation. Rendered only for a day with a record. */
export function CheckInDeletion({ confirming, dateLabel, disabled, failure, onCancel, onConfirm, onStart, phase }: CheckInDeletionProps) {
  const pending = phase === 'pending';
  if (!confirming) {
    return (
      <div className="checkin-form__delete">
        <button aria-label={`Delete the check-in of ${dateLabel}`} disabled={disabled} onClick={onStart} type="button">
          Delete check-in
        </button>
      </div>
    );
  }
  return (
    <section aria-label={`Delete the check-in of ${dateLabel}?`} className="run-delete checkin-form__delete">
      <h2>Delete this check-in?</h2>
      <p className="run-delete__warning">Everything recorded for {dateLabel} is removed permanently. This cannot be undone.</p>
      {failure !== null && <p className="run-delete__failure" role="alert">{failure}</p>}
      <div className="run-delete__actions">
        <button className="finish-action" disabled={pending} onClick={onConfirm} type="button">
          {pending ? 'Deleting…' : 'Confirm delete'}
        </button>
        <button disabled={pending} onClick={onCancel} type="button">Cancel</button>
      </div>
    </section>
  );
}

// Daily check-in of the signed-in person (ADR-0074). The parent keys it by session, person and organization, so a
// change of any of them starts from a clean form and history with no request carried over. Owner-only: nothing here
// is visible to a coach or another member.
export function DailyCheckInScreen({ csrf, nowMs, orgId, signal }: DailyCheckInScreenProps) {
  const timeZone = useMemo(() => defaultTimeZone(), []);
  const today = useMemo(() => localDateIn(timeZone, nowMs ?? Date.now()), [nowMs, timeZone]);
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const [dateInput, setDateInput] = useState(today);
  const [draft, setDraft] = useState<CheckInDraft>(emptyCheckInDraft);
  const [showErrors, setShowErrors] = useState(false);
  const [day, setDay] = useState<CheckInDaySnapshot>(() => loadingCheckInDay(today));
  const [history, setHistory] = useState<CheckInHistorySnapshot>(loadingCheckInHistory);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A saved or deleted day can make the week's insight stale or delete it: the Insights panel reads it again.
  const [insightRefresh, setInsightRefresh] = useState(0);
  const dayController = useRef<CheckInDayController | null>(null);
  const historyController = useRef<CheckInHistoryController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const validation = validateCheckInDraft(draft);
  const dateProblem = checkInDateProblem(dateInput, today);
  const pending = day.save === 'pending';
  const deleting = day.deletion === 'pending';
  // A save or a deletion is in flight: the date, the values and the other action wait for it.
  const busy = pending || deleting;
  const loading = day.load !== 'ready';

  const afterLoaded = useRef<(date: string, existing: Parameters<typeof draftFromView>[0] | null) => void>(() => undefined);
  afterLoaded.current = (_date, existing) => {
    setShowErrors(false);
    setDraft(existing === null ? emptyCheckInDraft : draftFromView(existing));
  };

  const afterDeleted = useRef<() => void>(() => undefined);
  afterDeleted.current = () => {
    setConfirmingDelete(false);
    setShowErrors(false);
    setDraft(emptyCheckInDraft);
    historyController.current?.refresh();
    setInsightRefresh((count) => count + 1);
    heading.current?.focus();
  };

  useEffect(() => {
    const next = new CheckInHistoryController({ load: listDailyMetrics, onChange: setHistory, orgId, signal, today });
    historyController.current = next;
    next.start();
    return () => {
      next.dispose();
      if (historyController.current === next) historyController.current = null;
    };
  }, [orgId, signal, today]);

  useEffect(() => {
    const next = new CheckInDayController({
      csrf: () => csrfRef.current,
      date: today,
      onChange: setDay,
      onDeleted: () => afterDeleted.current(),
      onLoaded: (date, existing) => afterLoaded.current(date, existing),
      onSaved: () => {
        historyController.current?.refresh();
        setInsightRefresh((count) => count + 1);
      },
      orgId,
      read: readDailyMetrics,
      remove: deleteDailyMetrics,
      signal,
      timeZone,
      write: putDailyMetrics,
    });
    dayController.current = next;
    next.start();
    return () => {
      next.dispose();
      if (dayController.current === next) dayController.current = null;
    };
  }, [orgId, signal, timeZone, today]);

  const chooseDate = (value: string) => {
    setDateInput(value);
    setConfirmingDelete(false);
    if (checkInDateProblem(value, today) === null) dayController.current?.select(value);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    if (dateProblem !== null || loading || !validation.ok) return;
    setConfirmingDelete(false);
    dayController.current?.save(validation.values);
  };

  const update = (patch: Partial<CheckInDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const problems = [...(dateProblem === null ? [] : [dateProblem]), ...(validation.ok ? [] : validation.errors)];
  const fieldsDisabled = loading || busy;
  const actionMessage = day.saveMessage ?? (day.deletion === 'failed' ? null : day.deletionMessage);

  return (
    <section aria-labelledby="checkin-title" className="activity-shell">
      <div className="search-panel__heading">
        <p className="eyebrow">Daily check-in</p>
        <h1 id="checkin-title" ref={heading} tabIndex={-1}>Check-in</h1>
        <p>
          Record your weight, sleep, mood and soreness for a day. Every value is optional; fill in what you know. Only you
          can see your check-ins: coaches and other members cannot, even for runs you share with them.
        </p>
      </div>

      <form aria-label="Daily check-in" className="search-filters activity-form" noValidate onSubmit={submit}>
        <label>
          Date
          <input
            disabled={busy}
            max={today}
            min={DAILY_METRICS_LOCAL_DATE_MIN}
            onChange={(event) => chooseDate(event.target.value)}
            type="date"
            value={dateInput}
          />
        </label>
        <label>
          Weight in kg (optional)
          <input disabled={fieldsDisabled} inputMode="decimal" onChange={(event) => update({ weightKg: event.target.value })} value={draft.weightKg} />
        </label>
        <fieldset className="activity-form__duration checkin-form__sleep">
          <legend>Sleep (optional)</legend>
          <label>
            Hours
            <input disabled={fieldsDisabled} inputMode="numeric" onChange={(event) => update({ sleepHours: event.target.value.trim() })} value={draft.sleepHours} />
          </label>
          <label>
            Minutes
            <input disabled={fieldsDisabled} inputMode="numeric" onChange={(event) => update({ sleepMinutes: event.target.value.trim() })} value={draft.sleepMinutes} />
          </label>
        </fieldset>
        <label>
          Sleep quality (optional)
          <select disabled={fieldsDisabled} onChange={(event) => update({ sleepQuality: event.target.value })} value={draft.sleepQuality}>
            <option value="">Not rated</option>
            {scaleOptions(1, 5).map((value) => <option key={value} value={value}>{value} of 5</option>)}
          </select>
        </label>
        <label>
          Mood (optional)
          <select disabled={fieldsDisabled} onChange={(event) => update({ mood: event.target.value })} value={draft.mood}>
            <option value="">Not rated</option>
            {scaleOptions(1, 5).map((value) => <option key={value} value={value}>{value} of 5</option>)}
          </select>
        </label>
        <label>
          Soreness (optional)
          <select disabled={fieldsDisabled} onChange={(event) => update({ soreness: event.target.value })} value={draft.soreness}>
            <option value="">Not rated</option>
            {scaleOptions(0, 10).map((value) => <option key={value} value={value}>{value} of 10</option>)}
          </select>
        </label>
        <label className="activity-form__notes">
          Note (optional)
          <textarea disabled={fieldsDisabled} maxLength={DAILY_METRICS_NOTE_MAX_LENGTH} onChange={(event) => update({ note: event.target.value })} rows={2} value={draft.note} />
        </label>
        <p className="checkin-form__state" role="status">
          {day.load === 'loading'
            ? 'Loading this day…'
            : day.load === 'ready'
              ? day.existing === null
                ? `Nothing recorded for ${formatCheckInDate(day.date)} yet.`
                : `Showing what you recorded for ${formatCheckInDate(day.date)}. Saving replaces it.`
              : ''}
        </p>
        {(day.load === 'error' || day.load === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{day.loadMessage}</span>
            <button onClick={() => dayController.current?.retry()} type="button">Retry</button>
          </div>
        )}
        {showErrors && problems.length > 0 && (
          <ul aria-label="Problems with the check-in" className="search-filters__errors">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        )}
        <div className="activity-form__actions">
          <button className="primary-action" disabled={busy || loading} type="submit">
            {pending ? 'Saving…' : 'Save check-in'}
          </button>
          <p className={day.save === 'failed' ? 'activity-form__failure' : 'activity-form__status'} role="status">
            {actionMessage ?? ''}
          </p>
        </div>
        {day.load === 'ready' && day.existing !== null && (
          <CheckInDeletion
            confirming={confirmingDelete}
            dateLabel={formatCheckInDate(day.date)}
            disabled={busy}
            failure={day.deletion === 'failed' ? day.deletionMessage : null}
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={() => dayController.current?.deleteDay()}
            onStart={() => setConfirmingDelete(true)}
            phase={day.deletion}
          />
        )}
        <p className="search-results__note checkin-form__zone">Today is {formatCheckInDate(today)} in {timeZone}.</p>
      </form>

      <CheckInHistory
        disabled={busy}
        onEdit={chooseDate}
        onRetry={() => historyController.current?.retry()}
        selectedDate={day.date}
        snapshot={history}
      />

      <WeeklyInsightPanel csrf={csrf} orgId={orgId} refreshKey={insightRefresh} signal={signal} timeZone={timeZone} today={today} />
    </section>
  );
}
