import { uuidSchema, type RunCommandType } from '@running-tracker/contracts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { loadHealth, type HealthSnapshot } from './health.js';
import { ArchiveScreen } from './ArchiveScreen.js';
import { CoachScreen } from './CoachScreen.js';
import { CaptureController, type CaptureState } from './capture-controller.js';
import { GeolocationCaptureSource, SimulatorCaptureSource } from './capture-source.js';
import {
  DEFAULT_CAPTURE_SOURCE_KIND,
  parseCaptureSourceKind,
  type CaptureSourceKind,
} from './capture-source-kind.js';
import { executeRunnerRequest } from './runner-requests.js';
import { useRunnerSession } from './use-runner-session.js';
import { PointUploadWorker } from './point-upload-worker.js';
import {
  readRun,
  RunnerApiError,
  uploadPointBatch,
} from './runner-api.js';
import { getBrowserRunnerStorage } from './runner-storage.js';
import { SignInNotice, signInFailureMessage } from './sign-in.js';
import {
  availableCommands,
  createInitialRunnerState,
  runnerPhase,
  runnerReducer,
  type CommandRequest,
  type RunnerRequest,
  type StartRequest,
  type UploadState,
} from './runner-state.js';
import {
  WriterLeaseCoordinator,
  type WriterOwnershipState,
} from './writer-lease.js';

type HealthState = HealthSnapshot | { api: 'checking'; database: 'checking' };
type StorageState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { message: string; status: 'error' };
type ActiveView = 'archive' | 'coach' | 'runner';

const initialHealth: HealthState = { api: 'checking', database: 'checking' };

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  if (error instanceof RunnerApiError) {
    const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
    return `${error.message} (${error.code}).${reference}`;
  }
  return error instanceof Error ? error.message : 'The request failed for an unknown reason.';
}

function durationLabel(startedAt: string | undefined, finishedAt: string | null | undefined, now: number) {
  if (startedAt === undefined) {
    return '00:00:00';
  }
  const end = finishedAt === null ? now : Date.parse(finishedAt ?? startedAt);
  const elapsedSeconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  return [hours, minutes, seconds].map((value) => value.toString().padStart(2, '0')).join(':');
}

