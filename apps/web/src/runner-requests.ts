import type { RunCommandResponse, RunView } from '@running-tracker/contracts';

import { createRun, readRun, RunnerApiError, sendRunCommand, type CsrfCredentials } from './runner-api.js';
import { unrecoverableRefusalOf, type AuthorityRefusal } from './run-authority.js';
import {
  isDefinitiveStartRejectionCode,
  type RestoredRunnerState,
  type RunnerEvent,
  type RunnerRequest,
  type StartRejection,
} from './runner-state.js';
import type { IndexedDbRunnerStorage, RequestWriteOutcome, RunnerRecovery, WriterLease } from './runner-storage.js';

type RunnerRequestStorage = Pick<
  IndexedDbRunnerStorage,
  'acknowledgeCommand' | 'acknowledgeReconciledRequest' | 'acknowledgeStart' | 'queueRequest'
>;

interface RunnerRequestOptions {
  // The network calls; replaceable so the boundary can be exercised with exact failures.
  api?: { createRun: typeof createRun; readRun: typeof readRun; sendRunCommand: typeof sendRunCommand };
  csrf: CsrfCredentials;
  // The writer capability the request began with: user, owner and fencing epoch. Every durable write of the
  // request is fenced by it inside its own transaction.
  lease: WriterLease;
  online: boolean;
  request: RunnerRequest;
  // Proves the tab's writer lease again (the coordinator renews it) and returns the capability it holds now.
  revalidate: () => Promise<WriterLease | null>;
  run: RunView | null;
  // The lifetime of the session the request began in.
  signal: AbortSignal;
  storage: RunnerRequestStorage;
  userId: string;
}

// Why a request ended without reporting anything: the capability or session it began with is gone, or the durable
// write found the queue or the active run moved on (RequestWriteOutcome).
export type ObsoleteRequestReason = 'not-active' | 'session-ended' | 'superseded' | 'writer-lost';

export type RunnerRequestResult =
  | { kind: 'start'; run: RunView }
  | { kind: 'command'; result: RunCommandResponse }
  | { kind: 'reconciled'; run: RunView }
  | { kind: 'obsolete'; reason: ObsoleteRequestReason };

// Whether the server definitively refused a Start: a readable 403 error envelope whose code says the membership is
// gone. Nothing else qualifies. A network failure, a timeout, an abort, an unreadable body (which the client reports
// as HTTP_ERROR whatever its status), a 5xx, 408/425/429, a 401 (the session layer's) and every other code are an
// unknown outcome that keeps the exact request for a retry (ADR-0058).
export function definitiveStartRejectionOf(error: unknown): StartRejection | null {
  return error instanceof RunnerApiError && error.status === 403 && isDefinitiveStartRejectionCode(error.code)
    ? { code: error.code }
    : null;
}

// The same user, owner and fencing epoch. The expiry moves with every renewal and is not part of the capability.
function sameCapability(left: WriterLease | null, right: WriterLease): boolean {
  return left !== null
    && left.userId === right.userId
    && left.ownerId === right.ownerId
    && left.fencingToken === right.fencingToken;
}

function obsolete(reason: ObsoleteRequestReason): RunnerRequestResult {
  return { kind: 'obsolete', reason };
}

// One durable boundary for controls (ADR-0059). The exact request is queued under the request's capability before
// anything is sent, and an unknown outcome leaves it queued with its identity for an idempotent retry. Immediately
// before the mutation is sent, the same epoch and session are proven again; if they are gone, nothing is sent. That
// check and the server's execution are not atomic: a request already sent when another tab takes over relies on
// the server's revisions and idempotency, and its answer is acknowledged only if the acknowledgement transaction
// still finds the same epoch, the exact queued request and the run it applies to. Anything else is an obsolete
// outcome, with nothing written.
export async function executeRunnerRequest(options: RunnerRequestOptions): Promise<RunnerRequestResult> {
  const { lease, request, run, storage, userId, csrf, signal } = options;
  const api = options.api ?? { createRun, readRun, sendRunCommand };
  const written = (outcome: RequestWriteOutcome, result: RunnerRequestResult): RunnerRequestResult =>
    outcome.outcome === 'applied' ? result : obsolete(outcome.reason);

  const queued = await storage.queueRequest(userId, request, run, lease);
  if (queued.outcome === 'obsolete') return obsolete(queued.reason);
  if (signal.aborted) return obsolete('session-ended');
  if (!options.online) throw new Error('Saved locally. Retry the same request when the connection returns.');
  const held = await options.revalidate();
  if (signal.aborted) return obsolete('session-ended');
  if (!sameCapability(held, lease)) return obsolete('writer-lost');

  try {
    if (request.kind === 'start') {
      const started = await api.createRun(request, csrf, signal);
      if (signal.aborted) return obsolete('session-ended');
      return written(await storage.acknowledgeStart(userId, request, started, lease), { kind: 'start', run: started });
    }
    if (run === null) throw new Error('The durable command has no confirmed run state');
    const result = await api.sendRunCommand(request, csrf, signal);
    if (signal.aborted) return obsolete('session-ended');
    return written(await storage.acknowledgeCommand(userId, request, run, result, lease), { kind: 'command', result });
  } catch (error) {
    if (request.kind === 'command' && error instanceof RunnerApiError && error.code === 'CONTROL_REVISION_CONFLICT') {
      let authoritative: RunView;
      try {
        authoritative = await api.readRun(request.orgId, request.runId, signal);
      } catch (readError) {
        // The original command remains durable if reconciliation cannot settle. The one answer that is not about
        // the conflict is the server saying the run is gone for this identity: that is the refusal to surface.
        if (unrecoverableRefusalOf(readError) !== null) throw readError;
        throw error;
      }
      if (signal.aborted) return obsolete('session-ended');
      return written(
        await storage.acknowledgeReconciledRequest(userId, request, authoritative, lease),
        { kind: 'reconciled', run: authoritative },
      );
    }
    throw error;
  }
}

