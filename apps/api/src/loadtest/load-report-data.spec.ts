import { describe, expect, it } from 'vitest';

import { aggregateLoadRuns, evaluateTargets, histogramQuantileMs } from './load-report-data.js';
import type { LoadRunResult } from './load-result.js';

function ingestion(kind: string, startMs: number, durationMs: number) {
  return { endMs: startMs + durationMs, kind, startMs, status: 200, unexpected: false };
}

function tile(zoom: number, durationMs: number, bytes: number, outcome = 'ok') {
  return { bytes, endMs: 100 + durationMs, outcome, startMs: 100, status: 200, zoom };
}

function run(overrides: Record<string, unknown> = {}): LoadRunResult {
  return {
    archive: { revisionSamples: [], window: { from: '', to: '' } },
    asOf: '2026-09-30T00:00:00.000Z',
    failure: null,
    freshLatency: {
      samples: [
        { latencyMs: 9_000, sampleId: 0 },
        { latencyMs: 1_000, sampleId: 1 },
        { latencyMs: 3_000, sampleId: 2 },
      ],
      summaryMs: {},
      unresolved: 0,
    },
    freshPoints: [
      { bridge: true, sampleId: 0 },
      { bridge: false, sampleId: 1 },
      { bridge: false, sampleId: 2 },
    ],
    gitCommit: 'abc123',
    http: {
      ingestion: [ingestion('fresh', 0, 10), ingestion('fresh', 0, 20), ingestion('catchup', 0, 100), ingestion('setup', 0, 30)],
      lifecycle: [],
      polls: [],
      tiles: [tile(9, 400, 0), tile(9, 600, 5_000), tile(11, 200, 100), tile(13, 50, 0, 'shed')],
    },
    lockSamples: [
      { atMs: 0, waits: [] },
      { atMs: 250, waits: [{ application: 'running-tracker-maintenance', locktype: 'transactionid', waiting: 1 }] },
    ],
    metrics: {
      after: [
        { labels: { le: '0.05', method: 'POST', route: '/api/orgs/:orgId/runs/:runId/points' }, name: 'http_request_duration_seconds_bucket', value: 90 },
        { labels: { le: '0.25', method: 'POST', route: '/api/orgs/:orgId/runs/:runId/points' }, name: 'http_request_duration_seconds_bucket', value: 99 },
        { labels: { le: '+Inf', method: 'POST', route: '/api/orgs/:orgId/runs/:runId/points' }, name: 'http_request_duration_seconds_bucket', value: 100 },
        { labels: {}, name: 'process_resident_memory_bytes', value: 120_000_000 },
      ],
      before: [],
      snapshots: [
        { atMs: 1, series: [{ labels: {}, name: 'archive_tile_cache_bytes', value: 1_000 }, { labels: {}, name: 'archive_tile_generation_queue_depth', value: 2 }, { labels: {}, name: 'process_resident_memory_bytes', value: 90_000_000 }] },
        { atMs: 2, series: [{ labels: {}, name: 'archive_tile_cache_bytes', value: 4_000 }, { labels: {}, name: 'archive_tile_generation_queue_depth', value: 0 }, { labels: {}, name: 'process_resident_memory_bytes', value: 100_000_000 }] },
      ],
    },
    configuration: { DB_POOL_MAX: 10 },
    node: 'v24',
    observers: Array.from({ length: 2 }, (_, index) => ({ closedUnexpectedly: false, index, protocolErrors: 0, reconnects: 0 })),
    postgis: '3.5',
    postgres: 'PostgreSQL 17.5',
    profile: 'ordinary',
    serverLog: { byEvent: {}, errorLines: 0, warnLines: 0 },
    startedAt: '2026-09-30T09:00:00.000Z',
    status: 'ok',
    summaryPublication: { archiveRevisionVisibleMs: 61_000, finishAckedMs: 1_000, summaryVisibleMs: 61_500, timedOut: false },
    workload: { tileBursts: 4, tileRequests: 4 },
    ...overrides,
  } as unknown as LoadRunResult;
}

