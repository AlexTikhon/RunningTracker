import type { RunCommandType } from '@running-tracker/contracts';
import { useState } from 'react';

import type { CaptureState } from './capture-controller.js';
import {
  DEFAULT_CAPTURE_SOURCE_KIND,
  parseCaptureSourceKind,
  type CaptureSourceKind,
} from './capture-source-kind.js';
import { RefusedRunNotice } from './RefusedRunNotice.js';
import { RejectedBufferNotice } from './RejectedBufferNotice.js';
import { availableCommands, refusedRunMayBeDetached, runnerPhase, type RunnerState } from './runner-state.js';
import type { WriterOwnershipState } from './writer-lease.js';

export type StorageState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { message: string; status: 'error' };

interface RunnerViewProps {
  // Whether the next run can be started in the selected organization right now.
  canStart: boolean;
  capture: CaptureState;
  captureSourceKind: CaptureSourceKind | null;
  controlsDisabled: boolean;
  elapsed: string;
  // Said at the Start button: which organization the run goes to, or why none is chosen yet.
  organizationNote: string;
  rejected: { canDiscard: boolean; canExport: boolean; onDiscard: () => void; onExport: () => void };
  // The local discard of a run the server refuses (ADR-0052); the export is the same as for rejected points.
  refused: { canDiscard: boolean; onDiscard: () => void };
  runner: RunnerState;
  sessionReady: boolean;
  storage: StorageState;
  writer: WriterOwnershipState;
  onChooseCaptureSource: (kind: CaptureSourceKind) => void;
  onClearFinishedRun: () => void;
  onConfirmRun: () => void;
  onCommand: (type: RunCommandType) => void;
  onRetryOwnership: () => void;
  onRetryRequest: () => void;
  onStart: () => void;
}

