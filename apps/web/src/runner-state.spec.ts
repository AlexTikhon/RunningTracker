import type { RunCommandResponse, RunView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  availableCommands,
  createInitialRunnerState,
  rejectedStartMayBeAbandoned,
  runnerPhase,
  runnerReducer,
  type CommandRequest,
  type StartRequest,
} from './runner-state.js';

const startRequest: StartRequest = {
  kind: 'start',
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  startedAt: '2026-09-26T08:00:00.000Z',
};

const recordingRun: RunView = {
  controlRevision: '0',
  dataRevision: '0',
  finishedAt: null,
  rawState: 'available',
  runId: startRequest.runId,
  startedAt: startRequest.startedAt,
  status: 'recording',
  summary: null,
};

function startRecording() {
  const pending = runnerReducer(createInitialRunnerState('online'), {
    request: startRequest,
    type: 'request-started',
  });
  return runnerReducer(pending, { request: startRequest, run: recordingRun, type: 'start-succeeded' });
}

describe('runnerReducer', () => {
  it('forgets the signed-out identity run, pending request, error and upload state, but keeps the connection', () => {
    const pending = runnerReducer(startRecording(), {
      request: {
        commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        expectedControlRevision: '0',
        kind: 'command',
        orgId: startRequest.orgId,
        runId: startRequest.runId,
        type: 'pause',
      },
      type: 'request-started',
    });
    const buffered = runnerReducer(
      runnerReducer(pending, { runId: startRequest.runId, type: 'point-buffered' }),
      { connectivity: 'offline', type: 'connectivity-changed' },
    );
    expect(buffered.pendingRequest).not.toBeNull();
    expect(buffered.upload.pendingCount).toBe(1);

    expect(runnerReducer(buffered, { type: 'session-ended' })).toEqual(createInitialRunnerState('offline'));
  });

  it.each(['pause', 'finish'] as const)('keeps %s confirmed in either upload/command ACK order', (type) => {
    const request: CommandRequest = { kind: 'command', orgId: startRequest.orgId, runId: startRequest.runId, commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expectedControlRevision: '0', type };
    const result: RunCommandResponse = { commandId: request.commandId, controlRevision: '1', dataRevision: '1', status: type === 'pause' ? 'paused' : 'finished', finishedAt: type === 'finish' ? '2026-09-26T08:01:00.000Z' : null };
    for (const uploadFirst of [true, false]) {
      let state = runnerReducer(startRecording(), { type: 'request-started', request });
      if (uploadFirst) state = runnerReducer(state, { type: 'point-batch-acknowledged', runId: request.runId, dataRevision: '2' });
      state = runnerReducer(state, { type: 'command-succeeded', request, result });
      if (!uploadFirst) state = runnerReducer(state, { type: 'point-batch-acknowledged', runId: request.runId, dataRevision: '2' });
      expect(state.run).toMatchObject({ controlRevision: '1', dataRevision: '2', status: result.status, finishedAt: result.finishedAt });
      state = runnerReducer(state, { type: 'run-reconciled', run: { ...recordingRun, dataRevision: '3' } });
      expect(state.run).toMatchObject({ controlRevision: '1', dataRevision: '3', status: result.status });
    }
  });
  it('moves from idle through starting to recording', () => {
    const idle = createInitialRunnerState('online');
    const pending = runnerReducer(idle, { request: startRequest, type: 'request-started' });

    expect(runnerPhase(pending)).toBe('starting');
    expect(runnerPhase(startRecording())).toBe('recording');
  });

  it('applies revision-aware lifecycle results to the current run', () => {
    const command: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId: startRequest.orgId,
      runId: startRequest.runId,
      type: 'pause',
    };
    const pending = runnerReducer(startRecording(), { request: command, type: 'request-started' });
    const result: RunCommandResponse = {
      commandId: command.commandId,
      controlRevision: '1',
      dataRevision: '1',
      finishedAt: null,
      status: 'paused',
    };

    const paused = runnerReducer(pending, { request: command, result, type: 'command-succeeded' });

    expect(runnerPhase(paused)).toBe('paused');
    expect(paused.run).toMatchObject({ controlRevision: '1', dataRevision: '1', status: 'paused' });
  });

  it('retains the exact failed request so an unknown outcome can be retried idempotently', () => {
    const pending = runnerReducer(createInitialRunnerState('online'), {
      request: startRequest,
      type: 'request-started',
    });
    const failed = runnerReducer(pending, {
      message: 'Network request failed',
      request: startRequest,
      type: 'request-failed',
    });

    expect(runnerPhase(failed)).toBe('error');
    expect(failed.error?.request).toBe(startRequest);
    expect(runnerReducer(failed, { request: startRequest, type: 'request-started' }).pendingRequest).toBe(
      startRequest,
    );
  });

  it('tracks connectivity independently of the server-confirmed run state', () => {
    const offline = runnerReducer(startRecording(), {
      connectivity: 'offline',
      type: 'connectivity-changed',
    });

    expect(offline.connectivity).toBe('offline');
    expect(runnerPhase(offline)).toBe('recording');
  });

  it('advances acknowledged data revisions monotonically', () => {
    const state = startRecording();
    const advanced = runnerReducer(state, {
      dataRevision: '3',
      runId: recordingRun.runId,
      type: 'point-batch-acknowledged',
    });
    const late = runnerReducer(advanced, {
      dataRevision: '2',
      runId: recordingRun.runId,
      type: 'point-batch-acknowledged',
    });
    const staleReconciliation = runnerReducer(late, {
      run: recordingRun,
      type: 'run-reconciled',
    });

    expect(advanced.run?.dataRevision).toBe('3');
    expect(late.run?.dataRevision).toBe('3');
    expect(staleReconciliation.run?.dataRevision).toBe('3');
  });

  it('reflects each durably buffered capture before the uploader wakes', () => {
    const buffered = runnerReducer(startRecording(), {
      runId: recordingRun.runId,
      type: 'point-buffered',
    });

    expect(buffered.upload.pendingCount).toBe(1);
  });

  it('restores a confirmed run, pending point count, and exact unacknowledged request', () => {
    const command: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId: startRequest.orgId,
      runId: startRequest.runId,
      type: 'finish',
    };

    const restored = runnerReducer(createInitialRunnerState('offline'), {
      pendingPointCount: 7,
      request: command,
      run: recordingRun,
      type: 'storage-restored',
    });

    expect(restored.run).toEqual(recordingRun);
    expect(restored.upload.pendingCount).toBe(7);
    expect(restored.error?.request).toEqual(command);
    expect(runnerPhase(restored)).toBe('error');
  });

  it('synchronizes a durable request when a new tab takes ownership of an existing run', () => {
    const staleTab = startRecording();
    const command: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId: startRequest.orgId,
      runId: startRequest.runId,
      type: 'pause',
    };

    const synchronized = runnerReducer(staleTab, {
      pendingPointCount: 4,
      request: command,
      run: recordingRun,
      type: 'storage-restored',
    });

    expect(synchronized.error?.request).toEqual(command);
    expect(synchronized.upload.pendingCount).toBe(4);
    expect(runnerPhase(synchronized)).toBe('error');
  });

  it('ignores stale completions from superseded requests', () => {
    const state = startRecording();
    const stale = runnerReducer(state, {
      request: startRequest,
      run: { ...recordingRun, status: 'paused' },
      type: 'start-succeeded',
    });

    expect(stale).toBe(state);
  });

  it('settles a stale command with an authoritative reconciled run', () => {
    const command: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId: startRequest.orgId,
      runId: startRequest.runId,
      type: 'finish',
    };
    const pending = runnerReducer(startRecording(), { request: command, type: 'request-started' });
    const authoritative = {
      ...recordingRun,
      dataRevision: '1',
      finishedAt: '2026-09-26T09:00:00.000Z',
      status: 'finished' as const,
    };

    const reconciled = runnerReducer(pending, {
      request: command,
      run: authoritative,
      type: 'request-reconciled',
    });

    expect(reconciled.pendingRequest).toBeNull();
    expect(reconciled.run).toEqual(authoritative);
    expect(runnerPhase(reconciled)).toBe('finished');
  });

  // ADR-0059: the completion of a request whose writer epoch or durable write is obsolete reports nothing.
  describe('an obsolete request', () => {
    const pause: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId: startRequest.orgId,
      runId: startRequest.runId,
      type: 'pause',
    };

    it('is released without a success or a failure, and the page keeps its run when nothing could be read', () => {
      const pending = runnerReducer(startRecording(), { request: pause, type: 'request-started' });
      const released = runnerReducer(pending, { recovery: null, request: pause, type: 'request-obsolete' });
      expect(released).toEqual({ ...pending, pendingRequest: null });
      expect(released.error).toBeNull();
      expect(released.run?.status).toBe('recording');
      // The late answer to the released request is a stale completion like any other.
      expect(runnerReducer(released, { request: pause, result: { commandId: pause.commandId, controlRevision: '1', dataRevision: '0', finishedAt: null, status: 'paused' }, type: 'command-succeeded' })).toBe(released);
    });

    it('follows the durable state another writer left: no run, nothing queued', () => {
      const pending = runnerReducer(startRecording(), { request: pause, type: 'request-started' });
      const followed = runnerReducer(pending, {
        recovery: { pendingPointCount: 0, request: null, run: null, uploadRejection: null },
        request: pause,
        type: 'request-obsolete',
      });
      expect(followed.pendingRequest).toBeNull();
      expect(followed.run).toBeNull();
      expect(followed.error).toBeNull();
      expect(runnerPhase(followed)).toBe('idle');
    });

    it('follows a durable state that still holds the exact request, as a recovered request awaiting confirmation', () => {
      const pending = runnerReducer(startRecording(), { request: pause, type: 'request-started' });
      const followed = runnerReducer(pending, {
        recovery: { pendingPointCount: 2, request: pause, run: recordingRun, uploadRejection: null },
        request: pause,
        type: 'request-obsolete',
      });
      expect(followed).toMatchObject({ authority: { status: 'restored' }, error: { request: pause }, pendingRequest: null, run: recordingRun, upload: { pendingCount: 2 } });
    });

    it('changes nothing when it is not the request in flight', () => {
      const pending = runnerReducer(startRecording(), { request: pause, type: 'request-started' });
      const other = { ...pause, commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
      expect(runnerReducer(pending, { recovery: null, request: other, type: 'request-obsolete' })).toBe(pending);
      const idle = startRecording();
      expect(runnerReducer(idle, { recovery: { pendingPointCount: 0, request: null, run: null }, request: pause, type: 'request-obsolete' })).toBe(idle);
    });
  });

  it('exposes only valid lifecycle commands', () => {
    expect(availableCommands('recording')).toEqual(['pause', 'finish']);
    expect(availableCommands('paused')).toEqual(['resume', 'finish']);
    expect(availableCommands('finished')).toEqual([]);
  });

  it('clears a settled finished run before starting another one', () => {
    const finished = {
      ...startRecording(),
      run: {
        ...recordingRun,
        controlRevision: '1',
        dataRevision: '1',
        finishedAt: '2026-09-26T09:00:00.000Z',
        status: 'finished' as const,
      },
    };

    expect(runnerPhase(runnerReducer(finished, { runId: recordingRun.runId, type: 'finished-run-cleared' }))).toBe('idle');
  });

  it('ignores a clear of another run than the one shown', () => {
    const finished = { ...startRecording(), run: { ...recordingRun, finishedAt: '2026-09-26T09:00:00.000Z', status: 'finished' as const } };
    const other = { ...startRecording(), run: { ...recordingRun, runId: crypto.randomUUID() } };

    expect(runnerReducer(other, { runId: recordingRun.runId, type: 'finished-run-cleared' })).toBe(other);
    expect(runnerReducer({ ...finished, run: null }, { runId: recordingRun.runId, type: 'finished-run-cleared' }).run).toBeNull();
  });
});

