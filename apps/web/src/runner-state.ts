import type { RunCommandResponse, RunCommandType, RunStatus, RunView } from '@running-tracker/contracts';

import { advanceDataRevision, mergeCommandResult, mergeRunSnapshot } from './run-snapshot.js';

export type Connectivity = 'online' | 'offline';
export type UploadStatus = 'idle' | 'uploading' | 'retrying' | 'error' | 'suspended' | 'blocked';

export interface UploadState {
  message: string | null;
  pendingCount: number;
  status: UploadStatus;
}

export interface StartRequest {
  kind: 'start';
  orgId: string;
  runId: string;
  startedAt: string;
}

export interface CommandRequest {
  commandId: string;
  expectedControlRevision: string;
  kind: 'command';
  orgId: string;
  runId: string;
  type: RunCommandType;
}

export type RunnerRequest = StartRequest | CommandRequest;

export interface RunnerFailure {
  message: string;
  request: RunnerRequest;
}

// Whether the lifecycle shown for the current run comes from a server answer, kept apart from the lifecycle
// itself: the copy in IndexedDB is recoverable data, never proof that the server still considers the run active.
//  - confirmed:   a server answer in this page lifetime (start, command, reconciliation, authoritative read)
//  - restored:    read from IndexedDB; the server has not been asked yet
//  - offline:     could not be asked because the browser is offline; ask again on reconnection
//  - confirming:  the authoritative read `attempt` is in flight; `offlineCapture` keeps an offline capture running
//  - unreachable: asked while online without an answer (network, timeout, 5xx); not proof of anything
//  - refused:     the server answered that the run is not readable (403/404/410...); not resumable. `code` is the
//                 server's error code, kept so that nothing has to be decided from the message (ADR-0052).
export type RunAuthority =
  | { status: 'confirmed' }
  | { status: 'restored' }
  | { status: 'offline' }
  | { attempt: number; offlineCapture: boolean; status: 'confirming' }
  | { message: string; status: 'unreachable' }
  | { code: string; message: string; status: 'refused' };

export interface RunnerState {
  authority: RunAuthority;
  // Counts authoritative reads so a late answer to a superseded one is recognisable and dropped.
  authorityAttempt: number;
  connectivity: Connectivity;
  error: RunnerFailure | null;
  pendingRequest: RunnerRequest | null;
  run: RunView | null;
  upload: UploadState;
}

export type RunnerPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'finishing'
  | 'finished'
  | 'error';

export type RunnerEvent =
  | { connectivity: Connectivity; type: 'connectivity-changed' }
  | {
      pendingPointCount: number;
      uploadRejection?: string | null;
      request: RunnerRequest | null;
      run: RunView | null;
      type: 'storage-restored';
    }
  | { request: RunnerRequest; type: 'request-started' }
  | { request: StartRequest; run: RunView; type: 'start-succeeded' }
  | { request: CommandRequest; result: RunCommandResponse; type: 'command-succeeded' }
  | { request: CommandRequest; run: RunView; type: 'request-reconciled' }
  | { message: string; request: RunnerRequest; type: 'request-failed' }
  | { runId: string; type: 'point-buffered' }
  | { dataRevision: string; runId: string; type: 'point-batch-acknowledged' }
  | { run: RunView; type: 'run-reconciled' }
  | { attempt: number; type: 'authority-requested' }
  | { attempt: number; run: RunView; type: 'authority-confirmed' }
  | { attempt: number; kind: 'unreachable'; message: string; type: 'authority-unconfirmed' }
  | { attempt: number; code: string; kind: 'refused'; message: string; type: 'authority-unconfirmed' }
  // The server refused the run in answer to an upload or a command, not to a read. Same meaning as a refused read.
  | { code: string; message: string; runId: string; type: 'authority-refused' }
  | { type: 'rejected-run-discarded' }
  // The browser's recovery copy of a run the server refused was cleared on purpose. Local only: not a lifecycle
  // event, and nothing about the server run is implied.
  | { runId: string; type: 'local-recovery-discarded' }
  | { type: 'session-ended' }
  | { type: 'finished-run-cleared' }
  | { upload: UploadState; type: 'upload-changed' };

export function createInitialRunnerState(connectivity: Connectivity): RunnerState {
  return {
    authority: { status: 'confirmed' },
    authorityAttempt: 0,
    connectivity,
    error: null,
    pendingRequest: null,
    run: null,
    upload: { message: null, pendingCount: 0, status: 'idle' },
  };
}

// An offline period ends any confirmation: the server may have changed the run meanwhile, so the first answer
// after reconnection must be an authoritative read. Only states that can still hold a capture or a stale view
// are downgraded; an in-flight read and a refusal keep their meaning.
function afterConnectivityChange(authority: RunAuthority, connectivity: Connectivity): RunAuthority {
  if (connectivity !== 'offline') return authority;
  return authority.status === 'confirmed' || authority.status === 'restored' || authority.status === 'unreachable'
    ? { status: 'offline' }
    : authority;
}

