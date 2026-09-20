import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemClock } from '../clock.js';
import { shutdownInfrastructure } from './shutdown.js';

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers.clear();
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

describe('shutdownInfrastructure', () => {
  it('stops accepting HTTP requests before closing the pool', async () => {
    const server = createServer();
    servers.add(server);
    await listen(server);
    const end = vi.fn(() => Promise.resolve());

    const result = await shutdownInfrastructure({
      clock: systemClock,
      pool: { end },
      server,
      timeoutMs: 100,
    });

    expect(result).toEqual({ forced: false });
    expect(server.listening).toBe(false);
    expect(end).toHaveBeenCalledOnce();
  });

  it('returns a forced result when pool shutdown exceeds the shared deadline', async () => {
    const server = createServer();
    servers.add(server);

    const startedAt = Date.now();
    const result = await shutdownInfrastructure({
      clock: systemClock,
      pool: { end: () => new Promise(() => undefined) },
      server,
      timeoutMs: 10,
    });

    expect(result).toEqual({ forced: true });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
