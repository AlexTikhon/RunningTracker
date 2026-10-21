import type { RunView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CaptureState } from './capture-controller.js';
import type { CaptureSourceKind } from './capture-source-kind.js';
import { RunnerView } from './RunnerView.js';
import {
  createInitialRunnerState,
  runnerReducer,
  type RunnerEvent,
  type RunnerState,
  type StartRequest,
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

function render(
  runner: RunnerState,
  writer: WriterOwnershipState = owned,
  rejectedStart: { canAbandon: boolean; failure: string | null; onAbandon: () => void } = {
    canAbandon: true,
    failure: null,
    onAbandon: () => undefined,
  },
  captureView: { capture: CaptureState; kind: CaptureSourceKind; nowMs: number } = {
    capture: { status: 'idle' },
    kind: 'simulator',
    nowMs: 0,
  },
): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <RunnerView
      canStart
      capture={captureView.capture}
      captureNowMs={captureView.nowMs}
      captureSourceKind={captureView.kind}
      controlsDisabled={false}
      onRetryCapture={noop}
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
      rejectedStart={rejectedStart}
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

// A Start the server definitively rejected has no run, so the refused-run notice cannot apply. The ordinary
// "Request not confirmed" notice carries its explicit local way out instead (ADR-0058).
describe('RunnerView for a Start the server rejected', () => {
  const start: StartRequest = {
    kind: 'start',
    orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    runId,
    startedAt: '2026-10-06T08:00:00.000Z',
  };
  const message = 'The current identity cannot access this organization (ORG_ACCESS_DENIED).';
  const rejected = apply(
    createInitialRunnerState('online'),
    { request: start, type: 'request-started' },
    { message, rejection: { code: 'ORG_ACCESS_DENIED' }, request: start, type: 'request-failed' },
  );
  const abandonButton = /<button[^>]*>Abandon this Start/u;
  const disabledAbandon = /<button[^>]*disabled=""[^>]*>Abandon this Start/u;

  it('offers the retry of the same request and the explicit abandonment, with what it does and does not do', () => {
    const markup = render(rejected);
    expect(markup).toContain('Request not confirmed');
    expect(markup).toContain('Retry same request');
    expect(markup).toMatch(abandonButton);
    expect(markup).not.toMatch(disabledAbandon);
    expect(markup).toContain('only removes the saved Start request from this browser');
    expect(markup).toContain('does not create, finish or delete anything on the server');
  });

  it('offers nothing destructive for a Start whose outcome is unknown', () => {
    const unknown = apply(
      createInitialRunnerState('online'),
      { request: start, type: 'request-started' },
      { message: 'Failed to fetch', request: start, type: 'request-failed' },
    );
    const markup = render(unknown);
    expect(markup).toContain('Retry same request');
    expect(markup).not.toContain('Abandon this Start');
  });

  it('offers nothing destructive for a request restored after a reload: the answer must be asked for again', () => {
    const restored = apply(createInitialRunnerState('online'), {
      pendingPointCount: 0,
      request: start,
      run: null,
      type: 'storage-restored',
    });
    const markup = render(restored);
    expect(markup).toContain('Retry same request');
    expect(markup).not.toContain('Abandon this Start');
  });

  it('is disabled for a tab that does not own the writer lease, and while the page cannot act', () => {
    expect(render(rejected, { expiresAt: '2026-10-07T08:00:00.000Z', status: 'conflict' })).toMatch(disabledAbandon);
    expect(render(rejected, { status: 'acquiring' })).toMatch(disabledAbandon);
    expect(render(rejected, owned, { canAbandon: false, failure: null, onAbandon: () => undefined })).toMatch(disabledAbandon);
  });

  it('says that a failed abandonment left the Start saved, and keeps both ways out', () => {
    const markup = render(rejected, owned, { canAbandon: true, failure: 'disk failure', onAbandon: () => undefined });
    expect(markup).toContain('The Start was not abandoned and is still saved: disk failure');
    expect(markup).toContain('Retry same request');
    expect(markup).toMatch(abandonButton);
  });

  it('after the abandonment the runner is idle and Start is available again', () => {
    const idle = apply(rejected, { request: start, type: 'start-abandoned' });
    const markup = render(idle, { status: 'unclaimed' });
    expect(markup).toContain('Start run');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Start run/u);
    expect(markup).not.toContain('Request not confirmed');
    expect(markup).not.toContain('Abandon this Start');
    expect(markup).toContain('No active run');
  });
});

