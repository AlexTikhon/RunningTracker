import { describe, expect, it } from 'vitest';

import { ApiError } from '../http/errors.js';
import { createApiMetrics } from '../observability/api-metrics.js';
import { measureIngestion } from './ingestion-metrics.js';

function setup() {
  const metrics = createApiMetrics();
  let now = 0;
  const clock = { monotonicNow: () => (now += 120) };
  return { clock, metrics };
}

describe('P11.1 ingestion metrics', () => {
  it('records commit latency and inserted/duplicate point counts for an accepted batch', async () => {
    const { clock, metrics } = setup();

    const result = await measureIngestion(metrics.ingestion, clock, () =>
      Promise.resolve({ dataRevision: '5', duplicateCount: 3, insertedCount: 7 }),
    );

    expect(result).toEqual({ dataRevision: '5', duplicateCount: 3, insertedCount: 7 });
    const output = metrics.registry.render();
    expect(output).toContain('point_ingest_commit_seconds_count{outcome="ok"} 1');
    expect(output).toContain('point_ingest_commit_seconds_bucket{outcome="ok",le="0.25"} 1');
    expect(output).toContain('point_ingest_points_total{kind="inserted"} 7');
    expect(output).toContain('point_ingest_points_total{kind="duplicate"} 3');
  });

  it('counts an application rejection by its code and rethrows the same error', async () => {
    const { clock, metrics } = setup();
    const conflict = new ApiError(409, 'POINT_CONFLICT', 'conflict');

    await expect(
      measureIngestion(metrics.ingestion, clock, () => Promise.reject(conflict)),
    ).rejects.toBe(conflict);

    const output = metrics.registry.render();
    expect(output).toContain('point_ingest_commit_seconds_count{outcome="rejected"} 1');
    expect(output).toContain('point_ingest_rejections_total{code="POINT_CONFLICT"} 1');
    expect(output).not.toContain('point_ingest_points_total{');
  });

  it('classifies an unexpected failure as an error without leaking its message or code', async () => {
    const { clock, metrics } = setup();
    const failure = Object.assign(new Error('relation "run_points" secret'), { code: '23505' });

    await expect(measureIngestion(metrics.ingestion, clock, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    const output = metrics.registry.render();
    expect(output).toContain('point_ingest_commit_seconds_count{outcome="error"} 1');
    expect(output).not.toContain('point_ingest_rejections_total{');
    expect(output).not.toMatch(/secret|23505/u);
  });
});
