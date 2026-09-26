import { uuidSchema, type RunCommandType, type SessionResponse } from '@running-tracker/contracts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { loadHealth, type HealthSnapshot } from './health.js';
import { PointUploadWorker } from './point-upload-worker.js';
import {
  createRun,
  loadSession,
  readRun,
  RunnerApiError,
  sendRunCommand,
  uploadPointBatch,
} from './runner-api.js';
import { getBrowserRunnerStorage } from './runner-storage.js';
import {
  availableCommands,
  createInitialRunnerState,
  runnerPhase,
  runnerReducer,
  type CommandRequest,
  type RunnerRequest,
  type StartRequest,
} from './runner-state.js';
import {
  WriterLeaseCoordinator,
  type WriterOwnershipState,
} from './writer-lease.js';

type HealthState = HealthSnapshot | { api: 'checking'; database: 'checking' };
type SessionState =
  | { status: 'loading' }
  | { message: string; status: 'required' }
  | { session: SessionResponse; status: 'ready' };
type StorageState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { message: string; status: 'error' };

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
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [orgId, setOrgId] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [storage, setStorage] = useState<StorageState>({ status: 'loading' });
  const [writer, setWriter] = useState<WriterOwnershipState>({ status: 'unclaimed' });
  const restoredUserId = useRef<string | null>(null);
  const uploadWorker = useRef<PointUploadWorker | null>(null);
  const writerCoordinator = useRef<WriterLeaseCoordinator | null>(null);
  const [runner, dispatch] = useReducer(
    runnerReducer,
    typeof navigator === 'undefined' || navigator.onLine !== false ? 'online' : 'offline',
    createInitialRunnerState,
  );
  const normalizedOrgId = orgId.trim().toLowerCase();

  const refreshHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      setHealth(await loadHealth(signal));
    } catch (error) {
      if (!isAbortError(error)) {
        setHealth({ api: 'down', database: 'unknown' });
      }
    }
  }, []);

  const refreshSession = useCallback(async (signal?: AbortSignal) => {
    setSession({ status: 'loading' });
    try {
      setSession({ session: await loadSession(signal), status: 'ready' });
    } catch (error) {
      if (!isAbortError(error)) {
        setSession({
          message: 'Create the development session first, then retry. Production identity arrives in P12.',
          status: 'required',
        });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshHealth(controller.signal);
    void refreshSession(controller.signal);
    return () => controller.abort();
  }, [refreshHealth, refreshSession]);

  useEffect(() => {
    if (session.status !== 'ready' || restoredUserId.current === session.session.identity.userId) {
      return;
    }
    let active = true;
    const userId = session.session.identity.userId;
    setStorage({ status: 'loading' });
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
        dispatch({
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
      || writer.status !== 'owned'
      || runner.run === null
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
      onPermanentError: async () => {
        const authoritativeRun = await readRun(scope.orgId, scope.runId);
        await runnerStorage.saveRunSnapshot(scope.userId, scope.orgId, authoritativeRun);
        dispatch({ run: authoritativeRun, type: 'run-reconciled' });
      },
      onState: (nextUpload) => dispatch({ type: 'upload-changed', upload: nextUpload }),
      scope,
      send: async (points) => {
        if (!await writerCoordinator.current?.assertOwned()) {
          throw new Error('Point upload stopped because this tab no longer owns the writer lease');
        }
        return uploadPointBatch(
          { orgId: scope.orgId, points, runId: scope.runId },
          session.session.csrf,
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
        const runnerStorage = getBrowserRunnerStorage();
        await runnerStorage.queueRequest(session.session.identity.userId, request, runner.run);
        if (runner.connectivity === 'offline') {
          dispatch({
            message: 'Saved locally. Retry the same request when the connection returns.',
            request,
            type: 'request-failed',
          });
          return;
        }
        if (request.kind === 'start') {
          const run = await createRun(request, session.session.csrf);
          if (!await writerCoordinator.current?.assertOwned()) {
            throw new Error(
              'Writer ownership changed after the server response; the exact start request remains queued.',
            );
          }
          await runnerStorage.acknowledgeStart(session.session.identity.userId, request, run);
          dispatch({ request, run, type: 'start-succeeded' });
          return;
        }
        if (runner.run === null) {
          throw new Error('The durable command has no confirmed run state');
        }
        const result = await sendRunCommand(request, session.session.csrf);
        if (!await writerCoordinator.current?.assertOwned()) {
          throw new Error(
            'Writer ownership changed after the server response; the exact command remains queued.',
          );
        }
        await runnerStorage.acknowledgeCommand(
          session.session.identity.userId,
          request,
          runner.run,
          result,
        );
        dispatch({ request, result, type: 'command-succeeded' });
      } catch (error) {
        if (
          request.kind === 'command'
          && error instanceof RunnerApiError
          && error.code === 'CONTROL_REVISION_CONFLICT'
        ) {
          try {
            const authoritativeRun = await readRun(request.orgId, request.runId);
            await getBrowserRunnerStorage().acknowledgeReconciledRequest(
              session.session.identity.userId,
              request,
              authoritativeRun,
            );
            dispatch({ request, run: authoritativeRun, type: 'request-reconciled' });
            return;
          } catch {
            // Preserve the original command failure when reconciliation is unavailable.
          }
        }
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

  return (
    <main>
      <header className="topbar">
        <div className="brand" aria-label="Running Tracker">
          <span className="brand-mark" aria-hidden="true">RT</span>
          <span>Running Tracker</span>
        </div>
        <div className="service-health" aria-label="Service health">
          <StatusDot label="API" value={health.api} />
          <StatusDot label="DB" value={health.database} />
        </div>
      </header>

      <section className="runner-shell" aria-labelledby="runner-title">
        <div className="runner-copy">
          <p className="eyebrow">Runner console · P05.4</p>
          <h1 id="runner-title">Your run,<br />under control.</h1>
          <p className="lede">
            Lifecycle requests and points survive reloads in IndexedDB. A fenced browser lease keeps one
            tab in control while buffered uploads continue; GPS capture joins this screen in P05.5.
          </p>
        </div>

        <section className="control-card" aria-label="Run controls">
          <div className="control-card__topline">
            <span className={`phase-badge phase-badge--${phase}`}>{phase}</span>
            <span className="run-id">{runner.run ? `#${runner.run.runId.slice(0, 8)}` : 'No active run'}</span>
          </div>

          <p className="timer" aria-label={`Elapsed time ${elapsed}`}>{elapsed}</p>
          <p className="timer-label">elapsed foreground session</p>

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
                <button disabled={controlsDisabled} onClick={() => command('pause')} type="button">
                  {phase === 'pausing' ? 'Pausing…' : 'Pause'}
                </button>
              )}
              {commands.includes('resume') && (
                <button disabled={controlsDisabled} onClick={() => command('resume')} type="button">
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
                  disabled={runner.upload.pendingCount > 0 || writer.status !== 'owned'}
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

      {storage.status === 'error' && (
        <section className="notice notice--error" role="alert">
          <div><strong>Local storage unavailable</strong><span>{storage.message}</span></div>
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
      </section>

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
