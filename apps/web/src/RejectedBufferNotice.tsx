interface RejectedBufferNoticeProps {
  canDiscard: boolean;
  canExport: boolean;
  message: string | null;
  onDiscard: () => void;
  onExport: () => void;
}

// The server permanently refused buffered points (ADR-0048). They are kept so they can be exported before the
// run is finished and the queue is discarded.
export function RejectedBufferNotice({ canDiscard, canExport, message, onDiscard, onExport }: RejectedBufferNoticeProps) {
  return (
    <section className="notice notice--error" role="alert">
      <strong>Buffered points were rejected</strong>
      <span>{message} Export the retained points before discarding them. Discard removes this browser's queue; finish the run before clearing it.</span>
      <button disabled={!canExport} onClick={onExport} type="button">Export buffered points</button>
      <button disabled={!canDiscard} onClick={onDiscard} type="button">Discard buffered points and clear run</button>
    </section>
  );
}
