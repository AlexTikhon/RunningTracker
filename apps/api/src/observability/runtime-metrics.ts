import { monitorEventLoopDelay } from 'node:perf_hooks';
import process from 'node:process';
import type { Pool } from 'pg';

import type { Clock } from '../clock.js';
import type { ApiMetrics } from './api-metrics.js';
import type { MetricsRegistry } from './metrics.js';

type PoolState = Pick<Pool, 'connect' | 'idleCount' | 'totalCount' | 'waitingCount'>;

/**
 * Times how long callers wait for a connection and exports live pool state at
 * scrape time. The promise form of `connect` is wrapped in place so the pool
 * keeps its identity for shutdown and event handling; the callback form is
 * left alone because nothing in this codebase uses it.
 */
export function observePool(
  pool: PoolState,
  options: { clock: Pick<Clock, 'monotonicNow'>; metrics: ApiMetrics; name: string },
): void {
  const { clock, metrics, name } = options;
  const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;

  (pool as { connect: unknown }).connect = (...args: unknown[]): unknown => {
    if (args.length > 0) {
      return original(...args);
    }
    const startedAt = clock.monotonicNow();
    const record = (): void =>
      metrics.pool.acquireSeconds.observe(
        { pool: name },
        Math.max(0, (clock.monotonicNow() - startedAt) / 1_000),
      );
    return (original() as Promise<unknown>).then(
      (client) => {
        record();
        return client;
      },
      (error: unknown) => {
        record();
        throw error;
      },
    );
  };

  metrics.registry.addCollector(() => {
    metrics.pool.connections.set({ pool: name, state: 'total' }, pool.totalCount);
    metrics.pool.connections.set({ pool: name, state: 'idle' }, pool.idleCount);
    metrics.pool.connections.set({ pool: name, state: 'waiting' }, pool.waitingCount);
  });
}

/** Memory, event-loop delay, and uptime, sampled when the endpoint is scraped. */
export function registerProcessMetrics(registry: MetricsRegistry): { stop(): void } {
  const rss = registry.gauge({
    help: 'Resident set size in bytes.',
    name: 'process_resident_memory_bytes',
  });
  const heapUsed = registry.gauge({
    help: 'V8 heap in use in bytes.',
    name: 'nodejs_heap_used_bytes',
  });
  const loopDelayP99 = registry.gauge({
    help: '99th percentile event-loop delay since the previous scrape.',
    name: 'nodejs_eventloop_delay_p99_seconds',
  });
  const uptime = registry.gauge({ help: 'Process uptime in seconds.', name: 'process_uptime_seconds' });
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  registry.addCollector(() => {
    const memory = process.memoryUsage();
    rss.set({}, memory.rss);
    heapUsed.set({}, memory.heapUsed);
    loopDelayP99.set({}, loopDelay.count > 0 ? loopDelay.percentile(99) / 1e9 : 0);
    loopDelay.reset();
    uptime.set({}, process.uptime());
  });

  return { stop: () => void loopDelay.disable() };
}

/** Archive tile cache and scheduler state, sampled at scrape time. */
export function observeArchiveTiles(
  metrics: ApiMetrics,
  sources: {
    cache: { readonly entryCount: number; readonly totalBytes: number };
    scheduler: { readonly activeCount: number; readonly queueDepth: number };
  },
): void {
  metrics.registry.addCollector(() => {
    metrics.archive.cacheBytes.set({}, sources.cache.totalBytes);
    metrics.archive.cacheEntries.set({}, sources.cache.entryCount);
    metrics.archive.generationActive.set({}, sources.scheduler.activeCount);
    metrics.archive.generationQueueDepth.set({}, sources.scheduler.queueDepth);
  });
}
