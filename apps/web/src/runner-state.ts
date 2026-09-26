import type { RunCommandResponse, RunCommandType, RunStatus, RunView } from '@running-tracker/contracts';

export type Connectivity = 'online' | 'offline';
export type UploadStatus = 'idle' | 'uploading' | 'retrying' | 'error';

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

export interface RunnerState {
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
  | { type: 'finished-run-cleared' }
  | { upload: UploadState; type: 'upload-changed' };

export function createInitialRunnerState(connectivity: Connectivity): RunnerState {
  return {
    connectivity,
    error: null,
    pendingRequest: null,
    run: null,
    upload: { message: null, pendingCount: 0, status: 'idle' },
  };
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

function latestRunSnapshot(current: RunView, incoming: RunView): RunView {
  const dataOrder = BigInt(incoming.dataRevision) - BigInt(current.dataRevision);
  if (dataOrder !== 0n) {
    return dataOrder > 0n ? incoming : current;
  }
  return BigInt(incoming.controlRevision) >= BigInt(current.controlRevision) ? incoming : current;
}

export function runnerReducer(state: RunnerState, event: RunnerEvent): RunnerState {
  switch (event.type) {
    case 'connectivity-changed':
      return { ...state, connectivity: event.connectivity };
    case 'storage-restored':
      if (state.pendingRequest !== null) {
        throw new Error('Durable state cannot be synchronized during an active request');
      }
      return {
        ...state,
        error: event.request === null
          ? null
          : {
              message: 'Recovered an unacknowledged request from this browser.',
              request: event.request,
            },
        run: event.run,
        upload: {
          message: null,
          pendingCount: event.pendingPointCount,
          status: 'idle',
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
        error: null,
        pendingRequest: null,
        run: state.run === null ? event.run : latestRunSnapshot(state.run, event.run),
      };
    case 'command-succeeded':
      if (!isSameRequest(state.pendingRequest, event.request) || state.run === null) {
        return state;
      }
      return {
        ...state,
        error: null,
        pendingRequest: null,
        run: {
          ...state.run,
          controlRevision: event.result.controlRevision,
          dataRevision: event.result.dataRevision,
          finishedAt: event.result.finishedAt,
          status: event.result.status,
        },
      };
    case 'request-reconciled':
      if (!isSameRequest(state.pendingRequest, event.request)) {
        return state;
      }
      return { ...state, error: null, pendingRequest: null, run: event.run };
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
    case 'finished-run-cleared':
      if (state.run?.status !== 'finished' || state.pendingRequest !== null) {
        throw new Error('Only a settled finished run can be cleared');
      }
      return {
        ...state,
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
        run: BigInt(event.dataRevision) > BigInt(state.run.dataRevision)
          ? { ...state.run, dataRevision: event.dataRevision }
          : state.run,
      };
    case 'run-reconciled':
      if (state.run?.runId !== event.run.runId) {
        return state;
      }
      return { ...state, run: latestRunSnapshot(state.run, event.run) };
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
