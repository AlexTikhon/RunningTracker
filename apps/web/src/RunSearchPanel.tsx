import { useEffect, useMemo, useRef, useState } from 'react';

import { RunSearchFilters } from './RunSearchFilters.js';
import { AppliedFilters, RunSearchResults } from './RunSearchResults.js';
import {
  RunSearchController,
  type RunSearchSnapshot,
} from './run-search-controller.js';
import {
  defaultDraft,
  defaultTimeZone,
  validateDraft,
  type RunSearchDraft,
  type RunSearchFilters as RunSearchFilterValues,
} from './run-search.js';
import { searchRuns } from './runner-api.js';

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
  orgId: string;
  userId: string;
}

// Search over the signed-in person's own finished runs. The parent gives it `key={user/organization}`, so a
// different person or organization starts from a clean draft with no results, cursors or requests carried over.
// The editable draft and the applied filters are separate state: results always belong to the applied filters.
export function RunSearchPanel({ orgId, userId }: RunSearchPanelProps) {
  const timeZone = useMemo(() => defaultTimeZone(), []);
  const [draft, setDraft] = useState<RunSearchDraft>(defaultDraft);
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

  const validation = validateDraft(draft, timeZone);
  const errors = validation.ok ? [] : validation.errors;
  const dirty = !validation.ok || JSON.stringify(validation.filters) !== JSON.stringify(applied.filters);

  const apply = () => {
    if (validation.ok) {
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
      <RunSearchFilters
        dirty={dirty}
        draft={draft}
        errors={errors}
        onApply={apply}
        onChange={setDraft}
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
