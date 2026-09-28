export interface MapboxMapInstance {
  addControl(control: unknown, position?: string): void;
  on(type: string, listener: (event: unknown) => void): void;
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

export function loadMapbox(): Promise<MapboxRuntime>;
