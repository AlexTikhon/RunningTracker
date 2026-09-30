import { describe, expect, it } from 'vitest';

import { parsePrometheusText, selectSeries } from './load-metrics-scrape.js';

const exposition = [
  '# HELP point_ingest_points_total Points by kind.',
  '# TYPE point_ingest_points_total counter',
  'point_ingest_points_total{kind="inserted"} 4',
  'point_ingest_points_total{kind="duplicate"} 1',
  '# TYPE process_resident_memory_bytes gauge',
  'process_resident_memory_bytes 123456',
  '# TYPE http_request_duration_seconds histogram',
  'http_request_duration_seconds_bucket{method="GET",route="/api/x\\"y",le="0.5"} 3',
  'http_request_duration_seconds_bucket{method="GET",route="/api/x\\"y",le="+Inf"} 5',
  'http_request_duration_seconds_sum{method="GET",route="/api/x\\"y"} 1.5',
  'http_request_duration_seconds_count{method="GET",route="/api/x\\"y"} 5',
  'archive_tile_cache_bytes NaN',
  '',
].join('\n');

describe('parsePrometheusText', () => {
  it('reads names, escaped labels, and numeric values and skips comments', () => {
    const series = parsePrometheusText(exposition);
    expect(series).toContainEqual({
      labels: { kind: 'inserted' },
      name: 'point_ingest_points_total',
      value: 4,
    });
    expect(series).toContainEqual({
      labels: {},
      name: 'process_resident_memory_bytes',
      value: 123_456,
    });
    expect(series).toContainEqual({
      labels: { le: '+Inf', method: 'GET', route: '/api/x"y' },
      name: 'http_request_duration_seconds_bucket',
      value: 5,
    });
    expect(series.some((entry) => entry.name.startsWith('#'))).toBe(false);
  });

  it('keeps non-finite values out of the numeric result', () => {
    const series = parsePrometheusText(exposition);
    expect(series.find((entry) => entry.name === 'archive_tile_cache_bytes')).toBeUndefined();
  });

  it('rejects a line it cannot understand instead of guessing', () => {
    expect(() => parsePrometheusText('not a valid line at all')).toThrow();
  });
});

describe('selectSeries', () => {
  it('keeps only the named metric families, including histogram suffixes', () => {
    const selected = selectSeries(parsePrometheusText(exposition), [
      'http_request_duration_seconds',
      'process_resident_memory_bytes',
    ]);
    expect(new Set(selected.map((entry) => entry.name))).toEqual(
      new Set([
        'http_request_duration_seconds_bucket',
        'http_request_duration_seconds_count',
        'http_request_duration_seconds_sum',
        'process_resident_memory_bytes',
      ]),
    );
  });
});
