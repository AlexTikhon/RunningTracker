import type { RunView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunnerView } from './RunnerView.js';
import {
  createInitialRunnerState,
  runnerReducer,
  type RunnerEvent,
  type RunnerState,
} from './runner-state.js';
import type { WriterOwnershipState } from './writer-lease.js';

const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const run: RunView = {
  controlRevision: '3',
  dataRevision: '5',
  finishedAt: null,
  rawState: 'available',
  runId,
  startedAt: '2026-10-06T08:00:00.000Z',
  status: 'recording',
  summary: null,
};
const owned: WriterOwnershipState = { expiresAt: '2026-10-07T08:00:00.000Z', fencingToken: '1', status: 'owned' };

function apply(state: RunnerState, ...events: RunnerEvent[]): RunnerState {
  return events.reduce(runnerReducer, state);
}

function refusedWith(code: string): RunnerState {
  return apply(
    createInitialRunnerState('online'),
    { pendingPointCount: 3, request: null, run, type: 'storage-restored' },
    { attempt: 1, type: 'authority-requested' },
    { attempt: 1, code, kind: 'refused', message: 'The server said no.', type: 'authority-unconfirmed' },
  );
}

function render(runner: RunnerState, writer: WriterOwnershipState = owned): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <RunnerView
      canStart
      capture={{ status: 'idle' }}
      captureSourceKind="simulator"
      controlsDisabled={false}
      elapsed="00:00:00"
      onChooseCaptureSource={noop}
      onClearFinishedRun={noop}
      onCommand={noop}
      onConfirmRun={noop}
      onRetryOwnership={noop}
      onRetryRequest={noop}
      onStart={noop}
      organizationNote="note"
      refused={{ canDiscard: true, onDiscard: noop }}
      rejected={{ canDiscard: true, canExport: true, onDiscard: noop, onExport: noop }}
      runner={runner}
      sessionReady
      storage={{ status: 'ready' }}
      writer={writer}
    />,
  );
}

describe('RunnerView for a run the server refuses', () => {
  it.each(['RUN_DELETED', 'RUN_NOT_FOUND', 'ORG_ACCESS_DENIED'])('%s offers check again, export and the local discard to the writer', (code) => {
    const markup = render(refusedWith(code));
    expect(markup).toContain('Run not confirmed by the server');
    expect(markup).toContain('Check again');
    expect(markup).toContain('Export buffered points');
    expect(markup).toContain('Discard local recovery');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Discard local recovery/u);
  });

  it('a server that cannot be reached offers a retry and never the destructive discard', () => {
    const unreachable = apply(
      createInitialRunnerState('online'),
      { pendingPointCount: 3, request: null, run, type: 'storage-restored' },
      { attempt: 1, type: 'authority-requested' },
      { attempt: 1, kind: 'unreachable', message: 'The server could not be reached.', type: 'authority-unconfirmed' },
    );
    const markup = render(unreachable);
    expect(markup).toContain('Confirming this run with the server');
    expect(markup).toContain('Check again');
    expect(markup).not.toContain('Discard local recovery');
    expect(markup).not.toContain('Export buffered points');
  });

  it.each(['ROUTE_NOT_FOUND', 'INVALID_REQUEST', 'HTTP_ERROR'])('a refusal with code %s offers a retry but no discard', (code) => {
    const markup = render(refusedWith(code));
    expect(markup).toContain('Check again');
    expect(markup).not.toContain('Discard local recovery');
  });

  it.each<[string, WriterOwnershipState]>([
    ['another tab owns the lease', { expiresAt: '2026-10-07T08:00:00.000Z', status: 'conflict' }],
    ['the lease was lost', { message: 'lost', status: 'lost' }],
    ['the lease is being acquired', { status: 'acquiring' }],
  ])('the discard is disabled while %s, and the export is not', (_name, writer) => {
    const markup = render(refusedWith('RUN_DELETED'), writer);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Discard local recovery/u);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Export buffered points/u);
  });

  it('the discard is disabled while a request is in flight', () => {
    const busy = apply(refusedWith('RUN_DELETED'), {
      request: { commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expectedControlRevision: '3', kind: 'command', orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runId, type: 'finish' },
      type: 'request-started',
    });
    expect(render(busy)).toMatch(/<button[^>]*disabled=""[^>]*>Discard local recovery/u);
  });

  it('one notice says it: the blocked-upload notice, whose discard needs a finished run, is not shown beside it', () => {
    const blocked = apply(refusedWith('RUN_DELETED'), {
      type: 'upload-changed',
      upload: { message: 'The run has been deleted (RUN_DELETED).', pendingCount: 3, status: 'blocked' },
    });
    const markup = render(blocked);
    expect(markup).not.toContain('Buffered points were rejected');
    expect(markup).toContain('Discard local recovery');
    // A refusal that does not open the discard leaves the blocked-upload notice in place.
    const other = apply(refusedWith('INVALID_REQUEST'), {
      type: 'upload-changed',
      upload: { message: 'rejected', pendingCount: 3, status: 'blocked' },
    });
    expect(render(other)).toContain('Buffered points were rejected');
  });

  it('after the local discard the runner is idle and a new run can be started', () => {
    const idle = apply(refusedWith('RUN_DELETED'), { runId, type: 'local-recovery-discarded' });
    const markup = render(idle, { status: 'unclaimed' });
    expect(markup).toContain('Start run');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Start run/u);
    expect(markup).not.toContain('Run not confirmed by the server');
    expect(markup).not.toContain('Discard local recovery');
    expect(markup).toContain('No active run');
  });
});
