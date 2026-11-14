import { MEAL_LOCAL_DATE_MIN, MEAL_NUTRITION_FIELDS, MEAL_TITLE_MAX_LENGTH, type MealView } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';

import { checkInDateProblem, formatCheckInDate, localDateIn } from './daily-checkin.js';
import { applyProposalToDraft, hasUnsavedDetails } from './meal-draft.js';
import { idleMealDraft, MealDraftController, type MealDraftScope, type MealDraftSnapshot } from './meal-draft-controller.js';
import { MealDraftPanel, type MealDraftPanelProps } from './MealDraftPanel.js';
import {
  confirmingMealDeletion,
  idleMealSave,
  loadingMealList,
  MealCreateController,
  MealDeletionController,
  MealEditController,
  MealListController,
  type MealCreator,
  type MealDeletionSnapshot,
  type MealListSnapshot,
  type MealLoader,
  type MealRemover,
  type MealSaveSnapshot,
  type MealUpdater,
} from './meal-log-controller.js';
import {
  emptyMealDraft,
  mealDraftFromView,
  mealSourceLabel,
  mealTypeLabels,
  mealTypeOptions,
  nutritionInputLabel,
  summarizeMeal,
  validateMealDraft,
  type MealDraft,
} from './meal-log.js';
import { defaultTimeZone } from './run-search.js';
import { createMeal, deleteMeal, listMeals, proposeMealDraft, updateMeal, type CsrfCredentials } from './runner-api.js';

// The Meal log (ADR-0083): log what you ate by hand, for a selected local date. Nutrition values are optional totals for
// the whole entry; nothing is estimated, looked up or judged. Only the person who logged an entry can see it.

export interface MealLogHandlers {
  askDelete: (view: MealView) => void;
  backToToday?: () => void;
  cancelDelete: () => void;
  cancelEdit: () => void;
  chooseDate: (value: string) => void;
  confirmDelete: () => void;
  edit: (view: MealView) => void;
  goToToday: () => void;
  loadMore: () => void;
  retryList: () => void;
  startNew: () => void;
  submit: (event: FormEvent) => void;
  update: (patch: Partial<MealDraft>) => void;
}

export interface MealLogViewProps {
  // A create, an edit or a deletion is in flight (ADR-0083: one mutation at a time). The date, the entry being edited
  // and the entry being deleted stay as they are until it settles.
  busy: boolean;
  dateInput: string;
  deletion: { mealId: string; snapshot: MealDeletionSnapshot } | null;
  draft: MealDraft;
  // The form's details came from an applied text draft (ADR-0092) and have not been saved yet.
  draftApplied?: boolean;
  // "Draft from text" (ADR-0092); omitted, the screen is the manual form only.
  draftPanel?: MealDraftPanelProps;
  // The entry being edited, or null for a new entry.
  editing: MealView | null;
  // Validation problems to show (after a save was attempted), or null.
  errors: string[] | null;
  formHeading?: RefObject<HTMLHeadingElement | null>;
  handlers: MealLogHandlers;
  list: MealListSnapshot;
  listHeading?: RefObject<HTMLHeadingElement | null>;
  notice: string | null;
  // Saving these details repeats the uncertain earlier attempt (no warning needed).
  repeatsUncertain: boolean;
  save: MealSaveSnapshot;
  timeZone: string;
  today: string;
}

