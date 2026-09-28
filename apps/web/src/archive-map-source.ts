import type { ArchiveMetadataResponse } from '@running-tracker/contracts';

export const ARCHIVE_MAP_SOURCE_ID = 'running-tracker-archive';
export const ARCHIVE_MAP_LAYER_ID = 'running-tracker-archive-lines';

export interface ArchiveVectorSourcePort {
  setTiles(tiles: string[]): void;
}

export interface ArchiveMapPort {
  addLayer(layer: Record<string, unknown>): void;
  addSource(id: string, source: Record<string, unknown>): void;
  getLayer(id: string): unknown;
  getSource(id: string): unknown;
  removeLayer(id: string): void;
  removeSource(id: string): void;
}

function removeArchiveSource(map: ArchiveMapPort): void {
  if (map.getLayer(ARCHIVE_MAP_LAYER_ID) !== undefined) {
    map.removeLayer(ARCHIVE_MAP_LAYER_ID);
  }
  if (map.getSource(ARCHIVE_MAP_SOURCE_ID) !== undefined) {
    map.removeSource(ARCHIVE_MAP_SOURCE_ID);
  }
}

function sameShape(
  previous: ArchiveMetadataResponse,
  next: ArchiveMetadataResponse,
): boolean {
  return previous.sourceLayer === next.sourceLayer
    && previous.minzoom === next.minzoom
    && previous.maxzoom === next.maxzoom;
}

export function synchronizeArchiveMapSource(
  map: ArchiveMapPort,
  previous: ArchiveMetadataResponse | null,
  next: ArchiveMetadataResponse | null,
): void {
  if (next === null) {
    removeArchiveSource(map);
    return;
  }

  const existing = map.getSource(ARCHIVE_MAP_SOURCE_ID) as ArchiveVectorSourcePort | undefined;
  if (existing !== undefined && previous !== null && sameShape(previous, next)) {
    if (previous.archiveRevision !== next.archiveRevision
      || previous.tiles.join('\n') !== next.tiles.join('\n')) {
      existing.setTiles([...next.tiles]);
    }
    return;
  }

  removeArchiveSource(map);
  map.addSource(ARCHIVE_MAP_SOURCE_ID, {
    maxzoom: next.maxzoom,
    minzoom: next.minzoom,
    tiles: [...next.tiles],
    type: 'vector',
  });
  map.addLayer({
    id: ARCHIVE_MAP_LAYER_ID,
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#b8f264',
      'line-opacity': 0.88,
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        next.minzoom,
        1.5,
        next.maxzoom,
        4,
      ],
    },
    source: ARCHIVE_MAP_SOURCE_ID,
    'source-layer': next.sourceLayer,
    type: 'line',
  });
}

function numericStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function archiveTileErrorStatus(event: unknown): number | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const candidate = event as {
    error?: {
      response?: { status?: unknown };
      status?: unknown;
      statusCode?: unknown;
      url?: unknown;
    };
    sourceId?: unknown;
  };
  const fromArchiveSource = candidate.sourceId === ARCHIVE_MAP_SOURCE_ID;
  const fromArchiveUrl = typeof candidate.error?.url === 'string'
    && candidate.error.url.includes('/tiles/runs/');
  if (!fromArchiveSource && !fromArchiveUrl) {
    return null;
  }
  return numericStatus(candidate.error?.status)
    ?? numericStatus(candidate.error?.statusCode)
    ?? numericStatus(candidate.error?.response?.status);
}
