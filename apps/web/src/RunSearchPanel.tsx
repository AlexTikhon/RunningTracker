import { useEffect, useMemo, useRef, useState } from 'react';

import { openSharingItem, type ArchiveShareSelection } from './ArchiveRunShare.js';
import { RunSearchFilters } from './RunSearchFilters.js';
import { RunSearchInterpreter } from './RunSearchInterpreter.js';
import { AppliedFilters, RunSearchResults } from './RunSearchResults.js';
import {
  confirmingDeletion,
  RunDeletionController,
  type RunDeletionSnapshot,
} from './run-deletion.js';
import {
  RunSearchController,
  type RunSearchSnapshot,
} from './run-search-controller.js';
import {
  RunSearchInterpretationController,
  type InterpretationSnapshot,
} from './run-search-interpretation-controller.js';
import { proposalToDraft } from './run-search-interpretation.js';
import {
  defaultDraft,
  defaultTimeZone,
  validateDraft,
  type RunSearchDraft,
  type RunSearchFilters as RunSearchFilterValues,
} from './run-search.js';
import { deleteRun, interpretRunSearch, searchRuns, type CsrfCredentials } from './runner-api.js';

const loadingSnapshot: RunSearchSnapshot = {
  hasMore: false,
  items: [],
  loadingMore: false,
  message: null,
  moreMessage: null,
  outdated: false,
  pendingSummaryCount: 0,
  resolved: null,
  status: 'loading',
};

interface AppliedSearch {
  filters: RunSearchFilterValues;
  // Applying always starts a new search, even with unchanged filters, so it also refreshes.
  id: number;
}

export interface RunSearchPanelProps {
  csrf: CsrfCredentials;
  // Told once after the server confirmed that one of the person's runs was deleted, so the archive map can read its
  // metadata again at once rather than at its next poll.
  onRunDeleted?: () => void;
  orgId: string;
  // The session's signal, from when the session was issued: ending or replacing the session silences sharing and
  // deletion.
  signal: AbortSignal;
  userId: string;
}

// The one run whose deletion confirmation is open. `id` tells one opening from the next, so reopening the same run
// starts a new confirmation instead of showing the previous one's outcome. `searchKey` is the search it was opened
// from, as for sharing.
interface DeletionSelection {
  id: number;
  runId: string;
  searchKey: string;
  startedAtLabel: string;
}

// What the panel says about a deletion outside its card: the confirmed result, or an outcome whose card is no longer
// on the screen.
interface DeletionNotice {
  kind: 'alert' | 'status';
  text: string;
}

const idleInterpretation: InterpretationSnapshot = { status: 'idle' };