describe('histogramQuantileMs', () => {
  const series = run().metrics.after ?? [];

  it('returns the upper bound in milliseconds of the bucket that holds the quantile', () => {
    expect(histogramQuantileMs(series, 'http_request_duration_seconds', { method: 'POST' }, 0.5)).toBe(50);
    expect(histogramQuantileMs(series, 'http_request_duration_seconds', { method: 'POST' }, 0.95)).toBe(250);
  });

  it('is infinite when the quantile falls beyond the last finite bucket and null with no data', () => {
    expect(histogramQuantileMs(series, 'http_request_duration_seconds', { method: 'POST' }, 0.999)).toBe(Number.POSITIVE_INFINITY);
    expect(histogramQuantileMs(series, 'http_request_duration_seconds', { method: 'GET' }, 0.5)).toBeNull();
    expect(histogramQuantileMs([], 'x', {}, 0.5)).toBeNull();
  });
});

describe('aggregateLoadRuns', () => {
  const aggregated = aggregateLoadRuns([run(), run({ startedAt: '2026-09-30T09:05:00.000Z' })]);
  const group = aggregated[0];

  it('groups runs by profile and by whether tile bursts were sent', () => {
    const mixed = aggregateLoadRuns([run(), run({ workload: { tileBursts: 0, tileRequests: 0 } })]);

    expect(mixed.map(({ profile, tiles }) => [profile, tiles])).toEqual([
      ['ordinary', true],
      ['ordinary', false],
    ]);
    expect(group?.runs).toBe(2);
  });

  it('pools every run’s ingestion samples per kind and overall, in milliseconds', () => {
    expect(group?.ingestion.fresh?.count).toBe(4);
    expect(group?.ingestion.fresh?.p50).toBe(10);
    expect(group?.ingestion.fresh?.max).toBe(20);
    expect(group?.ingestionAll.count).toBe(8);
    expect(group?.ingestionAll.max).toBe(100);
  });

  it('leaves the bridge point out of the pooled fresh latency', () => {
    expect(group?.freshLatency.count).toBe(4);
    expect(group?.freshLatency.max).toBe(3_000);
    expect(group?.freshLatency.p50).toBe(1_000);
  });

  it('summarizes tile time per zoom for served tiles only, counting empty tiles and other outcomes separately', () => {
    expect(group?.tileByZoom['9']?.durationMs.count).toBe(4);
    expect(group?.tileByZoom['9']?.emptyCount).toBe(2);
    expect(group?.tileByZoom['9']?.bytes.max).toBe(5_000);
    expect(group?.tileByZoom['13']).toBeUndefined();
    expect(group?.tileOutcomes).toEqual({ ok: 6, shed: 2 });
  });

  it('records each run’s summary timings and counts failures, unexpected responses, and log problems', () => {
    expect(group?.summaryVisibleMs).toEqual([61_500, 61_500]);
    expect(group?.finishAckedMs).toEqual([1_000, 1_000]);
    expect(group?.failedRuns).toBe(0);
    expect(group?.unexpectedResponses).toBe(0);
    expect(group?.serverErrorLines).toBe(0);
  });

  it('carries the API configuration the runs used and flags a group whose runs used different ones', () => {
    expect(group?.configuration).toEqual({ DB_POOL_MAX: 10 });
    expect(group?.configurationVaries).toBe(false);
    const varied = aggregateLoadRuns([run(), run({ configuration: { DB_POOL_MAX: 20 } })]);

    expect(varied[0]?.configurationVaries).toBe(true);
  });

  it('counts observer streams that closed unexpectedly, reconnected, or hit a protocol error', () => {
    expect(group?.observerProblems).toBe(0);
    const troubled = aggregateLoadRuns([
      run({ observers: [{ closedUnexpectedly: false, index: 0, protocolErrors: 0, reconnects: 1 }, { closedUnexpectedly: true, index: 1, protocolErrors: 0, reconnects: 0 }, { closedUnexpectedly: false, index: 2, protocolErrors: 2, reconnects: 0 }, { closedUnexpectedly: false, index: 3, protocolErrors: 0, reconnects: 0 }] }),
    ]);

    expect(troubled[0]?.observerProblems).toBe(3);
  });

  it('pools lock samples and reports which application ever waited', () => {
    expect(group?.locks.sampleCount).toBe(4);
    expect(group?.locks.samplesWithWaiters).toBe(2);
    expect(group?.locks.byApplication['running-tracker-maintenance']?.peakWaiting).toBe(1);
    expect(group?.locks.byApplication['running-tracker-api']).toBeUndefined();
  });

  it('reads server-side ingestion latency bounds, tile cache and queue peaks, and memory from the metrics', () => {
    expect(group?.server.ingestionRequestP95Ms).toEqual([250, 250]);
    expect(group?.server.tileCacheBytesPeak).toBe(4_000);
    expect(group?.server.tileQueueDepthPeak).toBe(2);
    expect(group?.server.residentMemoryPeakBytes).toBe(120_000_000);
  });

  it('never pools runs of different datasets: another seed or dataset instant makes another group', () => {
    const seeds = aggregateLoadRuns([run({ seed: 1 }), run({ seed: 2 })]);
    const instants = aggregateLoadRuns([run(), run({ asOf: '2027-01-01T00:00:00.000Z' })]);

    expect(seeds).toHaveLength(2);
    expect(instants).toHaveLength(2);
  });
});

