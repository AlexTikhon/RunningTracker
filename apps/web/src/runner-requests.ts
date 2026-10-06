import type { RunCommandResponse, RunView } from '@running-tracker/contracts';

import { createRun, readRun, RunnerApiError, sendRunCommand, type CsrfCredentials } from './runner-api.js';
import type { RunnerRequest } from './runner-state.js';
import type { IndexedDbRunnerStorage } from './runner-storage.js';

interface RunnerRequestOptions {
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

// One durable boundary for controls: preserve exact identities on an unknown
// outcome, and acknowledge only after both the server and ownership checks.
export async function executeRunnerRequest(options: RunnerRequestOptions): Promise<RunnerRequestResult> {
  const { request, run, storage, userId, csrf, signal, assertOwned } = options;
  await storage.queueRequest(userId, request, run);
  signal.throwIfAborted();
  if (!options.online) throw new Error('Saved locally. Retry the same request when the connection returns.');
  const requireOwnership = async () => {
    if (!await assertOwned()) throw new Error('Writer ownership changed; the exact request remains queued.');
    signal.throwIfAborted();
  };
  try {
    if (request.kind === 'start') {
      const started = await createRun(request, csrf, signal);
      await requireOwnership();
      await storage.acknowledgeStart(userId, request, started);
      return { kind: 'start', run: started };
    }
    if (run === null) throw new Error('The durable command has no confirmed run state');
    const result = await sendRunCommand(request, csrf, signal);
    await requireOwnership();
    await storage.acknowledgeCommand(userId, request, run, result);
    return { kind: 'command', result };
  } catch (error) {
    if (request.kind === 'command' && error instanceof RunnerApiError && error.code === 'CONTROL_REVISION_CONFLICT') {
      try {
        const authoritative = await readRun(request.orgId, request.runId, signal);
        await requireOwnership();
        await storage.acknowledgeReconciledRequest(userId, request, authoritative);
        return { kind: 'reconciled', run: authoritative };
      } catch {
        // The original command remains durable if reconciliation cannot settle.
      }
    }
    throw error;
  }
}
