import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApiMetrics } from './api-metrics.js';
import { createMetricsServer } from './metrics-server.js';
import { observePool, registerProcessMetrics } from './runtime-metrics.js';

interface FakePool {
  connect: (...args: unknown[]) => Promise<{ id: number }> | void;
  idleCount: number;
  totalCount: number;
  waitingCount: number;
}

function fakePool(behavior: () => Promise<{ id: number }>): FakePool {
  return {
    connect: (...args: unknown[]) => {
      if (args.length > 0) {
        (args[0] as (error: Error | undefined, client: { id: number }) => void)(undefined, { id: 0 });
        return undefined;
      }
      return behavior();
    },
    idleCount: 1,
    totalCount: 4,
    waitingCount: 2,
  };
}

function ticker(stepMs: number): { monotonicNow: () => number } {
  let now = 0;
  return { monotonicNow: () => (now += stepMs) };
}

describe('P11.1 pool metrics', () => {
  it('times checkout waits (including failures) and exports live pool state at render time', async () => {
    const metrics = createApiMetrics();
    const pool = fakePool(() => Promise.resolve({ id: 7 }));
    observePool(pool as never, { clock: ticker(300), metrics, name: 'runtime' });

    await expect(pool.connect()).resolves.toEqual({ id: 7 });
    pool.connect = fakePool(() => Promise.reject(new Error('timeout secret'))).connect;
    observePool(pool as never, { clock: ticker(2_000), metrics, name: 'runtime' });
    await expect(pool.connect()).rejects.toThrow('timeout secret');

    const output = metrics.registry.render();
    expect(output).toContain('db_pool_acquire_seconds_count{pool="runtime"} 2');
    expect(output).toContain('db_pool_acquire_seconds_bucket{pool="runtime",le="0.5"} 1');
    expect(output).toContain('db_pool_connections{pool="runtime",state="total"} 4');
    expect(output).toContain('db_pool_connections{pool="runtime",state="idle"} 1');
    expect(output).toContain('db_pool_connections{pool="runtime",state="waiting"} 2');
    expect(output).not.toContain('secret');

    pool.waitingCount = 9;
    expect(metrics.registry.render()).toContain('db_pool_connections{pool="runtime",state="waiting"} 9');
  });

  it('leaves the callback form of connect untouched', () => {
    const metrics = createApiMetrics();
    const pool = fakePool(() => Promise.resolve({ id: 1 }));
    observePool(pool as never, { clock: ticker(1), metrics, name: 'maintenance' });

    let seen: { id: number } | undefined;
    void pool.connect((_error: unknown, client: { id: number }) => {
      seen = client;
    });

    expect(seen).toEqual({ id: 0 });
    expect(metrics.registry.render()).not.toContain('db_pool_acquire_seconds_count');
  });
});

describe('P11.1 process metrics', () => {
  it('exports memory, event-loop, and uptime gauges', () => {
    const metrics = createApiMetrics();
    registerProcessMetrics(metrics.registry);

    const output = metrics.registry.render();
    expect(output).toMatch(/^process_resident_memory_bytes [1-9]\d*$/mu);
    expect(output).toMatch(/^nodejs_heap_used_bytes [1-9]\d*$/mu);
    expect(output).toMatch(/^nodejs_eventloop_delay_p99_seconds \d/mu);
    expect(output).toMatch(/^process_uptime_seconds [\d.]+$/mu);
  });
});

describe('P11.1 metrics endpoint', () => {
  it('serves only GET /metrics as text and nothing else', async () => {
    const metrics = createApiMetrics();
    metrics.http.inFlight.set({}, 3);
    const server = createMetricsServer(metrics.registry);

    const ok = await request(server).get('/metrics').expect(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/u);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.text).toContain('http_requests_in_flight 3');

    await request(server).get('/metrics?x=1').expect(200);
    await request(server).get('/').expect(404);
    await request(server).get('/api/health/ready').expect(404);
    await request(server).post('/metrics').expect(405);
    await request(server).delete('/metrics').expect(405);
  });
});
