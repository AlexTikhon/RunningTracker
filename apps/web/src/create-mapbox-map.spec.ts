import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMapboxMap } from './create-mapbox-map.js';
import { loadMapbox, MAPBOX_BASE_STYLE, type MapboxRuntime } from './mapbox-runtime.js';

vi.mock('./mapbox-runtime.js', () => ({ loadMapbox: vi.fn(), MAPBOX_BASE_STYLE: 'mapbox://styles/mapbox/dark-v11' }));

function fixture() {
  const map = { addControl: vi.fn(), remove: vi.fn() };
  const construct = vi.fn(function () { return map; });
  const runtime: MapboxRuntime = {
    Map: construct as unknown as MapboxRuntime['Map'],
    NavigationControl: class {},
  };
  // No DOM is used by this allocation boundary; the runtime receives the exact host.
  const container = {} as HTMLDivElement;
  const lifetime = new AbortController();
  const options = { accessToken: 'fixture', center: [21, 52] as [number, number], container, signal: lifetime.signal, zoom: 10 };
  vi.mocked(loadMapbox).mockResolvedValue(runtime);
  return { construct, lifetime, map, options, runtime };
}

describe('Mapbox allocation ownership', () => {
  beforeEach(() => vi.resetAllMocks());

  it('transfers ownership only after installing the navigation control', async () => {
    const { construct, map, options } = fixture();
    expect(await createMapboxMap(options)).toBe(map);
    expect(construct).toHaveBeenCalledExactlyOnceWith({
      accessToken: options.accessToken, center: options.center, container: options.container,
      style: MAPBOX_BASE_STYLE, zoom: options.zoom,
    });
    expect(map.addControl).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 'top-right');
    expect(map.remove).not.toHaveBeenCalled();
  });

  it('does not import the runtime for an already aborted lifetime', async () => {
    const { construct, lifetime, options } = fixture();
    lifetime.abort();
    await expect(createMapboxMap(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(loadMapbox).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
  });

  it('does not allocate after the screen closes during runtime loading', async () => {
    const { construct, lifetime, options, runtime } = fixture();
    let resolve!: (runtime: MapboxRuntime) => void;
    vi.mocked(loadMapbox).mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = createMapboxMap(options);
    lifetime.abort();
    resolve(runtime);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(construct).not.toHaveBeenCalled();
  });

  it.each(['constructor', 'installation'] as const)('removes the map when navigation-control %s fails', async (step) => {
    const { map, options, runtime } = fixture();
    const failure = new Error('setup failure');
    if (step === 'constructor') runtime.NavigationControl = class { constructor() { throw failure; } };
    else map.addControl.mockImplementation(() => { throw failure; });
    await expect(createMapboxMap(options)).rejects.toBe(failure);
    expect(map.remove).toHaveBeenCalledOnce();
  });

  it('preserves the setup failure even when removal throws', async () => {
    const { map, options } = fixture();
    const failure = new Error('setup failure');
    map.addControl.mockImplementation(() => { throw failure; });
    map.remove.mockImplementation(() => { throw new Error('remove failure'); });
    await expect(createMapboxMap(options)).rejects.toBe(failure);
    expect(map.remove).toHaveBeenCalledOnce();
  });

  it('propagates an import failure without attempting allocation', async () => {
    const { construct, options } = fixture();
    const failure = new Error('import failure');
    vi.mocked(loadMapbox).mockRejectedValue(failure);
    await expect(createMapboxMap(options)).rejects.toBe(failure);
    expect(construct).not.toHaveBeenCalled();
  });
});
