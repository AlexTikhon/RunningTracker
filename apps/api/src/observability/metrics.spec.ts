import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from './metrics.js';

function lines(registry: MetricsRegistry): string[] {
  return registry.render().trimEnd().split('\n');
}

describe('P11.1 metrics registry', () => {
  it('renders counters and gauges in Prometheus text format with HELP/TYPE', () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter({
      help: 'Handled requests.',
      labelNames: ['route', 'status'],
      name: 'http_requests_total',
    });
    const inFlight = registry.gauge({ help: 'Requests in flight.', name: 'http_in_flight' });

    requests.inc({ route: '/api/x', status: '200' });
    requests.inc({ route: '/api/x', status: '200' }, 2);
    requests.inc({ route: '/api/x', status: '500' });
    inFlight.set({}, 4);
    inFlight.dec({});

    expect(lines(registry)).toEqual(
      expect.arrayContaining([
        '# HELP http_requests_total Handled requests.',
        '# TYPE http_requests_total counter',
        'http_requests_total{route="/api/x",status="200"} 3',
        'http_requests_total{route="/api/x",status="500"} 1',
        '# TYPE http_in_flight gauge',
        'http_in_flight 3',
      ]),
    );
  });

  it('renders cumulative histogram buckets, sum, and count', () => {
    const registry = new MetricsRegistry();
    const duration = registry.histogram({
      buckets: [0.1, 0.5, 1],
      help: 'Duration.',
      labelNames: ['route'],
      name: 'request_seconds',
    });

    duration.observe({ route: 'a' }, 0.05);
    duration.observe({ route: 'a' }, 0.1);
    duration.observe({ route: 'a' }, 0.7);
    duration.observe({ route: 'a' }, 5);

    expect(lines(registry)).toEqual(
      expect.arrayContaining([
        '# TYPE request_seconds histogram',
        'request_seconds_bucket{route="a",le="0.1"} 2',
        'request_seconds_bucket{route="a",le="0.5"} 2',
        'request_seconds_bucket{route="a",le="1"} 3',
        'request_seconds_bucket{route="a",le="+Inf"} 4',
        'request_seconds_sum{route="a"} 5.85',
        'request_seconds_count{route="a"} 4',
      ]),
    );
  });

  it('escapes label values so a hostile value cannot forge extra series or lines', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ help: 'x', labelNames: ['route'], name: 'c_total' });

    counter.inc({ route: 'a"\nfake_metric 1\\' });

    const output = registry.render();
    expect(output).toContain('c_total{route="a\\"\\nfake_metric 1\\\\"} 1');
    expect(output.split('\n').filter((line) => line.startsWith('fake_metric'))).toEqual([]);
  });

  it('bounds label cardinality by folding excess series into one overflow series', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({
      help: 'x',
      labelNames: ['code'],
      maxSeries: 2,
      name: 'errors_total',
    });

    counter.inc({ code: 'A' });
    counter.inc({ code: 'B' });
    counter.inc({ code: 'C' });
    counter.inc({ code: 'D' });
    counter.inc({ code: 'A' });

    const output = lines(registry);
    expect(output).toContain('errors_total{code="A"} 2');
    expect(output).toContain('errors_total{code="B"} 1');
    expect(output).toContain('errors_total{code="_overflow"} 2');
    expect(output.filter((line) => line.startsWith('errors_total{'))).toHaveLength(3);
    expect(output).toContain('metrics_series_overflow_total{metric="errors_total"} 2');
  });

  it('ignores non-finite or negative values instead of poisoning a series', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter({ help: 'x', name: 'c_total' });
    const histogram = registry.histogram({ buckets: [1], help: 'x', name: 'h_seconds' });

    counter.inc({}, Number.NaN);
    counter.inc({}, -1);
    counter.inc({}, Number.POSITIVE_INFINITY);
    histogram.observe({}, Number.NaN);
    histogram.observe({}, -0.5);

    const output = lines(registry);
    expect(output).not.toContain('c_total NaN');
    expect(output.some((line) => line.startsWith('h_seconds_count'))).toBe(false);
    expect(output).not.toContain('c_total 0');
  });

  it('rejects invalid names, duplicate registrations, and mismatched label sets', () => {
    const registry = new MetricsRegistry();
    registry.counter({ help: 'x', labelNames: ['a'], name: 'dup_total' });

    expect(() => registry.counter({ help: 'x', name: 'bad-name' })).toThrow(/metric name/u);
    expect(() => registry.counter({ help: 'x', labelNames: ['bad-label'], name: 'ok_total' })).toThrow(
      /label name/u,
    );
    expect(() => registry.counter({ help: 'x', name: 'dup_total' })).toThrow(/already registered/u);
    expect(() =>
      registry.histogram({ buckets: [1, 0.5], help: 'x', name: 'unsorted_seconds' }),
    ).toThrow(/ascending/u);

    const counter = registry.counter({ help: 'x', labelNames: ['a'], name: 'labelled_total' });
    expect(() => counter.inc({ b: '1' })).toThrow(/labels/u);
    expect(() => counter.inc({})).toThrow(/labels/u);
  });

  it('refreshes gauges from collectors on every render and survives a failing collector', () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge({ help: 'x', labelNames: ['state'], name: 'pool_connections' });
    let waiting = 1;
    registry.addCollector(() => gauge.set({ state: 'waiting' }, waiting));
    registry.addCollector(() => {
      throw new Error('collector boom with secret');
    });

    expect(lines(registry)).toContain('pool_connections{state="waiting"} 1');
    waiting = 7;
    const second = registry.render();
    expect(second).toContain('pool_connections{state="waiting"} 7');
    expect(second).toContain('metrics_collector_errors_total 2');
    expect(second).not.toContain('secret');
  });
});
