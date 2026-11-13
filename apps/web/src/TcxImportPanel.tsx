import {
  ACTIVITY_TYPES,
  TCX_IMPORT_MAX_BYTES,
  TCX_IMPORT_MAX_LAPS,
  type ActivityType,
  type DistanceUnit,
} from '@running-tracker/contracts';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';

import { activityTypeLabels } from './activity-form.js';
import { formatDistance, formatDuration, formatStartedAt } from './run-search.js';
import { confirmTcxImport, previewTcxImport, type CsrfCredentials } from './runner-api.js';
import { idleTcxImport, TcxImportController, type TcxImportSnapshot } from './tcx-import-controller.js';

export interface TcxImportPanelProps {
  csrf: CsrfCredentials;
  /** Called once per confirmed import, so the history can show it. */
  onImported: () => void;
  orgId: string;
  /** The session's signal: ending or replacing the session silences every request of this panel. */
  signal: AbortSignal;
  timeZone: string;
  unit: DistanceUnit;
}

const MAX_MEGABYTES = TCX_IMPORT_MAX_BYTES / (1024 * 1024);
const groupThousands = (value: string) => value.replace(/^\d+/u, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ' '));

export interface TcxImportViewProps {
  inputRef?: RefObject<HTMLInputElement | null>;
  onChoose: (event: ChangeEvent<HTMLInputElement>) => void;
  onRetry: () => void;
  onStartOver: () => void;
  onSubmit: (event: FormEvent) => void;
  onType: (type: ActivityType | '') => void;
  /** Confirming `type` now repeats the attempt whose outcome is unknown. */
  repeats: boolean;
  snapshot: TcxImportSnapshot;
  timeZone: string;
  type: ActivityType | '';
  unit: DistanceUnit;
}

/** What the TCX import shows for one snapshot (ADR-0091). Pure, so every state can be rendered on its own. */
export function TcxImportView({ inputRef, onChoose, onRetry, onStartOver, onSubmit, onType, repeats, snapshot, timeZone, type, unit }: TcxImportViewProps) {
  const { phase, preview } = snapshot;
  const saving = phase === 'saving';
  const duplicate = preview?.duplicateOf ?? null;
  const finished = phase === 'already-imported' || phase === 'already-saved' || phase === 'invalid' || phase === 'access-denied';
  const previewShown = phase === 'preview' || phase === 'saving' || phase === 'save-failed';
  return (
    <section aria-labelledby="tcx-import-title" className="search-filters activity-import">
      <h2 id="tcx-import-title">Import a TCX file</h2>
      <p className="activity-import__intro">
        One activity from a Training Center (TCX v2) file, up to {MAX_MEGABYTES} MB and {groupThousands(String(TCX_IMPORT_MAX_LAPS))}{' '}
        laps, each lap with its start time, total time and distance. GPS positions are not needed. Only the start, the
        duration the laps report and their distance are saved: the file, its laps, track, heart rate, calories, notes and
        device are not kept, and no map is shown.
      </p>
      <label className="activity-import__file">
        TCX file
        <input disabled={saving} onChange={onChoose} ref={inputRef} type="file" />
      </label>
      {phase === 'previewing' && <p className="activity-form__status" role="status">Checking {snapshot.fileName}…</p>}

      {previewShown && preview !== null && (
        <form aria-label="Preview of the TCX file" className="activity-import__preview" noValidate onSubmit={onSubmit}>
          <h3>What the server read from {snapshot.fileName}</h3>
          <dl className="activity-saved__details">
            <div><dt>Started</dt><dd>{formatStartedAt(preview.summary.startedAt, timeZone)}</dd></div>
            <div><dt>Reported duration</dt><dd>{formatDuration(preview.summary.reportedDurationS)}</dd></div>
            <div><dt>Distance</dt><dd>{formatDistance(preview.summary.distanceM, unit)}</dd></div>
            <div><dt>Laps</dt><dd>{groupThousands(String(preview.summary.lapCount))}</dd></div>
          </dl>
          <p className="activity-import__note" data-testid="tcx-rounding">
            The laps report {groupThousands(preview.summary.lapTotals.totalTimeSeconds)} s and{' '}
            {groupThousands(preview.summary.lapTotals.distanceMeters)} m in total. Each total is added exactly and rounded once,
            to the nearest whole second and metre (halves up): {groupThousands(String(preview.summary.reportedDurationS))} s and{' '}
            {groupThousands(String(preview.summary.distanceM))} m are saved.
          </p>
          <p className="activity-import__note">
            Reported duration is the sum of the laps&apos; own total times, as the device wrote them. It is not elapsed time and
            not moving time: the file does not say whether pauses were left out. The start is the first lap&apos;s start time.
          </p>
          <p className="activity-import__note">
            The import is not compared with GPX imports, manual entries or GPS runs recorded in SomaLane. If the same outing
            is already there in another form, both are kept and shown separately.
          </p>
          {duplicate !== null && (
            <p className="activity-form__warning" role="alert">
              You already imported this TCX activity, so it cannot be imported again. Delete that activity first if you want
              to replace it.
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

// Select a TCX file, see what the server computed from it, choose the type, confirm (ADR-0091). The parent (the Activity
// screen) is keyed by session, person and organization, and the controller follows the session signal too, so no request
// or answer crosses those boundaries.
export function TcxImportPanel({ csrf, onImported, orgId, signal, timeZone, unit }: TcxImportPanelProps) {
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const imported = useRef(onImported);
  imported.current = onImported;
  const [snapshot, setSnapshot] = useState<TcxImportSnapshot>(idleTcxImport);
  const [type, setType] = useState<ActivityType | ''>('');
  const controller = useRef<TcxImportController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const clearInput = () => {
    // Lets the same file be chosen again (a change event fires only for a different value).
    if (input.current !== null) input.current.value = '';
  };

  useEffect(() => {
    const next = new TcxImportController({
      confirm: confirmTcxImport,
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
      preview: previewTcxImport,
      signal,
    });
    controller.current = next;
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal]);

  return (
    <TcxImportView
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
