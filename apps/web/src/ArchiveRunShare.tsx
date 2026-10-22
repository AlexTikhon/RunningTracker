import type { RunSearchItem } from '@running-tracker/contracts';
import { useEffect, useId, useRef, useState } from 'react';

import type { RunSearchSnapshot } from './run-search-controller.js';
import type { SharingUnavailable } from './run-sharing.js';
import { RunSharePanel } from './RunSharePanel.js';

// The run whose sharing panel is open in My runs, and the search it was chosen from.
export interface ArchiveShareSelection {
  runId: string;
  searchKey: string;
}

/**
 * The run whose panel may be shown: only one that the search the person is looking at lists right now. A new
 * search, a first page read again, lost access or the run leaving the list all close it; another page added to the
 * same search keeps it. The list is the owner-only search, so another person's run can never be chosen here.
 */
export function openSharingItem(
  selection: ArchiveShareSelection | null,
  searchKey: string,
  snapshot: RunSearchSnapshot,
): RunSearchItem | null {
  if (selection === null || selection.searchKey !== searchKey || snapshot.status !== 'ready') return null;
  return snapshot.items.find((item) => item.runId === selection.runId) ?? null;
}

// What the person, the organization and the session are, for the one panel that may be open.
export interface ArchiveShareScope {
  csrfToken: string;
  orgId: string;
  // The session's signal, from when the session was issued: ending or replacing the session silences the panel.
  signal: AbortSignal;
  userId: string;
}

const unavailableText: Record<SharingUnavailable, string> = {
  deleted: 'This run has been deleted, so there is no sharing left to manage.',
  missing: 'This run is no longer available to you, so its sharing cannot be managed. Search again to refresh the list.',
  'no-access': 'You no longer have access to this organization, so this run’s sharing cannot be managed.',
};

export interface ArchiveRunShareProps {
  // The element id the card's Manage sharing button points at.
  id: string;
  onClose: () => void;
  runId: string;
  scope: ArchiveShareScope;
  // The run's start as the card shows it, so the panel names the same run.
  startedAtLabel: string;
}

// Sharing for a finished run chosen in My runs (ADR-0064). It reuses the Runner tab's panel and controller; it never
// touches the runner's active run. When the server refuses the run for good, the panel and its controller go and
// only the reason stays.
export function ArchiveRunShare({ id, onClose, runId, scope, startedAtLabel }: ArchiveRunShareProps) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [unavailable, setUnavailable] = useState<SharingUnavailable | null>(null);

  // Opening moves focus into the panel, so its name is read out; closing returns it to the card's button.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby={titleId}
      className="archive-share"
      id={id}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="archive-share__header">
        <h5 id={titleId} ref={heading} tabIndex={-1}>
          Sharing for your run of {startedAtLabel} <span className="run-id">#{runId.slice(0, 8)}</span>
        </h5>
        <button onClick={onClose} type="button">Close</button>
      </div>
      {unavailable === null ? (
        <RunSharePanel
          csrfToken={scope.csrfToken}
          key={`${scope.userId}|${scope.orgId}|${runId}`}
          onUnavailable={setUnavailable}
          orgId={scope.orgId}
          runId={runId}
          signal={scope.signal}
          variant="archive"
        />
      ) : (
        <p className="run-share__failure" role="alert">{unavailableText[unavailable]}</p>
      )}
    </section>
  );
}
