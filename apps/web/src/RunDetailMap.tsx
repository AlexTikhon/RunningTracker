import { useEffect, useRef, useState } from 'react';

import { createMapboxMap } from './create-mapbox-map.js';
import { MERCATOR_MAX_LATITUDE, RunDetailMapController, type ArchiveGeometry, type RunDetailMapStatus } from './run-detail-map.js';

export function RunDetailMap({ accessToken, geometry, signal }: {
  accessToken: string | null;
  geometry: ArchiveGeometry;
  signal: AbortSignal;
}) {
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<RunDetailMapController | null>(null);
  const [status, setStatus] = useState<RunDetailMapStatus>('loading');
  const hasPolarCoordinates = geometry.coordinates.some((line) => line.some((point) => Math.abs(point[1]) > MERCATOR_MAX_LATITUDE));
  useEffect(() => {
    if (accessToken === null || container.current === null || signal.aborted) return;
    const element = container.current;
    setStatus('loading');
    const next = new RunDetailMapController({
      createMap: (lifetime) => createMapboxMap({ accessToken, center: [0, 0], container: element, signal: lifetime, zoom: 1 }),
      geometry, onStatus: setStatus, signal,
    });
    controller.current = next;
    return () => { next.dispose(); if (controller.current === next) controller.current = null; };
  }, [accessToken, geometry, signal]);

  return (
    <section aria-label="Run route" className="run-detail-route">
      <h2>Route</h2>
      {accessToken === null ? (
        <p role="status">The route map is unavailable. Your run statistics are shown above.</p>
      ) : (
        <>
          <div className="run-detail-map" ref={container} />
          {status === 'loading' && <p role="status">Loading route map…</p>}
          {(status === 'failed' || status === 'degraded') && <p role="status">{status === 'failed' ? 'The route map could not be loaded.' : 'Part of the base map could not be loaded.'} Your run statistics are still available.</p>}
          <button disabled={status !== 'ready' && status !== 'degraded'} onClick={() => controller.current?.fitRoute()} type="button">Fit route</button>
        </>
      )}
      {hasPolarCoordinates && <p>The map cannot display the parts of this route beyond 85° latitude.</p>}
    </section>
  );
}