// Search over the signed-in person's own finished runs. The parent gives it `key={user/organization}`, so a
// different person or organization starts from a clean draft with no results, cursors or requests carried over.
// The editable draft and the applied filters are separate state: results always belong to the applied filters.
// Describing the search in words only ever replaces the draft; applying it stays the person's explicit step.
export function RunSearchPanel({ csrf, onRunDeleted, orgId, signal, userId }: RunSearchPanelProps) {
  const timeZone = useMemo(() => defaultTimeZone(), []);
  const [draft, setDraft] = useState<RunSearchDraft>(defaultDraft);
  const [text, setText] = useState('');
  const [interpretation, setInterpretation] = useState<InterpretationSnapshot>(idleInterpretation);
  const interpreter = useRef<RunSearchInterpretationController | null>(null);
  // The latest token is read when a request is made, so a refreshed session needs no new controller.
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const [applied, setApplied] = useState<AppliedSearch>(() => {
    const first = validateDraft(defaultDraft(), timeZone);
    if (!first.ok) {
      throw new Error('The default filters must be valid');
    }
    return { filters: first.filters, id: 0 };
  });
  const scopeKey = `${userId}/${orgId}/${applied.id}`;
  const [searchState, setSearchState] = useState<{ scopeKey: string; snapshot: RunSearchSnapshot }>({
    scopeKey,
    snapshot: loadingSnapshot,
  });
  const controller = useRef<RunSearchController | null>(null);
  const snapshot = searchState.scopeKey === scopeKey ? searchState.snapshot : loadingSnapshot;
  // The one run whose sharing panel is open. It is dropped as soon as the shown search no longer lists it, so a
  // later answer listing the same run again does not reopen it by itself.
  const [sharing, setSharing] = useState<ArchiveShareSelection | null>(null);
  const sharedItem = openSharingItem(sharing, scopeKey, snapshot);
  if (sharing !== null && sharedItem === null) {
    setSharing(null);
  }

  // Deletion (owner only, permanent). The controller belongs to the person, organization, session and run, not to the
  // search: a DELETE already on its way is not abandoned because the list changed, and its outcome is still reported.
  const heading = useRef<HTMLHeadingElement>(null);
  const resultsArea = useRef<HTMLDivElement>(null);
  const [deletion, setDeletion] = useState<DeletionSelection | null>(null);
  const [deletionState, setDeletionState] = useState<{ id: number; snapshot: RunDeletionSnapshot } | null>(null);
  const [deletionNotice, setDeletionNotice] = useState<DeletionNotice | null>(null);
  const deleter = useRef<RunDeletionController | null>(null);
  const nextDeletionId = useRef(1);
  const deletionSnapshot = deletion !== null && deletionState?.id === deletion.id
    ? deletionState.snapshot
    : confirmingDeletion;
  const deletionPending = deletion !== null && deletionSnapshot.phase === 'pending';
  // Its confirmation is shown only in the card of the search it was opened from, while that search lists the run.
  const deletionShown = deletion !== null
    && deletion.searchKey === scopeKey
    && snapshot.status === 'ready'
    && snapshot.items.some((item) => item.runId === deletion.runId);
  // Set while a DELETE is on its way and its card is not on the screen, so its outcome is said at the panel instead.
  const outcomeUnseen = useRef(false);
  if (deletionPending && !deletionShown) {
    outcomeUnseen.current = true;
  }
  if (deletion !== null && !deletionShown && !deletionPending && deletionSnapshot.phase !== 'deleted') {
    // A confirmation whose card went away closes; an outcome nobody could see yet is said once at the panel.
    if (outcomeUnseen.current && deletionSnapshot.message !== null) {
      setDeletionNotice({
        kind: 'alert',
        text: `Your run of ${deletion.startedAtLabel}: ${deletionSnapshot.message}`,
      });
    }
    setDeletion(null);
  }

  // Read when the server confirms, so the latest render's scope and callbacks are used.
  const afterDeleted = useRef<(selection: DeletionSelection) => void>(() => undefined);
  afterDeleted.current = (selection) => {
    // Starting over unmounts every card, so focus inside the list (or already lost when the pressed button was
    // disabled) moves to the panel's heading. Someone who has since moved on to the filters keeps their place.
    const active = document.activeElement;
    if (active === null || active === document.body || resultsArea.current?.contains(active) === true) {
      heading.current?.focus();
    }
    setDeletion((current) => (current?.id === selection.id ? null : current));
    setSharing((current) => (current?.runId === selection.runId ? null : current));
    // Page one again, with the applied filters; the draft and the interpretation are left as they are.
    controller.current?.refresh();
    onRunDeleted?.();
    setDeletionNotice({ kind: 'status', text: `Your run of ${selection.startedAtLabel} was deleted.` });
  };

  useEffect(() => {
    if (deletion === null) return;
    const selection = deletion;
    const next = new RunDeletionController({
      csrf: () => csrfRef.current,
      deleteRun,
      onChange: (changed) => setDeletionState({ id: selection.id, snapshot: changed }),
      onDeleted: () => afterDeleted.current(selection),
      orgId,
      runId: selection.runId,
    });
    deleter.current = next;
    const stop = () => next.dispose();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    return () => {
      signal.removeEventListener('abort', stop);
      next.dispose();
      if (deleter.current === next) deleter.current = null;
    };
  }, [deletion, orgId, signal]);

  const toggleDeletion = (runId: string, startedAtLabel: string) => {
    if (deletionPending) return;
    if (deletion?.runId === runId && deletion.searchKey === scopeKey) {
      setDeletion(null);
      return;
    }
    // The run's own sharing panel closes: it must not change the run while it is being deleted.
    setSharing((current) => (current?.runId === runId ? null : current));
    setDeletionNotice(null);
    outcomeUnseen.current = false;
    setDeletion({ id: nextDeletionId.current++, runId, searchKey: scopeKey, startedAtLabel });
  };

  const cancelDeletion = () => {
    if (!deletionPending) setDeletion(null);
  };

  useEffect(() => {
    const next = new RunSearchController({
      filters: applied.filters,
      load: searchRuns,
      onChange: (changed) => setSearchState({ scopeKey, snapshot: changed }),
      orgId,
    });
    controller.current = next;
    next.start();
    return () => {
      if (controller.current === next) {
        controller.current = null;
      }
      next.dispose();
    };
  }, [applied.filters, orgId, scopeKey]);

  // One controller per organization (the panel is keyed by person and organization, so this is also per person).
  // Unmounting, signing out or switching scope disposes it, which drops any answer that is still on its way.
  useEffect(() => {
    const next = new RunSearchInterpretationController({
      load: (input, signal) => interpretRunSearch(input, csrfRef.current, signal),
      onChange: setInterpretation,
      onProposal: (filters) => setDraft(proposalToDraft(filters)),
      orgId,
      timeZone,
    });
    interpreter.current = next;
    return () => {
      if (interpreter.current === next) {
        interpreter.current = null;
      }
      next.dispose();
    };
  }, [orgId, timeZone]);

  const validation = validateDraft(draft, timeZone);
  const errors = validation.ok ? [] : validation.errors;
  const dirty = !validation.ok || JSON.stringify(validation.filters) !== JSON.stringify(applied.filters);

  // Anything the person does by hand makes a pending or shown interpretation obsolete.
  const editDraft = (next: RunSearchDraft) => {
    interpreter.current?.invalidate();
    setDraft(next);
  };
  const editText = (next: string) => {
    interpreter.current?.invalidate();
    setText(next);
  };

  const apply = () => {
    if (validation.ok) {
      interpreter.current?.invalidate();
      setDeletionNotice(null);
      setApplied((current) => ({ filters: validation.filters, id: current.id + 1 }));
    }
  };

  const statusText = deletion !== null && deletionPending && !deletionShown
    ? `Deleting your run of ${deletion.startedAtLabel}…`
    : deletionNotice?.kind === 'status'
      ? deletionNotice.text
      : '';

  return (
    <section aria-labelledby="my-runs-title" className="search-panel">
      <div className="search-panel__heading">
        <p className="eyebrow">Search</p>
        <h2 id="my-runs-title" ref={heading} tabIndex={-1}>My runs</h2>
        <p>
          This list has only runs you recorded yourself. The map above can also show routes that other people
          shared with you.
        </p>
      </div>
      {/* Always present, so a screen reader is already listening when the result is written into it. */}
      <p className="search-panel__notice" role="status">{statusText}</p>
      {deletionNotice?.kind === 'alert' && (
        <p className="search-panel__notice search-panel__notice--alert" role="alert">{deletionNotice.text}</p>
      )}
      <RunSearchInterpreter
        onInterpret={() => interpreter.current?.submit(text)}
        onTextChange={editText}
        snapshot={interpretation}
        text={text}
      />
      <RunSearchFilters
        dirty={dirty}
        draft={draft}
        errors={errors}
        onApply={apply}
        onChange={editDraft}
        timeZone={timeZone}
      />
      <AppliedFilters filters={applied.filters} resolved={snapshot.resolved} />
      <div className="search-panel__results" ref={resultsArea}>
        <RunSearchResults
          deletion={{
            busy: deletionPending,
            onCancel: cancelDeletion,
            onConfirm: () => deleter.current?.confirm(),
            onToggle: toggleDeletion,
            open: deletion !== null && deletionShown ? { runId: deletion.runId, snapshot: deletionSnapshot } : null,
          }}
          filters={applied.filters}
          onLoadMore={() => controller.current?.loadMore()}
          onRetry={() => controller.current?.retry()}
          sharing={{
            onClose: () => setSharing(null),
            onToggle: (runId) =>
              setSharing((current) =>
                current?.runId === runId && current.searchKey === scopeKey ? null : { runId, searchKey: scopeKey }),
            openRunId: sharedItem?.runId ?? null,
            scope: { csrfToken: csrf.token, orgId, signal, userId },
          }}
          snapshot={snapshot}
        />
      </div>
    </section>
  );
}
