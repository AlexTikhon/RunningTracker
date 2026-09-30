export interface SampleSummary {
  count: number;
  max: number | null;
  mean: number | null;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Nearest-rank percentile (the smallest sample with at least `rank` percent of samples at or below it). */
export function percentile(values: readonly number[], rank: number): number {
  if (values.length === 0) {
    throw new Error('A percentile needs at least one sample');
  }
  if (!Number.isFinite(rank) || rank < 0 || rank > 100) {
    throw new Error('A percentile rank must be within [0, 100]');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(1, Math.ceil((rank / 100) * sorted.length));
  return sorted[position - 1] as number;
}

/** Convenience statistics only; the raw samples stay in the result so P11.4 can verify them. */
export function summarize(values: readonly number[]): SampleSummary {
  if (values.length === 0) {
    return { count: 0, max: null, mean: null, min: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    max: sorted[sorted.length - 1] as number,
    mean: total / sorted.length,
    min: sorted[0] as number,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}
