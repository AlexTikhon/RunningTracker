import { describe, expect, it } from 'vitest';

import type { ExplainRunResult } from './explain-run-cli.js';
import { aggregateLoadRuns, evaluateTargets } from './load-report-data.js';
import { renderReport } from './load-report-render.js';
import type { LoadRunResult } from './load-result.js';

const summary = (executionMs: number, sharedHit: number, scans: string[] = []) => ({
  buffers: { sharedDirtied: 0, sharedHit, sharedRead: 2, sharedWritten: 0, tempRead: 0, tempWritten: 0 },
  executionMs,
  heaviestNodes: [],
  indexScans: [],
  jit: false,
  nodeCount: 3,
  planningBuffers: { sharedHit: 1, sharedRead: 0 },
  planningMs: 1.5,
  sequentialScans: scans.map((relation) => ({ actualRows: 10, loops: 1, relation, rowsRemovedByFilter: 3_640 })),
  sortSpace: [],
  triggers: [],
  wal: { bytes: 0, fullPageImages: 0, records: 0 },
});

const explain = {
  activatedRuns: 10,
  asOf: '2026-09-30T00:00:00.000Z',
  finishedAt: '2026-09-30T09:00:00.000Z',
  gitCommit: 'deadbeef',
  host: { cpuCount: 16, cpuModel: 'Example CPU 3.0 GHz', diskFreeBytes: 500e9, diskTotalBytes: 1_000e9, osRelease: '10.0.26200', platform: 'win32', totalMemoryBytes: 34_359_738_368 },
  node: 'v24.11.1',
  postgis: '3.5.2',
  postgres: 'PostgreSQL 17.5',
  profile: 'explain-stress',
  relations: {
    indexes: [{ accessMethod: 'btree', bytes: 700_000_000, name: 'run_points_pkey', scans: 5, table: 'run_points', tuplesRead: 90 }],
    settings: [{ name: 'shared_buffers', setting: '16384', unit: '8kB' }],
    tables: [
      { autovacuumCount: 1, deadTuples: 0, heapBytes: 424_000_000, indexBytes: 666_000_000, indexScans: 9, lastAutoanalyze: null, lastAutovacuum: null, liveTuples: 3_000_000, name: 'run_points', sequentialScans: 1, toastBytes: 0, totalBytes: 1_090_000_000 },
    ],
  },
  repetitions: 3,
  schema: 'running-tracker.explain-result',
  schemaVersion: 1,
  seed: 42,
  startedAt: '2026-09-30T08:59:00.000Z',
  statements: [
    {
      description: 'Live-track snapshot page', error: null, executedAs: 'running_tracker_runtime',
      executions: [summary(2_568.9, 343_185), summary(2_630.5, 343_185), summary(2_400, 343_185)],
      group: 'live-snapshot', mode: 'read', name: 'live-snapshot/first-page', needs: 'seeded', plan: null,
      response: { bytes: 201_601, elapsedMs: [2_700, 2_650, 2_600], serializeMs: [1.2, 1.1, 1.0] }, role: 'runtime',
    },
    {
      description: 'Archive tile', error: null, executedAs: 'running_tracker_runtime',
      executions: [summary(406, 66_010, ['run_summaries', 'run_summaries', 'run_summaries'])],
      group: 'tile', mode: 'read', name: 'tile/lisbon/z11', needs: 'seeded', plan: null,
      response: { bytes: 67_738, elapsedMs: [410], serializeMs: [] }, role: 'runtime',
    },
    {
      description: 'Broken', error: { code: '57014', errorClass: 'DatabaseError' }, executedAs: null, executions: [],
      group: 'summary', mode: 'rollback', name: 'summary/publish-current-run', needs: 'seeded', plan: null, response: null, role: 'maintenance',
    },
  ],
  target: { database: 'running_tracker_load_test', host: '127.0.0.1', port: '5433' },
} as unknown as ExplainRunResult;

