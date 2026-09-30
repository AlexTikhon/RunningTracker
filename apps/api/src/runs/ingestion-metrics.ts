import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import type { ApiMetrics } from '../observability/api-metrics.js';

/**
 * Times one point-batch transaction (checkout through COMMIT) and counts the
 * acknowledged points. Rejection codes are the application's own bounded
 * vocabulary; unexpected errors are only counted, never labelled.
 */
export async function measureIngestion<Result extends { duplicateCount: number; insertedCount: number }>(
  metrics: ApiMetrics['ingestion'],
  clock: Pick<Clock, 'monotonicNow'>,
  operation: () => Promise<Result>,
): Promise<Result> {
  const startedAt = clock.monotonicNow();
  const elapsedSeconds = (): number => Math.max(0, (clock.monotonicNow() - startedAt) / 1_000);
  try {
    const result = await operation();
    metrics.commitSeconds.observe({ outcome: 'ok' }, elapsedSeconds());
    metrics.points.inc({ kind: 'inserted' }, result.insertedCount);
    metrics.points.inc({ kind: 'duplicate' }, result.duplicateCount);
    return result;
  } catch (error) {
    if (error instanceof ApiError) {
      metrics.commitSeconds.observe({ outcome: 'rejected' }, elapsedSeconds());
      metrics.rejections.inc({ code: error.code });
    } else {
      metrics.commitSeconds.observe({ outcome: 'error' }, elapsedSeconds());
    }
    throw error;
  }
}
