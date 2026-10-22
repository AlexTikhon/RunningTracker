import { useEffect, useId, useRef, useState } from 'react';

import type { CoachMapGeometry, CoachMapTrackStatus } from './coach-map-geometry.js';
import { CoachMapController, type CoachMapStatus } from './coach-map-source.js';
import { loadMapbox, MAPBOX_BASE_STYLE } from './mapbox-runtime.js';

export interface CoachMapProps {
  accessToken: string | null;
  geometry: CoachMapGeometry;
  // The session the map belongs to; the parent keys this component by user and organization.
  signal: AbortSignal;
}

function positionSummary(geometry: CoachMapGeometry): string {
  const { confirmed, stale, unconfirmed } = geometry.markerCounts;
  const total = confirmed + stale + unconfirmed;
  if (total === 0) {
    return 'No positions on the map.';
  }
  const parts = [
    confirmed > 0 ? `${confirmed} confirmed` : null,
    unconfirmed > 0 ? `${unconfirmed} unconfirmed` : null,
    stale > 0 ? `${stale} stale` : null,
  ].filter((part) => part !== null);
  return `${total} ${total === 1 ? 'position' : 'positions'} on the map: ${parts.join(', ')}.`;
}

// Which revision is drawn, and never "latest" for older geometry kept during a refresh or after a failure.
function trackStatusLabel(track: CoachMapTrackStatus): string {
  if (track.drawnRevision === null) {
    return track.status === 'error'
      ? `${track.label}: rev ${track.targetRevision} could not be loaded`
      : `${track.label}: loading rev ${track.targetRevision}`;
  }
  if (track.latest) {
    return `${track.label}: rev ${track.drawnRevision}, latest`;
  }
  return track.status === 'error'
    ? `${track.label}: showing older rev ${track.drawnRevision}; rev ${track.targetRevision} could not be loaded`
    : `${track.label}: showing older rev ${track.drawnRevision} while rev ${track.targetRevision} loads`;
}

const legend = [
  ['confirmed', 'Confirmed position: solid disc'],
  ['unconfirmed', 'Unconfirmed position: ring'],
  ['stale', 'Stale last-known position: small faded disc'],
  ['track', 'Selected track, latest revision: solid line'],
  ['retained', 'Older revision kept while updating: dashed line'],
  ['isolated', 'Unconnected track point: small dot'],
] as const;

export function CoachMap({ accessToken, geometry, signal }: CoachMapProps) {
  const headingId = useId();
  const container = useRef<HTMLDivElement | null>(null);
  const controller = useRef<CoachMapController | null>(null);
  const latestGeometry = useRef(geometry);
  latestGeometry.current = geometry;
  const [status, setStatus] = useState<CoachMapStatus>('loading');

  useEffect(() => {
    const element = container.current;
    if (accessToken === null || element === null) {
      return undefined;
    }
    const created = new CoachMapController({
      createMap: async (lifetime) => {
        const mapboxgl = await loadMapbox();
        lifetime.throwIfAborted();
        const map = new mapboxgl.Map({
          accessToken,
          center: [21.0122, 52.2297],
          container: element,
          style: MAPBOX_BASE_STYLE,
          zoom: 10,
        });
        map.addControl(new mapboxgl.NavigationControl(), 'top-right');
        return map;
      },
      onStatus: setStatus,
      signal,
    });
    controller.current = created;
    created.start();
    created.update(latestGeometry.current);
    return () => {
      if (controller.current === created) {
        controller.current = null;
      }
      created.dispose();
    };
  }, [accessToken, signal]);

  useEffect(() => {
    controller.current?.update(geometry);
  }, [geometry]);

  return (
    <section className="coach-map-panel" aria-labelledby={headingId}>
      <div className="coach-map-panel__header">
        <strong id={headingId}>Live map</strong>
        {accessToken !== null && (
          <button
            disabled={status === 'failed' || status === 'loading' || geometry.bounds === null}
            onClick={() => controller.current?.fitVisible()}
            type="button"
          >
            Fit visible runs
          </button>
        )}
      </div>
      {accessToken === null ? (
        <p className="coach-map coach-map--unavailable" role="note">
          Map unavailable. Positions and tracks are listed below.
        </p>
      ) : (
        <>
          <div className="coach-map">
            {/* Mapbox owns this element and expects it empty; the notices are drawn over it. */}
            <div className="coach-map__canvas" ref={container} />
            {status === 'loading' && <span className="coach-map__notice">Loading map…</span>}
            {status === 'failed' && (
              <span className="coach-map__notice coach-map__notice--error" role="alert">
                The map could not be shown. Positions and tracks are listed below.
              </span>
            )}
            {status === 'degraded' && (
              <span className="coach-map__notice" role="status">Part of the base map could not be loaded.</span>
            )}
          </div>
          <div className="coach-map-panel__details">
            <ul className="coach-map-legend" aria-label="Map legend">
              {legend.map(([kind, text]) => (
                <li key={kind}>
                  <span className={`coach-map-legend__swatch coach-map-legend__swatch--${kind}`} aria-hidden="true" />
                  {text}
                </li>
              ))}
            </ul>
            <div className="coach-map-panel__summary">
              <p>{positionSummary(geometry)} A run without a usable position is not drawn.</p>
              {geometry.trackStatuses.length > 0 && (
                <ul aria-label="Tracks on the map">
                  {geometry.trackStatuses.map((track) => (
                    <li key={track.runId}>{trackStatusLabel(track)}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