function loadRun(): LoadRunResult {
  return {
    archive: { revisionSamples: [], window: { from: '', to: '' } },
    asOf: '2026-09-30T00:00:00.000Z',
    configuration: { DB_POOL_MAX: 10, RUN_SUMMARY_INTERVAL_MS: 60_000 },
    failure: null,
    freshLatency: { samples: [{ latencyMs: 1_000, sampleId: 1 }], summaryMs: {}, unresolved: 0 },
    freshPoints: [{ bridge: false, sampleId: 1 }],
    gitCommit: 'deadbeef',
    http: { ingestion: [{ endMs: 40, kind: 'fresh', startMs: 0, status: 200, unexpected: false }], lifecycle: [], polls: [], tiles: [{ bytes: 20_000, endMs: 900, outcome: 'ok', startMs: 100, status: 200, zoom: 9 }] },
    lockSamples: [],
    metrics: { after: [], before: [], snapshots: [] },
    node: 'v24.11.1',
    observers: [],
    postgis: '3.5.2',
    postgres: 'PostgreSQL 17.5',
    profile: 'stress',
    seed: 42,
    serverLog: { byEvent: {}, errorLines: 0, warnLines: 0 },
    startedAt: '2026-09-30T09:00:00.000Z',
    status: 'ok',
    summaryPublication: { archiveRevisionVisibleMs: 61_000, finishAckedMs: 1_000, summaryVisibleMs: 61_500, timedOut: false },
    workload: { tileBursts: 4, tileRequests: 1 },
  } as unknown as LoadRunResult;
}

const groups = aggregateLoadRuns([loadRun(), loadRun()]);
const markdown = renderReport({ explain: [explain], groups, targets: evaluateTargets(groups) });

describe('renderReport', () => {
  it('states the provenance a reader needs to reproduce the numbers', () => {
    expect(markdown).toContain('deadbeef');
    expect(markdown).toContain('PostgreSQL 17.5');
    expect(markdown).toContain('PostGIS 3.5.2');
    expect(markdown).toContain('Example CPU 3.0 GHz');
    expect(markdown).toMatch(/32(\.0)? GiB/u);
    expect(markdown).toMatch(/930(\.\d)? GiB|1000 GB|931 GiB/u);
    expect(markdown).toContain('shared_buffers');
    expect(markdown).toContain('DB_POOL_MAX');
  });

  it('lists met, not met, and not confirmed goals in separate sections', () => {
    const met = markdown.indexOf('## Goals met');
    const notMet = markdown.indexOf('## Goals not met');
    const unconfirmed = markdown.indexOf('## Goals not confirmed');

    expect(met).toBeGreaterThan(-1);
    expect(notMet).toBeGreaterThan(met);
    expect(unconfirmed).toBeGreaterThan(notMet);
    expect(markdown.slice(met, notMet)).toContain('ingestion HTTP p95');
    expect(markdown.slice(unconfirmed)).toContain('summary publication');
  });

  it('shows pooled percentiles, run count, and the with-tiles variant per profile', () => {
    expect(markdown).toMatch(/stress/u);
    expect(markdown).toMatch(/2 runs/u);
    expect(markdown).toMatch(/p99/u);
  });

  it('shows one EXPLAIN row per statement with time, buffers, response bytes, and sequential scans', () => {
    expect(markdown).toContain('live-snapshot/first-page');
    expect(markdown).toContain('343185');
    expect(markdown).toContain('201601');
    expect(markdown).toContain('run_summaries ×3');
  });

  it('reports a failed statement by its SQLSTATE instead of hiding it', () => {
    expect(markdown).toContain('summary/publish-current-run');
    expect(markdown).toContain('57014');
  });

  it('reports relation and index sizes in megabytes', () => {
    expect(markdown).toContain('run_points');
    expect(markdown).toMatch(/1090\.0|1,090|1039/u);
    expect(markdown).toContain('run_points_pkey');
  });

  it('is deterministic: rendering twice gives the same text', () => {
    expect(renderReport({ explain: [explain], groups, targets: evaluateTargets(groups) })).toBe(markdown);
  });
});
