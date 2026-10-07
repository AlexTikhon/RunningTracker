import type { RunCommandResponse, RunView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  captureMayRun,
  createInitialRunnerState,
  needsAuthoritativeRead,
  refusedRunMayBeDetached,
  runnerPhase,
  runnerReducer,
  type CommandRequest,
  type Connectivity,
  type RunnerEvent,
  type RunnerState,
} from './runner-state.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const startedAt = '2026-10-06T08:00:00.000Z';
const autoFinishedAt = '2026-10-07T08:00:00.000Z';

function run(status: RunView['status'], controlRevision: number, dataRevision: number): RunView {
  return {
    controlRevision: String(controlRevision),
    dataRevision: String(dataRevision),
    finishedAt: status === 'finished' ? autoFinishedAt : null,
    rawState: 'available',
    runId,
    startedAt,
    status,
    summary: null,
  };
}

const pauseCommand: CommandRequest = {
  commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  expectedControlRevision: '3',
  kind: 'command',
  orgId,
  runId,
  type: 'pause',
};

function apply(state: RunnerState, ...events: RunnerEvent[]): RunnerState {
  return events.reduce(runnerReducer, state);
}

// What a reload finds in IndexedDB.
function restored(connectivity: Connectivity, stored: RunView, pendingPointCount = 0): RunnerState {
  return apply(createInitialRunnerState(connectivity), {
    pendingPointCount,
    request: null,
    run: stored,
    type: 'storage-restored',
  });
}

// A page that confirmed a recording run with the server.
function confirmedRecording(): RunnerState {
  return apply(
    createInitialRunnerState('online'),
    { request: { kind: 'start', orgId, runId, startedAt }, type: 'request-started' },
    { request: { kind: 'start', orgId, runId, startedAt }, run: run('recording', 3, 5), type: 'start-succeeded' },
  );
}

const latePauseResult: RunCommandResponse = {
  commandId: pauseCommand.commandId,
  controlRevision: '4',
  dataRevision: '6',
  finishedAt: null,
  status: 'paused',
};

