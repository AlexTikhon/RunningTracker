import type { DistanceUnit } from '@running-tracker/contracts';
import { useEffect, useRef, useState } from 'react';

import { loadArchiveTrack } from './runner-api.js';
import { RunDetailController, type RunDetailSnapshot } from './run-detail-controller.js';
import { RunDetailMap } from './RunDetailMap.js';
import { formatDistance, formatDuration, formatStartedAt } from './run-search.js';

export interface RunDetailScreenProps {
  accessToken: string | null;
  onBack: () => void;
  orgId: string;
  runId: string;
  signal: AbortSignal;
  timeZone: string;
  unit: DistanceUnit;
  userId: string;
}

export function RunDetailScreen({ accessToken, onBack, orgId, runId, signal, timeZone, unit, userId }: RunDetailScreenProps) {
  const scopeKey = `${userId}|${orgId}|${runId}`;
  const [state, setState] = useState<{ key: string; session: AbortSignal; snapshot: RunDetailSnapshot } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const controller = useRef<RunDetailController | null>(null);
  const snapshot: RunDetailSnapshot = state?.key === scopeKey && state.session === signal && !signal.aborted
    && !(state.snapshot.status === 'ready' && state.snapshot.signal.aborted)
    ? state.snapshot : { status: 'loading' };
  useEffect(() => {
    const next = new RunDetailController({
      load: loadArchiveTrack,
      onChange: (snapshot) => setState({ key: scopeKey, session: signal, snapshot }),
      scope: { orgId, runId }, signal,
    });
    controller.current = next;
    void next.refresh();
    heading.current?.focus();
    return () => { next.dispose(); if (controller.current === next) controller.current = null; };
  }, [orgId, runId, scopeKey, signal]);
  const feature = snapshot.status === 'ready' ? snapshot.feature : null;
  const properties = feature?.properties;
  return (
    <section aria-labelledby="run-detail-title" className="run-detail">
      <div className="run-detail-heading">
        <button onClick={onBack} type="button">Back to My runs</button>
        <h1 id="run-detail-title" ref={heading} tabIndex={-1}>Run details</h1>
        {(snapshot.status !== 'error' || snapshot.retryable) && (
          <button disabled={snapshot.status === 'loading'} onClick={() => void controller.current?.refresh()} type="button">{snapshot.status === 'error' ? 'Retry' : 'Refresh run'}</button>
        )}
      </div>
      {snapshot.status === 'loading' && <p role="status">Loading run details…</p>}
      {snapshot.status === 'error' && <p role="alert">{snapshot.message}</p>}
      {properties !== undefined && feature !== null && (
        <>
          <dl className="run-detail-stats" aria-label="Run times">
            <div><dt>Started</dt><dd><time dateTime={properties.startedAt}>{formatStartedAt(properties.startedAt, timeZone)}</time></dd></div>
            <div><dt>Finished</dt><dd><time dateTime={properties.finishedAt}>{formatStartedAt(properties.finishedAt, timeZone)}</time></dd></div>
          </dl>
          {properties.summaryState !== 'ready' ? (
            <p role="status">{properties.summaryState === 'pending' ? 'This run’s summary is still being prepared.' : 'New GPS data arrived. This run’s summary is being updated.'} Refresh this run to check again.</p>
          ) : (
            <>
              <dl className="run-detail-stats" aria-label="Run statistics">
                <div><dt>Distance</dt><dd>{formatDistance(properties.distanceM, unit)}</dd></div>
                <div><dt>Observed duration</dt><dd>{formatDuration(properties.observedDurationS)}</dd></div>
              </dl>
              <p>Observed duration covers accepted GPS measurements. It excludes pauses, gaps and rejected stretches; it is not moving time.</p>
              <section aria-labelledby="run-detail-quality">
                <h2 id="run-detail-quality">GPS quality</h2>
                <p>{properties.qualityStats.insufficientData ? 'Insufficient GPS data for a usable route.' : `${properties.qualityStats.acceptedPointCount} of ${properties.qualityStats.rawPointCount} GPS measurements were used.`}</p>
                <p>GPS noise can affect the measured distance. These statistics describe recorded measurements, not a verified distance.</p>
                <details><summary>GPS quality breakdown</summary>
                <dl className="run-detail-stats">
                  <div><dt>Poor accuracy measurements</dt><dd>{properties.qualityStats.poorAccuracyPointCount}</dd></div>
                  <div><dt>Sequence gaps</dt><dd>{properties.qualityStats.seqGapCount}</dd></div>
                  <div><dt>Segment breaks</dt><dd>{properties.qualityStats.segmentBreakCount}</dd></div>
                  <div><dt>Time gaps</dt><dd>{properties.qualityStats.excessiveTimeGapCount}</dd></div>
                  <div><dt>Non-increasing timestamps</dt><dd>{properties.qualityStats.nonpositiveTimeDeltaCount}</dd></div>
                  <div><dt>Excessive speed edges</dt><dd>{properties.qualityStats.excessiveSpeedCount}</dd></div>
                </dl>
                </details>
              </section>
              {feature.geometry === null ? <p role="status">No usable route was produced from this run’s GPS data.</p>
                : snapshot.status === 'ready' && <RunDetailMap accessToken={accessToken} geometry={feature.geometry} signal={snapshot.signal} />}
              <details><summary>Processing details</summary>
                <p>Algorithm {properties.algorithmVersion}; source revision {properties.sourceRevision}.</p>
                <p>{properties.rawState === 'available' ? 'Original GPS measurements are currently available.' : 'Original GPS measurements are being removed or have expired. The published route and statistics remain available.'}</p>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
