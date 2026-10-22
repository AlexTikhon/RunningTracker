export interface MapboxMapInstance {
  addControl(control: unknown, position?: string): void;
  addLayer(layer: Record<string, unknown>): unknown;
  addSource(id: string, source: Record<string, unknown>): unknown;
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: { duration?: number; maxZoom?: number; padding?: number },
  ): unknown;
  getSource(id: string): unknown;
  isStyleLoaded(): boolean;
  off(type: string, listener: (event: unknown) => void): unknown;
  on(type: string, listener: (event: unknown) => void): unknown;
  remove(): void;
}

export interface MapboxRuntime {
  Map: new (options: {
    accessToken: string;
    center: [number, number];
    container: HTMLDivElement;
    style: string;
    zoom: number;
  }) => MapboxMapInstance;
  NavigationControl: new () => unknown;
}

export const MAPBOX_BASE_STYLE: string;

export function loadMapbox(): Promise<MapboxRuntime>;