describe('evaluateTargets', () => {
  const within = aggregateLoadRuns([run(), run()]);

  it('meets the ingestion and live-latency targets when their pooled p95 is within bounds', () => {
    const outcomes = evaluateTargets(within);
    const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));

    expect(byId.get('ingestion-p95')?.status).toBe('met');
    expect(byId.get('fresh-p95')?.status).toBe('met');
  });

  it('does not meet the ingestion target when the pooled p95 exceeds 500 ms', () => {
    const slow = aggregateLoadRuns([
      run({ http: { ingestion: [ingestion('fresh', 0, 900), ingestion('fresh', 0, 950)], lifecycle: [], polls: [], tiles: [] } }),
    ]);

    expect(evaluateTargets(slow).find(({ id }) => id === 'ingestion-p95')?.status).toBe('not met');
  });

  it('does not meet the fresh-latency target above five seconds', () => {
    const slow = aggregateLoadRuns([
      run({
        freshLatency: { samples: [{ latencyMs: 6_000, sampleId: 1 }], summaryMs: {}, unresolved: 0 },
        freshPoints: [{ bridge: false, sampleId: 1 }],
      }),
    ]);

    expect(evaluateTargets(slow).find(({ id }) => id === 'fresh-p95')?.status).toBe('not met');
  });

  it('cannot confirm starvation without a run that had no tile load, and confirms it with one', () => {
    const without = evaluateTargets(within).find(({ id }) => id === 'no-starvation');
    const withBaseline = evaluateTargets(
      aggregateLoadRuns([run(), run({ workload: { tileBursts: 0, tileRequests: 0 } })]),
    ).find(({ id }) => id === 'no-starvation');

    expect(without?.status).toBe('not confirmed');
    expect(withBaseline?.status).toBe('met');
  });

  it('never marks the cache-pressure and SSE-buffer targets as met because the workload cannot show them', () => {
    const outcomes = evaluateTargets(within);

    expect(outcomes.find(({ id }) => id === 'lru-footprint')?.status).toBe('not confirmed');
    expect(outcomes.find(({ id }) => id === 'sse-buffer')?.status).toBe('not confirmed');
  });

  it('reports the summary target from the finish-to-visible interval with the interval definition stated', () => {
    const outcome = evaluateTargets(within).find(({ id }) => id === 'summary-visible');

    expect(outcome?.measured).toMatch(/61\.5/u);
    expect(outcome?.basis).toMatch(/finish/iu);
  });
});
