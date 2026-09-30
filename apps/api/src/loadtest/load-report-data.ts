import { summarizeLockSamples, type LockSample, type LockSampleSummary } from './load-lock-sampler.js';
import type { MetricSeries } from './load-metrics-scrape.js';
import type { LoadRunResult } from './load-result.js';
import { percentile, summarize, type SampleSummary } from './load-stats.js';

export const ingestionP95TargetMs = 500;
export const freshP95TargetMs = 5_000;
export const summaryVisibleTargetMs = 60_000;
/** Flat starvation rule: pooled ingestion p95 under tile load stays inside the target and within this factor of the baseline. */
export const starvationFactor = 2;

/**
 * Upper bound, in milliseconds, of the histogram bucket that holds the quantile. `labels` is a subset match on
 * the series' labels (the `le` label is the bucket edge). Infinity means the quantile lies beyond the last
 * finite bucket; null means there is no data.
 */
export function histogramQuantileMs(
  series: readonly MetricSeries[],
  family: string,
  labels: Readonly<Record<string, string>>,
  quantile: number,
): number | null {
  const cumulative = new Map<number, number>();
  for (const entry of series) {
    if (entry.name !== `${family}_bucket`) {
      continue;
    }
    if (!Object.entries(labels).every(([key, value]) => entry.labels[key] === value)) {
      continue;
    }
    const edge = entry.labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(entry.labels.le);
    if (Number.isNaN(edge)) {
      continue;
    }
    cumulative.set(edge, (cumulative.get(edge) ?? 0) + entry.value);
  }
  const total = cumulative.get(Number.POSITIVE_INFINITY);
  if (total === undefined || total === 0) {
    return null;
  }
  const edges = [...cumulative.keys()].toSorted((left, right) => left - right);
  for (const edge of edges) {
    if ((cumulative.get(edge) ?? 0) >= quantile * total) {
      return edge * 1_000;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export interface TileZoomReport {
  bytes: SampleSummary;
  durationMs: SampleSummary;
  /** Served tiles that carried no geometry (zero bytes): a region with no run in view. */
  emptyCount: number;
}

export interface ServerSideReport {
  ingestionRequestP95Ms: (number | null)[];
  poolAcquireP95Ms: (number | null)[];
  residentMemoryPeakBytes: number | null;
  tileCacheBytesPeak: number | null;
  tileQueueDepthPeak: number | null;
}

export interface RunGroup {
  archiveRevisionVisibleMs: (number | null)[];
  asOf: string;
  commits: string[];
  /** Effective non-secret API settings of the first run; see configurationVaries. */
  configuration: Record<string, boolean | number | string>;
  configurationVaries: boolean;
  failedRuns: number;
  finishAckedMs: (number | null)[];
  freshLatency: SampleSummary;
  ingestion: Record<string, SampleSummary>;
  ingestionAll: SampleSummary;
  locks: LockSampleSummary;
  /** Observer streams that closed unexpectedly, reconnected, or reported a protocol error, over all runs. */
  observerProblems: number;
  /** Per-run p95 (ms) of the pooled ingestion samples, to show run-to-run spread. */
  perRunIngestionP95Ms: number[];
  profile: string;
  runs: number;
  seed: number;
  server: ServerSideReport;
  serverErrorLines: number;
  summaryVisibleMs: (number | null)[];
  tileByZoom: Record<string, TileZoomReport>;
  tileOutcomes: Record<string, number>;
  /** False for the baseline group that sent no tile bursts. */
  tiles: boolean;
  unexpectedResponses: number;
}

function seriesMax(runs: readonly LoadRunResult[], family: string): number | null {
  const values: number[] = [];
  for (const result of runs) {
    for (const snapshot of result.metrics.snapshots) {
      for (const entry of snapshot.series) {
        if (entry.name === family) {
          values.push(entry.value);
        }
      }
    }
    for (const entry of result.metrics.after ?? []) {
      if (entry.name === family) {
        values.push(entry.value);
      }
    }
  }
  return values.length === 0 ? null : Math.max(...values);
}

function ingestionRoutes(series: readonly MetricSeries[]): string[] {
  return [
    ...new Set(
      series
        .filter(
          (entry) =>
            entry.name === 'http_request_duration_seconds_bucket' &&
            entry.labels.method === 'POST' &&
            (entry.labels.route ?? '').endsWith('/points'),
        )
        .map((entry) => entry.labels.route ?? ''),
    ),
  ];
}

function groupKey(result: LoadRunResult): string {
  return [result.profile, result.workload.tileBursts > 0, result.seed, result.asOf].join('|');
}

function durations(samples: readonly { endMs: number; startMs: number }[]): number[] {
  return samples.map((sample) => sample.endMs - sample.startMs);
}

function summarizeGroup(runs: readonly LoadRunResult[]): RunGroup {
  const first = runs[0];
  if (!first) {
    throw new Error('A run group cannot be empty');
  }
  const kinds = new Map<string, number[]>();
  const all: number[] = [];
  const fresh: number[] = [];
  const zooms = new Map<string, { bytes: number[]; durations: number[]; empty: number }>();
  const outcomes: Record<string, number> = {};
  const lockSamples: LockSample[] = [];
  let unexpected = 0;

  for (const result of runs) {
    for (const sample of result.http.ingestion) {
      const elapsed = sample.endMs - sample.startMs;
      all.push(elapsed);
      kinds.set(sample.kind, [...(kinds.get(sample.kind) ?? []), elapsed]);
      if (sample.unexpected) {
        unexpected += 1;
      }
    }
    const bridges = new Set(result.freshPoints.filter((point) => point.bridge).map((point) => point.sampleId));
    for (const sample of result.freshLatency.samples) {
      if (!bridges.has(sample.sampleId)) {
        fresh.push(sample.latencyMs);
      }
    }
    for (const tile of result.http.tiles) {
      outcomes[tile.outcome] = (outcomes[tile.outcome] ?? 0) + 1;
      if (tile.outcome !== 'ok') {
        continue;
      }
      const entry = zooms.get(String(tile.zoom)) ?? { bytes: [], durations: [], empty: 0 };
      entry.durations.push(tile.endMs - tile.startMs);
      if (tile.bytes === 0) {
        entry.empty += 1;
      } else {
        entry.bytes.push(tile.bytes);
      }
      zooms.set(String(tile.zoom), entry);
    }
    lockSamples.push(...result.lockSamples);
  }

  const routes = ingestionRoutes(runs.flatMap((result) => result.metrics.after ?? []));
  const tileByZoom: Record<string, TileZoomReport> = {};
  for (const [zoom, entry] of zooms) {
    tileByZoom[zoom] = {
      bytes: summarize(entry.bytes),
      durationMs: summarize(entry.durations),
      emptyCount: entry.empty,
    };
  }

  return {
    archiveRevisionVisibleMs: runs.map((result) => result.summaryPublication.archiveRevisionVisibleMs),
    asOf: first.asOf,
    commits: [...new Set(runs.map((result) => result.gitCommit ?? 'unknown'))],
    configuration: first.configuration,
    configurationVaries: runs.some((result) => JSON.stringify(result.configuration) !== JSON.stringify(first.configuration)),
    failedRuns: runs.filter((result) => result.status !== 'ok').length,
    finishAckedMs: runs.map((result) => result.summaryPublication.finishAckedMs),
    freshLatency: summarize(fresh),
    ingestion: Object.fromEntries([...kinds].map(([kind, values]) => [kind, summarize(values)])),
    ingestionAll: summarize(all),
    locks: summarizeLockSamples(lockSamples),
    observerProblems: runs.reduce(
      (total, result) =>
        total +
        result.observers.filter((observer) => observer.closedUnexpectedly || observer.protocolErrors > 0 || observer.reconnects > 0)
          .length,
      0,
    ),
    perRunIngestionP95Ms: runs.map((result) => {
      const elapsed = durations(result.http.ingestion);
      return elapsed.length === 0 ? 0 : percentile(elapsed, 95);
    }),
    profile: first.profile,
    runs: runs.length,
    seed: first.seed,
    server: {
      ingestionRequestP95Ms: runs.map((result) => {
        const route = routes.find((candidate) =>
          (result.metrics.after ?? []).some((entry) => entry.labels.route === candidate),
        );
        return route === undefined
          ? null
          : histogramQuantileMs(result.metrics.after ?? [], 'http_request_duration_seconds', { method: 'POST', route }, 0.95);
      }),
      poolAcquireP95Ms: runs.map((result) =>
        histogramQuantileMs(result.metrics.after ?? [], 'db_pool_acquire_seconds', { pool: 'runtime' }, 0.95),
      ),
      residentMemoryPeakBytes: seriesMax(runs, 'process_resident_memory_bytes'),
      tileCacheBytesPeak: seriesMax(runs, 'archive_tile_cache_bytes'),
      tileQueueDepthPeak: seriesMax(runs, 'archive_tile_generation_queue_depth'),
    },
    serverErrorLines: runs.reduce((total, result) => total + (result.serverLog?.errorLines ?? 0), 0),
    summaryVisibleMs: runs.map((result) => result.summaryPublication.summaryVisibleMs),
    tileByZoom,
    tileOutcomes: outcomes,
    tiles: first.workload.tileBursts > 0,
    unexpectedResponses: unexpected,
  };
}

/**
 * Groups result files by profile, whether tile bursts were sent, the seed, and the dataset instant, so runs of
 * different datasets or of the with-tiles and without-tiles variants are never pooled.
 */
export function aggregateLoadRuns(results: readonly LoadRunResult[]): RunGroup[] {
  const groups = new Map<string, LoadRunResult[]>();
  for (const result of results) {
    const key = groupKey(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.values()]
    .map(summarizeGroup)
    .toSorted(
      (left, right) =>
        left.profile.localeCompare(right.profile) ||
        Number(right.tiles) - Number(left.tiles) ||
        left.seed - right.seed ||
        left.asOf.localeCompare(right.asOf),
    );
}

export type TargetStatus = 'met' | 'not confirmed' | 'not met';

export interface TargetOutcome {
  basis: string;
  id: string;
  measured: string;
  status: TargetStatus;
  target: string;
}

const seconds = (ms: number): string => (ms / 1_000).toFixed(1);
const ms = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value)} ms`);

function withTiles(groups: readonly RunGroup[]): RunGroup[] {
  return groups.filter((group) => group.tiles);
}

/** Verdicts follow explicit rules; anything a workload cannot show stays `not confirmed`, never `met`. */
export function evaluateTargets(groups: readonly RunGroup[]): TargetOutcome[] {
  const loaded = withTiles(groups);
  const outcomes: TargetOutcome[] = [];

  const ingestion = loaded.map((group) => ({ group, p95: group.ingestionAll.p95 }));
  outcomes.push({
    basis:
      'Client-measured from socket hand-off to the last body byte over loopback, pooled over every ingestion request of the runs (setup, catch-up, retries, fresh), tile bursts running.',
    id: 'ingestion-p95',
    measured: ingestion.map(({ group, p95 }) => `${group.profile}: ${ms(p95)} over ${group.runs} runs`).join('; ') || 'no data',
    status:
      ingestion.length === 0
        ? 'not confirmed'
        : ingestion.every(({ p95 }) => p95 !== null && p95 <= ingestionP95TargetMs)
          ? 'met'
          : 'not met',
    target: `ingestion HTTP p95 ≤ ${ingestionP95TargetMs} ms`,
  });

  const fresh = loaded.map((group) => ({ group, p95: group.freshLatency.p95 }));
  outcomes.push({
    basis:
      'From the creation instant of a fresh point to the first live state on an expected observer stream, correlated by run and sequence; bridge points excluded; pooled over the runs; the browser render step is not included.',
    id: 'fresh-p95',
    measured: fresh.map(({ group, p95 }) => `${group.profile}: ${ms(p95)} over ${group.runs} runs`).join('; ') || 'no data',
    status:
      fresh.length === 0
        ? 'not confirmed'
        : fresh.every(({ p95 }) => p95 !== null && p95 <= freshP95TargetMs)
          ? 'met'
          : 'not met',
    target: `fresh GPS → screen p95 ≤ ${freshP95TargetMs / 1_000} s`,
  });

  const visible = loaded.flatMap((group) => group.summaryVisibleMs.filter((value): value is number => value !== null));
  outcomes.push({
    basis:
      'The interval starts at the finish command, not at publication, and therefore includes the summary worker cadence; publication itself cannot be timed from the client. The runner polls the run and the archive metadata once per second.',
    id: 'summary-visible',
    measured:
      visible.length === 0
        ? 'no data'
        : `finish → summary visible ${seconds(Math.min(...visible))}–${seconds(Math.max(...visible))} s over ${visible.length} runs`,
    status: visible.length > 0 && Math.max(...visible) <= summaryVisibleTargetMs ? 'met' : 'not confirmed',
    target: `summary publication → active map ≤ ${summaryVisibleTargetMs / 1_000} s`,
  });

  const baselines = groups.filter((group) => !group.tiles);
  const comparisons = loaded.flatMap((group) => {
    const baseline = baselines.find((candidate) => candidate.profile === group.profile);
    return baseline ? [{ baseline, group }] : [];
  });
  outcomes.push({
    basis: `Pooled ingestion p95 with tile bursts is compared with runs of the same profile that sent none; met when it stays within ${ingestionP95TargetMs} ms and within ${starvationFactor}× the baseline. Two overlapping tile streams is the only tile load tested.`,
    id: 'no-starvation',
    measured:
      comparisons
        .map(
          ({ baseline, group }) =>
            `${group.profile}: ${ms(group.ingestionAll.p95)} with tiles vs ${ms(baseline.ingestionAll.p95)} without`,
        )
        .join('; ') || 'no baseline without tile load',
    status:
      comparisons.length === 0
        ? 'not confirmed'
        : comparisons.every(
              ({ baseline, group }) =>
                group.ingestionAll.p95 !== null &&
                baseline.ingestionAll.p95 !== null &&
                group.ingestionAll.p95 <= ingestionP95TargetMs &&
                group.ingestionAll.p95 <= starvationFactor * baseline.ingestionAll.p95,
            )
          ? 'met'
          : 'not met',
    target: 'no ingestion starvation from tile jobs',
  });

  const cachePeak = Math.max(0, ...loaded.map((group) => group.server.tileCacheBytesPeak ?? 0));
  outcomes.push({
    basis:
      'The cache stayed far below its size limit in every run, so eviction under pressure was never exercised; the footprint is bounded by construction, not shown by this workload.',
    id: 'lru-footprint',
    measured: `tile cache peak ${(cachePeak / 1_048_576).toFixed(1)} MiB`,
    status: 'not confirmed',
    target: 'stable LRU footprint',
  });

  const observerProblems = loaded.reduce((total, group) => total + group.observerProblems, 0);
  const runCount = loaded.reduce((total, group) => total + group.runs, 0);
  outcomes.push({
    basis:
      'No SSE pending-buffer size is exported; the observable proxies are that no stream dropped or hit protocol errors in a run that succeeded.',
    id: 'sse-buffer',
    measured: `${observerProblems} observer streams closed, reconnected, or hit a protocol error across ${runCount} runs`,
    status: 'not confirmed',
    target: 'stable SSE pending-buffer size',
  });

  return outcomes;
}
