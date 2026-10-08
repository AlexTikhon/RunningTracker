import type { RunCommandType } from '@running-tracker/contracts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { loadHealth, type HealthSnapshot } from './health.js';
import { ArchiveScreen } from './ArchiveScreen.js';
import { CoachScreen } from './CoachScreen.js';
import { CaptureController, type CaptureState } from './capture-controller.js';
import { GeolocationCaptureSource, SimulatorCaptureSource } from './capture-source.js';
import type { CaptureSourceKind } from './capture-source-kind.js';
import { organizationLabel, organizationPrompt } from './organization-selection.js';
import { OrganizationPicker } from './OrganizationPicker.js';
import { executeRunnerRequest } from './runner-requests.js';
import { RunnerView, type StorageState } from './RunnerView.js';
import { SessionBar } from './SessionBar.js';
import { unsentWorkNote } from './unsent-work.js';
import { useOrganizations } from './use-organizations.js';
import { useRunnerSession } from './use-runner-session.js';
import { PointUploadWorker } from './point-upload-worker.js';
import {
  AUTHORITY_RETRY_MS,
  RunAuthority,
  unrecoverableRefusalOf,
  type AuthorityScope,
} from './run-authority.js';
import { RunnerApiError, uploadPointBatch } from './runner-api.js';
import { getBrowserRunnerStorage } from './runner-storage.js';
import { SignInNotice, signInFailureMessage } from './sign-in.js';
import {
  captureMayRun,
  createInitialRunnerState,
  needsAuthoritativeRead,
  refusedRunMayBeDetached,
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
  // The organization the current run belongs to, from the run's own durable record. It is not the selection:
  // choosing another organization to look at can never redirect a run's capture or upload.
  const [runOrgId, setRunOrgId] = useState<string | null>(null);
  const [signInFailure] = useState(() =>
    typeof window === 'undefined' ? undefined : signInFailureMessage(window.location.search),
  );
  const [now, setNow] = useState(() => Date.now());
  const [storage, setStorage] = useState<StorageState>({ status: 'loading' });
  const [writer, setWriter] = useState<WriterOwnershipState>({ status: 'unclaimed' });
  // True from the start of an explicit claim until the page has taken over what the previous owner left behind.
  const [writerSyncing, setWriterSyncing] = useState(false);
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
  // After an explicit sign-out the page forgets what it showed for that person. Only in-memory state goes: the
  // exact points, requests and run pointer stay in IndexedDB for the same person's next sign-in.
  const forgetSignedOutIdentity = useCallback(() => {
    dispatch({ type: 'session-ended' });
    setRunOrgId(null);
    setStorage({ status: 'loading' });
    setCaptureSourceKind(null);
    setCapture({ status: 'idle' });
    setWriter({ status: 'unclaimed' });
  }, []);
  const { session, refreshSession, signOut, signOutState, verification } = useRunnerSession(suspendRunner, forgetSignedOutIdentity);
  const { choose: chooseOrganization, discovery, prefer: preferOrganization, reload: reloadOrganizations, selectedOrgId } =
    useOrganizations(session);
  const [runner, dispatch] = useReducer(
    runnerReducer,
    typeof navigator === 'undefined' || navigator.onLine !== false ? 'online' : 'offline',
    createInitialRunnerState,
  );
  latestUpload.current = runner.upload;
  // Everything that decides whether a server answer about the run may still be used is asked of the page at the moment
  // the answer arrives (run-authority.ts): the run, the identity and organization, the session and the writer.
  const authorityPage = useRef<{ online: boolean; scope: AuthorityScope | null; signal: AbortSignal | null }>({
    online: true,
    scope: null,
    signal: null,
  });
  const authority = useRef<RunAuthority | null>(null);
  authority.current ??= new RunAuthority({
    dispatch,
    host: {
      lease: () => writerCoordinator.current?.currentLease() ?? null,
      online: () => authorityPage.current.online,
      scope: () => authorityPage.current.scope,
      signal: () => authorityPage.current.signal,
    },
    storage: { refreshActiveRun: (...input) => getBrowserRunnerStorage().refreshActiveRun(...input) },
  });
  // A run is captured and uploaded for the organization it was started in; before one exists, the selection decides.
  const scopeOrgId = runner.run !== null ? runOrgId ?? selectedOrgId : selectedOrgId;
  // Capture runs only for a lifecycle the server has confirmed (or, offline, one that will be confirmed on reconnection).
  const captureAllowed = captureMayRun(runner);
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
        setRunOrgId(recovery.orgId);
        preferOrganization(recovery.orgId);
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
  }, [preferOrganization, session]);

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
      || scopeOrgId === null
    ) {
      return undefined;
    }
    const runnerStorage = getBrowserRunnerStorage();
    const writerLease = writerCoordinator.current?.currentLease() ?? null;
    const scope = {
      orgId: scopeOrgId,
      runId: runner.run.runId,
      userId: session.session.identity.userId,
    };
    const worker = new PointUploadWorker({
      onAcknowledged: (dataRevision) => {
        dispatch({ dataRevision, runId: scope.runId, type: 'point-batch-acknowledged' });
      },
      // The server rejected the points for good. What that means for the run is decided by the same scoped
      // authority logic as a read: a definitive refusal joins the recovery flow at once, any other rejection asks
      // the server what the run is. Both are dropped when the page has moved on to another run or writer.
      onPermanentError: async (error) => {
        const coordinator = authority.current;
        if (writerLease === null || coordinator === null || !coordinator.isCurrentScope(scope)) return;
        captureController.current?.stop();
        const marked = await runnerStorage.rejectUpload(scope, errorMessage(error), writerLease);
        if (marked.outcome === 'obsolete') return;
        const refusal = unrecoverableRefusalOf(error);
        if (refusal !== null) coordinator.refuse(scope, refusal);
        else void coordinator.request({ reconcile: true });
      },
      onState: (nextUpload) => {
        if (authority.current?.isCurrentScope(scope)) dispatch({ type: 'upload-changed', upload: nextUpload });
      },
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
  }, [scopeOrgId, runner.run?.runId, session, storage.status, writer.status]);

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
      || runner.run === null
      || !captureAllowed
      || captureSourceKind === null
      || scopeOrgId === null
    ) {
      setCapture({ status: 'idle' });
      return undefined;
    }
    const scope = {
      orgId: scopeOrgId,
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
  }, [captureAllowed, captureSourceKind, scopeOrgId, runner.run?.runId, runner.upload.status === 'blocked', session, storage.status, writer.status]);

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
        // The request stays exactly as it was, queued under its own identity. A definitive refusal of the run also
        // stops the capture and opens the explicit discard; a network failure, a 5xx or any unknown outcome is
        // only a failed request.
        dispatch({ message: errorMessage(error), request, type: 'request-failed' });
        const refusal = request.kind === 'command' ? unrecoverableRefusalOf(error) : null;
        if (refusal !== null) {
          captureController.current?.stop();
          authority.current?.refuse(
            { orgId: request.orgId, runId: request.runId, userId: session.session.identity.userId },
            refusal,
          );
        }
      }
    },
    [runner.connectivity, runner.run, session, storage.status],
  );

  // Asks the server what the run is. A lifecycle read back from IndexedDB, or recorded while offline, is only
  // recoverable data until this answers; capture and the controls wait for it.
  const confirmRun = useCallback(() => { void authority.current?.request(); }, []);

  // The page states what it shows; the coordinator compares every completion with this, not with what was true when
  // the read began. The writer capability is part of the key: another epoch is another operation.
  authorityPage.current = {
    online: runner.connectivity === 'online',
    scope: session.status === 'ready'
      && storage.status === 'ready'
      && restoredUserId.current === session.session.identity.userId
      && runner.run !== null
      && scopeOrgId !== null
      ? { orgId: scopeOrgId, runId: runner.run.runId, userId: session.session.identity.userId }
      : null,
    signal: session.status === 'ready' ? session.signal : null,
  };
  const authorityScope = authorityPage.current.scope;
  const writerSettled = writer.status !== 'unclaimed' && writer.status !== 'acquiring' && !writerSyncing;
  const authorityKey = authorityScope === null
    ? null
    : [authorityScope.userId, authorityScope.orgId, authorityScope.runId, writer.status === 'owned' ? writer.fencingToken : 'read-only'].join('|');
  const authoritySignal = authorityPage.current.signal;
  // A change of run, identity, organization, session or writer epoch (and closing the page) ends what was asked.
  useEffect(() => () => authority.current?.invalidate(), [authorityKey, authoritySignal]);

  const mustConfirm = needsAuthoritativeRead(runner);
  const confirming = runner.authority.status === 'confirming';
  // Ask once the writer question is settled, so the answer is stored by the tab that owns the run. A read that was
  // ended by a change above is asked again here while the reducer is still waiting for it.
  useEffect(() => {
    if (authorityKey !== null && writerSettled && (mustConfirm || confirming)) confirmRun();
  }, [authorityKey, confirmRun, confirming, mustConfirm, runner.connectivity, writerSettled]);

  const retryConfirmation = runner.authority.status === 'unreachable' && runner.connectivity === 'online';
  useEffect(() => {
    if (!retryConfirmation) return undefined;
    const timer = window.setTimeout(confirmRun, AUTHORITY_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [confirmRun, retryConfirmation]);

  const synchronizeAfterClaim = useCallback(async () => {
    if (session.status !== 'ready' || storage.status !== 'ready') {
      return false;
    }
    const recovery = await getBrowserRunnerStorage().loadRecovery(session.session.identity.userId);
    if (recovery.orgId !== null) {
      setRunOrgId(recovery.orgId);
    }
    if (
      runner.pendingRequest === null
      && (recovery.run !== null || recovery.request !== null)
    ) {
      // The restored state replaces what any read in flight was asked about.
      authority.current?.invalidate();
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
    setWriterSyncing(true);
    try {
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
    } finally {
      setWriterSyncing(false);
    }
  }, [synchronizeAfterClaim]);

  const busy = runner.pendingRequest !== null;
  const controlsDisabled = busy
    || runner.error !== null
    || runner.authority.status === 'confirming'
    || mustConfirm
    || session.status !== 'ready'
    || storage.status !== 'ready'
    || writer.status === 'acquiring'
    || (runner.run !== null && writer.status !== 'owned');
  const elapsed = useMemo(
    () => durationLabel(runner.run?.startedAt, runner.run?.finishedAt, now),
    [now, runner.run?.finishedAt, runner.run?.startedAt],
  );
  const needsOrganization = organizationPrompt(discovery, selectedOrgId);
  const organizationNote = session.status !== 'ready'
    ? 'Sign in to start a run.'
    : needsOrganization
      ?? `This run will be recorded in organization ${organizationLabel(selectedOrgId ?? '', discovery.status === 'ready' ? discovery.organizations : [])}. The server rechecks active membership inside the run transaction.`;

  const start = async () => {
    if (selectedOrgId === null || controlsDisabled || runner.run !== null) {
      return;
    }
    if (!await claimWriter()) {
      return;
    }
    const request: StartRequest = {
      kind: 'start',
      orgId: selectedOrgId,
      runId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    };
    setRunOrgId(selectedOrgId);
    void executeRequest(request);
  };

  const command = (type: RunCommandType) => {
    if (runner.run === null || scopeOrgId === null || controlsDisabled) {
      return;
    }
    const request: CommandRequest = {
      commandId: crypto.randomUUID(),
      expectedControlRevision: runner.run.controlRevision,
      kind: 'command',
      orgId: scopeOrgId,
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
    authority.current?.invalidate();
    try {
      await getBrowserRunnerStorage().clearActiveRun(session.session.identity.userId);
      dispatch({ type: 'finished-run-cleared' });
      await writerCoordinator.current?.release();
    } catch (error) {
      setStorage({ message: errorMessage(error), status: 'error' });
    }
  };

  const rejectedScope = session.status === 'ready' && runner.run !== null && scopeOrgId !== null
    ? { userId: session.session.identity.userId, orgId: scopeOrgId, runId: runner.run.runId } : null;
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
      authority.current?.invalidate();
      captureController.current?.stop();
      uploadWorker.current?.stop();
      await getBrowserRunnerStorage().discardRejectedRun(rejectedScope, lease);
      dispatch({ type: 'rejected-run-discarded' });
      await writerCoordinator.current?.release();
    } catch (error) { setStorage({ message: errorMessage(error), status: 'error' }); }
  };

  // Local recovery cleanup for a run the server refuses (ADR-0052). It never calls the API: the run can be neither
  // finished nor deleted by this browser any more. Everything local is stopped first, the transaction checks the
  // writer lease and the exact active run itself, and only then does the page let go of the run and the lease.
  const discardRefusedRecovery = async () => {
    if (rejectedScope === null || busy || !refusedRunMayBeDetached(runner)) return;
    try {
      const lease = await writerCoordinator.current?.assertOwnedLease();
      if (!lease) return;
      authority.current?.invalidate();
      captureController.current?.stop();
      uploadWorker.current?.stop();
      await getBrowserRunnerStorage().discardRefusedRun(rejectedScope, lease);
      dispatch({ runId: rejectedScope.runId, type: 'local-recovery-discarded' });
      await writerCoordinator.current?.release();
      // The refusal may have been a lost membership: the next run follows what the server lists now.
      reloadOrganizations();
    } catch (error) { setStorage({ message: errorMessage(error), status: 'error' }); }
  };

  const viewPrerequisite = (what: string) =>
    session.status === 'ready'
      ? needsOrganization ?? ''
      : `An active session is required before the ${what} can open.`;

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

      <div className="context-bar">
        <OrganizationPicker
          locked={runner.run !== null || busy}
          onChoose={chooseOrganization}
          onRetry={reloadOrganizations}
          selected={selectedOrgId}
          state={discovery}
        />
        <SessionBar
          onRetry={() => void refreshSession()}
          onSignOut={() => void signOut()}
          session={session}
          signOut={signOutState}
          unsentNote={unsentWorkNote(runner)}
          verification={verification}
        />
      </div>

      {session.status === 'required' && <SignInNotice failure={signInFailure} message={session.message} />}

      <div hidden={activeView !== 'runner'}>
        <RunnerView
          canStart={scopeOrgId !== null}
          capture={capture}
          captureSourceKind={captureSourceKind}
          controlsDisabled={controlsDisabled}
          elapsed={elapsed}
          onChooseCaptureSource={chooseCaptureSource}
          onClearFinishedRun={() => void clearFinishedRun()}
          onConfirmRun={confirmRun}
          onCommand={command}
          onRetryOwnership={() => void claimWriter()}
          onRetryRequest={() => { if (runner.error !== null) void executeRequest(runner.error.request); }}
          onStart={() => void start()}
          organizationNote={organizationNote}
          refused={{
            canDiscard: rejectedScope !== null,
            onDiscard: () => void discardRefusedRecovery(),
          }}
          rejected={{
            canDiscard: rejectedScope !== null,
            canExport: rejectedScope !== null,
            onDiscard: () => void discardRejectedPoints(),
            onExport: () => void exportRejectedPoints(),
          }}
          runner={runner}
          sessionReady={session.status === 'ready'}
          storage={storage}
          writer={writer}
        />
      </div>

      {activeView === 'coach' && (
        session.status === 'ready' && selectedOrgId !== null ? (
          <CoachScreen
            orgId={selectedOrgId}
            sessionExpiresAt={session.session.expiresAt}
            userId={session.session.identity.userId}
          />
        ) : (
          <section className="coach-prerequisite" role="status">{viewPrerequisite('coach stream')}</section>
        )
      )}

      {activeView === 'archive' && (
        session.status === 'ready' && selectedOrgId !== null ? (
          <ArchiveScreen
            accessToken={mapboxAccessToken}
            orgId={selectedOrgId}
            userId={session.session.identity.userId}
          />
        ) : (
          <section className="coach-prerequisite" role="status">{viewPrerequisite('archive source')}</section>
        )
      )}
    </main>
  );
}

function StatusDot({ label, value }: { label: string; value: string }) {
  return <span><i className={`dot dot--${value}`} aria-hidden="true" />{label} {value}</span>;
}
