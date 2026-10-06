import type { RunCommandResponse, RunView } from '@running-tracker/contracts';

// Upload ACKs carry no lifecycle state. The two revision axes must never compete
// for ownership of the whole snapshot.
export function mergeRunSnapshot(current: RunView | null | undefined, incoming: RunView): RunView {
  if (current == null) return incoming;
  if (current.runId !== incoming.runId) throw new Error('Cannot merge different runs');
  const lifecycle = BigInt(incoming.controlRevision) >= BigInt(current.controlRevision) ? incoming : current;
  const data = BigInt(incoming.dataRevision) >= BigInt(current.dataRevision) ? incoming : current;
  const summary = lifecycle.status === 'finished'
    ? [incoming.summary, current.summary].find((candidate) => candidate?.sourceRevision === data.dataRevision) ?? null
    : null;
  return {
    ...data,
    controlRevision: lifecycle.controlRevision,
    finishedAt: lifecycle.finishedAt,
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