export function App() {
  const [health, setHealth] = useState<HealthState>(initialHealth);
  const [orgId, setOrgId] = useState('');
  const [signInFailure] = useState(() =>
    typeof window === 'undefined' ? undefined : signInFailureMessage(window.location.search),
  );
  const [now, setNow] = useState(() => Date.now());
  const [storage, setStorage] = useState<StorageState>({ status: 'loading' });
  const [writer, setWriter] = useState<WriterOwnershipState>({ status: 'unclaimed' });
  const [capture, setCapture] = useState<CaptureState>({ status: 'idle' });
  // null until the stored choice has been restored: capture must not start, and the select must not change,
  // before then, or a restored Simulator run would briefly start the Device GPS.
  const [captureSourceKind, setCaptureSourceKind] = useState<CaptureSourceKind | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>('runner');
  const captureController = useRef<CaptureController | null>(null);
  const restoredUserId = useRef<string | null>(null);
  const uploadWorker = useRef<PointUploadWorker | null>(null);
  const writerCoordinator = useRef<WriterLeaseCoordinator | null>(null);
  const latestUpload = useRef<UploadState>({ message: null, pendingCount: 0, status: 'idle' });
  const suspendRunner = useCallback(() => {
    captureController.current?.stop();
    uploadWorker.current?.stop();
    if (uploadWorker.current !== null && latestUpload.current.status !== 'blocked') {
      dispatch({ type: 'upload-changed', upload: { ...latestUpload.current, status: 'suspended', message: 'Sign in to resume upload.' } });
    }
    restoredUserId.current = null;
  }, []);
  const { session, refreshSession } = useRunnerSession(suspendRunner);
  const [runner, dispatch] = useReducer(
    runnerReducer,
    typeof navigator === 'undefined' || navigator.onLine !== false ? 'online' : 'offline',
    createInitialRunnerState,
  );
  latestUpload.current = runner.upload;
  const normalizedOrgId = orgId.trim().toLowerCase();
  const mapboxAccessToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? '').trim() || null;

  const refreshHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      setHealth(await loadHealth(signal));
    } catch (error) {
      if (!isAbortError(error)) {
        setHealth({ api: 'down', database: 'unknown' });
      }
    }
  }, []);

  useEffect(() => {
    // The failure is shown once; a reload must not repeat it.
    if (new URLSearchParams(window.location.search).has('sign_in_error')) {
      const cleaned = new URL(window.location.href);
      cleaned.searchParams.delete('sign_in_error');
      window.history.replaceState(null, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshHealth(controller.signal);
    return () => controller.abort();
  }, [refreshHealth]);

  useEffect(() => {
    if (session.status !== 'ready' || restoredUserId.current === session.session.identity.userId) {
      return;
    }
    let active = true;
    const userId = session.session.identity.userId;
    setStorage({ status: 'loading' });
    setCaptureSourceKind(null);
    void (async () => {
      try {
        const recovery = await getBrowserRunnerStorage().loadRecovery(userId);
        if (!active) {
          return;
        }
        restoredUserId.current = userId;
        if (recovery.orgId !== null) {
          setOrgId(recovery.orgId);
        }
        // Set in the same batch as the storage becoming ready, which every capture start waits for.
        setCaptureSourceKind(recovery.captureSource);
        dispatch({
          uploadRejection: recovery.uploadRejection,
          pendingPointCount: recovery.pendingPointCount,
          request: recovery.request,
          run: recovery.run,
          type: 'storage-restored',
        });
        setStorage({ status: 'ready' });
      } catch (error) {
        if (active) {
          setStorage({ message: errorMessage(error), status: 'error' });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    if (session.status !== 'ready') {
      return undefined;
    }
    const coordinator = new WriterLeaseCoordinator({
      onState: setWriter,
      storage: getBrowserRunnerStorage(),
      userId: session.session.identity.userId,
    });
    writerCoordinator.current = coordinator;
    setWriter({ status: 'unclaimed' });
    return () => {
      if (writerCoordinator.current === coordinator) {
        writerCoordinator.current = null;
      }
      void coordinator.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (storage.status === 'ready' && (runner.run !== null || runner.error !== null)) {
      void writerCoordinator.current?.claim();
    }
  }, [runner.error, runner.run, storage.status]);

  useEffect(() => {
    const updateConnectivity = () => {
      dispatch({ connectivity: navigator.onLine ? 'online' : 'offline', type: 'connectivity-changed' });
    };
    window.addEventListener('online', updateConnectivity);
    window.addEventListener('offline', updateConnectivity);
    return () => {
      window.removeEventListener('online', updateConnectivity);
      window.removeEventListener('offline', updateConnectivity);
    };
  }, []);

  useEffect(() => {
    if (
      session.status !== 'ready'
      || storage.status !== 'ready'
      || restoredUserId.current !== session.session.identity.userId
      || writer.status !== 'owned'
      || runner.run === null
      || runner.upload.status === 'blocked'
      || !uuidSchema.safeParse(normalizedOrgId).success
    ) {
      return undefined;
    }
    const runnerStorage = getBrowserRunnerStorage();
    const scope = {
      orgId: normalizedOrgId,
      runId: runner.run.runId,
      userId: session.session.identity.userId,
    };
    const worker = new PointUploadWorker({
      onAcknowledged: (dataRevision) => {
        dispatch({ dataRevision, runId: scope.runId, type: 'point-batch-acknowledged' });
      },
      onPermanentError: async (error, signal) => {
        captureController.current?.stop();
        await runnerStorage.rejectUpload(scope, errorMessage(error));
        const authoritativeRun = await readRun(scope.orgId, scope.runId, signal);
        await runnerStorage.saveRunSnapshot(scope.userId, scope.orgId, authoritativeRun);
        dispatch({ run: authoritativeRun, type: 'run-reconciled' });
      },
      onState: (nextUpload) => dispatch({ type: 'upload-changed', upload: nextUpload }),
      scope,
      send: async (points, signal) => {
        if (!await writerCoordinator.current?.assertOwned()) {
          throw new Error('Point upload stopped because this tab no longer owns the writer lease');
        }
        return uploadPointBatch(
          { orgId: scope.orgId, points, runId: scope.runId },
          session.session.csrf,
          signal,
        );
      },
      storage: runnerStorage,
    });
    uploadWorker.current = worker;
    worker.start(runner.connectivity === 'online');
    return () => {
      worker.stop();
      if (uploadWorker.current === worker) {
        uploadWorker.current = null;
      }
    };
  }, [normalizedOrgId, runner.run?.runId, session, storage.status, writer.status]);

  useEffect(() => {
    uploadWorker.current?.setOnline(runner.connectivity === 'online');
  }, [runner.connectivity]);

  useEffect(() => {
    if (
      session.status !== 'ready'
      || storage.status !== 'ready'
      || restoredUserId.current !== session.session.identity.userId
      || writer.status !== 'owned'
      || runner.upload.status === 'blocked'
      || runner.run?.status !== 'recording'
      || captureSourceKind === null
      || !uuidSchema.safeParse(normalizedOrgId).success
    ) {
      setCapture({ status: 'idle' });
      return undefined;
    }
    const scope = {
      orgId: normalizedOrgId,
      runId: runner.run.runId,
      userId: session.session.identity.userId,
    };
    const source = captureSourceKind === 'geolocation'
      ? new GeolocationCaptureSource()
      : new SimulatorCaptureSource({ name: 'normal', seed: 1 });
    const controller = new CaptureController({
      assertOwnedLease: async () => await writerCoordinator.current?.assertOwnedLease() ?? null,
      onPoint: () => {
        dispatch({ runId: scope.runId, type: 'point-buffered' });
        uploadWorker.current?.wake();
      },
      onState: setCapture,
      scope,
      source,
      storage: getBrowserRunnerStorage(),
    });
    captureController.current = controller;
    void controller.start();
    return () => {
      controller.stop();
      if (captureController.current === controller) captureController.current = null;
    };
  }, [captureSourceKind, normalizedOrgId, runner.run?.runId, runner.run?.status, runner.upload.status === 'blocked', session, storage.status, writer.status]);

  useEffect(() => {
    if (runner.run === null || runner.run.status === 'finished') {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runner.run]);

  const executeRequest = useCallback(
    async (request: RunnerRequest) => {
      if (session.status !== 'ready' || storage.status !== 'ready') {
        return;
      }
      if (!await writerCoordinator.current?.assertOwned()) {
        return;
      }
      dispatch({ request, type: 'request-started' });
      try {
        const outcome = await executeRunnerRequest({
          assertOwned: async () => await writerCoordinator.current?.assertOwned() ?? false,
          csrf: session.session.csrf,
          online: runner.connectivity === 'online',
          request,
          run: runner.run,
          signal: session.signal,
          storage: getBrowserRunnerStorage(),
          userId: session.session.identity.userId,
        });
        if (outcome.kind === 'start' && request.kind === 'start') {
          dispatch({ request, run: outcome.run, type: 'start-succeeded' });
        } else if (outcome.kind === 'command' && request.kind === 'command') {
          dispatch({ request, result: outcome.result, type: 'command-succeeded' });
        } else if (outcome.kind === 'reconciled' && request.kind === 'command') {
          dispatch({ request, run: outcome.run, type: 'request-reconciled' });
        }
      } catch (error) {
        dispatch({ message: errorMessage(error), request, type: 'request-failed' });
      }
    },
    [runner.connectivity, runner.run, session, storage.status],
  );

  const synchronizeAfterClaim = useCallback(async () => {
    if (session.status !== 'ready' || storage.status !== 'ready') {
      return false;
    }
    const recovery = await getBrowserRunnerStorage().loadRecovery(session.session.identity.userId);
    if (recovery.orgId !== null) {
      setOrgId(recovery.orgId);
    }
    if (
      runner.pendingRequest === null
      && (recovery.run !== null || recovery.request !== null)
    ) {
      dispatch({
        uploadRejection: recovery.uploadRejection,
        pendingPointCount: recovery.pendingPointCount,
        request: recovery.request,
        run: recovery.run,
        type: 'storage-restored',
      });
      return true;
    }
    return false;
  }, [runner.pendingRequest, runner.run, session, storage.status]);

  const claimWriter = useCallback(async () => {
    const acquired = await writerCoordinator.current?.claim() ?? false;
    if (!acquired) {
      return false;
    }
    try {
      return !await synchronizeAfterClaim();
    } catch (error) {
      setStorage({ message: errorMessage(error), status: 'error' });
      return false;
    }
  }, [synchronizeAfterClaim]);

  const validOrgId = uuidSchema.safeParse(normalizedOrgId).success;
  const phase = runnerPhase(runner);
  const busy = runner.pendingRequest !== null;
  const controlsDisabled = busy
    || runner.error !== null
    || session.status !== 'ready'
    || storage.status !== 'ready'
    || writer.status === 'acquiring'
    || (runner.run !== null && writer.status !== 'owned');
  const commands = runner.run === null ? [] : availableCommands(runner.run.status);
  const captureDetail = capture.status === 'capturing' || capture.status === 'complete'
    ? `segment ${capture.segmentId} · ${capture.capturedCount} buffered`
    : capture.status === 'starting'
      ? capture.source
      : capture.status === 'error' || capture.status === 'lost'
        ? capture.message
        : 'Starts while the run is recording';
  const elapsed = useMemo(
    () => durationLabel(runner.run?.startedAt, runner.run?.finishedAt, now),
    [now, runner.run?.finishedAt, runner.run?.startedAt],
  );

  const start = async () => {
    if (!validOrgId || controlsDisabled || runner.run !== null) {
      return;
    }
    if (!await claimWriter()) {
      return;
    }
    const request: StartRequest = {
      kind: 'start',
      orgId: normalizedOrgId,
      runId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    };
    void executeRequest(request);
  };

  const command = (type: RunCommandType) => {
    if (runner.run === null || controlsDisabled) {
      return;
    }
    const request: CommandRequest = {
      commandId: crypto.randomUUID(),
      expectedControlRevision: runner.run.controlRevision,
      kind: 'command',
      orgId: normalizedOrgId,
      runId: runner.run.runId,
      type,
    };
    void executeRequest(request);
  };

  const chooseCaptureSource = (kind: CaptureSourceKind) => {
    setCaptureSourceKind(kind);
    if (session.status !== 'ready') {
      return;
    }
    getBrowserRunnerStorage()
      .saveCaptureSource(session.session.identity.userId, kind)
      .catch((error: unknown) => setStorage({ message: errorMessage(error), status: 'error' }));
  };

  const clearFinishedRun = async () => {
    if (session.status !== 'ready') {
      return;
    }
    try {
      await getBrowserRunnerStorage().clearActiveRun(session.session.identity.userId);
      dispatch({ type: 'finished-run-cleared' });
      await writerCoordinator.current?.release();
    } catch (error) {
      setStorage({ message: errorMessage(error), status: 'error' });
    }
  };

  const rejectedScope = session.status === 'ready' && runner.run !== null
    ? { userId: session.session.identity.userId, orgId: normalizedOrgId, runId: runner.run.runId } : null;
  const exportRejectedPoints = async () => {
    if (rejectedScope === null) return;
    try {
      const points = await getBrowserRunnerStorage().exportBufferedPoints(rejectedScope);
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...rejectedScope, points }, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `run-${rejectedScope.runId}-buffer.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) { setStorage({ message: errorMessage(error), status: 'error' }); }
  };
  const discardRejectedPoints = async () => {
    if (rejectedScope === null || busy) return;
    try {
      const lease = await writerCoordinator.current?.assertOwnedLease();
      if (!lease) return;
      captureController.current?.stop();
      uploadWorker.current?.stop();
      await getBrowserRunnerStorage().discardRejectedRun(rejectedScope, lease);
      dispatch({ type: 'rejected-run-discarded' });
      await writerCoordinator.current?.release();
    } catch (error) { setStorage({ message: errorMessage(error), status: 'error' }); }
  };

  return (
    <main>
      <header className="topbar">
        <div className="brand" aria-label="Running Tracker">
          <span className="brand-mark" aria-hidden="true">RT</span>
          <span>Running Tracker</span>
        </div>
        <nav className="view-switcher" aria-label="Application view">
          <button
            aria-current={activeView === 'runner' ? 'page' : undefined}
            onClick={() => setActiveView('runner')}
            type="button"
          >
            Runner
          </button>
          <button
            aria-current={activeView === 'coach' ? 'page' : undefined}
            onClick={() => setActiveView('coach')}
            type="button"
          >
            Coach
          </button>
          <button
            aria-current={activeView === 'archive' ? 'page' : undefined}
            onClick={() => setActiveView('archive')}
            type="button"
          >
            Archive
          </button>
        </nav>
        <div className="service-health" aria-label="Service health">
          <StatusDot label="API" value={health.api} />
          <StatusDot label="DB" value={health.database} />
        </div>
      </header>

      <div hidden={activeView !== 'runner'}>
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
              onChange={(event) => chooseCaptureSource(parseCaptureSourceKind(event.target.value))}
              value={captureSourceKind ?? DEFAULT_CAPTURE_SOURCE_KIND}
            >
              <option value="geolocation">Device GPS</option>
              <option value="simulator">Simulator · normal · seed 1</option>
            </select>
            <span>Foreground only. Pausing or losing the writer lease stops capture.</span>
          </div>

          {runner.run === null ? (
            <div className="start-panel">
              <label htmlFor="organization-id">Organization ID</label>
              <input
                aria-describedby="organization-help"
                autoComplete="off"
                id="organization-id"
                onChange={(event) => setOrgId(event.target.value)}
                placeholder="00000000-0000-4000-8000-000000000000"
                spellCheck={false}
                value={orgId}
              />
              <p id="organization-help">The server rechecks active membership inside the run transaction.</p>
              <button className="primary-action" disabled={!validOrgId || controlsDisabled} onClick={() => void start()} type="button">
                {phase === 'starting' ? 'Starting…' : 'Start run'}
              </button>
            </div>
          ) : (
            <div className="command-grid">
              {commands.includes('pause') && (
                <button disabled={controlsDisabled || runner.upload.status === 'blocked'} onClick={() => command('pause')} type="button">
                  {phase === 'pausing' ? 'Pausing…' : 'Pause'}
                </button>
              )}
              {commands.includes('resume') && (
                <button disabled={controlsDisabled || runner.upload.status === 'blocked'} onClick={() => command('resume')} type="button">
                  {phase === 'resuming' ? 'Resuming…' : 'Resume'}
                </button>
              )}
              {commands.includes('finish') && (
                <button className="finish-action" disabled={controlsDisabled} onClick={() => command('finish')} type="button">
                  {phase === 'finishing' ? 'Finishing…' : 'Finish'}
                </button>
              )}
              {runner.run.status === 'finished' && (
                <button
                  className="primary-action"
                  disabled={controlsDisabled || runner.upload.pendingCount > 0 || writer.status !== 'owned'}
                  onClick={() => void clearFinishedRun()}
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

      {runner.upload.status === 'blocked' && (
        <section className="notice notice--error" role="alert">
          <strong>Buffered points were rejected</strong>
          <span>{runner.upload.message} Export the retained points before discarding them. Discard removes this browser's queue; finish the run before clearing it.</span>
          <button disabled={rejectedScope === null} onClick={() => void exportRejectedPoints()} type="button">Export buffered points</button>
          <button disabled={rejectedScope === null || busy || writer.status !== 'owned' || runner.run?.status !== 'finished'} onClick={() => void discardRejectedPoints()} type="button">Discard buffered points and clear run</button>
        </section>
      )}

      {session.status === 'required' && <SignInNotice failure={signInFailure} />}

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
          <button onClick={() => void claimWriter()} type="button">Retry ownership</button>
        </section>
      )}

      {runner.error !== null && (
        <section className="notice notice--error" role="alert">
          <div><strong>Request not confirmed</strong><span>{runner.error.message}</span></div>
          <button
            disabled={runner.connectivity === 'offline' || session.status !== 'ready' || writer.status !== 'owned'}
            onClick={() => void executeRequest(runner.error!.request)}
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
          value={runner.error === null ? 'confirmed' : 'error'}
        />
        <StateCard
          detail={writer.status === 'owned' ? `fence ${writer.fencingToken}` : 'Controls require the browser lease'}
          label="Writer"
          value={writer.status}
        />
        <StateCard detail={captureDetail} label="Capture" value={capture.status} />
      </section>
      </div>

      {activeView === 'coach' && (
        <>
          <section className="coach-org" aria-label="Coach organization">
            <label htmlFor="coach-organization-id">Organization ID</label>
            <input
              autoComplete="off"
              id="coach-organization-id"
              onChange={(event) => setOrgId(event.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
              spellCheck={false}
              value={orgId}
            />
            <span>The live endpoint revalidates this identity's membership and run grants.</span>
          </section>
          {session.status === 'ready' && validOrgId ? (
            <CoachScreen
              orgId={normalizedOrgId}
              sessionExpiresAt={session.session.expiresAt}
              userId={session.session.identity.userId}
            />
          ) : (
            <section className="coach-prerequisite" role="status">
              {session.status === 'ready'
                ? 'Enter a valid organization UUID to open the coach stream.'
                : 'An active session is required before the coach stream can open.'}
            </section>
          )}
        </>
      )}

      {activeView === 'archive' && (
        <>
          <section className="coach-org" aria-label="Archive organization">
            <label htmlFor="archive-organization-id">Organization ID</label>
            <input
              autoComplete="off"
              id="archive-organization-id"
              onChange={(event) => setOrgId(event.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
              spellCheck={false}
              value={orgId}
            />
            <span>Metadata and every tile request revalidate membership and history access.</span>
          </section>
          {session.status === 'ready' && validOrgId ? (
            <ArchiveScreen
              accessToken={mapboxAccessToken}
              orgId={normalizedOrgId}
              userId={session.session.identity.userId}
            />
          ) : (
            <section className="coach-prerequisite" role="status">
              {session.status === 'ready'
                ? 'Enter a valid organization UUID to open the archive source.'
                : 'An active session is required before the archive source can open.'}
            </section>
          )}
        </>
      )}

      <section className={`session-bar session-bar--${session.status}`} aria-live="polite">
        {session.status === 'loading' && <span>Checking session…</span>}
        {session.status === 'ready' && (
          <><span>Session ready · user {session.session.identity.userId.slice(0, 8)}</span><span>Expires {new Date(session.session.expiresAt).toLocaleTimeString()}</span></>
        )}
        {session.status === 'required' && (
          <><span>{session.message}</span><button onClick={() => void refreshSession()} type="button">Retry session</button></>
        )}
      </section>
    </main>
  );
}

function StatusDot({ label, value }: { label: string; value: string }) {
  return <span><i className={`dot dot--${value}`} aria-hidden="true" />{label} {value}</span>;
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