describe('late lifecycle responses', () => {
  it('REPRO: a delayed PAUSE response cannot overwrite an auto-finish learned in the meantime', () => {
    let state = apply(confirmedRecording(), { request: pauseCommand, type: 'request-started' });
    expect(runnerPhase(state)).toBe('pausing');

    // The server paused (rev 4), then auto-finished (still rev 4, data rev 7); the browser learns FINISHED first.
    state = apply(state, { run: run('finished', 4, 7), type: 'run-reconciled' });
    expect(state.run).toMatchObject({ controlRevision: '4', status: 'finished' });
    expect(captureMayRun(state)).toBe(false);

    // The old PAUSE response is released.
    state = apply(state, { request: pauseCommand, result: latePauseResult, type: 'command-succeeded' });

    expect(state.run).toMatchObject({ controlRevision: '4', dataRevision: '7', finishedAt: autoFinishedAt, status: 'finished' });
    expect(state.pendingRequest).toBeNull();
    expect(runnerPhase(state)).toBe('finished');
    expect(captureMayRun(state)).toBe(false);
  });

  it('the same race through a request reconciliation and a replayed stored response', () => {
    const state = apply(
      confirmedRecording(),
      { request: pauseCommand, type: 'request-started' },
      { run: run('finished', 4, 7), type: 'run-reconciled' },
      // The command ID is replayed by the server with the response it stored at commit time.
      { request: pauseCommand, run: run('paused', 4, 6), type: 'request-reconciled' },
    );
    expect(state.run?.status).toBe('finished');
    expect(state.pendingRequest).toBeNull();
  });

  it('ignores a command response whose request is no longer the pending one', () => {
    const state = confirmedRecording();
    expect(runnerReducer(state, { request: pauseCommand, result: latePauseResult, type: 'command-succeeded' })).toBe(state);
  });

  it('ignores a command response that arrives after the store was reinitialised for another session', () => {
    const pending = apply(confirmedRecording(), { request: pauseCommand, type: 'request-started' });
    const reinitialised = apply(pending, { type: 'session-ended' });
    const next = apply(
      reinitialised,
      { request: { kind: 'start', orgId, runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', startedAt }, type: 'request-started' },
    );
    const late = runnerReducer(next, { request: pauseCommand, result: latePauseResult, type: 'command-succeeded' });
    expect(late).toBe(next);
    expect(late.run).toBeNull();
  });

  it('treats repeated FINISHED snapshots as idempotent', () => {
    const once = apply(confirmedRecording(), { run: run('finished', 4, 7), type: 'run-reconciled' });
    const twice = apply(once, { run: run('finished', 4, 7), type: 'run-reconciled' }, { run: run('finished', 4, 7), type: 'run-reconciled' });
    expect(twice.run).toEqual(once.run);
    expect(twice.authority).toEqual({ status: 'confirmed' });
  });

  it('keeps the normal pause then resume flow working', () => {
    const resume: CommandRequest = { ...pauseCommand, commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', expectedControlRevision: '4', type: 'resume' };
    const state = apply(
      confirmedRecording(),
      { request: pauseCommand, type: 'request-started' },
      { request: pauseCommand, result: latePauseResult, type: 'command-succeeded' },
    );
    expect(state.run?.status).toBe('paused');
    expect(captureMayRun(state)).toBe(false);
    const resumed = apply(
      state,
      { request: resume, type: 'request-started' },
      { request: resume, result: { ...latePauseResult, commandId: resume.commandId, controlRevision: '5', dataRevision: '7', status: 'recording' }, type: 'command-succeeded' },
    );
    expect(resumed.run).toMatchObject({ controlRevision: '5', status: 'recording' });
    expect(captureMayRun(resumed)).toBe(true);
  });
});

describe('recovery authority', () => {
  it('does not allow capture for a run restored from IndexedDB while online until the server has answered', () => {
    const state = restored('online', run('recording', 3, 5));
    expect(state.authority).toEqual({ status: 'restored' });
    expect(captureMayRun(state)).toBe(false);
    expect(needsAuthoritativeRead(state)).toBe(true);

    const confirming = apply(state, { attempt: 1, type: 'authority-requested' });
    expect(confirming.authority).toMatchObject({ attempt: 1, offlineCapture: false, status: 'confirming' });
    expect(captureMayRun(confirming)).toBe(false);
    expect(needsAuthoritativeRead(confirming)).toBe(false);
  });

  it('starts capture only after the server confirms a still-recording run', () => {
    const confirmed = apply(
      restored('online', run('recording', 3, 5)),
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('recording', 3, 8), type: 'authority-confirmed' },
    );
    expect(confirmed.authority).toEqual({ status: 'confirmed' });
    expect(confirmed.run).toMatchObject({ dataRevision: '8', status: 'recording' });
    expect(captureMayRun(confirmed)).toBe(true);
  });

  it('never allows capture when the server reports the restored run as finished (refresh after auto-finish)', () => {
    const states: RunnerState[] = [];
    let state = restored('online', run('recording', 3, 5));
    states.push(state);
    state = apply(state, { attempt: 1, type: 'authority-requested' });
    states.push(state);
    state = apply(state, { attempt: 1, run: run('finished', 3, 6), type: 'authority-confirmed' });
    states.push(state);
    expect(states.map(captureMayRun)).toEqual([false, false, false]);
    expect(state.run).toMatchObject({ controlRevision: '3', status: 'finished' });
    expect(needsAuthoritativeRead(state)).toBe(false);
    expect(runnerPhase(state)).toBe('finished');
  });

  it('adopts a paused server state for a locally recording run and a finished one for a locally paused run', () => {
    const paused = apply(
      restored('online', run('recording', 3, 5)),
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('paused', 4, 6), type: 'authority-confirmed' },
    );
    expect(paused.run?.status).toBe('paused');
    expect(captureMayRun(paused)).toBe(false);

    const finished = apply(
      restored('online', run('paused', 4, 6)),
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('finished', 4, 7), type: 'authority-confirmed' },
    );
    expect(finished.run?.status).toBe('finished');
  });

  it('preserves a locally paused run that the server also reports as paused', () => {
    const state = apply(
      restored('online', run('paused', 4, 6)),
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('paused', 4, 6), type: 'authority-confirmed' },
    );
    expect(state.run?.status).toBe('paused');
    expect(state.authority).toEqual({ status: 'confirmed' });
  });

  it('drops the answer to a superseded read, a read for another run and an answer nobody asked for', () => {
    const confirming = apply(restored('online', run('recording', 3, 5)), { attempt: 1, type: 'authority-requested' });
    expect(runnerReducer(confirming, { attempt: 2, run: run('finished', 3, 6), type: 'authority-confirmed' })).toBe(confirming);
    expect(runnerReducer(confirming, { attempt: 1, run: { ...run('finished', 3, 6), runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, type: 'authority-confirmed' })).toBe(confirming);
    const unasked = restored('online', run('recording', 3, 5));
    expect(runnerReducer(unasked, { attempt: 1, run: run('finished', 3, 6), type: 'authority-confirmed' })).toBe(unasked);
    // A restore from storage supersedes the read in flight: its late answer is for a state that is gone.
    const reRestored = apply(confirming, { pendingPointCount: 0, request: null, run: run('recording', 3, 5), type: 'storage-restored' });
    expect(reRestored.authority).toEqual({ status: 'restored' });
    expect(runnerReducer(reRestored, { attempt: 1, run: run('finished', 3, 6), type: 'authority-confirmed' })).toBe(reRestored);
  });

  it('an answer older than what is already known cannot move the lifecycle backwards', () => {
    const state = apply(
      restored('online', run('paused', 4, 6)),
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('recording', 3, 5), type: 'authority-confirmed' },
    );
    expect(state.run?.status).toBe('paused');
  });

  it('accepts only the next attempt so two effects in one render start one read', () => {
    const state = restored('online', run('recording', 3, 5));
    const first = apply(state, { attempt: 1, type: 'authority-requested' });
    expect(runnerReducer(first, { attempt: 1, type: 'authority-requested' })).toBe(first);
    expect(runnerReducer(state, { attempt: 2, type: 'authority-requested' })).toBe(state);
  });

  it('does not ask about a finished run', () => {
    const state = restored('online', run('finished', 4, 7));
    expect(needsAuthoritativeRead(state)).toBe(false);
    expect(runnerReducer(state, { attempt: 1, type: 'authority-requested' })).toBe(state);
  });
});

