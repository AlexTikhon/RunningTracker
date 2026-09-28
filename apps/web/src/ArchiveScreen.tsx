import { useEffect, useMemo, useRef, useState } from 'react';

import { ArchiveMap } from './ArchiveMap.js';
import {
  ArchiveSourceController,
  type ArchivePeriod,
  type ArchiveSourceSnapshot,
} from './archive-source.js';
import { loadArchiveMetadata } from './runner-api.js';

const initialSnapshot: ArchiveSourceSnapshot = {
  checkedAt: null,
  message: null,
  metadata: null,
  status: 'loading',
};

function utcDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function initialDates(now = Date.now()): { fromDate: string; toDate: string } {
  const today = new Date(now);
  const tomorrowUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1,
  );
  return {
    fromDate: utcDate(tomorrowUtc - 30 * 24 * 60 * 60 * 1_000),
    toDate: utcDate(tomorrowUtc),
  };
}

function periodFromDates(fromDate: string, toDate: string): ArchivePeriod {
  return {
    from: `${fromDate}T00:00:00.000Z`,
    to: `${toDate}T00:00:00.000Z`,
  };
}

function periodIsValid(period: ArchivePeriod): boolean {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return Number.isFinite(from)
    && Number.isFinite(to)
    && from < to
    && to - from <= 366 * 24 * 60 * 60 * 1_000;
}

export interface ArchiveScreenProps {
  accessToken: string | null;
  orgId: string;
  userId: string;
}

export function ArchiveScreen({ accessToken, orgId, userId }: ArchiveScreenProps) {
  const defaults = useMemo(initialDates, []);
  const [fromDate, setFromDate] = useState(defaults.fromDate);
  const [toDate, setToDate] = useState(defaults.toDate);
  const [period, setPeriod] = useState<ArchivePeriod>(() =>
    periodFromDates(defaults.fromDate, defaults.toDate),
  );
  const scopeKey = `${userId}/${orgId}/${period.from}/${period.to}`;
  const [sourceState, setSourceState] = useState<{
    scopeKey: string;
    snapshot: ArchiveSourceSnapshot;
  }>({ scopeKey, snapshot: initialSnapshot });
  const controller = useRef<ArchiveSourceController | null>(null);
  const draftPeriod = periodFromDates(fromDate, toDate);
  const draftIsValid = periodIsValid(draftPeriod);
  const snapshot = sourceState.scopeKey === scopeKey
    ? sourceState.snapshot
    : initialSnapshot;

  useEffect(() => {
    const nextController = new ArchiveSourceController({
      from: period.from,
      loadMetadata: loadArchiveMetadata,
      onChange: (next) => setSourceState({ scopeKey, snapshot: next }),
      orgId,
      to: period.to,
    });
    controller.current = nextController;
    nextController.start();
    return () => {
      if (controller.current === nextController) {
        controller.current = null;
      }
      nextController.dispose();
    };
  }, [orgId, period.from, period.to, scopeKey, userId]);

  const applyPeriod = () => {
    if (draftIsValid) {
      setPeriod(draftPeriod);
    }
  };

  return (
    <section className="archive-shell" aria-labelledby="archive-title">
      <div className="archive-heading">
        <div>
          <p className="eyebrow">Archive map · P09.5</p>
          <h1 id="archive-title">Finished runs,<br />revision safe.</h1>
        </div>
        <div className={`archive-status archive-status--${snapshot.status}`} role="status">
          <span>{snapshot.status}</span>
          {snapshot.metadata !== null && (
            <small>archive revision {snapshot.metadata.archiveRevision}</small>
          )}
          {snapshot.checkedAt !== null && (
            <small>checked {new Date(snapshot.checkedAt).toLocaleTimeString()}</small>
          )}
        </div>
      </div>

      <section className="archive-filter" aria-label="Archive period">
        <label>
          From · UTC
          <input
            onChange={(event) => setFromDate(event.target.value)}
            type="date"
            value={fromDate}
          />
        </label>
        <label>
          To · exclusive UTC
          <input
            onChange={(event) => setToDate(event.target.value)}
            type="date"
            value={toDate}
          />
        </label>
        <button disabled={!draftIsValid} onClick={applyPeriod} type="button">
          Apply period
        </button>
        <button onClick={() => controller.current?.refreshNow()} type="button">
          Refresh now
        </button>
        {!draftIsValid && <span role="alert">Choose an ordered period of at most 366 days.</span>}
      </section>

      {snapshot.message !== null && (
        <section
          className="notice notice--error"
          role={snapshot.status === 'access-denied' ? 'alert' : 'status'}
        >
          <div>
            <strong>
              {snapshot.status === 'access-denied'
                ? 'Archive access unavailable'
                : 'Archive refresh failed'}
            </strong>
            <span>{snapshot.message}</span>
          </div>
          <button onClick={() => controller.current?.refreshNow()} type="button">Retry</button>
        </section>
      )}

      <ArchiveMap
        accessToken={accessToken}
        metadata={snapshot.metadata}
        onTileError={(status) => controller.current?.handleTileError(status)}
      />

      <footer className="archive-source-detail">
        <span>
          {snapshot.metadata === null
            ? 'No archive source is attached.'
            : `${snapshot.metadata.sourceLayer} · zoom ${snapshot.metadata.minzoom}–${snapshot.metadata.maxzoom}`}
        </span>
        <span>Metadata refreshes every 30 seconds and immediately on tab focus.</span>
      </footer>
    </section>
  );
}
