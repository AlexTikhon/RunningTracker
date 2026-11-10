import {
  ACTIVITY_TYPES,
  GPX_IMPORT_MAX_BYTES,
  GPX_IMPORT_MAX_POINTS,
  type ActivityType,
  type DistanceUnit,
} from '@running-tracker/contracts';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';

import { activityTypeLabels } from './activity-form.js';
import { GpxImportController, idleGpxImport, type GpxImportSnapshot } from './gpx-import-controller.js';
import { formatDistance, formatDuration, formatStartedAt } from './run-search.js';
import { confirmGpxImport, previewGpxImport, type CsrfCredentials } from './runner-api.js';

export interface GpxImportPanelProps {
  csrf: CsrfCredentials;
  /** Called once per confirmed import, so the list can show it. */
  onImported: () => void;
  orgId: string;
  /** The session's signal: ending or replacing the session silences every request of this panel. */
  signal: AbortSignal;
  timeZone: string;
  unit: DistanceUnit;
}

const MAX_MEGABYTES = GPX_IMPORT_MAX_BYTES / (1024 * 1024);
const groupThousands = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');

export interface GpxImportViewProps {
  inputRef?: RefObject<HTMLInputElement | null>;
  onChoose: (event: ChangeEvent<HTMLInputElement>) => void;
  onRetry: () => void;
  onStartOver: () => void;
  onSubmit: (event: FormEvent) => void;
  onType: (type: ActivityType | '') => void;
  /** Confirming `type` now repeats the attempt whose outcome is unknown. */
  repeats: boolean;
  snapshot: GpxImportSnapshot;
  timeZone: string;
  type: ActivityType | '';
  unit: DistanceUnit;
}

/** What the import shows for one snapshot. Pure, so every state can be rendered on its own. */
export function GpxImportView({ inputRef, onChoose, onRetry, onStartOver, onSubmit, onType, repeats, snapshot, timeZone, type, unit }: GpxImportViewProps) {
  const { phase, preview } = snapshot;
  const saving = phase === 'saving';
  const duplicate = preview?.duplicateOf ?? null;
  const finished = phase === 'already-imported' || phase === 'already-saved' || phase === 'invalid' || phase === 'access-denied';
  const previewShown = phase === 'preview' || phase === 'saving' || phase === 'save-failed';
  return (
    <section aria-labelledby="gpx-import-title" className="search-filters activity-import">
      <h2 id="gpx-import-title">Import a GPX file</h2>
      <p className="activity-import__intro">
        One GPX 1.1 track from another app or device (several segments are fine), up to {MAX_MEGABYTES} MB and{' '}
        {groupThousands(GPX_IMPORT_MAX_POINTS)} points, every point with a time. Only the start, the elapsed time and the
        distance are saved: the file, its route and its points are not kept, and no map is shown.
      </p>
      <label className="activity-import__file">
        GPX file
        <input disabled={saving} onChange={onChoose} ref={inputRef} type="file" />
      </label>
      {phase === 'previewing' && <p className="activity-form__status" role="status">Checking {snapshot.fileName}…</p>}

      {previewShown && preview !== null && (
        <form aria-label="Preview of the GPX file" className="activity-import__preview" noValidate onSubmit={onSubmit}>
          <h3>What the server read from {snapshot.fileName}</h3>
          <dl className="activity-saved__details">
            <div><dt>Started</dt><dd>{formatStartedAt(preview.summary.startedAt, timeZone)}</dd></div>
            <div><dt>Ended</dt><dd>{formatStartedAt(preview.summary.endedAt, timeZone)}</dd></div>
            <div><dt>Elapsed time</dt><dd>{formatDuration(preview.summary.elapsedDurationS)}</dd></div>
            <div><dt>Distance</dt><dd>{formatDistance(preview.summary.distanceM, unit)}</dd></div>
            <div><dt>Points</dt><dd>{groupThousands(preview.summary.pointCount)}</dd></div>
            <div><dt>Segments</dt><dd>{preview.summary.segmentCount}</dd></div>
          </dl>
          <p className="activity-import__note">
            Elapsed time runs from the first to the last point, pauses and gaps between segments included; it is not moving
            time. Distance adds up the straight lines between consecutive points of each segment, never across a gap.
          </p>
          <p className="activity-import__note">
            The import is not compared with GPS runs recorded in SomaLane. If you also recorded this outing here, both are
            kept and shown separately.
          </p>
          {duplicate !== null && (
            <p className="activity-form__warning" role="alert">
              You already imported this track, so it cannot be imported again. Delete that activity first if you want to
              replace it.
            </p>
          )}
          <label>
            Activity type
            <select disabled={saving} onChange={(event) => onType(event.target.value as ActivityType | '')} required value={type}>
              <option value="">Choose a type</option>
              {ACTIVITY_TYPES.map((value) => (
                <option key={value} value={value}>{activityTypeLabels[value]}</option>
              ))}
            </select>
          </label>
          {snapshot.uncertain && type !== '' && !repeats && (
            <p className="activity-form__warning">
              Your previous attempt may already have gone through. Importing with this type is still safe: if it did, no
              second activity is created and you are told so.
            </p>
          )}
          <div className="activity-form__actions">
            <button className="primary-action" disabled={saving || type === '' || duplicate !== null} type="submit">
              {saving ? 'Importing…' : snapshot.uncertain && repeats ? 'Import again' : 'Import activity'}
            </button>
            <button disabled={saving} onClick={onStartOver} type="button">Cancel</button>
          </div>
        </form>
      )}

      {snapshot.message !== null && phase !== 'previewing' && (
        <p
          className={phase === 'saved' ? 'activity-form__status' : phase === 'save-failed' && snapshot.uncertain ? 'activity-form__warning' : 'activity-form__failure'}
          role={phase === 'saved' ? 'status' : 'alert'}
        >
          {snapshot.message}
        </p>
      )}
      {phase === 'preview-failed' && (
        <div className="activity-form__actions">
          <button onClick={onRetry} type="button">Retry</button>
          <button onClick={onStartOver} type="button">Cancel</button>
        </div>
      )}
      {finished && (
        <div className="activity-form__actions">
          <button onClick={onStartOver} type="button">Choose another file</button>
        </div>
      )}
    </section>
  );
}

