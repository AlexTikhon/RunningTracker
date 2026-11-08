import { DAILY_MOVEMENT_LOCAL_DATE_MIN } from '@running-tracker/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { checkInDateProblem, formatCheckInDate } from './daily-checkin.js';
import {
  MovementDayController,
  MovementHistoryController,
  loadingMovementDay,
  loadingMovementHistory,
  type MovementDaySnapshot,
  type MovementDeletionPhase,
  type MovementHistorySnapshot,
} from './daily-movement-controller.js';
import {
  MOVEMENT_HISTORY_DAYS,
  emptyMovementDraft,
  movementDraftFromView,
  movementSourceLabel,
  summarizeMovement,
  validateMovementDraft,
  type MovementDraft,
} from './daily-movement.js';
import {
  deleteDailyMovement,
  listDailyMovement,
  putDailyMovement,
  readDailyMovement,
  type CsrfCredentials,
} from './runner-api.js';

// The Movement section of the Check-in tab (ADR-0078): steps and active energy entered by hand for one local date,
// owner-only, separate from the check-in above it (its own form, request, history and deletion). Nothing here is sent
// to AI insights, and nothing is imported from a phone or a watch. The weekly review reads movement on its own; a
// confirmed save or deletion here tells the screen (onChanged) so that the review reads its week again (ADR-0079).

export interface MovementHistoryProps {
  disabled: boolean;
  onEdit: (localDate: string) => void;
  onRetry: () => void;
  selectedDate: string;
  snapshot: MovementHistorySnapshot;
}