function EntryCard({
  busy,
  deletion,
  editing,
  handlers,
  view,
}: Pick<MealLogViewProps, 'busy' | 'deletion' | 'editing' | 'handlers'> & { view: MealView }) {
  const label = `${mealTypeLabels[view.mealType].toLowerCase()} "${view.title}"`;
  const confirming = deletion?.mealId === view.mealId ? deletion.snapshot : null;
  const isEditing = editing?.mealId === view.mealId;
  return (
    <li className={confirming !== null ? 'run-card run-card--deleting' : 'run-card'}>
      <p className="eyebrow">{mealTypeLabels[view.mealType]}</p>
      <h3>{view.title}</h3>
      <dl aria-label={`Values of ${label}`}>
        {summarizeMeal(view).map((row) => (
          <div className={row.value === 'Not recorded' ? 'today-rows__missing' : undefined} key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="meal-card__source">
        <span className="review-badge">{mealSourceLabel(view.source)}</span>
        {isEditing && ' Editing now.'}
      </p>
      {confirming === null && (
        <div className="run-card__actions">
          <button aria-label={`Edit ${label}`} disabled={busy || isEditing} onClick={() => handlers.edit(view)} type="button">
            Edit
          </button>
          <button aria-label={`Delete ${label}`} disabled={busy} onClick={() => handlers.askDelete(view)} type="button">
            Delete
          </button>
        </div>
      )}
      {confirming !== null && (
        <section aria-label={`Delete ${label}?`} className="run-delete">
          <h4>Delete this entry?</h4>
          <p className="run-delete__warning">It is removed permanently. This cannot be undone.</p>
          {confirming.message !== null && <p className="run-delete__failure" role="alert">{confirming.message}</p>}
          <div className="run-delete__actions">
            <button
              className="finish-action"
              disabled={busy || confirming.phase === 'unavailable'}
              onClick={handlers.confirmDelete}
              type="button"
            >
              {confirming.phase === 'pending' ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button disabled={busy} onClick={handlers.cancelDelete} type="button">Cancel</button>
          </div>
        </section>
      )}
    </li>
  );
}

/** Everything the screen shows, from its state. Pure, so every state is testable without a DOM. */
export function MealLogView(props: MealLogViewProps) {
  const { busy, dateInput, deletion, draft, draftApplied = false, draftPanel, editing, errors, handlers, list, notice, repeatsUncertain, save, timeZone, today } = props;
  const dateProblem = checkInDateProblem(dateInput, today);
  const dateLabel = formatCheckInDate(list.localDate);
  const pending = save.phase === 'pending';
  const alreadySaved = editing === null && save.phase === 'already-saved';
  return (
    <section aria-labelledby="meal-log-title" className="activity-shell meal-log">
      <div className="search-panel__heading">
        <p className="eyebrow">Nutrition</p>
        <h1 id="meal-log-title" tabIndex={-1}>Meal log</h1>
        <p>
          Log what you ate by hand. The values you enter are totals for the whole entry, not per 100 g, and every value is
          optional: leave it empty if you do not know it. Nothing is estimated or looked up. Only you can see your meal log.
        </p>
        {handlers.backToToday !== undefined && (
          <button className="meal-log__back" onClick={handlers.backToToday} type="button">Back to Today</button>
        )}
      </div>

      <div className="today-controls">
        <label>
          Date
          <input disabled={busy} max={today} min={MEAL_LOCAL_DATE_MIN} onChange={(event) => handlers.chooseDate(event.target.value)} type="date" value={dateInput} />
        </label>
        <button disabled={busy || (list.localDate === today && dateProblem === null)} onClick={handlers.goToToday} type="button">Go to today</button>
      </div>
      {dateProblem !== null && <p className="activity-form__failure" role="alert">{dateProblem}</p>}
      <p className="today-day">
        Showing <strong>{dateLabel}</strong>{list.localDate === today ? ' (today)' : ''}. New entries are saved in the time zone {timeZone}.
      </p>

      {draftPanel !== undefined && <MealDraftPanel {...draftPanel} />}

      <form aria-labelledby="meal-form-title" className="search-filters activity-form meal-form" noValidate onSubmit={handlers.submit}>
        <h2 id="meal-form-title" ref={props.formHeading} tabIndex={-1}>
          {editing === null ? `Add an entry for ${dateLabel}` : `Edit "${editing.title}"`}
        </h2>
        <label>
          Meal type
          <select onChange={(event) => handlers.update({ mealType: event.target.value as MealDraft['mealType'] })} value={draft.mealType}>
            {mealTypeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="activity-form__notes">
          Title
          <input maxLength={MEAL_TITLE_MAX_LENGTH * 2} onChange={(event) => handlers.update({ title: event.target.value })} value={draft.title} />
        </label>
        <fieldset className="meal-form__values">
          <legend>Nutrition for the whole entry (optional)</legend>
          {MEAL_NUTRITION_FIELDS.map((field) => (
            <label key={field}>
              {nutritionInputLabel(field)}
              <input inputMode="decimal" onChange={(event) => handlers.update({ [field]: event.target.value })} value={draft[field]} />
            </label>
          ))}
          <p className="meal-form__hint">
            Empty means not recorded (unknown); 0 means none. At most one decimal. Food energy is what you ate as you
            record it here; it is kept apart from the active energy in your movement.
          </p>
        </fieldset>
        <p className="meal-card__source">
          Source: <span className="review-badge">{mealSourceLabel('manual')}</span>
        </p>
        {draftApplied && editing === null && (
          <p className="meal-draft__applied" role="status">
            Filled in from your text and not saved yet. Check every value and change anything that is wrong. When you save,
            the entry is stored as manually entered, because you confirm each value yourself.
          </p>
        )}
        {errors !== null && errors.length > 0 && (
          <ul aria-label="Problems with the entry" className="search-filters__errors">
            {errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        )}
        {editing === null && save.uncertain && !repeatsUncertain && !pending && (
          <p className="activity-form__warning">
            Your previous save may already have gone through. Saving these changed details is still safe: if it did, no
            second entry is created and you are told so.
          </p>
        )}
        {alreadySaved && (
          <div className="activity-form__warning" role="alert">
            <p>{save.message}</p>
            <button onClick={handlers.startNew} type="button">Start a new entry</button>
          </div>
        )}
        <div className="activity-form__actions">
          <button className="primary-action" disabled={busy || alreadySaved || dateProblem !== null} type="submit">
            {pending ? 'Saving…' : editing === null ? 'Add entry' : 'Save changes'}
          </button>
          {editing !== null && (
            <button disabled={busy} onClick={handlers.cancelEdit} type="button">Cancel edit</button>
          )}
          <p className={save.phase === 'failed' ? 'activity-form__failure' : 'activity-form__status'} role="status">
            {alreadySaved ? '' : save.message ?? ''}
          </p>
        </div>
      </form>

      <section aria-labelledby="meal-list-title" className="search-results">
        <h2 id="meal-list-title" ref={props.listHeading} tabIndex={-1}>Entries for {dateLabel}</h2>
        <p className="search-panel__notice" role="status">{notice ?? ''}</p>
        <div aria-busy={list.status === 'loading' || list.loadingMore} data-meal-list-state={list.status}>
          {list.status === 'loading' && <p className="search-results__loading">Loading your entries for {dateLabel}…</p>}
          {(list.status === 'error' || list.status === 'access-denied') && (
            <div className="run-share__failure" role="alert">
              <span>{list.message}</span>
              <button onClick={handlers.retryList} type="button">Retry</button>
            </div>
          )}
          {list.status === 'ready' && list.items.length === 0 && (
            <p className="search-results__empty">Nothing is logged for {dateLabel} yet. Saved entries appear here in the order you log them.</p>
          )}
          {list.status === 'ready' && list.items.length > 0 && (
            <ul aria-label={`Entries for ${dateLabel}`} className="run-cards">
              {list.items.map((view) => (
                <EntryCard busy={busy} deletion={deletion} editing={editing} handlers={handlers} key={view.mealId} view={view} />
              ))}
            </ul>
          )}
          {list.status === 'ready' && list.moreMessage !== null && (
            <div className="run-share__failure" role="alert">
              <span>{list.moreMessage}</span>
              <button onClick={handlers.retryList} type="button">{list.outdated ? 'Refresh' : 'Retry'}</button>
            </div>
          )}
          {list.status === 'ready' && list.hasMore && list.moreMessage === null && (
            <button disabled={list.loadingMore} onClick={handlers.loadMore} type="button">{list.loadingMore ? 'Loading…' : 'Load more'}</button>
          )}
        </div>
      </section>
    </section>
  );
}

export interface MealLogApi {
  create: MealCreator;
  list: MealLoader;
  propose: typeof proposeMealDraft;
  remove: MealRemover;
  update: MealUpdater;
}

const defaultApi: MealLogApi = { create: createMeal, list: listMeals, propose: proposeMealDraft, remove: deleteMeal, update: updateMeal };

export interface MealLogScreenProps {
  csrf: CsrfCredentials;
  /** The date to open with (from a Today action); null or an invalid date opens today. */
  initialDate: string | null;
  /** Returns to Today on the date shown here; Today reads that date again when it opens. */
  onBackToToday?: (localDate: string) => void;
  orgId: string;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
  // For tests.
  api?: MealLogApi;
  newKey?: () => string;
  nowMs?: number;
  timeZone?: string;
}

interface DeletionSelection {
  id: number;
  mealId: string;
}

// The parent keys this screen by session, person and organization, so a change of any of them starts from a clean form
// and list with no request carried over.
export function MealLogScreen({ api = defaultApi, csrf, initialDate, newKey, nowMs, onBackToToday, orgId, signal, timeZone: zone }: MealLogScreenProps) {
  const timeZone = useMemo(() => zone ?? defaultTimeZone(), [zone]);
  const today = useMemo(() => localDateIn(timeZone, nowMs ?? Date.now()), [nowMs, timeZone]);
  const openingDate = initialDate !== null && checkInDateProblem(initialDate, today) === null ? initialDate : today;
  const openingRef = useRef(openingDate);
  const apiRef = useRef(api);
  const keyRef = useRef(newKey ?? (() => crypto.randomUUID()));
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;

  const [dateInput, setDateInput] = useState(openingDate);
  const [list, setList] = useState<MealListSnapshot>(() => loadingMealList(openingDate));
  const [draft, setDraft] = useState<MealDraft>(emptyMealDraft);
  const [showErrors, setShowErrors] = useState(false);
  const [editing, setEditing] = useState<MealView | null>(null);
  const [createSave, setCreateSave] = useState<MealSaveSnapshot>(idleMealSave);
  const [editSave, setEditSave] = useState<MealSaveSnapshot>(idleMealSave);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<DeletionSelection | null>(null);
  const [deletionState, setDeletionState] = useState<{ id: number; snapshot: MealDeletionSnapshot } | null>(null);
  const nextDeletionId = useRef(1);
  // "Draft from text" (ADR-0092).
  const [draftText, setDraftText] = useState('');
  const [draftSnapshot, setDraftSnapshot] = useState<MealDraftSnapshot>(idleMealDraft);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [draftApplied, setDraftApplied] = useState(false);
  const drafter = useRef<MealDraftController | null>(null);

  const lister = useRef<MealListController | null>(null);
  const creator = useRef<MealCreateController | null>(null);
  const editor = useRef<MealEditController | null>(null);
  const deleter = useRef<MealDeletionController | null>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);

  // Callbacks of long-lived controllers read the latest render through refs.
  const afterCreated = useRef<() => void>(() => undefined);
  afterCreated.current = () => {
    lister.current?.refresh();
    setShowErrors(false);
    setDraftApplied(false);
    setDraft((current) => ({ ...emptyMealDraft, mealType: current.mealType }));
  };
  const afterAlreadySaved = useRef<() => void>(() => undefined);
  afterAlreadySaved.current = () => lister.current?.refresh();
  // A deleted entry that was being edited ends the edit, so its values do not stay in the form as a new entry.
  const afterDeleted = useRef<(mealId: string) => void>(() => undefined);
  afterDeleted.current = (mealId) => {
    if (editing?.mealId === mealId) {
      setDraftApplied(false);
      setEditing(null);
      setEditSave(idleMealSave);
      setShowErrors(false);
      setDraft((current) => ({ ...emptyMealDraft, mealType: current.mealType }));
    }
    lister.current?.refresh();
    setNotice('The entry was deleted.');
    listHeading.current?.focus();
  };

  useEffect(() => {
    const next = new MealListController({ load: apiRef.current.list, localDate: openingRef.current, onChange: setList, orgId, signal });
    lister.current = next;
    setList(next.snapshot);
    next.start();
    return () => {
      next.dispose();
      if (lister.current === next) lister.current = null;
    };
  }, [orgId, signal]);

  // One draft controller per organization, session and zone. Ending the session disposes it, so a late proposal can never
  // reach another person's or another session's form.
  useEffect(() => {
    const next = new MealDraftController({
      load: (input, requestSignal) => apiRef.current.propose(input, csrfRef.current, requestSignal),
      onChange: setDraftSnapshot,
      orgId,
      signal,
      timeZone,
    });
    drafter.current = next;
    setDraftSnapshot(next.snapshot);
    return () => {
      next.dispose();
      if (drafter.current === next) drafter.current = null;
    };
  }, [orgId, signal, timeZone]);

  useEffect(() => {
    const next = new MealCreateController({
      create: apiRef.current.create,
      csrf: () => csrfRef.current,
      newKey: () => keyRef.current(),
      onAlreadySaved: () => afterAlreadySaved.current(),
      onChange: setCreateSave,
      onSaved: () => afterCreated.current(),
      orgId,
      signal,
      timeZone,
    });
    creator.current = next;
    return () => {
      next.dispose();
      if (creator.current === next) creator.current = null;
    };
  }, [orgId, signal, timeZone]);

  // One edit controller per entry being edited (not per refresh of the edited entry).
  const editingId = editing?.mealId ?? null;
  useEffect(() => {
    if (editingId === null) return;
    const mealId = editingId;
    const next = new MealEditController({
      csrf: () => csrfRef.current,
      mealId,
      onChange: setEditSave,
      onSaved: (view) => {
        lister.current?.refresh();
        setEditing(null);
        setEditSave(idleMealSave);
        setShowErrors(false);
        setDraft((current) => ({ ...emptyMealDraft, mealType: current.mealType }));
        setNotice(`Your changes to "${view.title}" were saved.`);
        listHeading.current?.focus();
      },
      orgId,
      signal,
      update: apiRef.current.update,
    });
    editor.current = next;
    return () => {
      next.dispose();
      if (editor.current === next) editor.current = null;
    };
  }, [editingId, orgId, signal]);

  useEffect(() => {
    if (deletion === null) return;
    const selection = deletion;
    const next = new MealDeletionController({
      csrf: () => csrfRef.current,
      mealId: selection.mealId,
      onChange: (snapshot) => setDeletionState({ id: selection.id, snapshot }),
      onDeleted: () => {
        setDeletion((current) => (current?.id === selection.id ? null : current));
        afterDeleted.current(selection.mealId);
      },
      orgId,
      remove: apiRef.current.remove,
      signal,
    });
    deleter.current = next;
    return () => {
      next.dispose();
      if (deleter.current === next) deleter.current = null;
    };
  }, [deletion, orgId, signal]);

  const validation = validateMealDraft(draft);
  const save = editing === null ? createSave : editSave;
  const deletionSnapshot = deletion !== null && deletionState?.id === deletion.id ? deletionState.snapshot : confirmingMealDeletion;
  // One mutation at a time (ADR-0083). While one is in flight its target and the shown date stay fixed: the controls are
  // disabled and every handler that would change the date, the entry being edited or deleted, or start another mutation
  // returns without effect, so a failed save can only be retried against the entry and date it was made for.
  const busy = createSave.phase === 'pending' || editSave.phase === 'pending' || (deletion !== null && deletionSnapshot.phase === 'pending');
  const repeatsUncertain = editing === null && validation.ok && creator.current?.wouldReuse(list.localDate, validation.details) === true;

  // Whatever proposal is pending or shown stops applying: the text, the date or the edit target changed.
  const dropDraft = () => {
    drafter.current?.invalidate();
    setConfirmingReplace(false);
  };

  const leaveEdit = () => {
    if (busy) return;
    setDraftApplied(false);
    setEditing(null);
    setEditSave(idleMealSave);
    setShowErrors(false);
    setDraft((current) => ({ ...emptyMealDraft, mealType: current.mealType }));
  };

  const chooseDate = (value: string) => {
    if (busy) return;
    setDateInput(value);
    if (checkInDateProblem(value, today) !== null) return;
    setNotice(null);
    setDeletion(null);
    // A proposal was asked for the date shown; it is never applied to another one.
    dropDraft();
    // An entry belongs to its date: editing it ends when another date is shown.
    if (editing !== null) leaveEdit();
    if (createSave.phase === 'saved') creator.current?.acknowledge();
    lister.current?.select(value);
  };

  const handlers: MealLogHandlers = {
    askDelete: (view) => {
      if (busy) return;
      setNotice(null);
      setDeletion({ id: nextDeletionId.current++, mealId: view.mealId });
    },
    ...(onBackToToday === undefined ? {} : { backToToday: () => onBackToToday(list.localDate) }),
    cancelDelete: () => {
      if (!busy) setDeletion(null);
    },
    cancelEdit: leaveEdit,
    chooseDate,
    confirmDelete: () => {
      if (!busy) deleter.current?.confirm();
    },
    edit: (view) => {
      if (busy || creator.current?.pending === true) return;
      // A draft only ever fills a new entry, never the entry being edited.
      dropDraft();
      setDraftApplied(false);
      setNotice(null);
      setShowErrors(false);
      setEditSave(idleMealSave);
      setEditing(view);
      setDraft(mealDraftFromView(view));
      formHeading.current?.focus();
    },
    goToToday: () => chooseDate(today),
    loadMore: () => lister.current?.loadMore(),
    retryList: () => lister.current?.retry(),
    startNew: () => {
      creator.current?.startNew();
      setDraftApplied(false);
      setShowErrors(false);
      setDraft((current) => ({ ...emptyMealDraft, mealType: current.mealType }));
    },
    submit: (event) => {
      event.preventDefault();
      setShowErrors(true);
      setNotice(null);
      if (busy || !validation.ok || checkInDateProblem(dateInput, today) !== null) return;
      if (editing !== null) editor.current?.submit(validation.details);
      else creator.current?.submit(list.localDate, validation.details);
    },
    update: (patch) => {
      setDraft((current) => ({ ...current, ...patch }));
      if (editing === null) creator.current?.acknowledge();
    },
  };

  const alreadySaved = createSave.phase === 'already-saved';
  const editMessage = 'Finish or cancel the edit first: a draft only fills a new entry.';
  const applyBlocked =
    editing !== null
      ? editMessage
      : busy
        ? 'Wait until the current save or deletion has finished.'
        : alreadySaved
          ? 'Your earlier save went through. Press "Start a new entry" in the form first.'
          : null;
  // The proposal on screen, only while it still belongs to this exact text and the date the form saves to.
  const currentProposal =
    draftSnapshot.status === 'proposal' && sameScope(draftSnapshot.scope, { localDate: list.localDate, text: draftText }) ? draftSnapshot.proposal : null;
  const applyNow = () => {
    if (currentProposal === null || applyBlocked !== null) return;
    setDraft((current) => applyProposalToDraft(currentProposal, current));
    setShowErrors(false);
    setNotice(null);
    creator.current?.acknowledge();
    drafter.current?.invalidate();
    setConfirmingReplace(false);
    setDraftApplied(true);
    formHeading.current?.focus();
  };
  const draftPanel: MealDraftPanelProps = {
    applyBlocked,
    confirmingReplace,
    handlers: {
      apply: () => {
        if (currentProposal === null || applyBlocked !== null) return;
        // Never replace details the person has not saved without asking.
        if (hasUnsavedDetails(draft)) setConfirmingReplace(true);
        else applyNow();
      },
      cancel: dropDraft,
      confirmReplace: applyNow,
      discard: dropDraft,
      keepForm: () => setConfirmingReplace(false),
      propose: () => {
        if (editing !== null) return;
        setConfirmingReplace(false);
        drafter.current?.submit(draftText, list.localDate);
      },
      textChange: (text) => {
        setDraftText(text);
        dropDraft();
      },
    },
    proposeBlocked: editing !== null ? editMessage : null,
    snapshot: draftSnapshot.status === 'proposal' && currentProposal === null ? idleMealDraft : draftSnapshot,
    text: draftText,
  };

  return (
    <MealLogView
      busy={busy}
      dateInput={dateInput}
      deletion={deletion === null ? null : { mealId: deletion.mealId, snapshot: deletionSnapshot }}
      draft={draft}
      draftApplied={draftApplied}
      draftPanel={draftPanel}
      editing={editing}
      errors={showErrors && !validation.ok ? validation.errors : null}
      formHeading={formHeading}
      handlers={handlers}
      list={list}
      listHeading={listHeading}
      notice={notice}
      repeatsUncertain={repeatsUncertain}
      save={save}
      timeZone={timeZone}
      today={today}
    />
  );
}

function sameScope(left: MealDraftScope, right: MealDraftScope): boolean {
  return left.localDate === right.localDate && left.text === right.text;
}
