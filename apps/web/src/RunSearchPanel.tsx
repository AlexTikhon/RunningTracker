import { useEffect, useMemo, useRef, useState } from 'react';

import { RunSearchFilters } from './RunSearchFilters.js';
import { RunSearchInterpreter } from './RunSearchInterpreter.js';
import { AppliedFilters, RunSearchResults } from './RunSearchResults.js';
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
import { interpretRunSearch, searchRuns, type CsrfCredentials } from './runner-api.js';

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
  orgId: string;
  userId: string;
}

const idleInterpretation: InterpretationSnapshot = { status: 'idle' };

// Search over the signed-in person's own finished runs. The parent gives it `key={user/organization}`, so a
// different person or organization starts from a clean draft with no results, cursors or requests carried over.
// The editable draft and the applied filters are separate state: results always belong to the applied filters.
// Describing the search in words only ever replaces the draft; applying it stays the person's explicit step.
export function RunSearchPanel({ csrf, orgId, userId }: RunSearchPanelProps) {
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
      setApplied((current) => ({ filters: validation.filters, id: current.id + 1 }));
    }
  };

  return (
    <section aria-labelledby="my-runs-title" className="search-panel">
      <div className="search-panel__heading">
        <p className="eyebrow">Search</p>
        <h2 id="my-runs-title">My runs</h2>
        <p>
          This list has only runs you recorded yourself. The map above can also show routes that other people
          shared with you.
        </p>
      </div>
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
      <RunSearchResults
        filters={applied.filters}
        onLoadMore={() => controller.current?.loadMore()}
        onRetry={() => controller.current?.retry()}
        snapshot={snapshot}
      />
    </section>
  );
}