// A Start the server definitively rejected has no run to discard, so it needs its own local way out. Only the
// answer of this page lifetime can offer it: a restored request carries no answer, and nothing else qualifies.
describe('a Start the server definitively rejected', () => {
  const rejection = { code: 'ORG_ACCESS_DENIED' } as const;
  const denied = (state = createInitialRunnerState('online')) => {
    const pending = runnerReducer(state, { request: startRequest, type: 'request-started' });
    return runnerReducer(pending, {
      message: 'The current identity cannot access this organization (ORG_ACCESS_DENIED).',
      rejection,
      request: startRequest,
      type: 'request-failed',
    });
  };

  it('keeps the request queued as the error and records that the answer was definitive', () => {
    const state = denied();
    expect(state.error?.message).toContain('ORG_ACCESS_DENIED');
    expect(state.error?.rejection).toEqual(rejection);
    expect(state.error?.request).toEqual(startRequest);
    expect(state.run).toBeNull();
    expect(state.pendingRequest).toBeNull();
    expect(runnerPhase(state)).toBe('error');
    expect(rejectedStartMayBeAbandoned(state)).toBe(true);
  });

  it('is not offered for a failure without a definitive answer, whatever the message says', () => {
    const pending = runnerReducer(createInitialRunnerState('online'), { request: startRequest, type: 'request-started' });
    const unknown = runnerReducer(pending, {
      message: 'The current identity cannot access this organization (ORG_ACCESS_DENIED).',
      request: startRequest,
      type: 'request-failed',
    });
    expect(unknown.error?.request).toEqual(startRequest);
    expect(unknown.error?.rejection).toBeUndefined();
    expect(rejectedStartMayBeAbandoned(unknown)).toBe(false);
  });

  it('is not offered for a request restored from storage: the answer must be asked for again', () => {
    const restored = runnerReducer(createInitialRunnerState('online'), {
      pendingPointCount: 0,
      request: startRequest,
      run: null,
      type: 'storage-restored',
    });
    expect(restored.error?.request).toEqual(startRequest);
    expect(rejectedStartMayBeAbandoned(restored)).toBe(false);
  });

  it('is withdrawn by the retry, so only the newest answer can offer it', () => {
    const retrying = runnerReducer(denied(), { request: startRequest, type: 'request-started' });
    expect(retrying.error).toBeNull();
    expect(rejectedStartMayBeAbandoned(retrying)).toBe(false);
    const unreachable = runnerReducer(retrying, { message: 'network', request: startRequest, type: 'request-failed' });
    expect(rejectedStartMayBeAbandoned(unreachable)).toBe(false);
  });

  it('is never accepted for a command, or for a code outside the narrow allowlist', () => {
    const active = startRecording();
    const command: CommandRequest = {
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedControlRevision: '0',
      kind: 'command',
      orgId: startRequest.orgId,
      runId: startRequest.runId,
      type: 'pause',
    };
    const failedCommand = runnerReducer(runnerReducer(active, { request: command, type: 'request-started' }), {
      message: 'denied',
      rejection,
      request: command,
      type: 'request-failed',
    });
    expect(failedCommand.error?.rejection).toBeUndefined();
    expect(rejectedStartMayBeAbandoned(failedCommand)).toBe(false);

    const pending = runnerReducer(createInitialRunnerState('online'), { request: startRequest, type: 'request-started' });
    const otherCode = runnerReducer(pending, {
      message: 'no',
      rejection: { code: 'RUN_DELETED' } as never,
      request: startRequest,
      type: 'request-failed',
    });
    expect(rejectedStartMayBeAbandoned(otherCode)).toBe(false);
  });

  it('is not offered while a request is in flight or when a run is shown', () => {
    const rejected = denied();
    expect(rejectedStartMayBeAbandoned({ ...rejected, pendingRequest: startRequest })).toBe(false);
    expect(rejectedStartMayBeAbandoned({ ...rejected, run: recordingRun })).toBe(false);
  });

  it('abandonment returns the page to idle without a run, an error or an upload, and keeps the connection', () => {
    const offline = runnerReducer(denied(), { connectivity: 'offline', type: 'connectivity-changed' });
    const idle = runnerReducer(offline, { request: startRequest, type: 'start-abandoned' });
    expect(idle).toEqual(createInitialRunnerState('offline'));
    expect(runnerPhase(idle)).toBe('idle');
  });

  it('abandonment of another request, or while one is in flight, changes nothing', () => {
    const rejected = denied();
    const other = { ...startRequest, runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    expect(runnerReducer(rejected, { request: other, type: 'start-abandoned' })).toBe(rejected);
    expect(runnerReducer(rejected, { request: { ...startRequest, startedAt: '2026-09-26T08:00:01.000Z' }, type: 'start-abandoned' })).toBe(rejected);
    const retrying = runnerReducer(rejected, { request: startRequest, type: 'request-started' });
    expect(runnerReducer(retrying, { request: startRequest, type: 'start-abandoned' })).toBe(retrying);
  });

  it('a late abandonment cannot clear an active run that replaced the request', () => {
    const active = startRecording();
    expect(runnerReducer(active, { request: startRequest, type: 'start-abandoned' })).toBe(active);
  });
});
