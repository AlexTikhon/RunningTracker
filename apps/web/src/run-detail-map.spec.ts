import { describe, expect, it, vi } from 'vitest';

import { archiveTrackBounds, MERCATOR_MAX_LATITUDE, RUN_DETAIL_SOURCE_ID, RunDetailMapController, type ArchiveGeometry } from './run-detail-map.js';

const geometry: ArchiveGeometry = { type: 'MultiLineString', coordinates: [[[21, 52], [21.1, 52.1]], [[21.2, 52.2], [21.3, 52.3]]] };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fakeMap(loaded = true) {
  const listeners = new Map<string, (event: unknown) => void>();
  const map = {
    addLayer: vi.fn(), addSource: vi.fn(), fitBounds: vi.fn(), isStyleLoaded: () => loaded,
    on: vi.fn((type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); }),
    off: vi.fn((type: string) => { listeners.delete(type); }), remove: vi.fn(),
  };
  return { listeners, map };
}

describe('archive route bounds', () => {
  it('fits all disconnected chains', () => {
    const bounds = archiveTrackBounds(geometry);
    expect(bounds[0][0]).toBeCloseTo(21); expect(bounds[0][1]).toBe(52);
    expect(bounds[1][0]).toBeCloseTo(21.3); expect(bounds[1][1]).toBe(52.3);
  });
  it('fits the short arc across the antimeridian without modifying coordinates', () => {
    const track: ArchiveGeometry = { type: 'MultiLineString', coordinates: [[[179.9, 10], [180, 11]], [[-180, 11], [-179.9, 12]]] };
    const saved = JSON.stringify(track);
    const bounds = archiveTrackBounds(track);
    expect(bounds[1][0] - bounds[0][0]).toBeCloseTo(0.2);
    expect(bounds[0][0]).toBeCloseTo(179.9);
    expect(JSON.stringify(track)).toBe(saved);
  });
  it('clamps only camera latitude and handles repeated coordinates', () => {
    const track: ArchiveGeometry = { type: 'MultiLineString', coordinates: [[[-10, -89], [-10, -89]]] };
    expect(archiveTrackBounds(track)).toEqual([[-10, -MERCATOR_MAX_LATITUDE], [-10, -MERCATOR_MAX_LATITUDE]]);
    expect(track.coordinates[0]![0]![1]).toBe(-89);
  });
});

describe('run detail map lifetime', () => {
  it('draws the exact complete geometry and fits once after load, then only on request', async () => {
    const { map, listeners } = fakeMap(false);
    const status = vi.fn();
    const controller = new RunDetailMapController({ createMap: () => Promise.resolve(map), geometry, onStatus: status, signal: new AbortController().signal });
    await settle();
    expect(map.addSource).not.toHaveBeenCalled();
    listeners.get('load')?.({}); listeners.get('load')?.({});
    expect(map.addSource).toHaveBeenCalledExactlyOnceWith(RUN_DETAIL_SOURCE_ID, {
      type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] },
    });
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    controller.fitRoute(); expect(map.fitBounds).toHaveBeenCalledTimes(2);
    controller.dispose();
    expect(listeners.size).toBe(0); expect(map.remove).toHaveBeenCalledOnce();
  });
  it('an ended read/session removes the map and ignores late events', async () => {
    const { map, listeners } = fakeMap(); const signal = new AbortController(); const status = vi.fn();
    new RunDetailMapController({ createMap: () => Promise.resolve(map), geometry, onStatus: status, signal: signal.signal });
    await settle(); const error = listeners.get('error'); const load = listeners.get('load');
    signal.abort(); const count = status.mock.calls.length;
    error?.({}); load?.({});
    expect(map.remove).toHaveBeenCalledOnce(); expect(listeners.size).toBe(0);
    expect(status).toHaveBeenCalledTimes(count);
  });
  it('removes a map whose factory resolves after the screen closed', async () => {
    const { map } = fakeMap(); let resolve!: (value: typeof map) => void;
    const pending = new Promise<typeof map>((res) => { resolve = res; });
    const controller = new RunDetailMapController({ createMap: () => pending, geometry, onStatus: vi.fn(), signal: new AbortController().signal });
    controller.dispose(); resolve(map); await settle();
    expect(map.remove).toHaveBeenCalledOnce(); expect(map.addSource).not.toHaveBeenCalled();
  });
  it('does not create a map under an already ended read', () => {
    const signal = new AbortController(); signal.abort(); const createMap = vi.fn();
    new RunDetailMapController({ createMap, geometry, onStatus: vi.fn(), signal: signal.signal });
    expect(createMap).not.toHaveBeenCalled();
  });
  it('removes an unusable map when adding the layer fails', async () => {
    const { map } = fakeMap(); map.addLayer.mockImplementation(() => { throw new Error('provider URL and token'); });
    const status = vi.fn();
    new RunDetailMapController({ createMap: () => Promise.resolve(map), geometry, onStatus: status, signal: new AbortController().signal });
    await settle();
    expect(status).toHaveBeenLastCalledWith('failed'); expect(map.remove).toHaveBeenCalledOnce();
    expect(JSON.stringify(status.mock.calls)).not.toContain('token');
  });
  it('reports a base-map failure without leaking provider details or losing the route', async () => {
    const { map, listeners } = fakeMap(); const status = vi.fn();
    const controller = new RunDetailMapController({ createMap: () => Promise.resolve(map), geometry, onStatus: status, signal: new AbortController().signal });
    await settle(); listeners.get('error')?.({ message: 'provider URL and token' });
    expect(status).toHaveBeenLastCalledWith('degraded'); expect(map.remove).not.toHaveBeenCalled();
    controller.dispose();
  });
});
