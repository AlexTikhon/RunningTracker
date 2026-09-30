import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { createApiMetrics } from './api-metrics.js';
import { startMetricsListener } from './metrics-server.js';

describe('P11.1 metrics listener lifecycle', () => {
  it('binds the requested host, serves a scrape, and closes without lingering connections', async () => {
    const metrics = createApiMetrics();
    metrics.http.inFlight.set({}, 2);
    const listener = await startMetricsListener(metrics.registry, { host: '127.0.0.1', port: 0 });
    const { address, port } = listener.server.address() as AddressInfo;
    expect(address).toBe('127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Connection: 'keep-alive' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('http_requests_in_flight 2');

    await listener.close();
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
    await expect(listener.close()).resolves.toBeUndefined();
  });

  it('fails startup when the port is already taken instead of silently running unobserved', async () => {
    const metrics = createApiMetrics();
    const first = await startMetricsListener(metrics.registry, { host: '127.0.0.1', port: 0 });
    const { port } = first.server.address() as AddressInfo;

    await expect(
      startMetricsListener(metrics.registry, { host: '127.0.0.1', port }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await first.close();
  });
});
