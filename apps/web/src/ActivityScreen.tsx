import { ACTIVITY_NOTES_MAX_LENGTH, ACTIVITY_TYPES } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  ActivityDeletionController,
  ActivitySubmissionController,
  confirmingActivityDeletion,
  idleSubmission,
  type ActivityDeletionSnapshot,
  type ActivitySubmissionSnapshot,
} from './activity-controller.js';
import {
  activityTypeLabels,
  defaultActivityDraft,
  validateActivityDraft,
  type ActivityDraft,
} from './activity-form.js';
import {
  ActivityHistoryController,
  historyFilterKey,
  loadingActivityHistory,
  noHistoryFilters,
  type ActivityHistoryFilters,
  type ActivityHistorySnapshot,
} from './activity-history-controller.js';
import { ActivityAlreadySaved, type SavedActivityView } from './ActivityAlreadySaved.js';
import { ActivityHistoryList } from './ActivityHistoryList.js';
import { GpxImportPanel } from './GpxImportPanel.js';
import { RunDetailScreen } from './RunDetailScreen.js';
import { defaultTimeZone } from './run-search.js';
import {
  createActivity,
  deleteActivity,
  loadActivityHistory,
  readActivity,
  type CsrfCredentials,
} from './runner-api.js';

export interface ActivityScreenProps {
  // The public Mapbox token for a recorded run's route in its details, or null (the details then say so).
  accessToken?: string | null;
  csrf: CsrfCredentials;
  orgId: string;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
  userId: string;
}

interface DeletionSelection {
  activityId: string;
  id: number;
  label: string;
}

interface RunDetailSelection {
  runId: string;
  scope: string;
  session: AbortSignal;
}