describe('recovery without an answer', () => {
  const unreadable = (state: RunnerState, kind: 'refused' | 'unreachable', code = 'RUN_DELETED') =>
    apply(
      state,
      kind === 'refused'
        ? { attempt: 1, code, kind, message: 'because', type: 'authority-unconfirmed' }
        : { attempt: 1, kind, message: 'because', type: 'authority-unconfirmed' },
    );

  it.each(['unreachable', 'refused'] as const)('%s keeps capture stopped and keeps the stored run', (kind) => {
    const state = unreadable(apply(restored('online', run('recording', 3, 5), 7), { attempt: 1, type: 'authority-requested' }), kind);
    expect(state.authority).toEqual(
      kind === 'refused' ? { code: 'RUN_DELETED', message: 'because', status: kind } : { message: 'because', status: kind },
    );
    expect(captureMayRun(state)).toBe(false);
    expect(state.run).toMatchObject({ status: 'recording' });
    expect(state.upload.pendingCount).toBe(7);
    expect(state.error).toBeNull();
  });

  it('an unreachable server is not a conclusion about the run, so it can be asked again', () => {
    const state = unreadable(apply(restored('online', run('recording', 3, 5)), { attempt: 1, type: 'authority-requested' }), 'unreachable');
    const retried = apply(state, { attempt: 2, type: 'authority-requested' }, { attempt: 2, run: run('recording', 3, 6), type: 'authority-confirmed' });
    expect(captureMayRun(retried)).toBe(true);
  });

  it('a failed read while the browser is offline is the offline case', () => {
    const confirming = apply(restored('online', run('recording', 3, 5)), { attempt: 1, type: 'authority-requested' }, { connectivity: 'offline', type: 'connectivity-changed' });
    expect(confirming.authority.status).toBe('confirming');
    const settled = unreadable(confirming, 'unreachable');
    expect(settled.authority).toEqual({ status: 'offline' });
  });

  it('drops a failure report for a superseded read', () => {
    const confirming = apply(restored('online', run('recording', 3, 5)), { attempt: 1, type: 'authority-requested' });
    expect(runnerReducer(confirming, { attempt: 5, code: 'RUN_DELETED', kind: 'refused', message: 'x', type: 'authority-unconfirmed' })).toBe(confirming);
  });
});