// Select a GPX file, see what the server computed from it, choose the type, confirm (ADR-0086). The parent (the Activity
// screen) is keyed by session, person and organization, and the controller follows the session signal too, so no request
// or answer crosses those boundaries.
export function GpxImportPanel({ csrf, onImported, orgId, signal, timeZone, unit }: GpxImportPanelProps) {
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const imported = useRef(onImported);
  imported.current = onImported;
  const [snapshot, setSnapshot] = useState<GpxImportSnapshot>(idleGpxImport);
  const [type, setType] = useState<ActivityType | ''>('');
  const controller = useRef<GpxImportController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const clearInput = () => {
    // Lets the same file be chosen again (a change event fires only for a different value).
    if (input.current !== null) input.current.value = '';
  };

  useEffect(() => {
    const next = new GpxImportController({
      confirm: confirmGpxImport,
      csrf: () => csrfRef.current,
      newId: () => crypto.randomUUID(),
      newKey: () => crypto.randomUUID(),
      onChange: setSnapshot,
      onSaved: () => {
        clearInput();
        setType('');
        imported.current();
      },
      orgId,
      preview: previewGpxImport,
      signal,
    });
    controller.current = next;
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal]);

  return (
    <GpxImportView
      inputRef={input}
      onChoose={(event) => {
        const file = event.target.files?.[0];
        if (file === undefined) return;
        setType('');
        controller.current?.select(file);
      }}
      onRetry={() => controller.current?.retryPreview()}
      onStartOver={() => {
        controller.current?.reset();
        setType('');
        clearInput();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (type !== '') controller.current?.confirm(type);
      }}
      onType={setType}
      repeats={type !== '' && controller.current?.wouldRepeat(type) === true}
      snapshot={snapshot}
      timeZone={timeZone}
      type={type}
      unit={unit}
    />
  );
}
