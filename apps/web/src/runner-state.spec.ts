import type { RunCommandResponse, RunView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  availableCommands,
  createInitialRunnerState,
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

  it('ignores stale completions from superseded requests', () => {
    const state = startRecording();
    const stale = runnerReducer(state, {
      request: startRequest,
      run: { ...recordingRun, status: 'paused' },
      type: 'start-succeeded',
    });

    expect(stale).toBe(state);
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

    expect(runnerPhase(runnerReducer(finished, { type: 'finished-run-cleared' }))).toBe('idle');
  });
});
