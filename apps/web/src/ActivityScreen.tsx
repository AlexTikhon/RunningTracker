import { ACTIVITY_NOTES_MAX_LENGTH, ACTIVITY_TYPES, type ActivityView } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  ActivityDeletionController,
  ActivityListController,
  ActivitySubmissionController,
  confirmingActivityDeletion,
  idleSubmission,
  loadingActivityList,
  type ActivityDeletionSnapshot,
  type ActivityListSnapshot,
  type ActivitySubmissionSnapshot,
} from './activity-controller.js';
import {
  activityDurationLabels,
  activitySourceLabels,
  activityTypeLabels,
  defaultActivityDraft,
  validateActivityDraft,
  type ActivityDraft,
} from './activity-form.js';
import { ActivityAlreadySaved, type SavedActivityView } from './ActivityAlreadySaved.js';
import { GpxImportPanel } from './GpxImportPanel.js';
import { defaultTimeZone, formatDistance, formatDuration, formatStartedAt } from './run-search.js';
import {
  createActivity,
  deleteActivity,
  listActivities,
  readActivity,
  type CsrfCredentials,
} from './runner-api.js';

export interface ActivityScreenProps {
  csrf: CsrfCredentials;
  orgId: string;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
}

interface DeletionSelection {
  activityId: string;
  id: number;
  label: string;
}

function describeActivity(activity: ActivityView, timeZone: string): string {
  return `${activityTypeLabels[activity.type].toLowerCase()} of ${formatStartedAt(activity.startedAt, timeZone)}`;
}

// Activities of the signed-in person: entered by hand (ADR-0072) or imported from a GPX file (ADR-0086). The parent keys
// it by session, person and organization, so a change of any of them starts from a clean form, import and list with no
// request carried over. Owner-only: nothing here is visible to a coach or another member.
export function ActivityScreen({ csrf, orgId, signal }: ActivityScreenProps) {
  const timeZone = useMemo(() => defaultTimeZone(), []);
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const [draft, setDraft] = useState<ActivityDraft>(() => defaultActivityDraft(new Date()));
  const [showErrors, setShowErrors] = useState(false);
  const [list, setList] = useState<ActivityListSnapshot>(loadingActivityList);
  const [submission, setSubmission] = useState<ActivitySubmissionSnapshot>(idleSubmission);
  const [notice, setNotice] = useState<string | null>(null);
  const lister = useRef<ActivityListController | null>(null);
  const submitter = useRef<ActivitySubmissionController | null>(null);
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

  useEffect(() => {
    const next = new ActivityListController({ load: listActivities, onChange: setList, orgId, signal });
    lister.current = next;
    next.start();
    return () => {
      next.dispose();
      if (lister.current === next) lister.current = null;
    };
  }, [orgId, signal]);

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
  const deletionPending = deletion !== null && deletionSnapshot.phase === 'pending';

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

  return (
    <section aria-labelledby="activity-title" className="activity-shell">
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

      <section aria-labelledby="activity-list-title" className="search-results">
        <h2 id="activity-list-title">Your activities</h2>
        <p className="search-results__note">
          Times are shown in {timeZone}. Distances in {draft.unit === 'km' ? 'kilometres' : 'miles'}. A GPX import shows its
          elapsed time (pauses included), not moving time.
        </p>
        <p className="search-panel__notice" role="status">{notice ?? ''}</p>
        {list.status === 'loading' && <p className="search-results__loading">Loading your activities…</p>}
        {(list.status === 'error' || list.status === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{list.message}</span>
            <button onClick={() => lister.current?.retry()} type="button">Retry</button>
          </div>
        )}
        {list.status === 'ready' && list.items.length === 0 && (
          <p className="search-results__empty">No activities yet. Saved activities appear here, newest first.</p>
        )}
        {list.status === 'ready' && list.items.length > 0 && (
          <ul aria-label="Your activities" className="run-cards">
            {list.items.map((activity) => {
              const label = describeActivity(activity, timeZone);
              const confirming = deletion?.activityId === activity.activityId;
              return (
                <li className={confirming ? 'run-card run-card--deleting' : 'run-card'} key={activity.activityId}>
                  <h3>{activityTypeLabels[activity.type]}</h3>
                  <time dateTime={activity.startedAt}>{formatStartedAt(activity.startedAt, timeZone)}</time>
                  <dl>
                    <div><dt>{activityDurationLabels[activity.source]}</dt><dd>{formatDuration(activity.durationS)}</dd></div>
                    <div><dt>Distance</dt><dd>{activity.distanceM === null ? '—' : formatDistance(activity.distanceM, draft.unit)}</dd></div>
                    <div><dt>Effort</dt><dd>{activity.rpe === null ? '—' : `${activity.rpe}/10`}</dd></div>
                    <div><dt>Source</dt><dd>{activitySourceLabels[activity.source]}</dd></div>
                  </dl>
                  {activity.notes !== null && <p className="activity-card__notes">{activity.notes}</p>}
                  {!confirming && (
                    <div className="run-card__actions">
                      <button
                        aria-label={`Delete your ${label}`}
                        disabled={deletionPending}
                        onClick={() => {
                          setNotice(null);
                          setDeletion({ activityId: activity.activityId, id: nextDeletionId.current++, label });
                        }}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                  {confirming && (
                    <section aria-label={`Delete your ${label}?`} className="run-delete">
                      <h4>Delete this activity?</h4>
                      <p className="run-delete__warning">It is removed permanently. This cannot be undone.</p>
                      {deletionSnapshot.message !== null && <p className="run-delete__failure" role="alert">{deletionSnapshot.message}</p>}
                      <div className="run-delete__actions">
                        <button
                          className="finish-action"
                          disabled={deletionPending || deletionSnapshot.phase === 'unavailable'}
                          onClick={() => deleter.current?.confirm()}
                          type="button"
                        >
                          {deletionPending ? 'Deleting…' : 'Confirm delete'}
                        </button>
                        <button disabled={deletionPending} onClick={() => setDeletion(null)} type="button">Cancel</button>
                      </div>
                    </section>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {list.status === 'ready' && list.moreMessage !== null && (
          <div className="run-share__failure" role="alert">
            <span>{list.moreMessage}</span>
            <button onClick={() => lister.current?.retry()} type="button">{list.outdated ? 'Refresh' : 'Retry'}</button>
          </div>
        )}
        {list.status === 'ready' && list.hasMore && list.moreMessage === null && (
          <button disabled={list.loadingMore} onClick={() => lister.current?.loadMore()} type="button">
            {list.loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>
    </section>
  );
}
