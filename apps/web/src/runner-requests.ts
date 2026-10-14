import type { RunCommandResponse, RunView } from '@running-tracker/contracts';

import { createRun, readRun, RunnerApiError, sendRunCommand, type CsrfCredentials } from './runner-api.js';
import { unrecoverableRefusalOf } from './run-authority.js';
import { isDefinitiveStartRejectionCode, type RunnerRequest, type StartRejection } from './runner-state.js';
import type { IndexedDbRunnerStorage } from './runner-storage.js';

interface RunnerRequestOptions {
  // The network calls; replaceable so the boundary can be exercised with exact failures.
  api?: { createRun: typeof createRun; readRun: typeof readRun; sendRunCommand: typeof sendRunCommand };
  assertOwned: () => Promise<boolean>;
  csrf: CsrfCredentials;
  online: boolean;
  request: RunnerRequest;
  run: RunView | null;
  signal: AbortSignal;
  storage: IndexedDbRunnerStorage;
  userId: string;
}

type RunnerRequestResult =
  | { kind: 'start'; run: RunView }
  | { kind: 'command'; result: RunCommandResponse }
  | { kind: 'reconciled'; run: RunView };

// Whether the server definitively refused a Start: a readable 403 error envelope whose code says the membership is
// gone. Nothing else qualifies. A network failure, a timeout, an abort, an unreadable body (which the client reports
// as HTTP_ERROR whatever its status), a 5xx, 408/425/429, a 401 (the session layer's) and every other code are an
// unknown outcome that keeps the exact request for a retry (ADR-0058).
export function definitiveStartRejectionOf(error: unknown): StartRejection | null {
  return error instanceof RunnerApiError && error.status === 403 && isDefinitiveStartRejectionCode(error.code)
    ? { code: error.code }
    : null;
}

// One durable boundary for controls: preserve exact identities on an unknown
// outcome, and acknowledge only after both the server and ownership checks.
export async function executeRunnerRequest(options: RunnerRequestOptions): Promise<RunnerRequestResult> {
  const { request, run, storage, userId, csrf, signal, assertOwned } = options;
  const api = options.api ?? { createRun, readRun, sendRunCommand };
  await storage.queueRequest(userId, request, run);
  signal.throwIfAborted();
  if (!options.online) throw new Error('Saved locally. Retry the same request when the connection returns.');
  const requireOwnership = async () => {
    if (!await assertOwned()) throw new Error('Writer ownership changed; the exact request remains queued.');
    signal.throwIfAborted();
  };
  try {
    if (request.kind === 'start') {
      const started = await api.createRun(request, csrf, signal);
      await requireOwnership();
      await storage.acknowledgeStart(userId, request, started);
      return { kind: 'start', run: started };
    }
    if (run === null) throw new Error('The durable command has no confirmed run state');
    const result = await api.sendRunCommand(request, csrf, signal);
    await requireOwnership();
    await storage.acknowledgeCommand(userId, request, run, result);
    return { kind: 'command', result };
  } catch (error) {
    if (request.kind === 'command' && error instanceof RunnerApiError && error.code === 'CONTROL_REVISION_CONFLICT') {
      try {
        const authoritative = await api.readRun(request.orgId, request.runId, signal);
        await requireOwnership();
        await storage.acknowledgeReconciledRequest(userId, request, authoritative);
        return { kind: 'reconciled', run: authoritative };
      } catch (readError) {
        // The original command remains durable if reconciliation cannot settle. The one answer that is not about
        // the conflict is the server saying the run is gone for this identity: that is the refusal to surface.
        if (unrecoverableRefusalOf(readError) !== null) throw readError;
      }
    }
    throw error;
  }
}
