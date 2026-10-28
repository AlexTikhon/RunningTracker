import { useEffect, useId, useRef } from 'react';

import type { RunDeletionSnapshot } from './run-deletion.js';

export interface ArchiveRunDeleteProps {
  // The element id the card's Delete run button points at.
  id: string;
  onCancel: () => void;
  onConfirm: () => void;
  snapshot: RunDeletionSnapshot;
  // The run's start as the card shows it, so the question names the same run.
  startedAtLabel: string;
}

// The inline confirmation for deleting a finished run from My runs. Opening it sends nothing; only Confirm delete does.
// While the request is on its way nothing here can be pressed, and Escape does nothing, because the request cannot be
// called back. It follows ArchiveRunShare: focus moves to its heading when it opens, and Cancel or Escape return it to
// the card's button.
export function ArchiveRunDelete({ id, onCancel, onConfirm, snapshot, startedAtLabel }: ArchiveRunDeleteProps) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const { phase } = snapshot;
  // `deleted` is only ever seen for the moment before the confirmation closes; nothing may be pressed in it either.
  const pending = phase === 'pending' || phase === 'deleted';

  useEffect(() => {
    heading.current?.focus();
  }, []);

  // The pressed button was disabled while the request was on its way. After a failure focus returns to it, now
  // offering the same deletion again; when there is nothing left to do, to Close.
  useEffect(() => {
    if (phase === 'failed') confirm.current?.focus();
    if (phase === 'unavailable') close.current?.focus();
  }, [phase]);

  return (
    <section
      aria-labelledby={titleId}
      className="run-delete"
      id={id}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h5 id={titleId} ref={heading} tabIndex={-1}>
        Delete your run of {startedAtLabel}?
      </h5>
      <p className="run-delete__warning">
        This permanently deletes the run, its route, distance and duration, and any sharing of it. It cannot be undone.
      </p>
      {pending && <p role="status">Deleting…</p>}
      {snapshot.message !== null && (
        <p className="run-delete__failure" role="alert">{snapshot.message}</p>
      )}
      <div className="run-delete__actions">
        {phase === 'unavailable' ? (
          <button onClick={onCancel} ref={close} type="button">Close</button>
        ) : (
          <>
            <button disabled={pending} onClick={onCancel} type="button">Cancel</button>
            <button
              className="finish-action"
              disabled={pending}
              onClick={onConfirm}
              ref={confirm}
              type="button"
            >
              {pending ? 'Deleting…' : phase === 'failed' ? 'Retry delete' : 'Confirm delete'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
