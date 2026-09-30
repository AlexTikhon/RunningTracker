import { MetricsRegistry } from './metrics.js';

/** Seconds; spans the 500 ms ingestion target up to the 2 s SQL / 30 s stream-poll ceilings. */
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30,
] as const;

/** Uncompressed tile bytes up to the 1 MiB hard limit. */
export const TILE_BYTES_BUCKETS = [
  1_024, 4_096, 16_384, 65_536, 131_072, 262_144, 524_288, 1_048_576,
] as const;

export function createApiMetrics(registry: MetricsRegistry = new MetricsRegistry()) {
  const latency = LATENCY_BUCKETS_SECONDS;
  return {
    archive: {
      cacheBytes: registry.gauge({
        help: 'Bytes held by the archive tile cache.',
        name: 'archive_tile_cache_bytes',
      }),
      cacheEntries: registry.gauge({
        help: 'Archive tiles currently held in the process cache.',
        name: 'archive_tile_cache_entries',
      }),
      generationActive: registry.gauge({
        help: 'Archive tile generations currently running.',
        name: 'archive_tile_generation_active',
      }),
      generationQueueDepth: registry.gauge({
        help: 'Archive tile generations waiting for admission.',
        name: 'archive_tile_generation_queue_depth',
      }),
      generationSeconds: registry.histogram({
        buckets: latency,
        help: 'SQL and encoding time for tiles that were actually generated.',
        name: 'archive_tile_generation_seconds',
      }),
      requests: registry.counter({
        help: 'Archive tile requests by cache result.',
        labelNames: ['result'],
        name: 'archive_tile_requests_total',
      }),
      tileBytes: registry.histogram({
        buckets: TILE_BYTES_BUCKETS,
        help: 'Uncompressed bytes of served archive tiles.',
        name: 'archive_tile_bytes',
      }),
    },
    http: {
      durationSeconds: registry.histogram({
        buckets: latency,
        help: 'Request duration excluding long-lived event streams.',
        labelNames: ['method', 'route'],
        maxSeries: 200,
        name: 'http_request_duration_seconds',
      }),
      inFlight: registry.gauge({
        help: 'HTTP requests currently being handled.',
        name: 'http_requests_in_flight',
      }),
      requests: registry.counter({
        help: 'Completed HTTP requests.',
        labelNames: ['method', 'route', 'status'],
        maxSeries: 400,
        name: 'http_requests_total',
      }),
    },
    ingestion: {
      commitSeconds: registry.histogram({
        buckets: latency,
        help: 'Point-batch transaction time from checkout to COMMIT, excluding request parsing.',
        labelNames: ['outcome'],
        name: 'point_ingest_commit_seconds',
      }),
      points: registry.counter({
        help: 'Points acknowledged, split into newly stored and duplicate retries.',
        labelNames: ['kind'],
        name: 'point_ingest_points_total',
      }),
      rejections: registry.counter({
        help: 'Point batches rejected with an application error code.',
        labelNames: ['code'],
        name: 'point_ingest_rejections_total',
      }),
    },
    live: {
      backpressureCloses: registry.counter({
        help: 'Event streams closed because a client stayed blocked past the timeout.',
        name: 'live_sse_backpressure_closes_total',
      }),
      connections: registry.gauge({
        help: 'Open live event streams.',
        name: 'live_sse_connections',
      }),
      opened: registry.counter({
        help: 'Live event streams accepted (a reconnect is a new stream).',
        name: 'live_sse_streams_opened_total',
      }),
      pollFailures: registry.counter({
        help: 'Subscription state reads that failed during a poll cycle.',
        name: 'live_sse_poll_failures_total',
      }),
      pollSeconds: registry.histogram({
        buckets: latency,
        help: 'Duration of one live reconciliation cycle across all subscriptions.',
        name: 'live_sse_poll_cycle_seconds',
      }),
      rejected: registry.counter({
        help: 'Live stream requests refused by the connection limit.',
        name: 'live_sse_connection_limit_rejections_total',
      }),
    },
    maintenance: {
      cycles: registry.counter({
        help: 'Background job cycles by outcome.',
        labelNames: ['task', 'outcome'],
        name: 'maintenance_cycles_total',
      }),
      durationSeconds: registry.histogram({
        buckets: latency,
        help: 'Background job cycle duration.',
        labelNames: ['task'],
        name: 'maintenance_cycle_duration_seconds',
      }),
      lastSuccessTimestampSeconds: registry.gauge({
        help: 'Unix time of the last successful cycle; alert on its age, not on the value.',
        labelNames: ['task'],
        name: 'maintenance_last_success_timestamp_seconds',
      }),
      rawPurgeBlocked: registry.counter({
        help: 'Raw purge cycles blocked because a current summary was unavailable (retention overrun).',
        name: 'raw_purge_blocked_total',
      }),
    },
    pool: {
      acquireSeconds: registry.histogram({
        buckets: latency,
        help: 'Time spent waiting to check out a pooled connection.',
        labelNames: ['pool'],
        name: 'db_pool_acquire_seconds',
      }),
      connections: registry.gauge({
        help: 'Pooled connections by state.',
        labelNames: ['pool', 'state'],
        name: 'db_pool_connections',
      }),
    },
    registry,
  };
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;