// The one gate for starting or continuing capture. A restored lifecycle is not trusted until the server has
// answered; the exception is the existing offline behaviour, where the server cannot answer and the run is
// recorded locally, to be confirmed on reconnection.
export function captureMayRun(state: RunnerState): boolean {
  if (state.run?.status !== 'recording') return false;
  switch (state.authority.status) {
    case 'confirmed':
    case 'offline':
      return true;
    case 'confirming':
      return state.authority.offlineCapture;
    case 'restored':
    case 'unreachable':
    case 'refused':
      return false;
  }
}

// The answers that mean "this identity cannot use this run, now or later": the run was deleted, it does not exist
// for this identity, or the membership that gave access is gone. Everything else a server can say about a read
// (a malformed request, a missing route, a rejected origin, a conflict) is about the request or the deployment,
// not the run, and never opens the local detach.
const UNRECOVERABLE_RUN_CODES: ReadonlySet<string> = new Set(['RUN_DELETED', 'RUN_NOT_FOUND', 'ORG_ACCESS_DENIED']);

export function isUnrecoverableRunCode(code: string): boolean {
  return UNRECOVERABLE_RUN_CODES.has(code);
}

// Whether the person may be offered the explicit local discard: the server definitely refused this run for one of
// the codes above. An unreachable server, a restored or unconfirmed run and any other refusal never qualify.
export function refusedRunMayBeDetached(state: RunnerState): boolean {
  return state.run !== null
    && state.authority.status === 'refused'
    && isUnrecoverableRunCode(state.authority.code);
}

// Whether the run must be asked about now: a restored or offline-recorded lifecycle, once the browser is online.
export function needsAuthoritativeRead(state: RunnerState): boolean {
  return state.connectivity === 'online'
    && state.run !== null
    && state.run.status !== 'finished'
    && (state.authority.status === 'restored' || state.authority.status === 'offline');
}

function isSameRequest(left: RunnerRequest | null, right: RunnerRequest): boolean {
  if (left === null || left.kind !== right.kind || left.orgId !== right.orgId || left.runId !== right.runId) {
    return false;
  }
  return left.kind === 'start'
    ? left.startedAt === (right as StartRequest).startedAt
    : left.commandId === (right as CommandRequest).commandId;
}

function assertRequestAllowed(state: RunnerState, request: RunnerRequest): void {
  if (request.kind === 'start') {
    if (state.run !== null) {
      throw new Error('A run can only be started from the idle state');
    }
    return;
  }

  if (state.run === null || state.run.runId !== request.runId) {
    throw new Error('A command requires the current run');
  }
  const allowed = availableCommands(state.run.status);
  if (!allowed.includes(request.type)) {
    throw new Error(`The ${request.type} command is invalid while ${state.run.status}`);
  }
}

