import type { GpsQuality, RunSearchItem } from '@running-tracker/contracts';
import { useId, useRef } from 'react';

import { ArchiveRunShare, type ArchiveShareScope } from './ArchiveRunShare.js';
import type { RunSearchSnapshot } from './run-search-controller.js';
import {
  describeAppliedFilters,
  formatDistance,
  formatDuration,
  formatStartedAt,
  type RunSearchFilters,
} from './run-search.js';

const qualityText: Record<GpsQuality, string> = {
  good: 'GPS data good',
  insufficient: 'Insufficient GPS data',
  poor: 'Poor GPS data',
};

export interface AppliedFiltersProps {
  filters: RunSearchFilters;
  resolved: { fromDate: string; toDate: string } | null;
}

// What the list below was produced with. It is read from the applied filters only, never from the editable draft.
export function AppliedFilters({ filters, resolved }: AppliedFiltersProps) {
  const text = describeAppliedFilters(filters, resolved);
  return (
    <section aria-label="Applied filters" className="search-applied">
      <h3>Applied filters</h3>
      <dl>
        <div>
          <dt>Period</dt>
          <dd>{text.period}</dd>
        </div>
        <div>
          <dt>Distance</dt>
          <dd>{text.distance}</dd>
        </div>
        <div>
          <dt>Sort</dt>
          <dd>{text.sort}</dd>
        </div>
        <div>
          <dt>Time zone</dt>
          <dd>{text.timeZone}</dd>
        </div>
      </dl>
    </section>
  );
}

function PendingNotice({ count, distanceFiltered }: { count: number; distanceFiltered: boolean }) {
  if (count === 0) {
    return null;
  }
  const subject =
    count === 1
      ? '1 finished run in this period is still being processed.'
      : `${count} finished runs in this period are still being processed.`;
  const listed = count === 1 ? 'It is not listed yet.' : 'They are not listed yet.';
  const filter = count === 1 ? 'it matches' : 'they match';
  return (
    <p className="search-results__pending" role="status">
      <strong>{subject}</strong>{' '}
      <span>
        {listed}
        {distanceFiltered && ` It is not known whether ${filter} your distance filter.`}
      </span>
    </p>
  );
}

// Managing who can see the person's own finished runs. At most one card has its panel open, and nothing about
// sharing is read until it is opened.
export interface RunSearchSharing {
  onClose: () => void;
  onToggle: (runId: string) => void;
  openRunId: string | null;
  scope: ArchiveShareScope;
}

function RunCard({
  filters,
  item,
  sharing,
}: {
  filters: RunSearchFilters;
  item: RunSearchItem;
  sharing: RunSearchSharing | undefined;
}) {
  const manage = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const startedAt = formatStartedAt(item.startedAt, filters.timeZone);
  const open = sharing !== undefined && sharing.openRunId === item.runId;
  return (
    <li className={open ? 'run-card run-card--sharing' : 'run-card'}>
      <h4>
        <time dateTime={item.startedAt}>{startedAt}</time>
      </h4>
      <dl>
        <div>
          <dt>Distance</dt>
          <dd>{formatDistance(item.distanceM, filters.unit)}</dd>
        </div>
        <div>
          <dt>Observed duration</dt>
          <dd>{formatDuration(item.observedDurationS)}</dd>
        </div>
      </dl>
      <p className={`run-card__quality run-card__quality--${item.gpsQuality}`}>{qualityText[item.gpsQuality]}</p>
      {sharing !== undefined && (
        <button
          aria-controls={open ? panelId : undefined}
          aria-expanded={open}
          aria-label={`Manage sharing for your run of ${startedAt}`}
          className="run-card__share"
          onClick={() => sharing.onToggle(item.runId)}
          ref={manage}
          type="button"
        >
          Manage sharing
        </button>
      )}
      {open && (
        <ArchiveRunShare
          id={panelId}
          onClose={() => {
            sharing.onClose();
            manage.current?.focus();
          }}
          runId={item.runId}
          scope={sharing.scope}
          startedAtLabel={startedAt}
        />
      )}
    </li>
  );
}

export interface RunSearchResultsProps {
  // The filters the shown results were produced with.
  filters: RunSearchFilters;
  onLoadMore: () => void;
  onRetry: () => void;
  // Absent: the cards offer no sharing.
  sharing?: RunSearchSharing;
  snapshot: RunSearchSnapshot;
}

export function RunSearchResults({ filters, onLoadMore, onRetry, sharing, snapshot }: RunSearchResultsProps) {
  const distanceFiltered = filters.minDistance !== null || filters.maxDistance !== null;

  if (snapshot.status === 'loading') {
    return (
      <p className="search-results__loading" role="status">
        Searching your runs…
      </p>
    );
  }

  if (snapshot.status === 'error' || snapshot.status === 'access-denied') {
    return (
      <section className="notice notice--error" role="alert">
        <div>
          <strong>
            {snapshot.status === 'access-denied' ? 'Your runs are unavailable' : 'The search failed'}
          </strong>
          <span>{snapshot.message}</span>
        </div>
        <button onClick={onRetry} type="button">
          Retry
        </button>
      </section>
    );
  }

  if (snapshot.items.length === 0) {
    return (
      <div className="search-results">
        <p className="search-results__empty" role="status">
          No finished runs of yours match these filters.
        </p>
        <PendingNotice count={snapshot.pendingSummaryCount} distanceFiltered={distanceFiltered} />
      </div>
    );
  }

  return (
    <div className="search-results">
      <PendingNotice count={snapshot.pendingSummaryCount} distanceFiltered={distanceFiltered} />
      <p className="search-results__note">
        Observed duration is the sum of the time between consecutive accepted GPS measurements of a run. Gaps,
        pauses and stretches the GPS data could not confirm are not counted.
      </p>
      <ol aria-label="My runs" className="run-cards">
        {snapshot.items.map((item) => (
          <RunCard filters={filters} item={item} key={item.runId} sharing={sharing} />
        ))}
      </ol>
      {snapshot.moreMessage !== null && (
        <p className="search-results__more-error" role="alert">
          {snapshot.moreMessage}
        </p>
      )}
      {snapshot.outdated ? (
        <button onClick={onRetry} type="button">
          Search again
        </button>
      ) : (
        snapshot.hasMore && (
          <button
            disabled={snapshot.loadingMore}
            onClick={snapshot.moreMessage === null ? onLoadMore : onRetry}
            type="button"
          >
            {snapshot.loadingMore
              ? 'Loading more…'
              : snapshot.moreMessage === null
                ? 'Load more runs'
                : 'Try again'}
          </button>
        )
      )}
    </div>
  );
}
