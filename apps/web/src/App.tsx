import type { RunCommandType } from '@running-tracker/contracts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { loadHealth, type HealthSnapshot } from './health.js';
import { ArchiveScreen } from './ArchiveScreen.js';
import { CoachScreen } from './CoachScreen.js';
import { CaptureController, type CaptureState } from './capture-controller.js';
import { performFinishedRunClear } from './finished-run-clear.js';
import { GeolocationCaptureSource, SimulatorCaptureSource } from './capture-source.js';
import type { CaptureSourceKind } from './capture-source-kind.js';
import { organizationLabel, organizationPrompt } from './organization-selection.js';
import { OrganizationPicker } from './OrganizationPicker.js';
import { performRunnerRequest } from './runner-requests.js';
import { RunnerView, type StorageState } from './RunnerView.js';
import { RunSharePanel } from './RunSharePanel.js';
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
  rejectedStartMayBeAbandoned,
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
  // The monotonic clock the capture controller stamps its saved points with; only for the freshness the page shows.
  const [captureNowMs, setCaptureNowMs] = useState(() => performance.now());
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
  // While the abandonment of a rejected Start is being stored no other request may begin, so the page cannot be
  // asked to restore durable state underneath a request in flight.
  const abandoningStart = useRef(false);
  const [abandonFailure, setAbandonFailure] = useState<string | null>(null);
  // The lifecycle request this page has in flight. A suspended or replaced session lets go of it, so its late
  // completion reports nothing (ADR-0059); the exact request stays queued in IndexedDB.
  const requestOperation = useRef<{ request: RunnerRequest } | null>(null);
  // The "New run" clear this page has in flight. A suspended or replaced session lets go of it too, so its late
  // completion neither reports nor releases anything; no lifecycle request begins while it is set.
  const clearingRun = useRef<object | null>(null);
  const suspendRunner = useCallback(() => {
    const operation = requestOperation.current;
    requestOperation.current = null;
    clearingRun.current = null;
    if (operation !== null) dispatch({ recovery: null, request: operation.request, type: 'request-obsolete' });
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
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setCaptureNowMs(performance.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [runner.run]);

  const executeRequest = useCallback(
    async (request: RunnerRequest) => {
      if (session.status !== 'ready' || storage.status !== 'ready' || abandoningStart.current || clearingRun.current !== null) {
        return;
      }
      // The capability the request is made under: this user, owner and fencing epoch, in this session.
      const lease = await writerCoordinator.current?.assertOwnedLease();
      if (!lease || session.signal.aborted) {
        return;
      }
      const operation = { request };
      requestOperation.current = operation;
      const userId = session.session.identity.userId;
      setAbandonFailure(null);
      dispatch({ request, type: 'request-started' });
      try {
        await performRunnerRequest({
          csrf: session.session.csrf,
          describe: errorMessage,
          dispatch,
          lease,
          // The durable state replaces what any read in flight was asked about.
          onFollow: (recovery) => {
            authority.current?.invalidate();
            setRunOrgId(recovery.orgId);
          },
          // A definitive refusal of the run also stops the capture and opens the explicit discard.
          onRefused: (refusal) => {
            captureController.current?.stop();
            authority.current?.refuse({ orgId: request.orgId, runId: request.runId, userId }, refusal);
          },
          online: runner.connectivity === 'online',
          page: {
            current: () => requestOperation.current === operation && !session.signal.aborted,
            lease: () => writerCoordinator.current?.currentLease() ?? null,
          },
          request,
          revalidate: async () => await writerCoordinator.current?.assertOwnedLease() ?? null,
          run: runner.run,
          signal: session.signal,
          storage: getBrowserRunnerStorage(),
          userId,
        });
      } finally {
        if (requestOperation.current === operation) requestOperation.current = null;
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

  // "Retry GPS" (ADR-0061). It asks only for what the capture effect would start under now: this session, a run the
  // server lets record, the owned writer and an unblocked upload. The controller then stops the old watch, proves
  // the lease again and starts one new watch in a new durable segment. No lifecycle request and no buffer change.
  const retryCapture = () => {
    if (
      session.status !== 'ready'
      || session.signal.aborted
      || storage.status !== 'ready'
      || writer.status !== 'owned'
      || runner.run === null
      || runner.upload.status === 'blocked'
      || !captureAllowed
      || captureSourceKind !== 'geolocation'
    ) {
      return;
    }
    void captureController.current?.retry();
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

  // "New run". The storage transaction decides whether this exact finished run may be let go of for the writer epoch
  // the page proves now; the completion reaches the page only while it still has the same session, operation and
  // coordinator, and only that coordinator's same epoch is released (finished-run-clear.ts).
  const clearFinishedRun = async () => {
    const coordinator = writerCoordinator.current;
    if (
      session.status !== 'ready'
      || storage.status !== 'ready'
      || coordinator === null
      || runner.run?.status !== 'finished'
      || scopeOrgId === null
      || busy
      || clearingRun.current !== null
    ) {
      return;
    }
    const operation = {};
    clearingRun.current = operation;
    const { signal } = session;
    const current = () => clearingRun.current === operation && !signal.aborted;
    authority.current?.invalidate();
    try {
      await performFinishedRunClear({
        dispatch,
        onFollow: (recovery) => {
          authority.current?.invalidate();
          setRunOrgId(recovery.orgId);
        },
        page: {
          current,
          lease: () => (writerCoordinator.current === coordinator ? coordinator.currentLease() : null),
        },
        release: () => coordinator.release(),
        revalidate: () => coordinator.assertOwnedLease(),
        scope: { orgId: scopeOrgId, runId: runner.run.runId, userId: session.session.identity.userId },
        storage: getBrowserRunnerStorage(),
      });
    } catch (error) {
      if (current()) setStorage({ message: errorMessage(error), status: 'error' });
    } finally {
      if (clearingRun.current === operation) clearingRun.current = null;
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

  // The local way out of a Start the server definitively rejected (ADR-0058). It never calls the API: no run was
  // created, so there is nothing to finish or delete. Only the exact queued Start is removed, inside a transaction
  // that checks the writer lease itself; what that transaction finds is what the page then follows.
  const abandonRejectedStart = async () => {
    const request = runner.error?.request;
    if (
      session.status !== 'ready'
      || request?.kind !== 'start'
      || busy
      || abandoningStart.current
      || !rejectedStartMayBeAbandoned(runner)
    ) {
      return;
    }
    const userId = session.session.identity.userId;
    abandoningStart.current = true;
    setAbandonFailure(null);
    try {
      const lease = await writerCoordinator.current?.assertOwnedLease();
      if (!lease) return;
      const runnerStorage = getBrowserRunnerStorage();
      const outcome = await runnerStorage.abandonQueuedStart(userId, request, lease);
      if (outcome.outcome === 'abandoned') {
        dispatch({ request, type: 'start-abandoned' });
        setRunOrgId(null);
        await writerCoordinator.current?.release();
        // A rejection that came from a lost membership: the next Start follows what the server lists now.
        reloadOrganizations();
        return;
      }
      // The queue is no longer what this page showed (another tab, a newer request, a lost writer). Follow the
      // durable state, whatever it is, instead of acting on a screen that is out of date.
      const recovery = await runnerStorage.loadRecovery(userId);
      setRunOrgId(recovery.orgId);
      authority.current?.invalidate();
      dispatch({
        pendingPointCount: recovery.pendingPointCount,
        request: recovery.request,
        run: recovery.run,
        type: 'storage-restored',
        uploadRejection: recovery.uploadRejection,
      });
    } catch (error) {
      setAbandonFailure(errorMessage(error));
    } finally {
      abandoningStart.current = false;
    }
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
          captureNowMs={captureNowMs}
          captureSourceKind={captureSourceKind}
          controlsDisabled={controlsDisabled}
          elapsed={elapsed}
          onChooseCaptureSource={chooseCaptureSource}
          onClearFinishedRun={() => void clearFinishedRun()}
          onConfirmRun={confirmRun}
          onCommand={command}
          onRetryCapture={retryCapture}
          onRetryOwnership={() => void claimWriter()}
          onRetryRequest={() => { if (runner.error !== null) void executeRequest(runner.error.request); }}
          onStart={() => void start()}
          organizationNote={organizationNote}
          refused={{
            canDiscard: rejectedScope !== null,
            onDiscard: () => void discardRefusedRecovery(),
          }}
          rejectedStart={{
            canAbandon: session.status === 'ready',
            failure: abandonFailure,
            onAbandon: () => void abandonRejectedStart(),
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
        {/* Sharing is the owner's server-side decision, outside the lifecycle queue and the writer lease (ADR-0063).
            The key makes a new user, organization or run a new panel; the session signal silences a replaced session. */}
        {session.status === 'ready'
          && restoredUserId.current === session.session.identity.userId
          && runner.run !== null
          && scopeOrgId !== null
          && runner.authority.status !== 'refused' && (
          <RunSharePanel
            csrfToken={session.session.csrf.token}
            key={`${session.session.identity.userId}|${scopeOrgId}|${runner.run.runId}`}
            orgId={scopeOrgId}
            runId={runner.run.runId}
            signal={session.signal}
          />
        )}
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
            csrf={session.session.csrf}
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
