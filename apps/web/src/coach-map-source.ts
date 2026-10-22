import type { CoachMapGeometry, LngLatBounds } from './coach-map-geometry.js';

export const COACH_MARKER_SOURCE_ID = 'running-tracker-coach-markers';
export const COACH_TRACK_SOURCE_ID = 'running-tracker-coach-tracks';
export const COACH_TRACK_LINE_LAYER_ID = 'running-tracker-coach-track-lines';
export const COACH_RETAINED_TRACK_LINE_LAYER_ID = 'running-tracker-coach-track-lines-retained';
export const COACH_TRACK_POINT_LAYER_ID = 'running-tracker-coach-track-points';
export const COACH_MARKER_LAYER_ID = 'running-tracker-coach-markers';

const fitOptions = { duration: 0, maxZoom: 16, padding: 56 } as const;

export interface CoachGeoJsonSourcePort {
  setData(data: unknown): unknown;
}

// The part of a Mapbox map the coach uses. The real `mapboxgl.Map` satisfies it structurally; tests inject a fake.
export interface CoachMapPort {
  addLayer(layer: Record<string, unknown>): unknown;
  addSource(id: string, source: Record<string, unknown>): unknown;
  fitBounds(bounds: LngLatBounds, options?: { duration?: number; maxZoom?: number; padding?: number }): unknown;
  getSource(id: string): unknown;
  isStyleLoaded(): boolean;
  off(type: string, listener: (event: unknown) => void): unknown;
  on(type: string, listener: (event: unknown) => void): unknown;
  remove(): void;
}

// `failed`: the provider or the browser could not give a usable map. `degraded`: the map works, but part of the
// base map did not load. Neither touches the position cards or the track picker.
export type CoachMapStatus = 'degraded' | 'failed' | 'loading' | 'ready';

export type CoachMapFactory = (signal: AbortSignal) => Promise<CoachMapPort>;

export interface AppliedCoachMapData {
  markers: string;
  tracks: string;
}

const isPoint = ['==', ['geometry-type'], 'Point'];
const isLine = ['==', ['geometry-type'], 'LineString'];
const isLatest = ['==', ['get', 'latest'], true];

function addCoachLayers(map: CoachMapPort): void {
  map.addSource(COACH_TRACK_SOURCE_ID, { data: { features: [], type: 'FeatureCollection' }, type: 'geojson' });
  map.addSource(COACH_MARKER_SOURCE_ID, { data: { features: [], type: 'FeatureCollection' }, type: 'geojson' });
  // Older committed geometry, kept while a newer revision is fetched or after a failed fetch: dashed and dimmed.
  map.addLayer({
    filter: ['all', isLine, ['!', isLatest]],
    id: COACH_RETAINED_TRACK_LINE_LAYER_ID,
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#8ecbff', 'line-dasharray': [2, 2], 'line-opacity': 0.55, 'line-width': 3 },
    source: COACH_TRACK_SOURCE_ID,
    type: 'line',
  });
  map.addLayer({
    filter: ['all', isLine, isLatest],
    id: COACH_TRACK_LINE_LAYER_ID,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#8ecbff', 'line-opacity': 0.92, 'line-width': 3.5 },
    source: COACH_TRACK_SOURCE_ID,
    type: 'line',
  });
  map.addLayer({
    filter: isPoint,
    id: COACH_TRACK_POINT_LAYER_ID,
    paint: {
      'circle-color': '#8ecbff',
      'circle-opacity': ['case', isLatest, 0.92, 0.55],
      'circle-radius': 3.5,
      'circle-stroke-color': '#121813',
      'circle-stroke-width': 1,
    },
    source: COACH_TRACK_SOURCE_ID,
    type: 'circle',
  });
  // Quality is shape as well as colour: confirmed is a solid disc, unconfirmed a ring, stale a small faded disc.
  map.addLayer({
    id: COACH_MARKER_LAYER_ID,
    paint: {
      'circle-color': ['match', ['get', 'quality'], 'confirmed', '#b8f264', 'unconfirmed', '#121813', '#ff8d81'],
      'circle-opacity': ['match', ['get', 'quality'], 'stale', 0.45, 1],
      'circle-radius': ['match', ['get', 'quality'], 'stale', 5.5, 8],
      'circle-stroke-color': ['match', ['get', 'quality'], 'confirmed', '#f4f9ef', 'unconfirmed', '#ffd166', '#ff8d81'],
      'circle-stroke-opacity': ['match', ['get', 'quality'], 'stale', 0.7, 1],
      'circle-stroke-width': ['match', ['get', 'quality'], 'unconfirmed', 3, 'stale', 1.5, 2],
    },
    source: COACH_MARKER_SOURCE_ID,
    type: 'circle',
  });
}

function source(map: CoachMapPort, id: string): CoachGeoJsonSourcePort | undefined {
  return map.getSource(id) as CoachGeoJsonSourcePort | undefined;
}

