import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from '../clock.js';
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

interface ScheduledTimer {
  callback: () => void;
  dueAt: number;
  handle: ReturnType<typeof setTimeout>;
}

function createControlledClock(): Clock & { advanceBy(milliseconds: number): void } {
  let monotonicTime = 0;
  let nextHandle = 1;
  const timers = new Map<ReturnType<typeof setTimeout>, ScheduledTimer>();

  return {
    advanceBy(milliseconds) {
      monotonicTime += milliseconds;
      for (const [handle, timer] of [...timers]) {
        if (timer.dueAt <= monotonicTime) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    monotonicNow: () => monotonicTime,
    setTimeout(callback, delayMs) {
      const handle = nextHandle as unknown as ReturnType<typeof setTimeout>;
      nextHandle += 1;
      timers.set(handle, { callback, dueAt: monotonicTime + delayMs, handle });
      return handle;
    },
    utcNow: () => new Date('2026-09-20T00:00:00.000Z'),
  };
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
    const clock = createControlledClock();
    const end = vi.fn(() => new Promise<void>(() => undefined));

    const resultPromise = shutdownInfrastructure({
      clock,
      pool: { end },
      server,
      timeoutMs: 10,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(end).toHaveBeenCalledOnce();
    clock.advanceBy(10);
    const result = await resultPromise;

    expect(result).toEqual({ forced: true });
  });
});
