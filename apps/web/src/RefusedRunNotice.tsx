interface RefusedRunNoticeProps {
  canCheckAgain: boolean;
  // Whether this tab may clear the recovery now: it owns the writer lease and nothing is in flight.
  canDiscard: boolean;
  canExport: boolean;
  // The discard has been asked for once and waits for the second, explicit press.
  confirming: boolean;
  // Whether the server's answer means the run can never be resumed by this identity. Other refusals can be asked
  // about again but never offer the discard.
  detachable: boolean;
  message: string;
  pendingCount: number;
  onCancelDiscard: () => void;
  onCheckAgain: () => void;
  onConfirmDiscard: () => void;
  onExport: () => void;
  onRequestDiscard: () => void;
}

function unsentPoints(count: number): string {
  return count === 0 ? 'no unsent points' : count === 1 ? '1 unsent point' : `${count} unsent points`;
}

// The server answered that it will not give this run back (ADR-0052). Nothing is deleted by that answer: the
// points stay on this device, and the person decides, after exporting them if they want to, whether to clear the
// browser's recovery copy so a new run can start.
export function RefusedRunNotice({
  canCheckAgain,
  canDiscard,
  canExport,
  confirming,
  detachable,
  message,
  pendingCount,
  onCancelDiscard,
  onCheckAgain,
  onConfirmDiscard,
  onExport,
  onRequestDiscard,
}: RefusedRunNoticeProps) {
  return (
    <section className="notice notice--error" role="alert">
      <div>
        <strong>Run not confirmed by the server</strong>
        <span>
          {message} Recording stays stopped. This device still holds {unsentPoints(pendingCount)} of this run
          {detachable ? '; export them before discarding the local recovery if you need them.' : '.'}
        </span>
        {detachable && confirming && (
          <span role="group" aria-label="Confirm discarding local recovery">
            This only clears this browser's recovery copy of the run. It does not restore the run or delete anything
            on the server, and the run is not finished. Its {unsentPoints(pendingCount)} will no longer be
            recoverable from here. Export the points first if you need them.
          </span>
        )}
      </div>
      <div className="notice__actions">
        <button disabled={!canCheckAgain} onClick={onCheckAgain} type="button">Check again</button>
        <button disabled={!canExport} onClick={onExport} type="button">Export buffered points</button>
        {detachable && !confirming && (
          <button className="finish-action" disabled={!canDiscard} onClick={onRequestDiscard} type="button">
            Discard local recovery…
          </button>
        )}
        {detachable && confirming && (
          <>
            <button className="finish-action" disabled={!canDiscard} onClick={onConfirmDiscard} type="button">
              Discard local recovery and start over
            </button>
            <button onClick={onCancelDiscard} type="button">Keep local recovery</button>
          </>
        )}
      </div>
    </section>
  );
}