// Replaces both GeoJSON sources with exactly what the geometry contains. A source whose content did not change is
// not touched, so the once-a-second freshness tick does not churn the map. Markers are compared as JSON (one point
// per run); tracks by their key, which names the committed snapshots drawn.
export function applyCoachMapGeometry(
  map: CoachMapPort,
  geometry: CoachMapGeometry,
  previous: AppliedCoachMapData | null,
): AppliedCoachMapData {
  if (source(map, COACH_MARKER_SOURCE_ID) === undefined || source(map, COACH_TRACK_SOURCE_ID) === undefined) {
    addCoachLayers(map);
    previous = null;
  }
  const next = { markers: JSON.stringify(geometry.markers), tracks: geometry.tracksKey };
  if (previous?.tracks !== next.tracks) {
    source(map, COACH_TRACK_SOURCE_ID)?.setData(geometry.tracks);
  }
  if (previous?.markers !== next.markers) {
    source(map, COACH_MARKER_SOURCE_ID)?.setData(geometry.markers);
  }
  return next;
}

export interface CoachMapControllerOptions {
  createMap: CoachMapFactory;
  onStatus: (status: CoachMapStatus) => void;
  // The session the map was opened under. Its end removes the map, whatever React does next.
  signal: AbortSignal;
}

// One map for one session, user and organization. The geometry is replaced as a whole on every update; the map
// instance and the camera are kept. The camera moves only once by itself, when there is first something to show,
// and otherwise only through `fitVisible`.
export class CoachMapController {
  readonly #createMap: CoachMapFactory;
  readonly #lifetime = new AbortController();
  readonly #listeners: [string, (event: unknown) => void][] = [];
  readonly #onStatus: CoachMapControllerOptions['onStatus'];
  readonly #signal: AbortSignal;
  #applied: AppliedCoachMapData | null = null;
  #fitted = false;
  #geometry: CoachMapGeometry | null = null;
  #loaded = false;
  #map: CoachMapPort | null = null;
  #started = false;

  public constructor(options: CoachMapControllerOptions) {
    this.#createMap = options.createMap;
    this.#onStatus = options.onStatus;
    this.#signal = options.signal;
  }

  public start(): void {
    if (this.#started || this.#lifetime.signal.aborted) {
      return;
    }
    this.#started = true;
    if (this.#signal.aborted) {
      this.dispose();
      return;
    }
    this.#signal.addEventListener('abort', this.#onSessionEnd, { once: true });
    this.#onStatus('loading');
    let creation: Promise<CoachMapPort>;
    try {
      creation = this.#createMap(this.#lifetime.signal);
    } catch {
      creation = Promise.reject(new Error('map creation failed'));
    }
    creation.then(
      (map) => {
        if (this.#lifetime.signal.aborted) {
          map.remove();
          return;
        }
        this.#attach(map);
      },
      () => {
        if (!this.#lifetime.signal.aborted) {
          this.#onStatus('failed');
        }
      },
    );
  }

  public update(geometry: CoachMapGeometry): void {
    if (this.#lifetime.signal.aborted) {
      return;
    }
    this.#geometry = geometry;
    this.#apply();
  }

  // The explicit "Fit visible runs". Returns false when there is nothing to fit or no usable map yet.
  public fitVisible(): boolean {
    const bounds = this.#geometry?.bounds ?? null;
    if (!this.#loaded || this.#map === null || bounds === null) {
      return false;
    }
    this.#map.fitBounds(bounds, fitOptions);
    this.#fitted = true;
    return true;
  }

  public dispose(): void {
    if (this.#lifetime.signal.aborted) {
      return;
    }
    this.#lifetime.abort();
    this.#signal.removeEventListener('abort', this.#onSessionEnd);
    const map = this.#map;
    this.#map = null;
    this.#loaded = false;
    this.#geometry = null;
    this.#applied = null;
    if (map === null) {
      return;
    }
    for (const [type, listener] of this.#listeners.splice(0)) {
      map.off(type, listener);
    }
    try {
      map.remove();
    } catch {
      // The instance is unusable either way; nothing of it is kept.
    }
  }

  readonly #onSessionEnd = (): void => {
    this.dispose();
  };

  #listen(map: CoachMapPort, type: string, listener: (event: unknown) => void): void {
    this.#listeners.push([type, listener]);
    map.on(type, listener);
  }

  #attach(map: CoachMapPort): void {
    this.#map = map;
    this.#listen(map, 'load', () => {
      this.#markLoaded();
    });
    this.#listen(map, 'error', () => {
      // Never the provider's message: it can name URLs and tokens.
      if (!this.#lifetime.signal.aborted) {
        this.#onStatus(this.#loaded ? 'degraded' : 'failed');
      }
    });
    if (map.isStyleLoaded()) {
      this.#markLoaded();
    }
  }

  #markLoaded(): void {
    if (this.#lifetime.signal.aborted || this.#loaded) {
      return;
    }
    this.#loaded = true;
    this.#onStatus('ready');
    this.#apply();
  }

  #apply(): void {
    const map = this.#map;
    const geometry = this.#geometry;
    if (!this.#loaded || map === null || geometry === null) {
      return;
    }
    try {
      this.#applied = applyCoachMapGeometry(map, geometry, this.#applied);
      if (!this.#fitted && geometry.bounds !== null) {
        map.fitBounds(geometry.bounds, fitOptions);
        this.#fitted = true;
      }
    } catch {
      // The map may still show what the update was meant to remove, so it goes instead of being kept stale.
      this.#onStatus('failed');
      this.dispose();
    }
  }
}
