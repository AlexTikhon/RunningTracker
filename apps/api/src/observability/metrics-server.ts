import { createServer, type Server } from 'node:http';

import type { MetricsRegistry } from './metrics.js';

/**
 * A listener separate from the public API, so scrape access is a network
 * decision (bind address, firewall) and never rides on a user session or
 * tenant context. It serves exactly GET /metrics.
 */
export function createMetricsServer(registry: MetricsRegistry): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '').split('?', 1)[0];
    if (path !== '/metrics') {
      response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' });
      response.end('not found\n');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, {
        Allow: 'GET',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain',
      });
      response.end('method not allowed\n');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    response.end(registry.render());
  });
}

export interface MetricsListener {
  close(): Promise<void>;
  server: Server;
}

export function startMetricsListener(
  registry: MetricsRegistry,
  options: { host: string; port: number },
): Promise<MetricsListener> {
  const server = createMetricsServer(registry);
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.off('error', onError);
      let closing: Promise<void> | undefined;
      resolve({
        close: () => {
          closing ??= new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
          return closing;
        },
        server,
      });
    });
  });
}