export function runnerReducer(state: RunnerState, event: RunnerEvent): RunnerState {
  switch (event.type) {
    case 'connectivity-changed':
      return {
        ...state,
        authority: state.run === null ? state.authority : afterConnectivityChange(state.authority, event.connectivity),
        connectivity: event.connectivity,
      };
    case 'storage-restored':
      if (state.pendingRequest !== null) {
        throw new Error('Durable state cannot be synchronized during an active request');
      }
      return {
        ...state,
        authority: event.run === null
          ? { status: 'confirmed' }
          : state.connectivity === 'offline' ? { status: 'offline' } : { status: 'restored' },
        error: event.request === null
          ? null
          : {
              message: 'Recovered an unacknowledged request from this browser.',
              request: event.request,
            },
        run: event.run,
        upload: {
          message: event.uploadRejection ?? null,
          pendingCount: event.pendingPointCount,
          status: event.uploadRejection ? 'blocked' : 'idle',
        },
      };
    case 'request-started':
      if (state.pendingRequest !== null) {
        throw new Error('Only one runner request may be active');
      }
      assertRequestAllowed(state, event.request);
      return { ...state, error: null, pendingRequest: event.request };
    case 'start-succeeded':
      if (!isSameRequest(state.pendingRequest, event.request)) {
        return state;
      }
      return {
        ...state,
        authority: { status: 'confirmed' },
        error: null,
        pendingRequest: null,
        run: state.run === null ? event.run : mergeRunSnapshot(state.run, event.run),
      };
    case 'command-succeeded':
      if (!isSameRequest(state.pendingRequest, event.request) || state.run === null) {
        return state;
      }
      return {
        ...state,
        authority: { status: 'confirmed' },
        error: null,
        pendingRequest: null,
        run: mergeCommandResult(state.run, event.result),
      };
    case 'request-reconciled':
      if (!isSameRequest(state.pendingRequest, event.request)) {
        return state;
      }
      return {
        ...state,
        authority: { status: 'confirmed' },
        error: null,
        pendingRequest: null,
        run: mergeRunSnapshot(state.run, event.run),
      };
    case 'request-failed':
      if (!isSameRequest(state.pendingRequest, event.request)) {
        return state;
      }
      return {
        ...state,
        error: { message: event.message, request: event.request },
        pendingRequest: null,
      };
    case 'point-buffered':
      if (state.run?.runId !== event.runId) {
        return state;
      }
      return {
        ...state,
        upload: {
          ...state.upload,
          pendingCount: state.upload.pendingCount + 1,
        },
      };
    case 'session-ended':
      // Signing out removes what the previous identity's page showed. The durable copy in IndexedDB is not part of
      // this state and is untouched: the next sign-in restores it for the same user only.
      return createInitialRunnerState(state.connectivity);
    case 'rejected-run-discarded':
      return {
        ...state,
        authority: { status: 'confirmed' },
        error: null,
        pendingRequest: null,
        run: null,
        upload: { message: null, pendingCount: 0, status: 'idle' },
      };
    case 'local-recovery-discarded':
      // Storage already cleared the run, so the page follows it, whatever the authority has become meanwhile; the
      // only thing ignored is a report about a run that is not the one shown.
      if (state.run?.runId !== event.runId) {
        return state;
      }
      return {
        ...state,
        authority: { status: 'confirmed' },
        error: null,
        pendingRequest: null,
        run: null,
        upload: { message: null, pendingCount: 0, status: 'idle' },
      };
    case 'finished-run-cleared':
      if (state.run?.status !== 'finished' || state.pendingRequest !== null) {
        throw new Error('Only a settled finished run can be cleared');
      }
      return {
        ...state,
        authority: { status: 'confirmed' },
        error: null,
        run: null,
        upload: { message: null, pendingCount: 0, status: 'idle' },
      };
    case 'point-batch-acknowledged':
      if (state.run?.runId !== event.runId) {
        return state;
      }
      return {
        ...state,
        run: advanceDataRevision(state.run, event.dataRevision),
      };
    case 'run-reconciled':
      if (state.run?.runId !== event.run.runId) {
        return state;
      }
      return { ...state, authority: { status: 'confirmed' }, run: mergeRunSnapshot(state.run, event.run) };
    case 'authority-requested':
      // The reads are numbered by the coordinator that owns them (run-authority.ts), so a number is accepted when
      // it is newer than every one seen; a repeated or older number, a request for a finished run and one for a
      // confirmed run change nothing. A newer request while one is in flight supersedes it (the coordinator
      // restarts a read after a writer change); the capture an offline read kept running stays running.
      if (
        event.attempt <= state.authorityAttempt
        || state.run === null
        || state.run.status === 'finished'
        || state.authority.status === 'confirmed'
      ) {
        return state;
      }
      return {
        ...state,
        authority: {
          attempt: event.attempt,
          offlineCapture: state.authority.status === 'confirming'
            ? state.authority.offlineCapture
            : state.authority.status === 'offline',
          status: 'confirming',
        },
        authorityAttempt: event.attempt,
      };
    case 'authority-refused':
      // A definitive answer from an upload or a command rather than from a read. It is about one run, so a
      // report for another run, or for none, changes nothing; otherwise it ends whatever read was in flight.
      if (state.run?.runId !== event.runId) {
        return state;
      }
      return { ...state, authority: { code: event.code, message: event.message, status: 'refused' } };
    case 'authority-confirmed':
      // Only the answer to the read in flight counts, and only for the run it was asked about. The merge is the
      // ordering rule, so an answer older than what is already known cannot move the lifecycle backwards.
      if (
        state.authority.status !== 'confirming'
        || state.authority.attempt !== event.attempt
        || state.run?.runId !== event.run.runId
      ) {
        return state;
      }
      return { ...state, authority: { status: 'confirmed' }, run: mergeRunSnapshot(state.run, event.run) };
    case 'authority-unconfirmed':
      if (state.authority.status !== 'confirming' || state.authority.attempt !== event.attempt) {
        return state;
      }
      // Failing to reach the server while the browser is offline is the offline case, not a fault.
      return {
        ...state,
        authority: event.kind === 'refused'
          ? { code: event.code, message: event.message, status: 'refused' }
          : state.connectivity === 'offline'
            ? { status: 'offline' }
            : { message: event.message, status: 'unreachable' },
      };
    case 'upload-changed':
      return { ...state, upload: event.upload };
  }
}

export function availableCommands(status: RunStatus): RunCommandType[] {
  switch (status) {
    case 'recording':
      return ['pause', 'finish'];
    case 'paused':
      return ['resume', 'finish'];
    case 'finished':
      return [];
  }
}

export function runnerPhase(state: RunnerState): RunnerPhase {
  if (state.pendingRequest?.kind === 'start') {
    return 'starting';
  }
  if (state.pendingRequest?.kind === 'command') {
    return state.pendingRequest.type === 'pause'
      ? 'pausing'
      : state.pendingRequest.type === 'resume'
        ? 'resuming'
        : 'finishing';
  }
  if (state.error !== null) {
    return 'error';
  }
  return state.run?.status ?? 'idle';
}
