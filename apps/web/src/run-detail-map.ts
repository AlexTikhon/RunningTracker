import type { ArchiveTrackResponse } from '@running-tracker/contracts';

import type { MapboxMapInstance } from './mapbox-runtime.js';

export type ArchiveGeometry = NonNullable<ArchiveTrackResponse['geometry']>;
export const RUN_DETAIL_SOURCE_ID = 'running-tracker-run-detail';
export const MERCATOR_MAX_LATITUDE = 85.0511287798066;
type Bounds = [[number, number], [number, number]];

// Fit the smallest longitude arc, allowing the east bound beyond 180 at the antimeridian. Geometry stays intact.
export function archiveTrackBounds(geometry: ArchiveGeometry): Bounds {
  const longitudes: number[] = [];
  let south = 90;
  let north = -90;
  for (const line of geometry.coordinates) {
    for (const [longitude, latitude] of line) {
      longitudes.push((longitude + 360) % 360);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
  }
  longitudes.sort((left, right) => left - right);
  let largestGap = -1;
  let startIndex = 0;
  for (let index = 0; index < longitudes.length; index += 1) {
    const next = longitudes[(index + 1) % longitudes.length]! + (index === longitudes.length - 1 ? 360 : 0);
    const gap = next - longitudes[index]!;
    if (gap > largestGap) {
      largestGap = gap;
      startIndex = (index + 1) % longitudes.length;
    }
  }
  let west = longitudes[startIndex]!;
  let east = west + (360 - largestGap);
  if (west > 180) { west -= 360; east -= 360; }
  const clamp = (latitude: number) => Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, latitude));
  return [[west, clamp(south)], [east, clamp(north)]];
}

export type RunDetailMapStatus = 'loading' | 'ready' | 'failed' | 'degraded';
type MapPort = Pick<MapboxMapInstance, 'addSource' | 'addLayer' | 'fitBounds' | 'on' | 'off' | 'remove' | 'isStyleLoaded'>;

export class RunDetailMapController {
  readonly #lifetime = new AbortController();
  readonly #listeners: [string, (event: unknown) => void][] = [];
  readonly #geometry: ArchiveGeometry;
  readonly #onStatus: (status: RunDetailMapStatus) => void;
  readonly #signal: AbortSignal;
  #map: MapPort | null = null;
  #ready = false;

  public constructor(options: {
    createMap: (signal: AbortSignal) => Promise<MapPort>;
    geometry: ArchiveGeometry;
    onStatus: (status: RunDetailMapStatus) => void;
    signal: AbortSignal;
  }) {
    this.#geometry = options.geometry;
    this.#onStatus = options.onStatus;
    this.#signal = options.signal;
    options.signal.addEventListener('abort', this.dispose, { once: true });
    if (options.signal.aborted) { this.dispose(); return; }
    void options.createMap(this.#lifetime.signal).then((map) => {
      if (this.#lifetime.signal.aborted) { map.remove(); return; }
      this.#map = map;
      this.#listen('load', () => this.#load());
      this.#listen('error', () => {
        if (this.#lifetime.signal.aborted) return;
        this.#onStatus(this.#ready ? 'degraded' : 'failed');
        if (!this.#ready) this.dispose();
      });
      if (map.isStyleLoaded()) this.#load();
    }).catch(() => {
      if (!this.#lifetime.signal.aborted) { this.#onStatus('failed'); this.dispose(); }
    });
  }

  public fitRoute(): void {
    if (this.#ready && this.#map !== null) {
      this.#map.fitBounds(archiveTrackBounds(this.#geometry), { duration: 0, maxZoom: 16, padding: 48 });
    }
  }

  public readonly dispose = (): void => {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort();
    this.#signal.removeEventListener('abort', this.dispose);
    const map = this.#map;
    this.#map = null;
    this.#ready = false;
    if (map !== null) {
      for (const [type, listener] of this.#listeners.splice(0)) map.off(type, listener);
      try { map.remove(); } catch { /* The instance is no longer retained. */ }
    }
  };

  #listen(type: string, listener: (event: unknown) => void): void {
    this.#listeners.push([type, listener]);
    this.#map?.on(type, listener);
  }

  #load(): void {
    const map = this.#map;
    if (map === null || this.#ready || this.#lifetime.signal.aborted) return;
    try {
      map.addSource(RUN_DETAIL_SOURCE_ID, {
        data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: this.#geometry, properties: {} }] },
        type: 'geojson',
      });
      map.addLayer({
        id: `${RUN_DETAIL_SOURCE_ID}-line`, source: RUN_DETAIL_SOURCE_ID, type: 'line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#b8f264', 'line-width': 4 },
      });
      this.#ready = true;
      this.fitRoute();
      this.#onStatus('ready');
    } catch {
      this.#onStatus('failed');
      this.dispose();
    }
  }
}
