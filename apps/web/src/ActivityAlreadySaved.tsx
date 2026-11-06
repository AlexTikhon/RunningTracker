import type { ActivityView, DistanceUnit } from '@running-tracker/contracts';

import { activityTypeLabels } from './activity-form.js';
import { formatDistance, formatDuration, formatStartedAt } from './run-search.js';

export type SavedActivityView =
  | { status: 'closed' }
  | { status: 'loading' }
  | { message: string; status: 'error' }
  | { activity: ActivityView; status: 'ready' };

export interface ActivityAlreadySavedProps {
  onOpen: () => void;
  onStartNew: () => void;
  // The activity the form session already saved, when the server named it.
  savedActivityId: string | null;
  timeZone: string;
  unit: DistanceUnit;
  view: SavedActivityView;
}

// Shown after 409 ACTIVITY_ALREADY_SAVED (ADR-0073): an earlier save from this form went through while its answer was
// lost, and the changed details were not saved. The person can open what was saved, or start a new activity.
export function ActivityAlreadySaved({ onOpen, onStartNew, savedActivityId, timeZone, unit, view }: ActivityAlreadySavedProps) {
  return (
    <section aria-label="Your earlier save went through" className="activity-saved" role="alert">
      <p>
        <strong>Your earlier save went through.</strong> The changed details you just tried to save were not saved, so
        nothing was duplicated. To change the saved activity, delete it from your list and save it again.
      </p>
      {view.status === 'ready' && (
        <dl className="activity-saved__details">
          <div><dt>Type</dt><dd>{activityTypeLabels[view.activity.type]}</dd></div>
          <div><dt>Started</dt><dd>{formatStartedAt(view.activity.startedAt, timeZone)}</dd></div>
          <div><dt>Duration</dt><dd>{formatDuration(view.activity.durationS)}</dd></div>
          <div><dt>Distance</dt><dd>{view.activity.distanceM === null ? '—' : formatDistance(view.activity.distanceM, unit)}</dd></div>
          <div><dt>Effort</dt><dd>{view.activity.rpe === null ? '—' : `${view.activity.rpe}/10`}</dd></div>
          {view.activity.notes !== null && <div><dt>Notes</dt><dd>{view.activity.notes}</dd></div>}
        </dl>
      )}
      {view.status === 'loading' && <p className="activity-saved__status">Opening the saved activity…</p>}
      {view.status === 'error' && <p className="activity-saved__status">{view.message}</p>}
      {savedActivityId === null && <p className="activity-saved__status">It is in your list of activities below.</p>}
      <div className="activity-form__actions">
        {savedActivityId !== null && view.status !== 'ready' && (
          <button disabled={view.status === 'loading'} onClick={onOpen} type="button">
            Open saved activity
          </button>
        )}
        <button className="primary-action" onClick={onStartNew} type="button">
          Start a new activity
        </button>
      </div>
    </section>
  );
}
