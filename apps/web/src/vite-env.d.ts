interface ImportMetaEnv {
  // "true" only for the Vite process `npm run demo:up` starts; see demo-sign-in.ts.
  readonly VITE_LOCAL_DEMO_ENABLED?: string;
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
