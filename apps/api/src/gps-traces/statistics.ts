import type { SanitizedTrace } from './trace-schema.js';

// Descriptive statistics for the D10 report. Everything here describes data; nothing here classifies a fix as good
// or bad or changes what the evaluator decides. The thresholds mirror the ones the production evaluator uses
// (a 10 s gap, a 30 m accuracy cutoff) so that a report uses the same words as the algorithm.

export const GAP_THRESHOLD_S = 10;
export const POOR_ACCURACY_M = 30;
export const COARSE_ACCURACY_M = 10;
const JITTER_WINDOW_MS = 10_000;
const MIN_JITTER_DURATION_MS = 30_000;

export interface Distribution {
  readonly count: number;
  readonly max: number;
  readonly median: number;
  readonly min: number;
  readonly p95: number;
}

/** Linear interpolation between closest ranks (the common "type 7" definition) on an ascending list. */
export function percentile(sorted: readonly number[], p: number): number {
  const last = sorted.length - 1;
  const rank = (p / 100) * last;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (rank - lower);
}

export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    max: sorted[sorted.length - 1] as number,
    median: percentile(sorted, 50),
    min: sorted[0] as number,
    p95: percentile(sorted, 95),
  };
}

export interface SourceCharacteristics {
  readonly accuracyM: Distribution | null;
  readonly accuracyOver10mCount: number | null;
  readonly accuracyOver30mCount: number | null;
  readonly durationS: number;
  readonly gapCount: number;
  readonly intervalS: Distribution | null;
  /** Full-rate path length divided by the length of the same track sampled about every 10 s; null if undefined. */
  readonly jitterRatio: number | null;
  readonly maxGapS: number | null;
  readonly planarDistanceM: number;
  readonly pointCount: number;
  readonly repeatedCoordinateCount: number;
}

function jitterRatio(trace: SanitizedTrace): number | null {
  const points = trace.points;
  const last = points[points.length - 1];
  if (last === undefined || last.elapsedMs < MIN_JITTER_DURATION_MS) {
    return null;
  }
  const picked = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[picked[picked.length - 1] as number];
    const point = points[index];
    if (point !== undefined && previous !== undefined && point.elapsedMs - previous.elapsedMs >= JITTER_WINDOW_MS) {
      picked.push(index);
    }
  }
  if (picked.length < 3) {
    return null;
  }
  let full = 0;
  for (let index = 1; index <= (picked[picked.length - 1] as number); index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a !== undefined && b !== undefined) {
      full += Math.hypot(b.xM - a.xM, b.yM - a.yM);
    }
  }
  let coarse = 0;
  for (let index = 1; index < picked.length; index += 1) {
    const a = points[picked[index - 1] as number];
    const b = points[picked[index] as number];
    if (a !== undefined && b !== undefined) {
      coarse += Math.hypot(b.xM - a.xM, b.yM - a.yM);
    }
  }
  return coarse === 0 ? null : full / coarse;
}

export function sourceCharacteristics(trace: SanitizedTrace): SourceCharacteristics {
  const points = trace.points;
  const intervals: number[] = [];
  let planarDistanceM = 0;
  let repeated = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) {
      continue;
    }
    intervals.push((b.elapsedMs - a.elapsedMs) / 1000);
    planarDistanceM += Math.hypot(b.xM - a.xM, b.yM - a.yM);
    if (a.xM === b.xM && a.yM === b.yM) {
      repeated += 1;
    }
  }
  const accuracies = points.flatMap((point) => (point.accuracyM === undefined ? [] : [point.accuracyM]));
  const hasAccuracy = accuracies.length > 0;
  const last = points[points.length - 1];
  return {
    accuracyM: distribution(accuracies),
    accuracyOver10mCount: hasAccuracy ? accuracies.filter((value) => value > COARSE_ACCURACY_M).length : null,
    accuracyOver30mCount: hasAccuracy ? accuracies.filter((value) => value > POOR_ACCURACY_M).length : null,
    durationS: (last?.elapsedMs ?? 0) / 1000,
    gapCount: intervals.filter((interval) => interval > GAP_THRESHOLD_S).length,
    intervalS: distribution(intervals),
    jitterRatio: jitterRatio(trace),
    maxGapS: intervals.length === 0 ? null : Math.max(...intervals),
    planarDistanceM,
    pointCount: points.length,
    repeatedCoordinateCount: repeated,
  };
}

