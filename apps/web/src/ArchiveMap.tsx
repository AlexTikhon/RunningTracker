import type { ArchiveMetadataResponse } from '@running-tracker/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  archiveTileErrorStatus,
  synchronizeArchiveMapSource,
  type ArchiveMapPort,
} from './archive-map-source.js';
import { createMapboxMap } from './create-mapbox-map.js';
import type { MapboxMapInstance } from './mapbox-runtime.js';

export interface ArchiveMapProps {
  accessToken: string | null;
  metadata: ArchiveMetadataResponse | null;
  onTileError: (status: number) => void;
}

export function ArchiveMap({ accessToken, metadata, onTileError }: ArchiveMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapboxMapInstance | null>(null);
  const previousMetadata = useRef<ArchiveMetadataResponse | null>(null);
  const onTileErrorRef = useRef(onTileError);
  const [mapError, setMapError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  onTileErrorRef.current = onTileError;

  useEffect(() => {
    if (accessToken === null || container.current === null) {
      return undefined;
    }
    const lifetime = new AbortController();
    let createdMap: MapboxMapInstance | null = null;
    setMapError(null);
    void createMapboxMap({
      accessToken, center: [21.0122, 52.2297], container: container.current,
      signal: lifetime.signal, zoom: 10,
    }).then((instance) => {
      if (lifetime.signal.aborted) {
        instance.remove();
        return;
      }
      createdMap = instance;
      map.current = createdMap;
      createdMap.on('load', () => {
        if (!lifetime.signal.aborted && map.current === createdMap) {
          setReady(true);
        }
      });
      createdMap.on('error', (event) => {
        if (lifetime.signal.aborted || map.current !== createdMap) return;
        const status = archiveTileErrorStatus(event);
        if (status !== null) {
          onTileErrorRef.current(status);
        } else {
          setMapError('The map provider or base style could not be loaded.');
        }
      });
    }).catch(() => {
      if (!lifetime.signal.aborted) {
        if (map.current === createdMap) map.current = null;
        try { createdMap?.remove(); } catch { /* No failed instance is retained. */ }
        createdMap = null;
        setMapError('The map runtime could not be loaded by this browser.');
      }
    });
    return () => {
      lifetime.abort();
      setReady(false);
      previousMetadata.current = null;
      if (map.current === createdMap) {
        map.current = null;
      }
      createdMap?.remove();
    };
  }, [accessToken]);

  useLayoutEffect(() => {
    if (!ready || map.current === null) {
      return;
    }
    synchronizeArchiveMapSource(
      map.current as unknown as ArchiveMapPort,
      previousMetadata.current,
      metadata,
    );
    previousMetadata.current = metadata;
  }, [metadata, ready]);

  if (accessToken === null) {
    return (
      <div className="archive-map archive-map--unavailable" role="status">
        <strong>Map provider not configured</strong>
        <span>Add a public VITE_MAPBOX_ACCESS_TOKEN to render the private archive source.</span>
      </div>
    );
  }

  return (
    <div className="archive-map">
      {/* Mapbox alone owns this subtree; React owns the sibling notices. */}
      <div className="archive-map__canvas" ref={container} />
      {!ready && <span className="archive-map__loading">Loading map…</span>}
      {mapError !== null && <span className="archive-map__error" role="alert">{mapError}</span>}
    </div>
  );
}
