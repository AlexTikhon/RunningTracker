import { describe, expect, it } from 'vitest';

import type { TraceReport } from './analyze.js';
import { renderAggregateReport, renderTraceReport } from './report-render.js';
import { edgeStatistics, sourceCharacteristics } from './statistics.js';
import type { SanitizedTrace } from './trace-schema.js';

function report(name: string, overrides: Partial<TraceReport> = {}): TraceReport {
  const trace: SanitizedTrace = {
    points: [0, 1, 2, 3, 4].map((index) => ({ accuracyM: 5 + index * 8, elapsedMs: index * 1000, xM: index * 3, yM: 0 })),
    scenario: 'city_run',
    schemaVersion: 1,
    source: 'real-device-sanitized',
  };
  const edges = edgeStatistics(
    [
      { accepted: true, distanceM: 3, durationS: 1, rejectionReason: null },
      { accepted: false, distanceM: 40, durationS: 1, rejectionReason: 'excessive_speed' },
      { accepted: true, distanceM: 3, durationS: 1, rejectionReason: null },
      { accepted: true, distanceM: 3, durationS: 1, rejectionReason: null },
    ],
    trace.points.map((point) => point.accuracyM ?? 0),
  );
  return {
    algorithmVersion: 'v1',
    characteristics: sourceCharacteristics(trace),
    consistency: { agreesWithProductionSummary: true, mismatches: [] },
    contentSha256: 'a'.repeat(64),
    display: {
      acceptedChainCount: 2,
      acceptedLengthM: 9,
      acceptedVertexCount: 5,
      maxDeviationM: 1.234,
      reductionPercent: 40,
      simplifiedLengthM: 9,
      simplifiedVertexCount: 3,
      toleranceM: 5,
    },
    distance: {
      canonicalM: 9,
      canonicalVsReferencePercent: null,
      differenceM: -40,
      differencePercent: -81.63265306122449,
      rawObservedM: 49,
      rawVsReferencePercent: null,
      referenceM: null,
    },
    edges,
    name,
    replay: { accuracyAssumed: false, assumedAccuracyM: null },
    scenario: 'city_run',
    sourceKind: 'real-device-sanitized',
    ...overrides,
  };
}

describe('per-trace report', () => {
  const text = renderTraceReport(report('city_run_01'));

  it('keeps raw observed distance and canonical distance apart and never calls either ground truth', () => {
    expect(text).toContain('Raw observed polyline distance');
    expect(text).toContain('Canonical accepted distance');
    expect(text).toMatch(/not ground truth/iu);
    expect(text).toContain('-81.6 %');
  });

  it('lists the production rejection reasons and the objective signals', () => {
    expect(text).toContain('excessive_speed');
    expect(text).toMatch(/isolated/iu);
    expect(text).toMatch(/jitter/iu);
    expect(text).toMatch(/repeated coordinates/iu);
  });

  it('states the display metric and the tolerance', () => {
    expect(text).toContain('1.23 m');
    expect(text).toContain('5 m');
  });

  it('states when an accuracy had to be assumed', () => {
    const assumed = renderTraceReport(
      report('x', { replay: { accuracyAssumed: true, assumedAccuracyM: 5 } }),
    );
    expect(assumed).toMatch(/accuracy.*assumed.*5 m/iu);
  });

  it('flags a disagreement with the production summary instead of hiding it', () => {
    const bad = renderTraceReport(
      report('x', { consistency: { agreesWithProductionSummary: false, mismatches: ['accepted edges: per-edge 3, production summary 4'] } }),
    );
    expect(bad).toMatch(/DISAGREES/u);
    expect(bad).toContain('accepted edges: per-edge 3, production summary 4');
  });

  it('shows a reference distance only when there is one', () => {
    expect(text).not.toMatch(/reference/iu);
    const withReference = renderTraceReport(
      report('x', {
        distance: {
          canonicalM: 9,
          canonicalVsReferencePercent: 2.5,
          differenceM: -40,
          differencePercent: -81.6,
          rawObservedM: 49,
          rawVsReferencePercent: 3,
          referenceM: 8.8,
        },
      }),
    );
    expect(withReference).toMatch(/independent reference/iu);
    expect(withReference).toContain('8.8 m');
  });
});

describe('aggregate report', () => {
  it('is explicit and honest when there are no traces', () => {
    const text = renderAggregateReport([]);
    expect(text).toMatch(/Traces analyzed: 0/u);
    expect(text).toMatch(/blocked on collecting/iu);
    expect(text).toMatch(/PARTIAL/u);
    expect(text).not.toMatch(/\| city_run/u);
  });

  it('states the sample size and lists every trace in a stable order', () => {
    const text = renderAggregateReport([report('b_trace'), report('a_trace')]);
    expect(text).toMatch(/Traces analyzed: 2/u);
    expect(text.indexOf('a_trace')).toBeLessThan(text.indexOf('b_trace'));
    expect(text).toContain('real-device-sanitized: 2');
  });

  it('pools counts and reports ranges, and does not average percentages across traces', () => {
    const text = renderAggregateReport([report('a'), report('b')]);
    expect(text).toMatch(/Pooled edges: 8, rejected 2 \(25\.0 %\)/u);
    expect(text).toMatch(/per-trace range/iu);
    expect(text).not.toMatch(/average|mean/iu);
  });

  it('separates synthetic traces from real-device ones', () => {
    const text = renderAggregateReport([report('real'), report('synth', { sourceKind: 'synthetic' })]);
    expect(text).toContain('real-device-sanitized: 1');
    expect(text).toContain('synthetic: 1');
    expect(text).toMatch(/Real-device traces: 1/u);
  });

  it('is deterministic and carries no clock', () => {
    const first = renderAggregateReport([report('a')]);
    expect(renderAggregateReport([report('a')])).toBe(first);
    expect(first).not.toMatch(/20\d\d-\d\d-\d\d/u);
  });

  it('says what the data cannot support', () => {
    const text = renderAggregateReport([report('a')]);
    expect(text).toMatch(/does not establish|cannot establish|do not show/iu);
    expect(text).toMatch(/12 m\/s/u);
  });
});