// Capture health on the Runner screen (ADR-0061): a temporary location failure is a waiting state of the same
// watch, a permission denial is blocked with guidance, and only GPS failures offer the explicit Retry GPS.
describe('RunnerView capture health', () => {
  const recording = apply(createInitialRunnerState('online'), { pendingPointCount: 0, request: null, run, type: 'storage-restored' });
  const facts = { capturedCount: 4, lastPersistedAtMs: 20_000, lastRecordedAt: '2026-10-06T08:00:20.000Z' };
  const waiting: CaptureState = {
    ...facts,
    consecutiveFailures: 1,
    segmentId: 2,
    signal: 'waiting',
    source: 'Device GPS',
    startedAtMs: 1_000,
    status: 'capturing',
    warning: 'The location provider timed out while waiting for a fresh measurement.',
  };
  const denied: CaptureState = {
    ...facts,
    message: 'Location permission was denied.',
    reason: 'permission-denied',
    source: 'Device GPS',
    status: 'error',
  };
  const retryButton = /<button[^>]*>Retry GPS<\/button>/u;
  const disabledRetry = /<button[^>]*disabled=""[^>]*>Retry GPS<\/button>/u;
  const show = (capture: CaptureState, writer: WriterOwnershipState = owned, kind: CaptureSourceKind = 'geolocation') =>
    render(recording, writer, undefined, { capture, kind, nowMs: 30_000 });

  it('shows a temporary failure as waiting for location, with the stale last point, the same segment and a retry', () => {
    const markup = show(waiting);
    expect(markup).toContain('Waiting for location');
    expect(markup).toContain('Last point saved 10 s ago (stale).');
    expect(markup).toContain('segment 2 · 4 buffered');
    expect(markup).not.toContain('Capture stopped');
    expect(markup).toMatch(retryButton);
    expect(markup).not.toMatch(disabledRetry);
  });

  it('shows a permission denial as blocked, with guidance and an enabled Retry GPS', () => {
    const markup = show(denied);
    expect(markup).toContain('Location permission blocked');
    expect(markup).toContain('Allow location for this site in the browser settings, then choose Retry GPS.');
    expect(markup).toMatch(retryButton);
    expect(markup).not.toMatch(disabledRetry);
  });

  it('disables Retry GPS for a tab that does not own the writer lease', () => {
    expect(show(denied, { message: 'lost', status: 'lost' })).toMatch(disabledRetry);
  });

  it('offers no Retry GPS for a storage failure, a lost writer or the simulator', () => {
    const storage: CaptureState = { ...facts, message: 'QuotaExceededError', reason: 'storage', source: 'Device GPS', status: 'error' };
    expect(show(storage)).toContain('Capture stopped');
    expect(show(storage)).not.toContain('Retry GPS');
    expect(show({ ...facts, message: 'No lease.', source: 'Device GPS', status: 'lost' })).not.toContain('Retry GPS');
    expect(show(waiting, owned, 'simulator')).not.toContain('Retry GPS');
  });

  it('a live capture shows the age of the last saved point and no retry', () => {
    const markup = show({ ...waiting, consecutiveFailures: 0, lastPersistedAtMs: 26_000, signal: 'live', warning: null });
    expect(markup).toContain('Capturing');
    expect(markup).toContain('Last point saved 4 s ago.');
    expect(markup).not.toContain('Retry GPS');
  });
});
