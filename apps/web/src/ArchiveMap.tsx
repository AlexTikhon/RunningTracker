import type { ArchiveMetadataResponse } from '@running-tracker/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  archiveTileErrorStatus,
  synchronizeArchiveMapSource,
  type ArchiveMapPort,
} from './archive-map-source.js';
import { loadMapbox, type MapboxMapInstance } from './mapbox-runtime.js';

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
    let disposed = false;
    let createdMap: MapboxMapInstance | null = null;
    setMapError(null);
    void loadMapbox().then((mapboxgl) => {
      if (disposed || container.current === null) {
        return;
      }
      createdMap = new mapboxgl.Map({
        accessToken,
        center: [21.0122, 52.2297],
        container: container.current,
        style: 'mapbox://styles/mapbox/dark-v11',
        zoom: 10,
      });
      map.current = createdMap;
      createdMap.addControl(new mapboxgl.NavigationControl(), 'top-right');
      createdMap.on('load', () => {
        if (!disposed && map.current === createdMap) {
          setReady(true);
        }
      });
      createdMap.on('error', (event) => {
        const status = archiveTileErrorStatus(event);
        if (status !== null) {
          onTileErrorRef.current(status);
        } else if (!disposed) {
          setMapError('The map provider or base style could not be loaded.');
        }
      });
    }).catch(() => {
      if (!disposed) {
        setMapError('The map runtime could not be loaded by this browser.');
      }
    });
    return () => {
      disposed = true;
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
    <div className="archive-map" ref={container}>
      {!ready && <span className="archive-map__loading">Loading map…</span>}
      {mapError !== null && <span className="archive-map__error" role="alert">{mapError}</span>}
    </div>
  );
}
