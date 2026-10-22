import type { BrowserContext, Page, Request } from '@playwright/test';

// What the app has put on the map, as the fake runtime saw it. `sources` is cleared when the map is removed, so it
// is exactly what a person could see.
export interface FakeMapProbe {
  readonly created: number;
  readonly fitBounds: number;
  readonly listeners: number;
  readonly removed: number;
  readonly sources: Readonly<Record<string, GeoJsonCollection | undefined>>;
}

export interface GeoJsonCollection {
  readonly features: readonly {
    readonly geometry: { readonly coordinates: unknown; readonly type: string };
    readonly properties: Readonly<Record<string, unknown>>;
  }[];
}

export const markerSourceId = 'running-tracker-coach-markers';
export const trackSourceId = 'running-tracker-coach-tracks';

// The pre-bundled module Vite serves for `import('mapbox-gl')` in development.
const mapboxModule = /\/node_modules\/\.vite\/deps\/mapbox-gl\.js(?:\?|$)/u;

// A stand-in for mapbox-gl with the methods the app calls. It records into window.__coachMapProbe and becomes
// usable ("load") a little later, like the real runtime. It renders nothing and makes no request.
const fakeModule = String.raw`
const probe = { created: 0, fitBounds: 0, listeners: 0, removed: 0, sources: {} };
window.__coachMapProbe = probe;
class FakeMap {
  constructor(options) {
    if (typeof options.accessToken !== 'string' || !(options.container instanceof HTMLElement)) {
      throw new Error('unexpected map options');
    }
    probe.created += 1;
    this.handlers = new Map();
    this.sourceData = new Map();
    this.loaded = false;
    this.removed = false;
    setTimeout(() => {
      if (this.removed) return;
      this.loaded = true;
      for (const handler of [...(this.handlers.get('load') ?? [])]) handler({ type: 'load' });
    }, 50);
  }
  addControl() {}
  addLayer() {}
  addSource(id, source) {
    const map = this;
    this.sourceData.set(id, {
      setData(data) {
        if (map.removed) throw new Error('setData on a removed map');
        probe.sources[id] = JSON.parse(JSON.stringify(data));
      },
    });
    probe.sources[id] = JSON.parse(JSON.stringify(source.data));
  }
  fitBounds() { probe.fitBounds += 1; }
  getSource(id) { return this.sourceData.get(id); }
  isStyleLoaded() { return this.loaded; }
  on(type, handler) {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    probe.listeners += 1;
  }
  off(type, handler) {
    if (this.handlers.get(type)?.delete(handler)) probe.listeners -= 1;
  }
  remove() {
    this.removed = true;
    probe.removed += 1;
    probe.sources = {};
  }
}
class NavigationControl {}
export { FakeMap as Map, NavigationControl };
export default { Map: FakeMap, NavigationControl };
`;

// Installed on the context before its page exists, so the first import of the map code already gets the fake.
export async function installFakeMapbox(context: BrowserContext): Promise<void> {
  await context.route(mapboxModule, (route) =>
    route.fulfill({ body: fakeModule, contentType: 'text/javascript', status: 200 }),
  );
}

export async function readProbe(page: Page): Promise<FakeMapProbe | null> {
  return page.evaluate(
    () => (window as unknown as { __coachMapProbe?: FakeMapProbe }).__coachMapProbe ?? null,
  );
}

export function features(probe: FakeMapProbe | null, sourceId: string): GeoJsonCollection['features'] {
  return probe?.sources[sourceId]?.features ?? [];
}

// Requests for the map runtime or to any Mapbox host, for proving the tokenless page made none.
export function isMapboxRequest(request: Request): boolean {
  const url = new URL(request.url());
  return mapboxModule.test(url.pathname) || url.hostname.endsWith('mapbox.com');
}