// The Runner screen. It only renders and reports intent: the capture, upload, writer-lease and request
// machinery stay in App and its hooks.
export function RunnerView({
  canStart,
  capture,
  captureSourceKind,
  controlsDisabled,
  elapsed,
  organizationNote,
  rejected,
  refused,
  runner,
  sessionReady,
  storage,
  writer,
  onChooseCaptureSource,
  onClearFinishedRun,
  onConfirmRun,
  onCommand,
  onRetryOwnership,
  onRetryRequest,
  onStart,
}: RunnerViewProps) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const phase = runnerPhase(runner);
  const busy = runner.pendingRequest !== null;
  const commands = runner.run === null ? [] : availableCommands(runner.run.status);
  const captureDetail = capture.status === 'capturing' || capture.status === 'complete'
    ? `segment ${capture.segmentId} · ${capture.capturedCount} buffered`
    : capture.status === 'starting'
      ? capture.source
      : capture.status === 'error' || capture.status === 'lost'
        ? capture.message
        : 'Starts while the run is recording';

  return (
    <>
      <section className="runner-shell" aria-labelledby="runner-title">
        <div className="runner-copy">
          <p className="eyebrow">Runner console · P05.5</p>
          <h1 id="runner-title">Your run,<br />under control.</h1>
          <p className="lede">
            Device GPS and the seeded simulator share one fenced foreground capture path. Measurements
            are durably sequenced in IndexedDB before the uploader can send them.
          </p>
        </div>

        <section className="control-card" aria-label="Run controls">
          <div className="control-card__topline">
            <span className={`phase-badge phase-badge--${phase}`}>{phase}</span>
            <span className="run-id">{runner.run ? `#${runner.run.runId.slice(0, 8)}` : 'No active run'}</span>
          </div>

          <p className="timer" aria-label={`Elapsed time ${elapsed}`}>{elapsed}</p>
          <p className="timer-label">elapsed foreground session</p>

          <div className="capture-source">
            <label htmlFor="capture-source">Capture source</label>
            <select
              disabled={
                captureSourceKind === null
                || runner.run?.status === 'recording'
                || busy
                || (runner.run !== null && writer.status !== 'owned')
              }
              id="capture-source"
              onChange={(event) => onChooseCaptureSource(parseCaptureSourceKind(event.target.value))}
              value={captureSourceKind ?? DEFAULT_CAPTURE_SOURCE_KIND}
            >
              <option value="geolocation">Device GPS</option>
              <option value="simulator">Simulator · normal · seed 1</option>
            </select>
            <span>Foreground only. Pausing or losing the writer lease stops capture.</span>
          </div>

          {runner.run === null ? (
            <div className="start-panel">
              <p id="organization-help">{organizationNote}</p>
              <button className="primary-action" disabled={!canStart || controlsDisabled} onClick={onStart} type="button">
                {phase === 'starting' ? 'Starting…' : 'Start run'}
              </button>
            </div>
          ) : (
            <div className="command-grid">
              {commands.includes('pause') && (
                <button disabled={controlsDisabled || runner.upload.status === 'blocked'} onClick={() => onCommand('pause')} type="button">
                  {phase === 'pausing' ? 'Pausing…' : 'Pause'}
                </button>
              )}
              {commands.includes('resume') && (
                <button disabled={controlsDisabled || runner.upload.status === 'blocked'} onClick={() => onCommand('resume')} type="button">
                  {phase === 'resuming' ? 'Resuming…' : 'Resume'}
                </button>
              )}
              {commands.includes('finish') && (
                <button className="finish-action" disabled={controlsDisabled} onClick={() => onCommand('finish')} type="button">
                  {phase === 'finishing' ? 'Finishing…' : 'Finish'}
                </button>
              )}
              {runner.run.status === 'finished' && (
                <button
                  className="primary-action"
                  disabled={controlsDisabled || runner.upload.pendingCount > 0 || writer.status !== 'owned'}
                  onClick={onClearFinishedRun}
                  type="button"
                >
                  New run
                </button>
              )}
            </div>
          )}
        </section>
      </section>

      {runner.connectivity === 'offline' && (
        <section className="notice notice--offline" role="status">
          <strong>Offline</strong>
          <span>Lifecycle requests can be saved locally and retried after reconnection.</span>
        </section>
      )}

      {/* A run the server refuses has its own notice, which owns the export and the discard. */}
      {runner.upload.status === 'blocked' && !refusedRunMayBeDetached(runner) && (
        <RejectedBufferNotice
          canDiscard={rejected.canDiscard && !busy && writer.status === 'owned' && runner.run?.status === 'finished'}
          canExport={rejected.canExport}
          message={runner.upload.message}
          onDiscard={rejected.onDiscard}
          onExport={rejected.onExport}
        />
      )}

      {storage.status === 'error' && (
        <section className="notice notice--error" role="alert">
          <div><strong>Local storage unavailable</strong><span>{storage.message}</span></div>
        </section>
      )}

      {(capture.status === 'error' || capture.status === 'lost') && (
        <section className="notice notice--error" role="alert">
          <div><strong>Capture stopped</strong><span>{capture.message}</span></div>
        </section>
      )}

      {(writer.status === 'conflict' || writer.status === 'lost' || writer.status === 'error') && (
        <section className="notice notice--writer" role="alert">
          <div>
            <strong>
              {writer.status === 'error' ? 'Writer ownership unavailable' : 'Another tab may own recording'}
            </strong>
            <span>
              {writer.status === 'conflict'
                ? `This tab is read-only while the current lease is live (through ${new Date(writer.expiresAt).toLocaleTimeString()}).`
                : writer.message}
            </span>
          </div>
          <button onClick={onRetryOwnership} type="button">Retry ownership</button>
        </section>
      )}

      {runner.authority.status === 'unreachable' && (
        <section className="notice notice--error" role="alert">
          <div>
            <strong>Confirming this run with the server</strong>
            <span>
              {runner.authority.message} Recording stays stopped and the buffered points stay on this device
              until the server confirms the run.
            </span>
          </div>
          <button disabled={runner.connectivity === 'offline' || !sessionReady} onClick={onConfirmRun} type="button">
            Check again
          </button>
        </section>
      )}

      {runner.authority.status === 'refused' && (
        <RefusedRunNotice
          canCheckAgain={runner.connectivity === 'online' && sessionReady}
          canDiscard={refused.canDiscard && !busy && writer.status === 'owned'}
          canExport={rejected.canExport}
          confirming={confirmingDiscard}
          detachable={refusedRunMayBeDetached(runner)}
          message={runner.authority.message}
          onCancelDiscard={() => setConfirmingDiscard(false)}
          onCheckAgain={() => { setConfirmingDiscard(false); onConfirmRun(); }}
          onConfirmDiscard={() => { setConfirmingDiscard(false); refused.onDiscard(); }}
          onExport={rejected.onExport}
          onRequestDiscard={() => setConfirmingDiscard(true)}
          pendingCount={runner.upload.pendingCount}
        />
      )}

      {runner.error !== null && (
        <section className="notice notice--error" role="alert">
          <div><strong>Request not confirmed</strong><span>{runner.error.message}</span></div>
          <button
            disabled={runner.connectivity === 'offline' || !sessionReady || writer.status !== 'owned'}
            onClick={onRetryRequest}
            type="button"
          >
            Retry same request
          </button>
        </section>
      )}

      <section className="state-grid" aria-label="Runner state">
        <StateCard detail={runner.run?.status ?? 'Ready for a new run'} label="Recording" value={phase} />
        <StateCard
          detail={runner.connectivity === 'online' ? 'Server controls available' : 'Waiting for connection'}
          label="Network"
          value={runner.connectivity}
        />
        <StateCard
          detail={runner.upload.message ?? (runner.upload.pendingCount === 0 ? 'No buffered points' : `${runner.upload.pendingCount} pending`)}
          label="Upload"
          value={runner.upload.status}
        />
        <StateCard
          detail={runner.run ? `control rev ${runner.run.controlRevision}` : 'No server revision yet'}
          label="Server state"
          value={runner.error !== null && runner.authority.status !== 'refused' ? 'error' : runner.authority.status === 'confirmed' ? 'confirmed' : runner.authority.status}
        />
        <StateCard
          detail={writer.status === 'owned' ? `fence ${writer.fencingToken}` : 'Controls require the browser lease'}
          label="Writer"
          value={writer.status}
        />
        <StateCard detail={captureDetail} label="Capture" value={capture.status} />
      </section>
    </>
  );
}

function StateCard({ detail, label, value }: { detail: string; label: string; value: string }) {
  return (
    <article className="state-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}