// What the page has when a request completes, asked at that moment and never remembered.
export interface RunnerRequestPage {
  // Whether the request still belongs to the page: false once its session ended or was replaced, or the page let go
  // of the request.
  current: () => boolean;
  // The writer capability the tab holds now, or null.
  lease: () => WriterLease | null;
}

interface PerformRunnerRequestOptions extends RunnerRequestOptions {
  describe: (error: unknown) => string;
  dispatch: (event: RunnerEvent) => void;
  // Called with the durable state the page is about to follow after an obsolete request, before it is dispatched.
  onFollow: (recovery: RunnerRecovery) => void;
  // A command refused for good, reported only to the page and writer epoch the command began in.
  onRefused: (refusal: AuthorityRefusal) => void;
  page: RunnerRequestPage;
  storage: RunnerRequestStorage & Pick<IndexedDbRunnerStorage, 'loadRecovery'>;
}

//  - reported: the outcome (success or failure) was dispatched to the page it began in
//  - obsolete: nothing was reported; the request in flight was released and the durable state followed
//  - detached: the page has another session, or no longer has the request; nothing was dispatched at all
export type RunnerRequestSettlement =
  | { kind: 'reported' }
  | { kind: 'obsolete'; reason: ObsoleteRequestReason }
  | { kind: 'detached' };

function restoredOf(recovery: RunnerRecovery): RestoredRunnerState {
  return {
    pendingPointCount: recovery.pendingPointCount,
    request: recovery.request,
    run: recovery.run,
    uploadRejection: recovery.uploadRejection,
  };
}

// Runs a lifecycle request and decides what its completion may tell the page. Whether the page is still the one the
// request began in is asked after everything durable has finished, so a change during the acknowledgement counts.
// A late success, failure or reconciliation is never delivered to another session, operation or writer epoch.
export async function performRunnerRequest(options: PerformRunnerRequestOptions): Promise<RunnerRequestSettlement> {
  const { dispatch, page, request } = options;
  const detached = () => !page.current() || options.signal.aborted;
  let result: RunnerRequestResult | null = null;
  let failure: { error: unknown } | null = null;
  try {
    result = await executeRunnerRequest(options);
  } catch (error) {
    failure = { error };
  }
  if (detached()) return { kind: 'detached' };

  const reason = result?.kind === 'obsolete'
    ? result.reason
    : sameCapability(page.lease(), options.lease) ? null : 'writer-lost';
  if (reason !== null) {
    // Another epoch may have changed the durable state meanwhile; that state, not this answer, is what the page shows.
    const recovery = await options.storage.loadRecovery(options.userId).catch(() => null);
    if (detached()) return { kind: 'detached' };
    if (recovery !== null) options.onFollow(recovery);
    dispatch({ recovery: recovery === null ? null : restoredOf(recovery), request, type: 'request-obsolete' });
    return { kind: 'obsolete', reason };
  }

  if (failure !== null) {
    // The request stays exactly as it was, queued under its own identity. Only a Start answered by the definitive
    // rejection may later be abandoned, and only a command refused for good opens the run's recovery; any other
    // failure keeps the exact request for the retry and offers nothing destructive.
    const rejection = request.kind === 'start' ? definitiveStartRejectionOf(failure.error) : null;
    dispatch({
      message: options.describe(failure.error),
      ...(rejection === null ? {} : { rejection }),
      request,
      type: 'request-failed',
    });
    const refusal = request.kind === 'command' ? unrecoverableRefusalOf(failure.error) : null;
    if (refusal !== null) options.onRefused(refusal);
    return { kind: 'reported' };
  }

  if (result?.kind === 'start' && request.kind === 'start') {
    dispatch({ request, run: result.run, type: 'start-succeeded' });
  } else if (result?.kind === 'command' && request.kind === 'command') {
    dispatch({ request, result: result.result, type: 'command-succeeded' });
  } else if (result?.kind === 'reconciled' && request.kind === 'command') {
    dispatch({ request, run: result.run, type: 'request-reconciled' });
  }
  return { kind: 'reported' };
}