/** One edge as the production evaluator returned it. */
export interface EdgeResult {
  readonly accepted: boolean;
  readonly distanceM: number;
  readonly durationS: number;
  readonly rejectionReason: string | null;
}

export interface AccuracyBucket {
  readonly edges: number;
  readonly label: string;
  readonly rejected: number;
}

export interface EdgeStatistics {
  readonly acceptedCount: number;
  readonly acceptedDistanceM: number;
  readonly acceptedSpeedMps: Distribution | null;
  readonly accuracyBuckets: AccuracyBucket[] | null;
  readonly edgeCount: number;
  readonly excessiveSpeedRuns: { readonly isolated: number; readonly longer: number; readonly pair: number };
  readonly maxSpeedMps: number | null;
  readonly rawDistanceM: number;
  readonly rejectedCount: number;
  readonly rejectedPercent: number;
  readonly rejectedSpeedMps: Distribution | null;
  readonly rejectionReasons: Record<string, number>;
}

const BUCKETS: ReadonlyArray<{ readonly label: string; readonly test: (accuracy: number) => boolean }> = [
  { label: '<= 5 m', test: (accuracy) => accuracy <= 5 },
  { label: '5-10 m', test: (accuracy) => accuracy > 5 && accuracy <= 10 },
  { label: '10-20 m', test: (accuracy) => accuracy > 10 && accuracy <= 20 },
  { label: '20-30 m', test: (accuracy) => accuracy > 20 && accuracy <= 30 },
  { label: '> 30 m', test: (accuracy) => accuracy > 30 },
];

/**
 * Summarizes evaluator verdicts. `accuracies` are per point (edge i joins points i and i + 1); with them the edges
 * are grouped by the worse endpoint accuracy, which shows whether reported accuracy relates to rejection.
 */
export function edgeStatistics(edges: readonly EdgeResult[], accuracies?: readonly number[]): EdgeStatistics {
  const reasons: Record<string, number> = {};
  const acceptedSpeeds: number[] = [];
  const rejectedSpeeds: number[] = [];
  let rawDistanceM = 0;
  let acceptedDistanceM = 0;
  let acceptedCount = 0;
  const runs = { isolated: 0, longer: 0, pair: 0 };
  let runLength = 0;
  const closeRun = () => {
    if (runLength === 1) {
      runs.isolated += 1;
    } else if (runLength === 2) {
      runs.pair += 1;
    } else if (runLength > 2) {
      runs.longer += 1;
    }
    runLength = 0;
  };

  for (const edge of edges) {
    rawDistanceM += edge.distanceM;
    if (edge.accepted) {
      acceptedCount += 1;
      acceptedDistanceM += edge.distanceM;
    } else {
      const reason = edge.rejectionReason ?? 'unspecified';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    if (edge.durationS > 0) {
      (edge.accepted ? acceptedSpeeds : rejectedSpeeds).push(edge.distanceM / edge.durationS);
    }
    if (edge.rejectionReason === 'excessive_speed') {
      runLength += 1;
    } else {
      closeRun();
    }
  }
  closeRun();

  let accuracyBuckets: AccuracyBucket[] | null = null;
  if (accuracies !== undefined) {
    accuracyBuckets = BUCKETS.map((bucket) => ({ edges: 0, label: bucket.label, rejected: 0 }));
    edges.forEach((edge, index) => {
      const worse = Math.max(accuracies[index] ?? 0, accuracies[index + 1] ?? 0);
      const position = BUCKETS.findIndex((bucket) => bucket.test(worse));
      const bucket = accuracyBuckets?.[position];
      if (bucket !== undefined) {
        accuracyBuckets![position] = {
          edges: bucket.edges + 1,
          label: bucket.label,
          rejected: bucket.rejected + (edge.accepted ? 0 : 1),
        };
      }
    });
  }

  const allSpeeds = [...acceptedSpeeds, ...rejectedSpeeds];
  return {
    acceptedCount,
    acceptedDistanceM,
    acceptedSpeedMps: distribution(acceptedSpeeds),
    accuracyBuckets,
    edgeCount: edges.length,
    excessiveSpeedRuns: runs,
    maxSpeedMps: allSpeeds.length === 0 ? null : Math.max(...allSpeeds),
    rawDistanceM,
    rejectedCount: edges.length - acceptedCount,
    rejectedPercent: edges.length === 0 ? 0 : ((edges.length - acceptedCount) / edges.length) * 100,
    rejectedSpeedMps: distribution(rejectedSpeeds),
    rejectionReasons: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b))),
  };
}