// Activities of the signed-in person: entered by hand (ADR-0072) or imported from a GPX file (ADR-0086), listed with
// their own finished recorded runs in one history (ADR-0087). The parent keys it by session, person and organization,
// so a change of any of them starts from a clean form, import, filters and history with no request carried over.
// Owner-only: nothing here is visible to a coach or another member.
export function ActivityScreen({ accessToken = null, csrf, orgId, signal, userId }: ActivityScreenProps) {
  const timeZone = useMemo(() => defaultTimeZone(), []);
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const [draft, setDraft] = useState<ActivityDraft>(() => defaultActivityDraft(new Date()));
  const [showErrors, setShowErrors] = useState(false);
  const [filters, setFilters] = useState<ActivityHistoryFilters>(noHistoryFilters);
  const filterKey = historyFilterKey(filters);
  const [historyState, setHistoryState] = useState<{ key: string; snapshot: ActivityHistorySnapshot } | null>(null);
  // A snapshot of other filters is never shown: until the new controller answers, the history is loading.
  const history = historyState?.key === filterKey ? historyState.snapshot : loadingActivityHistory(filters);
  const [submission, setSubmission] = useState<ActivitySubmissionSnapshot>(idleSubmission);
  const [notice, setNotice] = useState<string | null>(null);
  const lister = useRef<ActivityHistoryController | null>(null);
  const submitter = useRef<ActivitySubmissionController | null>(null);
  const identityScope = `${userId}|${orgId}`;
  const [runDetail, setRunDetail] = useState<RunDetailSelection | null>(null);
  const selectedRun = runDetail?.scope === identityScope && runDetail.session === signal && !signal.aborted ? runDetail : null;
  if (runDetail !== null && selectedRun === null) setRunDetail(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const validation = validateActivityDraft(draft, Date.now());
  const pending = submission.phase === 'pending';
  const alreadySaved = submission.phase === 'already-saved';
  const repeatsUncertain = validation.ok && submitter.current?.wouldReuse(validation.request) === true;
  const [savedView, setSavedView] = useState<SavedActivityView>({ status: 'closed' });
  const opener = useRef<AbortController | null>(null);

  const freshDraft = (current: ActivityDraft): ActivityDraft => ({
    ...defaultActivityDraft(new Date()),
    type: current.type,
    unit: current.unit,
  });

  const afterSaved = useRef<() => void>(() => undefined);
  afterSaved.current = () => {
    lister.current?.refresh();
    setNotice(null);
    setShowErrors(false);
    setDraft(freshDraft);
  };

  // The earlier save of this form went through (ADR-0073): the list must show it.
  const afterAlreadySaved = useRef<() => void>(() => undefined);
  afterAlreadySaved.current = () => {
    lister.current?.refresh();
    setSavedView({ status: 'closed' });
  };

  const openSaved = () => {
    const activityId = submission.savedActivityId;
    if (activityId === null || signal.aborted) return;
    opener.current?.abort();
    const request = new AbortController();
    opener.current = request;
    setSavedView({ status: 'loading' });
    readActivity({ activityId, orgId }, request.signal).then(
      (activity) => {
        if (opener.current === request && !signal.aborted) setSavedView({ activity, status: 'ready' });
      },
      () => {
        if (opener.current === request && !signal.aborted) {
          setSavedView({ message: 'The saved activity could not be opened. It is in your list of activities below.', status: 'error' });
        }
      },
    );
  };

  const startNew = () => {
    opener.current?.abort();
    opener.current = null;
    submitter.current?.startNew();
    setSavedView({ status: 'closed' });
    setShowErrors(false);
    setDraft(freshDraft);
  };

  useEffect(() => {
    const stop = () => opener.current?.abort();
    signal.addEventListener('abort', stop, { once: true });
    return () => {
      signal.removeEventListener('abort', stop);
      stop();
    };
  }, [signal]);

  // One history controller per organization, filter pair and session: changing a filter disposes the previous one,
  // which aborts its request and silences any answer it would still have produced.
  const { source: sourceFilter, type: typeFilter } = filters;
  useEffect(() => {
    const key = historyFilterKey({ source: sourceFilter, type: typeFilter });
    const next = new ActivityHistoryController({
      filters: { source: sourceFilter, type: typeFilter },
      load: loadActivityHistory,
      onChange: (snapshot) => setHistoryState({ key, snapshot }),
      orgId,
      signal,
    });
    lister.current = next;
    next.start();
    return () => {
      next.dispose();
      if (lister.current === next) lister.current = null;
    };
  }, [orgId, signal, sourceFilter, typeFilter]);

  useEffect(() => {
    const next = new ActivitySubmissionController({
      create: createActivity,
      csrf: () => csrfRef.current,
      newId: () => crypto.randomUUID(),
      newKey: () => crypto.randomUUID(),
      onAlreadySaved: () => afterAlreadySaved.current(),
      onChange: setSubmission,
      onSaved: () => afterSaved.current(),
      orgId,
      signal,
    });
    submitter.current = next;
    return () => {
      next.dispose();
      if (submitter.current === next) submitter.current = null;
    };
  }, [orgId, signal]);

  // Deletion: one confirmation at a time, a controller per opening.
  const [deletion, setDeletion] = useState<DeletionSelection | null>(null);
  const [deletionState, setDeletionState] = useState<{ id: number; snapshot: ActivityDeletionSnapshot } | null>(null);
  const nextDeletionId = useRef(1);
  const deleter = useRef<ActivityDeletionController | null>(null);
  const deletionSnapshot = deletion !== null && deletionState?.id === deletion.id ? deletionState.snapshot : confirmingActivityDeletion;

  const afterDeleted = useRef<(selection: DeletionSelection) => void>(() => undefined);
  afterDeleted.current = (selection) => {
    setDeletion((current) => (current?.id === selection.id ? null : current));
    lister.current?.refresh();
    setNotice(`Your ${selection.label} was deleted.`);
    heading.current?.focus();
  };

  useEffect(() => {
    if (deletion === null) return;
    const selection = deletion;
    const next = new ActivityDeletionController({
      activityId: selection.activityId,
      csrf: () => csrfRef.current,
      deleteActivity,
      onChange: (changed) => setDeletionState({ id: selection.id, snapshot: changed }),
      onDeleted: () => afterDeleted.current(selection),
      orgId,
      signal,
    });
    deleter.current = next;
    return () => {
      next.dispose();
      if (deleter.current === next) deleter.current = null;
    };
  }, [deletion, orgId, signal]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    setNotice(null);
    if (!validation.ok) return;
    submitter.current?.submit(validation.request);
  };

  const update = (patch: Partial<ActivityDraft>) => setDraft((current) => ({ ...current, ...patch }));

  // A filter change starts a new history: no confirmation of the previous list stays open and its notice is dropped.
  const changeFilters = (next: ActivityHistoryFilters) => {
    setDeletion(null);
    setNotice(null);
    setFilters(next);
  };

  const openRun = (runId: string) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDeletion(null);
    setRunDetail({ runId, scope: identityScope, session: signal });
  };

  const closeRun = () => {
    setRunDetail(null);
    requestAnimationFrame(() => {
      const trigger = returnFocus.current;
      if (trigger?.isConnected) trigger.focus();
      else document.getElementById('activity-history-title')?.focus();
    });
  };

  return (
    <section aria-labelledby={selectedRun === null ? 'activity-title' : 'run-detail-title'} className="activity-shell">
      <div className="activity-overview" hidden={selectedRun !== null}>
      <div className="search-panel__heading">
        <p className="eyebrow">Activity log</p>
        <h1 id="activity-title" ref={heading} tabIndex={-1}>Activity</h1>
        <p>
          Log a ride, a swim, a strength session or any other activity by hand, or import one from a GPX file. Only you can
          see your activities: coaches and other members cannot, even for runs you share with them.
        </p>
      </div>

      <form aria-label="Add an activity" className="search-filters activity-form" noValidate onSubmit={submit}>
        <label>
          Type
          <select onChange={(event) => update({ type: event.target.value as ActivityDraft['type'] })} value={draft.type}>
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>{activityTypeLabels[type]}</option>
            ))}
          </select>
        </label>
        <label>
          Started
          <input onChange={(event) => update({ startedAtLocal: event.target.value })} type="datetime-local" value={draft.startedAtLocal} />
        </label>
        <fieldset className="activity-form__duration">
          <legend>Duration</legend>
          <label>
            Hours
            <input inputMode="numeric" onChange={(event) => update({ hours: event.target.value.trim() })} value={draft.hours} />
          </label>
          <label>
            Minutes
            <input inputMode="numeric" onChange={(event) => update({ minutes: event.target.value.trim() })} value={draft.minutes} />
          </label>
          <label>
            Seconds
            <input inputMode="numeric" onChange={(event) => update({ seconds: event.target.value.trim() })} value={draft.seconds} />
          </label>
        </fieldset>
        <label>
          Distance (optional)
          <input inputMode="decimal" onChange={(event) => update({ distance: event.target.value.trim() })} value={draft.distance} />
        </label>
        <label>
          Unit
          <select onChange={(event) => update({ unit: event.target.value as ActivityDraft['unit'] })} value={draft.unit}>
            <option value="km">Kilometres</option>
            <option value="mi">Miles</option>
          </select>
        </label>
        <label>
          Effort (RPE, optional)
          <select onChange={(event) => update({ rpe: event.target.value })} value={draft.rpe}>
            <option value="">Not rated</option>
            {Array.from({ length: 10 }, (_, index) => String(index + 1)).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="activity-form__notes">
          Notes (optional)
          <textarea maxLength={ACTIVITY_NOTES_MAX_LENGTH} onChange={(event) => update({ notes: event.target.value })} rows={2} value={draft.notes} />
        </label>
        {showErrors && !validation.ok && (
          <ul aria-label="Problems with the activity" className="search-filters__errors">
            {validation.errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        )}
        {submission.uncertain && validation.ok && !repeatsUncertain && (
          <p className="activity-form__warning">
            Your previous save may already have gone through. Saving these changed details is still safe: if it did, no
            second activity is created and you are told so.
          </p>
        )}
        {alreadySaved && (
          <ActivityAlreadySaved
            onOpen={openSaved}
            onStartNew={startNew}
            savedActivityId={submission.savedActivityId}
            timeZone={timeZone}
            unit={draft.unit}
            view={savedView}
          />
        )}
        <div className="activity-form__actions">
          <button className="primary-action" disabled={pending || alreadySaved} type="submit">
            {pending ? 'Saving…' : 'Save activity'}
          </button>
          <p className={submission.phase === 'failed' ? 'activity-form__failure' : 'activity-form__status'} role="status">
            {alreadySaved ? '' : submission.message ?? ''}
          </p>
        </div>
      </form>

      <GpxImportPanel
        csrf={csrf}
        onImported={() => {
          setNotice(null);
          lister.current?.refresh();
        }}
        orgId={orgId}
        signal={signal}
        timeZone={timeZone}
        unit={draft.unit}
      />

      <ActivityHistoryList
        deletion={deletion === null ? null : { activityId: deletion.activityId, snapshot: deletionSnapshot }}
        filters={filters}
        history={history}
        notice={notice}
        onCancelDelete={() => setDeletion(null)}
        onConfirmDelete={() => deleter.current?.confirm()}
        onDelete={(activityId, label) => {
          setNotice(null);
          setDeletion({ activityId, id: nextDeletionId.current++, label });
        }}
        onFiltersChange={changeFilters}
        onLoadMore={() => lister.current?.loadMore()}
        onOpenRun={openRun}
        onRefresh={() => {
          setNotice(null);
          lister.current?.refresh();
        }}
        onRetry={() => lister.current?.retry()}
        timeZone={timeZone}
        unit={draft.unit}
      />
      </div>
      {selectedRun !== null && (
        <RunDetailScreen
          accessToken={accessToken}
          backLabel="Back to activity history"
          key={`${identityScope}|${selectedRun.runId}`}
          onBack={closeRun}
          orgId={orgId}
          runId={selectedRun.runId}
          signal={signal}
          timeZone={timeZone}
          unit={draft.unit}
          userId={userId}
        />
      )}
    </section>
  );
}
