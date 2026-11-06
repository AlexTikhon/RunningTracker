import type { BrowserContext, Page } from '@playwright/test';

import type { E2eEnvironment } from './environment.js';

// Use the installed runtime and WebGL, but keep the provider protocol entirely in
// the browser. Auth/telemetry success is synthetic, not a provider availability test.
export async function installLocalMapbox(context: BrowserContext, environment: E2eEnvironment): Promise<string[]> {
  const unexpected: string[] = [];
  const localOrigins = new Set([environment.webOrigin, environment.mapWebOrigin, environment.apiOrigin]);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (localOrigins.has(url.origin) || ['blob:', 'data:'].includes(url.protocol)) {
      await route.fallback();
    } else if (url.hostname === 'api.mapbox.com' && url.pathname === '/styles/v1/mapbox/dark-v11') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#121813' } }],
      }) });
    } else if (url.hostname === 'api.mapbox.com' && url.pathname === '/map-sessions/v1') {
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    } else if (url.hostname === 'events.mapbox.com' && url.pathname === '/events/v2') {
      await route.fulfill({ status: 204 });
    } else if (url.hostname === 'fonts.googleapis.com') {
      await route.fulfill({ body: '', contentType: 'text/css' });
    } else {
      // Never log a query string: provider URLs can contain public access tokens.
      unexpected.push(`${url.hostname}${url.pathname}`);
      await route.abort('blockedbyclient');
    }
  });
  return unexpected;
}

export function mapRuntimeDiagnostics(page: Page): { errors: string[]; containerWarnings: string[] } {
  const errors: string[] = [];
  const containerWarnings: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning' && /container.*(?:empty|children)|(?:empty|children).*container/iu.test(message.text())) {
      containerWarnings.push(message.text());
    }
  });
  return { errors, containerWarnings };
}