describe('offline recovery and reconnection', () => {
  it('keeps the existing offline behaviour: a run restored while offline records, to be confirmed later', () => {
    const state = restored('offline', run('recording', 3, 5));
    expect(state.authority).toEqual({ status: 'offline' });
    expect(captureMayRun(state)).toBe(true);
    expect(needsAuthoritativeRead(state)).toBe(false);
  });

  it('asks the server before anything else once the browser is back online, without interrupting the capture', () => {
    const reconnected = apply(restored('offline', run('recording', 3, 5)), { connectivity: 'online', type: 'connectivity-changed' });
    expect(needsAuthoritativeRead(reconnected)).toBe(true);
    const confirming = apply(reconnected, { attempt: 1, type: 'authority-requested' });
    expect(captureMayRun(confirming)).toBe(true);
    expect(confirming.authority).toMatchObject({ offlineCapture: true, status: 'confirming' });
  });

  it('local ACTIVE + reconnect + server FINISHED stops capture and ends FINISHED', () => {
    const offline = apply(confirmedRecording(), { connectivity: 'offline', type: 'connectivity-changed' });
    expect(offline.authority).toEqual({ status: 'offline' });
    expect(captureMayRun(offline)).toBe(true);
    const online = apply(offline, { connectivity: 'online', type: 'connectivity-changed' });
    expect(needsAuthoritativeRead(online)).toBe(true);
    const finished = apply(
      online,
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('finished', 3, 9), type: 'authority-confirmed' },
    );
    expect(finished.run).toMatchObject({ status: 'finished' });
    expect(captureMayRun(finished)).toBe(false);
    expect(finished.authority).toEqual({ status: 'confirmed' });
  });

  it('local ACTIVE + reconnect + server ACTIVE continues, and local PAUSED + server PAUSED stays paused', () => {
    const recording = apply(
      confirmedRecording(),
      { connectivity: 'offline', type: 'connectivity-changed' },
      { connectivity: 'online', type: 'connectivity-changed' },
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('recording', 3, 12), type: 'authority-confirmed' },
    );
    expect(captureMayRun(recording)).toBe(true);
    expect(recording.run?.dataRevision).toBe('12');

    const paused = apply(
      restored('offline', run('paused', 4, 6)),
      { connectivity: 'online', type: 'connectivity-changed' },
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, run: run('paused', 4, 6), type: 'authority-confirmed' },
    );
    expect(paused.run?.status).toBe('paused');
    expect(captureMayRun(paused)).toBe(false);
  });

  it('a stale FINISHED never gives way to an ACTIVE report, since finished is terminal', () => {
    const state = apply(
      restored('online', run('finished', 4, 7)),
      { run: run('recording', 9, 99), type: 'run-reconciled' },
    );
    expect(state.run?.status).toBe('finished');
    expect(captureMayRun(state)).toBe(false);
  });

  it('going offline does not downgrade a refused run into one that may record', () => {
    const refused = apply(
      restored('online', run('recording', 3, 5)),
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, code: 'RUN_DELETED', kind: 'refused', message: 'gone', type: 'authority-unconfirmed' },
      { connectivity: 'offline', type: 'connectivity-changed' },
    );
    expect(refused.authority.status).toBe('refused');
    expect(captureMayRun(refused)).toBe(false);
  });

  it('a server answer through a lifecycle command or reconciliation confirms the run', () => {
    const offline = restored('offline', run('recording', 3, 5));
    expect(apply(offline, { run: run('recording', 3, 6), type: 'run-reconciled' }).authority).toEqual({ status: 'confirmed' });
  });

  it('no run, no authority to wait for', () => {
    const idle = createInitialRunnerState('online');
    expect(captureMayRun(idle)).toBe(false);
    expect(needsAuthoritativeRead(idle)).toBe(false);
    expect(apply(idle, { connectivity: 'offline', type: 'connectivity-changed' }).authority).toEqual({ status: 'confirmed' });
  });
});

