import type { RunView } from '@running-tracker/contracts';

import { readRun, RunnerApiError } from './runner-api.js';
import type { RunnerEvent } from './runner-state.js';
import type { IndexedDbRunnerStorage } from './runner-storage.js';

// How long an unreachable server is left alone before the same read is asked again.
export const AUTHORITY_RETRY_MS = 5_000;

export interface AuthorityScope {
  orgId: string;
  runId: string;
  userId: string;
}

export interface AuthorityReadOptions {
  attempt: number;
  read?: typeof readRun;
  scope: AuthorityScope;
  signal: AbortSignal;
  // null for a tab that is not the writer: it may show the answer but must not write it.
  storage: Pick<IndexedDbRunnerStorage, 'saveRunSnapshot'> | null;
}

type AuthorityEvent = Extract<RunnerEvent, { type: 'authority-confirmed' | 'authority-unconfirmed' }>;

// A 4xx that is about the request, not the run: the next attempt may succeed.
const transientStatuses: ReadonlySet<number> = new Set([408, 425, 429]);

function describe(error: unknown): string {
  if (error instanceof RunnerApiError) return `${error.message} (${error.code}).`;
  return error instanceof Error && error.message !== '' ? error.message : 'The server could not be reached.';
}

// Asks the server what it considers the run to be and stores the answer. The result is the reducer event to
// dispatch, or null when the read was cancelled and says nothing about the run.
//
// What the failures mean:
//  - no answer (network, timeout, 5xx, 408/425/429, unreadable body): unreachable. Not "finished", not "deleted",
//    not "signed out": nothing is concluded and nothing local is touched.
//  - the server answered that the run cannot be read (403, 404, 410, other 4xx): refused, with the server's error
//    code. Capture does not resume, and nothing local is deleted either; the buffered points stay exportable.
//    Which refusals also open the explicit local discard is decided from the code, in refusedRunMayBeDetached.
//  - 401: the session layer suspends everything on its own; there is nothing to report about the run.
// The local copy is only ever advanced here, through the same monotonic merge as every other writer.
export async function readAuthoritativeRun(options: AuthorityReadOptions): Promise<AuthorityEvent | null> {
  const { attempt, scope, signal, storage } = options;
  const read = options.read ?? readRun;
  let authoritative: RunView;
  try {
    authoritative = await read(scope.orgId, scope.runId, signal);
    if (signal.aborted) return null;
    await storage?.saveRunSnapshot(scope.userId, scope.orgId, authoritative);
    if (signal.aborted) return null;
  } catch (error) {
    if (signal.aborted) return null;
    if (error instanceof RunnerApiError) {
      if (error.status === 401) return null;
      const refused = error.status >= 400 && error.status < 500 && !transientStatuses.has(error.status);
      return refused
        ? { attempt, code: error.code, kind: 'refused', message: describe(error), type: 'authority-unconfirmed' }
        : { attempt, kind: 'unreachable', message: describe(error), type: 'authority-unconfirmed' };
    }
    return { attempt, kind: 'unreachable', message: describe(error), type: 'authority-unconfirmed' };
  }
  return { attempt, run: authoritative, type: 'authority-confirmed' };
}
