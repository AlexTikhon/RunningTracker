import { loadMapbox, MAPBOX_BASE_STYLE, type MapboxMapInstance } from './mapbox-runtime.js';

export interface CreateMapboxMapOptions {
  accessToken: string;
  center: [number, number];
  container: HTMLDivElement;
  signal: AbortSignal;
  zoom: number;
}

// Ownership transfers to the caller only after all synchronous setup succeeds.
export async function createMapboxMap({ signal, ...options }: CreateMapboxMapOptions): Promise<MapboxMapInstance> {
  signal.throwIfAborted();
  const runtime = await loadMapbox();
  signal.throwIfAborted();
  const map = new runtime.Map({ ...options, style: MAPBOX_BASE_STYLE });
  try {
    map.addControl(new runtime.NavigationControl(), 'top-right');
    return map;
  } catch (error) {
    try { map.remove(); } catch { /* Preserve the setup error; the instance is no longer retained. */ }
    throw error;
  }
}
