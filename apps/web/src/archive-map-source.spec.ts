import type { ArchiveMetadataResponse } from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_MAP_LAYER_ID,
  ARCHIVE_MAP_SOURCE_ID,
  archiveTileErrorStatus,
  synchronizeArchiveMapSource,
  type ArchiveMapPort,
  type ArchiveVectorSourcePort,
} from './archive-map-source.js';

const metadata = (revision: string): ArchiveMetadataResponse => ({
  archiveRevision: revision,
  filter: {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
  },
  maxzoom: 16,
  minzoom: 8,
  sourceLayer: 'runs',
  tiles: [`/api/tiles/{z}/{x}/{y}.mvt?revision=${revision}`],
});

function mapHarness() {
  const layers = new Map<string, unknown>();
  const sources = new Map<string, ArchiveVectorSourcePort>();
  const setTiles = vi.fn();
  const addLayer = vi.fn<(layer: Record<string, unknown>) => void>((layer) => {
    const id = layer['id'];
    if (typeof id === 'string') {
      layers.set(id, layer);
    }
  });
  const addSource = vi.fn<(id: string, source: Record<string, unknown>) => void>((id, source) => {
    void source;
    sources.set(id, { setTiles });
  });
  const removeLayer = vi.fn<(id: string) => void>((id) => {
    layers.delete(id);
  });
  const removeSource = vi.fn<(id: string) => void>((id) => {
    sources.delete(id);
  });
  const map: ArchiveMapPort = {
    addLayer,
    addSource,
    getLayer: (id) => layers.get(id),
    getSource: (id) => sources.get(id),
    removeLayer,
    removeSource,
  };
  return { addLayer, addSource, layers, map, removeLayer, removeSource, setTiles, sources };
}

describe('archive Mapbox source synchronization', () => {
  it('adds the private vector source and its server-defined source layer', () => {
    const subject = mapHarness();

    synchronizeArchiveMapSource(subject.map, null, metadata('1'));

    expect(subject.addSource).toHaveBeenCalledWith(ARCHIVE_MAP_SOURCE_ID, {
      maxzoom: 16,
      minzoom: 8,
      tiles: ['/api/tiles/{z}/{x}/{y}.mvt?revision=1'],
      type: 'vector',
    });
    expect(subject.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: ARCHIVE_MAP_LAYER_ID,
      source: ARCHIVE_MAP_SOURCE_ID,
      'source-layer': 'runs',
      type: 'line',
    }));
  });

  it('uses setTiles for a new archive revision without rebuilding the source', () => {
    const subject = mapHarness();
    const first = metadata('1');
    synchronizeArchiveMapSource(subject.map, null, first);

    synchronizeArchiveMapSource(subject.map, first, metadata('2'));

    expect(subject.setTiles).toHaveBeenCalledWith([
      '/api/tiles/{z}/{x}/{y}.mvt?revision=2',
    ]);
    expect(subject.addSource).toHaveBeenCalledTimes(1);
  });

  it('removes the layer before its source when access is lost', () => {
    const subject = mapHarness();
    const first = metadata('3');
    synchronizeArchiveMapSource(subject.map, null, first);

    synchronizeArchiveMapSource(subject.map, first, null);

    expect(subject.removeLayer).toHaveBeenCalledWith(ARCHIVE_MAP_LAYER_ID);
    expect(subject.removeSource).toHaveBeenCalledWith(ARCHIVE_MAP_SOURCE_ID);
    expect(subject.layers.size).toBe(0);
    expect(subject.sources.size).toBe(0);
  });

  it('recognizes only archive-source HTTP failures', () => {
    expect(archiveTileErrorStatus({
      error: { response: { status: 409 } },
      sourceId: ARCHIVE_MAP_SOURCE_ID,
    })).toBe(409);
    expect(archiveTileErrorStatus({
      error: { status: 403, url: '/api/orgs/abc/tiles/runs/8/1/1.mvt' },
    })).toBe(403);
    expect(archiveTileErrorStatus({
      error: { status: 401 },
      sourceId: 'mapbox-streets',
    })).toBeNull();
  });
});
