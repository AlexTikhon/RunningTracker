import type { RunnerEvent } from './runner-state.js';
import type { FinishedRunClearOutcome, IndexedDbRunnerStorage, RunnerRecovery, RunScope, WriterLease } from './runner-storage.js';

// What the page has when the clear completes, asked at that moment and never remembered.
export interface FinishedRunClearPage {
  // Whether the clear still belongs to the page: false once its session ended or was replaced, or the page let go
  // of the operation.
  current: () => boolean;
  // The writer capability the coordinator the clear began with holds now, or null (also once that coordinator is
  // no longer the page's).
  lease: () => WriterLease | null;
}

interface FinishedRunClearOptions {
  dispatch: (event: RunnerEvent) => void;
  // Called with the durable state the page is about to follow, before it is dispatched.
  onFollow: (recovery: RunnerRecovery) => void;
  page: FinishedRunClearPage;
  // Releases the lease of the coordinator the clear began with. Called only while that coordinator still holds the
  // exact capability the clear was made under.
  release: () => Promise<void>;
  // Proves the tab's writer lease again (the coordinator renews it) and returns the capability it holds now.
  revalidate: () => Promise<WriterLease | null>;
  // The finished run the page shows.
  scope: RunScope;
  storage: Pick<IndexedDbRunnerStorage, 'clearFinishedRun' | 'loadRecovery'>;
}

type NotCleared = Exclude<FinishedRunClearOutcome, { outcome: 'cleared' }>['reason'];

//  - cleared:  the run was cleared and the page told so; the lease it was cleared under was released
//  - followed: nothing was cleared for this page (stale epoch, another run active, or work still pending); the page
//              follows the durable state, which may be another epoch's run, and keeps its lease
//  - detached: the page has another session or no longer has the operation; nothing was dispatched or released
export type FinishedRunClearResult =
  | { kind: 'cleared' }
  | { kind: 'followed'; reason: NotCleared }
  | { kind: 'detached' };

// The same user, owner and fencing epoch. The expiry moves with every renewal and is not part of the capability.
function sameCapability(left: WriterLease | null, right: WriterLease): boolean {
  return left !== null
    && left.userId === right.userId
    && left.ownerId === right.ownerId
    && left.fencingToken === right.fencingToken;
}

// "New run" for the finished run the page shows. The storage transaction decides whether the pointer may be cleared
// (writer epoch, exact run, finished, nothing buffered or queued); this decides what the completion may still tell
// the page. Only the same session and operation, still holding the same epoch, is told the run was cleared and lets
// go of that lease. A replaced page gets nothing; anything else follows the durable state instead.
export async function performFinishedRunClear(options: FinishedRunClearOptions): Promise<FinishedRunClearResult> {
  const { page, scope } = options;
  let outcome: FinishedRunClearOutcome;
  let lease: WriterLease | null;
  try {
    lease = await options.revalidate();
    if (!page.current()) return { kind: 'detached' };
    outcome = lease === null
      ? { outcome: 'obsolete', reason: 'writer-lost' }
      : await options.storage.clearFinishedRun(scope, lease);
  } catch (error) {
    if (!page.current()) return { kind: 'detached' };
    throw error;
  }
  if (!page.current()) return { kind: 'detached' };

  if (outcome.outcome === 'cleared' && lease !== null && sameCapability(page.lease(), lease)) {
    options.dispatch({ runId: scope.runId, type: 'finished-run-cleared' });
    // Checked and started in the same turn: release() takes the coordinator's lease before it awaits anything.
    await options.release();
    return { kind: 'cleared' };
  }

  // Another epoch, run or piece of pending work: that durable state, not this page's screen, is what it shows. A
  // lease the transaction found lost is proven again first, so the writer state shows the loss before the page
  // follows another epoch's run.
  if (outcome.outcome === 'obsolete' && outcome.reason === 'writer-lost' && lease !== null) {
    await options.revalidate().catch(() => null);
    if (!page.current()) return { kind: 'detached' };
  }
  const recovery = await options.storage.loadRecovery(scope.userId).catch((error: unknown) => {
    if (!page.current()) return null;
    throw error;
  });
  if (recovery === null || !page.current()) return { kind: 'detached' };
  options.onFollow(recovery);
  options.dispatch({
    pendingPointCount: recovery.pendingPointCount,
    request: recovery.request,
    run: recovery.run,
    type: 'storage-restored',
    uploadRejection: recovery.uploadRejection,
  });
  return { kind: 'followed', reason: outcome.outcome === 'cleared' ? 'writer-lost' : outcome.reason };
}
