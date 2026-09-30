import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { FreshLatencySample } from './load-sse.js';
import type { LockSample } from './load-lock-sampler.js';
import type { MetricSeries } from './load-metrics-scrape.js';
import type { SampleSummary } from './load-stats.js';

export const resultSchemaName = 'running-tracker.load-result';
export const resultSchemaVersion = 1;

/** Why a run stopped being valid; see the failure classes in the P11.3 brief. */
export type FailureKind =
  | 'application-rejection'
  | 'load-runner'
  | 'sse'
  | 'timeout'
  | 'transport'
  | 'unexpected-response';

export interface LoadFailure {
  kind: FailureKind;
  message: string;
  /** Scenario phase active when the run became invalid. */
  phase: string;
}

/** All times are milliseconds since the scenario origin on the runner's monotonic clock. */
export type IngestionKind = 'catchup' | 'fresh' | 'retry-exact' | 'retry-overlap' | 'setup';

export interface IngestionSample {
  duplicateCount: number | null;
  endMs: number;
  errorCode: string | null;
  id: number;
  insertedCount: number | null;
  kind: IngestionKind;
  pointCount: number;
  round: number | null;
  runIndex: number;
  startMs: number;
  status: number | null;
  /** Set when the outcome differs from what the deterministic plan predicts. */
  unexpected: boolean;
}

export interface TileSample {
  burst: number;
  bytes: number;
  endMs: number;
  errorCode: string | null;
  outcome: 'ok' | 'revision-changed' | 'shed' | 'unexpected' | 'transport';
  repeatOfEarlier: boolean;
  revision: string;
  startMs: number;
  status: number | null;
  viewerIndex: number;
  zoom: number;
}

export interface RequestSample {
  endMs: number;
  errorCode: string | null;
  name: string;
  startMs: number;
  status: number | null;
}

export interface FreshPointSample {
  ackedMs: number | null;
  /**
   * The first fresh point after an offline backlog is more than ten seconds after its predecessor, so the
   * live state cannot show it until the next point arrives; its latency is kept but not summarized.
   */
  bridge: boolean;
  ingestionId: number;
  measuredMs: number;
  runIndex: number;
  sampleId: number;
  seq: string;
}

export interface ObserverReport {
  closedUnexpectedly: boolean;
  connectedMs: number | null;
  heartbeats: number;
  index: number;
  protocolErrors: number;
  reconnects: number;
  statesReceived: number;
}

export interface SummaryPublicationReport {
  archiveRevisionAfter: string | null;
  archiveRevisionBefore: string | null;
  /** First metadata poll that showed a revision above the one before the finish. */
  archiveRevisionVisibleMs: number | null;
  finishAckedMs: number | null;
  finishStartMs: number | null;
  /** First run read by the owner that carried the published summary. */
  summaryVisibleMs: number | null;
  /** The same tile before and after publication; differing sizes show the new summary reached the map source. */
  tileVerification: {
    afterBytes: number | null;
    beforeBytes: number | null;
    changed: boolean;
    revisionAfter: string | null;
    revisionBefore: string | null;
  } | null;
  timedOut: boolean;
}

export interface MetricsSnapshot {
  atMs: number;
  series: MetricSeries[];
}

export interface LoadRunResult {
  archive: { revisionSamples: { atMs: number; revision: string }[]; window: { from: string; to: string } };
  asOf: string;
  cleanup: { deletedRuns: number; enabled: boolean };
  configuration: Record<string, boolean | number | string>;
  failure: LoadFailure | null;
  finishedAt: string;
  freshLatency: {
    samples: FreshLatencySample[];
    /** Excludes bridge points; the raw samples include them. */
    summaryMs: SampleSummary;
    unresolved: number;
  };
  freshPoints: FreshPointSample[];
  gitCommit: string | null;
  http: {
    ingestion: IngestionSample[];
    lifecycle: RequestSample[];
    polls: RequestSample[];
    tiles: TileSample[];
  };
  ingestionSummaryMs: Record<string, SampleSummary>;
  /** Lock requests that were not yet granted, sampled during the concurrent window; empty when sampling was off. */
  lockSamples: LockSample[];
  metrics: { after: MetricSeries[] | null; before: MetricSeries[] | null; snapshots: MetricsSnapshot[] };
  node: string;
  observers: ObserverReport[];
  phases: { endMs: number | null; name: string; startMs: number }[];
  postgis: string | null;
  postgres: string | null;
  profile: string;
  schema: typeof resultSchemaName;
  schemaVersion: typeof resultSchemaVersion;
  seed: number;
  serverLog: { byEvent: Record<string, number>; errorLines: number; warnLines: number } | null;
  startedAt: string;
  status: 'failed' | 'ok';
  summaryPublication: SummaryPublicationReport;
  target: { database: string; host: string; port: string };
  tileSummaryMs: Record<string, SampleSummary>;
  warnings: string[];
  workload: {
    activeRuns: number;
    catchupRequests: number;
    catchupPoints: number;
    freshPointsSent: number;
    ingestionConcurrency: number;
    observers: number;
    summaryJobs: number;
    tileBursts: number;
    tileRequests: number;
  };
}

const forbiddenKey =
  /^(?:latitude|longitude|coordinates|lat|lon|lng|points|cookie|set-cookie|authorization|token|password)$|csrf|session.?token/iu;
const minimumSecretLength = 8;

function walk(value: unknown, secrets: readonly string[], path: string): void {
  if (typeof value === 'string') {
    for (const secret of secrets) {
      if (value.includes(secret)) {
        throw new Error(`The result would contain a secret value at ${path}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, secrets, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenKey.test(key)) {
        throw new Error(`The result contains a forbidden key (${key}) at ${path}`);
      }
      walk(key, secrets, `${path}.<key>`);
      walk(entry, secrets, `${path}.${key}`);
    }
  }
}

/**
 * Last line of defence before anything reaches disk: no session/CSRF value anywhere in the document, and no
 * key that would carry a coordinate, a cookie, or a token.
 */
export function assertSafeResult(result: unknown, secrets: readonly string[]): void {
  walk(
    result,
    secrets.filter((secret) => secret.length >= minimumSecretLength),
    '$',
  );
}

export function resultFileName(profile: string, startedAt: string): string {
  return `${profile}-${startedAt.replaceAll(/[-:.]/gu, '')}.json`;
}

/** Writes `<dir>/<profile>-<start>.json`, exclusively, after the safety scan. Returns the path. */
export async function writeResultFile<Result extends { profile: string; startedAt: string }>(
  directory: string,
  result: Result,
  secrets: readonly string[],
): Promise<string> {
  assertSafeResult(result, secrets);
  await mkdir(directory, { recursive: true });
  const path = join(directory, resultFileName(result.profile, result.startedAt));
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  return path;
}
