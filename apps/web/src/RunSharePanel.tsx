import { useEffect, useId, useRef, useState } from 'react';

import {
  accessLabel,
  personLabel,
  RunSharingController,
  rowActions,
  type RunSharingApi,
  type RunSharingSnapshot,
  type SharingUnavailable,
  type ShareRow,
} from './run-sharing.js';
import {
  grantRunShare,
  loadOrganizationCoaches,
  loadRunShares,
  revokeRunShare,
} from './runner-api.js';

const defaultApi: RunSharingApi = {
  grant: grantRunShare,
  loadCoaches: loadOrganizationCoaches,
  loadShares: loadRunShares,
  revoke: revokeRunShare,
};

// `runner`: the run in the Runner tab, which may still be recording. `archive`: a finished run chosen in My runs,
// inside a frame that names the run and closes the panel (ArchiveRunShare).
export type RunShareVariant = 'archive' | 'runner';

interface RunSharePanelProps {
  api?: RunSharingApi;
  csrfToken: string;
  // Told when the server refuses the run's sharing for good (deleted, not this person's, membership ended).
  onUnavailable?: (reason: SharingUnavailable) => void;
  orgId: string;
  runId: string;
  // The session's signal: when the session ends or is replaced, the panel stops listening to its answers.
  signal: AbortSignal;
  variant?: RunShareVariant;
}

const loadingSnapshot: RunSharingSnapshot = {
  message: null,
  pending: null,
  rows: [],
  status: 'loading',
  truncated: false,
  unavailable: null,
};

// Sharing for one run (ADR-0063, ADR-0064). It is separate from the runner's lifecycle state, request queue and
// writer lease: the server decides who owns the run, and nothing here is stored or replayed. The caller keys it by
// user, organization and run, so a new scope is a new panel.
export function RunSharePanel({
  api = defaultApi,
  csrfToken,
  onUnavailable,
  orgId,
  runId,
  signal,
  variant = 'runner',
}: RunSharePanelProps) {
  const [snapshot, setSnapshot] = useState<RunSharingSnapshot>(loadingSnapshot);
  const controller = useRef<RunSharingController | null>(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  useEffect(() => {
    const next = new RunSharingController({
      api,
      csrf: { headerName: 'x-csrf-token', token: csrfToken },
      onChange: (changed) => {
        setSnapshot(changed);
        if (changed.unavailable !== null) unavailable.current?.(changed.unavailable);
      },
      orgId,
      runId,
    });
    controller.current = next;
    const stop = () => next.dispose();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) {
      stop();
    } else {
      next.start();
    }
    return () => {
      signal.removeEventListener('abort', stop);
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [api, csrfToken, orgId, runId, signal]);

  return (
    <RunShareView
      onGrant={(userId) => controller.current?.grant(userId)}
      onRetry={() => controller.current?.retry()}
      onRevoke={(userId) => controller.current?.revoke(userId)}
      snapshot={snapshot}
      variant={variant}
    />
  );
}

interface RunShareViewProps {
  onGrant: (userId: string) => void;
  onRetry: () => void;
  onRevoke: (userId: string) => void;
  snapshot: RunSharingSnapshot;
  variant?: RunShareVariant;
}

export function RunShareView({ onGrant, onRetry, onRevoke, snapshot, variant = 'runner' }: RunShareViewProps) {
  const titleId = useId();
  const body = (
    <>
      {variant === 'runner' ? (
        <p className="run-share__note">
          Share gives the coach <strong>live and history access</strong>: your position and track while you record,
          and this run after you finish it, until you revoke it.
        </p>
      ) : (
        <p className="run-share__note">
          Share gives the coach <strong>live and history access</strong>. This run is finished, so the coach can
          see its recorded route, distance and duration until you revoke it.
        </p>
      )}

      {snapshot.status === 'loading' && <p role="status">Loading coaches and current sharing…</p>}

      {snapshot.status === 'error' && (
        <div className="run-share__failure">
          <p role="alert">{snapshot.message}</p>
          <button onClick={onRetry} type="button">Retry</button>
        </div>
      )}

      {snapshot.status === 'ready' && (
        <>
          {snapshot.message !== null && <p className="run-share__failure" role="alert">{snapshot.message}</p>}
          {snapshot.rows.length === 0 ? (
            <p className="run-share__empty">No other active coach in this organization.</p>
          ) : (
            <ul className="run-share__list">
              {snapshot.rows.map((row) => (
                <ShareRowItem
                  key={row.userId}
                  onGrant={onGrant}
                  onRevoke={onRevoke}
                  pending={snapshot.pending}
                  row={row}
                />
              ))}
            </ul>
          )}
          {snapshot.truncated && (
            <p className="run-share__empty">This run has more shares than can be shown; only the first 100 are listed.</p>
          )}
        </>
      )}
    </>
  );
  if (variant === 'archive') return <div className="run-share run-share--embedded">{body}</div>;
  return (
    <section className="run-share" aria-labelledby={titleId}>
      <h2 id={titleId}>Share this run with a coach</h2>
      {body}
    </section>
  );
}

function ShareRowItem({
  onGrant,
  onRevoke,
  pending,
  row,
}: {
  onGrant: (userId: string) => void;
  onRevoke: (userId: string) => void;
  pending: RunSharingSnapshot['pending'];
  row: ShareRow;
}) {
  const person = personLabel(row);
  const busy = pending !== null;
  const mine = pending?.userId === row.userId ? pending.change : null;
  return (
    <li className="run-share__row" aria-label={person}>
      <span className="run-share__person" title={row.userId}>{person}</span>
      <span className="run-share__access">{accessLabel(row.access)}</span>
      <span className="run-share__actions">
        {rowActions(row).map((change) =>
          change === 'grant' ? (
            <button
              aria-label={`${row.access === 'none' ? 'Share' : 'Share live and history'} with ${person}`}
              className="primary-action"
              disabled={busy}
              key={change}
              onClick={() => onGrant(row.userId)}
              type="button"
            >
              {mine === 'grant' ? 'Sharing…' : row.access === 'none' ? 'Share' : 'Share live and history'}
            </button>
          ) : (
            <button
              aria-label={`Revoke ${person}`}
              className="finish-action"
              disabled={busy}
              key={change}
              onClick={() => onRevoke(row.userId)}
              type="button"
            >
              {mine === 'revoke' ? 'Revoking…' : 'Revoke'}
            </button>
          ),
        )}
      </span>
    </li>
  );
}