describe('a run the server refuses', () => {
  const refusedWith = (code: string, pendingPointCount = 3) =>
    apply(
      restored('online', run('recording', 3, 5), pendingPointCount),
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, code, kind: 'refused', message: 'The server said no', type: 'authority-unconfirmed' },
    );

  it.each(['RUN_DELETED', 'RUN_NOT_FOUND', 'ORG_ACCESS_DENIED'])('%s means this identity cannot resume the run: the local detach is offered', (code) => {
    const state = refusedWith(code);
    expect(state.authority).toMatchObject({ code, status: 'refused' });
    expect(refusedRunMayBeDetached(state)).toBe(true);
    expect(captureMayRun(state)).toBe(false);
  });

  it.each(['ROUTE_NOT_FOUND', 'INVALID_REQUEST', 'ORIGIN_DENIED', 'HTTP_ERROR', 'CONTROL_REVISION_CONFLICT'])(
    '%s says nothing about the run: no local detach',
    (code) => {
      expect(refusedRunMayBeDetached(refusedWith(code))).toBe(false);
    },
  );

  it('an unreachable server, a restored, confirming, offline or confirmed run never offers the detach', () => {
    const restoredState = restored('online', run('recording', 3, 5));
    const confirming = apply(restoredState, { attempt: 1, type: 'authority-requested' });
    const unreachable = apply(confirming, { attempt: 1, kind: 'unreachable', message: 'down', type: 'authority-unconfirmed' });
    const offline = restored('offline', run('recording', 3, 5));
    for (const state of [restoredState, confirming, unreachable, offline, confirmedRecording(), createInitialRunnerState('online')]) {
      expect(refusedRunMayBeDetached(state)).toBe(false);
    }
  });

  it('is a local event, not a lifecycle one: the run, its buffer and its blocked upload are gone, the idle flow is back', () => {
    const state = apply(refusedWith('RUN_DELETED', 4), { runId, type: 'local-recovery-discarded' });
    expect(state).toMatchObject({
      authority: { status: 'confirmed' },
      error: null,
      pendingRequest: null,
      run: null,
      upload: { message: null, pendingCount: 0, status: 'idle' },
    });
    expect(runnerPhase(state)).toBe('idle');
    // The next Start is a plain start from idle.
    const start = { kind: 'start', orgId, runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', startedAt } as const;
    expect(apply(state, { request: start, type: 'request-started' }).pendingRequest).toEqual(start);
  });

  it('also clears a recovered request that belonged to the discarded run', () => {
    const recovered = apply(createInitialRunnerState('online'), {
      pendingPointCount: 2,
      request: pauseCommand,
      run: run('recording', 3, 5),
      type: 'storage-restored',
    });
    expect(recovered.error?.request).toEqual(pauseCommand);
    const state = apply(recovered, { runId, type: 'local-recovery-discarded' });
    expect(state.error).toBeNull();
    expect(state.run).toBeNull();
  });

  it('is ignored when the discarded run is not the one on screen', () => {
    const state = refusedWith('RUN_DELETED');
    const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(runnerReducer(state, { runId: other, type: 'local-recovery-discarded' })).toBe(state);
    expect(runnerReducer(createInitialRunnerState('online'), { runId, type: 'local-recovery-discarded' }).run).toBeNull();
  });

  it('never turns the run into a finished one on the way', () => {
    const state = apply(refusedWith('RUN_DELETED'), { runId, type: 'local-recovery-discarded' });
    expect(state.run).toBeNull();
    expect(runnerPhase(state)).not.toBe('finished');
  });
});