/** The last 14 days, newest first; a day without movement is shown as such, not left out. */
export function MovementHistory({ disabled, onEdit, onRetry, selectedDate, snapshot }: MovementHistoryProps) {
  return (
    <div className="movement-history">
      <h3 id="movement-history-title">Movement history</h3>
      <p className="search-results__note">The {MOVEMENT_HISTORY_DAYS} days ending today.</p>
      {snapshot.status === 'loading' && <p className="search-results__loading">Loading your recent movement…</p>}
      {(snapshot.status === 'error' || snapshot.status === 'access-denied') && (
        <div className="run-share__failure" role="alert">
          <span>{snapshot.message}</span>
          <button onClick={onRetry} type="button">Retry</button>
        </div>
      )}
      {snapshot.status === 'ready' && (
        <ul aria-labelledby="movement-history-title" className="checkin-history">
          {snapshot.days.map(({ localDate, movement }) => {
            const label = formatCheckInDate(localDate);
            return (
              <li
                aria-current={localDate === selectedDate ? 'date' : undefined}
                className={movement === null ? 'checkin-day checkin-day--empty' : 'checkin-day'}
                key={localDate}
              >
                <time dateTime={localDate}>{label}</time>
                {movement === null ? (
                  <p className="checkin-day__empty">No movement recorded</p>
                ) : (
                  <dl>
                    {summarizeMovement(movement).map((piece) => (
                      <div key={piece.label}><dt>{piece.label}</dt><dd>{piece.value}</dd></div>
                    ))}
                    <div><dt>Source</dt><dd>{movementSourceLabel(movement.source)}</dd></div>
                  </dl>
                )}
                <button
                  aria-label={`${movement === null ? 'Add movement for' : 'Edit the movement of'} ${label}`}
                  disabled={disabled || localDate === selectedDate}
                  onClick={() => onEdit(localDate)}
                  type="button"
                >
                  {movement === null ? 'Add' : 'Edit'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface MovementDeletionProps {
  confirming: boolean;
  dateLabel: string;
  disabled: boolean;
  // Why the last attempt failed; shown only while confirming.
  failure: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onStart: () => void;
  phase: MovementDeletionPhase;
}

/** Deleting the movement of the day in the form, behind an explicit confirmation. Rendered only for a stored day. */
export function MovementDeletion({ confirming, dateLabel, disabled, failure, onCancel, onConfirm, onStart, phase }: MovementDeletionProps) {
  const pending = phase === 'pending';
  if (!confirming) {
    return (
      <div className="checkin-form__delete">
        <button aria-label={`Delete the movement of ${dateLabel}`} disabled={disabled} onClick={onStart} type="button">
          Delete movement
        </button>
      </div>
    );
  }
  return (
    <section aria-label={`Delete the movement of ${dateLabel}?`} className="run-delete checkin-form__delete">
      <h3>Delete this movement?</h3>
      <p className="run-delete__warning">
        The steps and active energy entered for {dateLabel} are removed permanently. This cannot be undone.
      </p>
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

export interface MovementFormViewProps {
  confirmingDelete: boolean;
  dateInput: string;
  day: MovementDaySnapshot;
  draft: MovementDraft;
  onCancelDelete: () => void;
  onChangeDate: (value: string) => void;
  onChangeDraft: (patch: Partial<MovementDraft>) => void;
  onConfirmDelete: () => void;
  onRetry: () => void;
  onStartDelete: () => void;
  onSubmit: (event: FormEvent) => void;
  showErrors: boolean;
  timeZone: string;
  today: string;
}

/** The form for one day: every state comes from the props, so each can be rendered on its own. */
export function MovementFormView(props: MovementFormViewProps) {
  const { confirmingDelete, dateInput, day, draft, showErrors, timeZone, today } = props;
  const validation = validateMovementDraft(draft);
  const dateProblem = checkInDateProblem(dateInput, today);
  const pending = day.save === 'pending';
  const busy = pending || day.deletion === 'pending';
  const loading = day.load !== 'ready';
  const fieldsDisabled = loading || busy;
  const problems = [...(dateProblem === null ? [] : [dateProblem]), ...(validation.ok ? [] : validation.errors)];
  const actionMessage = day.saveMessage ?? (day.deletion === 'failed' ? null : day.deletionMessage);
  const dateLabel = formatCheckInDate(day.date);

  return (
    <form aria-label="Daily movement" className="search-filters activity-form" noValidate onSubmit={props.onSubmit}>
      <label>
        Date
        <input
          disabled={busy}
          max={today}
          min={DAILY_MOVEMENT_LOCAL_DATE_MIN}
          onChange={(event) => props.onChangeDate(event.target.value)}
          type="date"
          value={dateInput}
        />
      </label>
      <label>
        Steps (optional)
        <input
          disabled={fieldsDisabled}
          inputMode="numeric"
          onChange={(event) => props.onChangeDraft({ steps: event.target.value })}
          value={draft.steps}
        />
      </label>
      <label>
        Active energy (kcal)
        <input
          aria-describedby="movement-energy-hint"
          disabled={fieldsDisabled}
          inputMode="decimal"
          onChange={(event) => props.onChangeDraft({ activeEnergyKcal: event.target.value })}
          value={draft.activeEnergyKcal}
        />
      </label>
      <p className="checkin-form__state" id="movement-energy-hint">
        Optional. The active energy your device or app reports for the day, as you read it there; not resting energy, total
        energy burned or food. Leave a field empty when you do not know it: empty is not recorded, 0 is a value.
      </p>
      <p className="checkin-form__state" role="status">
        {day.load === 'loading'
          ? "Loading this day's movement…"
          : day.load === 'ready'
            ? day.existing === null
              ? `No movement recorded for ${dateLabel} yet.`
              : `Showing what you entered for ${dateLabel}. Saving replaces it.`
            : ''}
      </p>
      {day.load === 'ready' && day.existing !== null && (
        <p className="checkin-form__state movement-source">Source: {movementSourceLabel(day.existing.source)}</p>
      )}
      {(day.load === 'error' || day.load === 'access-denied') && (
        <div className="run-share__failure" role="alert">
          <span>{day.loadMessage}</span>
          <button onClick={props.onRetry} type="button">Retry</button>
        </div>
      )}
      {showErrors && problems.length > 0 && (
        <ul aria-label="Problems with the movement" className="search-filters__errors">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}
      <div className="activity-form__actions">
        <button className="primary-action" disabled={busy || loading} type="submit">
          {pending ? 'Saving…' : 'Save movement'}
        </button>
        <p className={day.save === 'failed' ? 'activity-form__failure' : 'activity-form__status'} role="status">
          {actionMessage ?? ''}
        </p>
      </div>
      {day.load === 'ready' && day.existing !== null && (
        <MovementDeletion
          confirming={confirmingDelete}
          dateLabel={dateLabel}
          disabled={busy}
          failure={day.deletion === 'failed' ? day.deletionMessage : null}
          onCancel={props.onCancelDelete}
          onConfirm={props.onConfirmDelete}
          onStart={props.onStartDelete}
          phase={day.deletion}
        />
      )}
      <p className="search-results__note checkin-form__zone">Today is {formatCheckInDate(today)} in {timeZone}.</p>
    </form>
  );
}

export interface DailyMovementSectionProps {
  csrf: CsrfCredentials;
  /** Opened from Today's movement action (ADR-0082): focus the section's heading when it mounts. */
  focusOnOpen?: boolean;
  /** The date the form opens on (read when the section mounts); today when omitted. The parent checks it. */
  initialDate?: string | undefined;
  /** Called once per confirmed save and once per confirmed deletion (never for a failed or unconfirmed one). */
  onChanged?: () => void;
  orgId: string;
  // The session's signal: ending or replacing the session silences every request of this section.
  signal: AbortSignal;
  timeZone: string;
  today: string;
}

// Mounted inside the Check-in screen, which the parent keys by session, person and organization: a change of any of
// them starts this section from an empty form and history, and its controllers are disposed with the old screen.
export function DailyMovementSection({ csrf, focusOnOpen = false, initialDate, onChanged, orgId, signal, timeZone, today }: DailyMovementSectionProps) {
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const [opening] = useState(() => ({ date: initialDate ?? today, focus: focusOnOpen }));
  const [dateInput, setDateInput] = useState(opening.date);
  const [draft, setDraft] = useState<MovementDraft>(emptyMovementDraft);
  const [showErrors, setShowErrors] = useState(false);
  const [day, setDay] = useState<MovementDaySnapshot>(() => loadingMovementDay(opening.date));
  const [history, setHistory] = useState<MovementHistorySnapshot>(loadingMovementHistory);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dayController = useRef<MovementDayController | null>(null);
  const historyController = useRef<MovementHistoryController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const afterLoaded = useRef<(existing: Parameters<typeof movementDraftFromView>[0] | null) => void>(() => undefined);
  afterLoaded.current = (existing) => {
    setShowErrors(false);
    setDraft(existing === null ? emptyMovementDraft : movementDraftFromView(existing));
  };

  const afterDeleted = useRef<() => void>(() => undefined);
  afterDeleted.current = () => {
    setConfirmingDelete(false);
    setShowErrors(false);
    setDraft(emptyMovementDraft);
    historyController.current?.refresh();
    onChangedRef.current?.();
    heading.current?.focus();
  };

  useEffect(() => {
    const next = new MovementHistoryController({ load: listDailyMovement, onChange: setHistory, orgId, signal, today });
    historyController.current = next;
    next.start();
    return () => {
      next.dispose();
      if (historyController.current === next) historyController.current = null;
    };
  }, [orgId, signal, today]);

  useEffect(() => {
    const next = new MovementDayController({
      csrf: () => csrfRef.current,
      date: opening.date,
      onChange: setDay,
      onDeleted: () => afterDeleted.current(),
      onLoaded: (_date, existing) => afterLoaded.current(existing),
      onSaved: () => {
        historyController.current?.refresh();
        onChangedRef.current?.();
      },
      orgId,
      read: readDailyMovement,
      remove: deleteDailyMovement,
      signal,
      timeZone,
      write: putDailyMovement,
    });
    dayController.current = next;
    next.start();
    return () => {
      next.dispose();
      if (dayController.current === next) dayController.current = null;
    };
  }, [opening, orgId, signal, timeZone, today]);

  useEffect(() => {
    if (!opening.focus) return;
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
  }, [opening]);

  const chooseDate = (value: string) => {
    setDateInput(value);
    setConfirmingDelete(false);
    if (checkInDateProblem(value, today) === null) dayController.current?.select(value);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    const validation = validateMovementDraft(draft);
    if (checkInDateProblem(dateInput, today) !== null || day.load !== 'ready' || !validation.ok) return;
    setConfirmingDelete(false);
    dayController.current?.save(validation.values);
  };

  const busy = day.save === 'pending' || day.deletion === 'pending';

  return (
    <section aria-labelledby="movement-title" className="movement-section search-results">
      <div className="search-panel__heading">
        <h2 id="movement-title" ref={heading} tabIndex={-1}>Movement</h2>
        <p>
          Steps and active energy for a day, entered by hand. Phone and watch synchronization is not connected yet, so
          nothing is imported automatically. Only you can see your movement: coaches and other members cannot, even for
          runs you share with them.
        </p>
      </div>
      <MovementFormView
        confirmingDelete={confirmingDelete}
        dateInput={dateInput}
        day={day}
        draft={draft}
        onCancelDelete={() => setConfirmingDelete(false)}
        onChangeDate={chooseDate}
        onChangeDraft={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onConfirmDelete={() => dayController.current?.deleteDay()}
        onRetry={() => dayController.current?.retry()}
        onStartDelete={() => setConfirmingDelete(true)}
        onSubmit={submit}
        showErrors={showErrors}
        timeZone={timeZone}
        today={today}
      />
      <MovementHistory
        disabled={busy}
        onEdit={chooseDate}
        onRetry={() => historyController.current?.retry()}
        selectedDate={day.date}
        snapshot={history}
      />
    </section>
  );
}
