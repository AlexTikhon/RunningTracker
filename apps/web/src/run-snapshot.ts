import type { RunCommandResponse, RunView } from '@running-tracker/contracts';

// Which snapshot owns the lifecycle. Two facts of the server's state machine decide it, not a precedence of status names:
//  - finished is absorbing. Only recording and paused can become finished and nothing leaves it, so a finished
//    snapshot supersedes every non-finished one. Auto-finish makes this necessary: it changes the status and the
//    data revision but is not a control command, so it keeps controlRevision and a late pause/resume answer at that
//    same revision would otherwise tie and win.
//  - otherwise every control command advances controlRevision by one, so the higher revision is the later state.
// Equal revisions describe the same state (or two finished snapshots), and the current snapshot stays: replaying a
// snapshot is idempotent.
function newerLifecycle(current: RunView, incoming: RunView): RunView {
  if (current.status === 'finished' && incoming.status !== 'finished') return current;
  if (incoming.status === 'finished' && current.status !== 'finished') return incoming;
  return BigInt(incoming.controlRevision) > BigInt(current.controlRevision) ? incoming : current;
}

// Upload ACKs carry no lifecycle state. The two revision axes must never compete
// for ownership of the whole snapshot.
export function mergeRunSnapshot(current: RunView | null | undefined, incoming: RunView): RunView {
  if (current == null) return incoming;
  if (current.runId !== incoming.runId) throw new Error('Cannot merge different runs');
  const lifecycle = newerLifecycle(current, incoming);
  const data = BigInt(incoming.dataRevision) >= BigInt(current.dataRevision) ? incoming : current;
  const summary = lifecycle.status === 'finished'
    ? [incoming.summary, current.summary].find((candidate) => candidate?.sourceRevision === data.dataRevision) ?? null
    : null;
  return {
    ...data,
    controlRevision: lifecycle.controlRevision,
    finishedAt: lifecycle.finishedAt ?? (lifecycle.status === 'finished' ? current.finishedAt ?? incoming.finishedAt : null),
    status: lifecycle.status,
    summary,
  };
}

export function mergeCommandResult(current: RunView, result: RunCommandResponse): RunView {
  return mergeRunSnapshot(current, { ...current, controlRevision: result.controlRevision, dataRevision: result.dataRevision, finishedAt: result.finishedAt, status: result.status, summary: null });
}

export function advanceDataRevision(run: RunView, dataRevision: string): RunView {
  return BigInt(dataRevision) > BigInt(run.dataRevision)
    ? { ...run, dataRevision, summary: null }
    : run;
}
