import type { TraceReport } from './analyze.js';
import type { Distribution } from './statistics.js';

// Deterministic Markdown for the D10 trace reports. No clock, no host, no database-generated value: the same
// fixtures and the same algorithm give the same text, which lets a test compare the committed report with a fresh one.

function number(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? '-' : value.toFixed(digits);
}

function metres(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '-' : `${value.toFixed(digits)} m`;
}

function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '-' : `${value.toFixed(digits)} %`;
}

function describeDistribution(value: Distribution | null, unit: string, digits = 2): string {
  if (value === null) {
    return '-';
  }
  return `n=${String(value.count)}, min ${value.min.toFixed(digits)}, median ${value.median.toFixed(digits)}, p95 ${value.p95.toFixed(digits)}, max ${value.max.toFixed(digits)} ${unit}`;
}

export function renderTraceReport(report: TraceReport): string {
  const { characteristics: source, display, distance, edges } = report;
  const lines: string[] = [`### ${report.name}`, ''];
  lines.push(`Scenario \`${report.scenario}\`, source \`${report.sourceKind}\`, algorithm \`${report.algorithmVersion}\`, fixture sha256 \`${report.contentSha256.slice(0, 16)}\`.`, '');

  lines.push('**Source characteristics**', '');
  lines.push(`- Points: ${String(source.pointCount)}; duration ${number(source.durationS, 1)} s`);
  lines.push(`- Sample interval: ${describeDistribution(source.intervalS, 's')}`);
  lines.push(`- Gaps over 10 s (the evaluator's limit): ${String(source.gapCount)}${source.maxGapS === null ? '' : `; longest interval ${number(source.maxGapS, 2)} s`}`);
  if (report.replay.accuracyAssumed) {
    lines.push(`- Accuracy: assumed ${number(report.replay.assumedAccuracyM, 0)} m for every point (the fixture has none), so no accuracy statistic or accuracy rejection is meaningful`);
  } else {
    lines.push(`- Reported accuracy: ${describeDistribution(source.accuracyM, 'm', 1)}; over 10 m: ${String(source.accuracyOver10mCount)}, over 30 m: ${String(source.accuracyOver30mCount)}`);
  }
  lines.push('');

  lines.push('**Edge evaluation (production `evaluate_track_edge`)**', '');
  lines.push(`- Edges: ${String(edges.edgeCount)}; accepted ${String(edges.acceptedCount)}; rejected ${String(edges.rejectedCount)} (${percent(edges.rejectedPercent)})`);
  const reasons = Object.entries(edges.rejectionReasons);
  lines.push(`- Rejection reasons: ${reasons.length === 0 ? 'none' : reasons.map(([reason, count]) => `${reason} ${String(count)}`).join(', ')}`);
  lines.push(`- Accepted speed: ${describeDistribution(edges.acceptedSpeedMps, 'm/s')}`);
  lines.push(`- Rejected speed: ${describeDistribution(edges.rejectedSpeedMps, 'm/s')}`);
  lines.push(`- Maximum observed speed: ${number(edges.maxSpeedMps, 2)} m/s`);
  lines.push('');

  lines.push('**Distance**', '');
  lines.push(`- Raw observed polyline distance (every consecutive fix, rejected edges included): ${metres(distance.rawObservedM)}`);
  lines.push(`- Canonical accepted distance (production summary): ${metres(distance.canonicalM)}`);
  lines.push(`- Difference (canonical - raw): ${metres(distance.differenceM)} (${percent(distance.differencePercent)})`);
  if (distance.referenceM !== null) {
    lines.push(`- Independent reference distance from the fixture: ${metres(distance.referenceM)}; raw ${percent(distance.rawVsReferencePercent)} and canonical ${percent(distance.canonicalVsReferencePercent)} against it`);
  }
  lines.push('- Both are measurements, not ground truth: a device polyline carries its own error.', '');

  lines.push('**Display simplification (production `simplify_display_geometry`)**', '');
  if (display.simplifiedVertexCount === null) {
    lines.push('- No display line: the evaluator accepted no edge.');
  } else {
    lines.push(`- Vertices: ${String(display.acceptedVertexCount)} accepted, ${String(display.simplifiedVertexCount)} displayed (reduction ${percent(display.reductionPercent)}) in ${String(display.acceptedChainCount)} chain(s)`);
    lines.push(`- Maximum deviation of an accepted vertex from the displayed line: ${metres(display.maxDeviationM, 2)} (configured tolerance ${number(display.toleranceM, 0)} m)`);
  }
  lines.push('');

  lines.push('**Objective signals (descriptive; not verdicts on the algorithm)**', '');
  lines.push(`- Isolated excessive-speed edges: ${String(edges.excessiveSpeedRuns.isolated)}; two-edge runs (out-and-back spike signature): ${String(edges.excessiveSpeedRuns.pair)}; longer runs: ${String(edges.excessiveSpeedRuns.longer)}`);
  lines.push(`- Repeated coordinates (consecutive identical fixes): ${String(source.repeatedCoordinateCount)}`);
  lines.push(`- Jitter ratio (full-rate path length / path sampled about every 10 s): ${source.jitterRatio === null ? 'not defined for this trace' : number(source.jitterRatio, 3)}`);
  if (edges.accuracyBuckets !== null) {
    lines.push('', '| Worse endpoint accuracy | Edges | Rejected |', '|---|---|---|');
    for (const bucket of edges.accuracyBuckets) {
      lines.push(`| ${bucket.label} | ${String(bucket.edges)} | ${String(bucket.rejected)} |`);
    }
  }
  lines.push('');

  if (report.consistency.agreesWithProductionSummary) {
    lines.push('Per-edge verdicts agree with the production summary calculation.', '');
  } else {
    lines.push('**The per-edge check DISAGREES with the production summary calculation:**', '');
    for (const mismatch of report.consistency.mismatches) {
      lines.push(`- ${mismatch}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function countBy(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}: ${String(count)}`)
    .join(', ');
}

export function renderAggregateReport(unsorted: readonly TraceReport[]): string {
  const reports = [...unsorted].sort((a, b) => a.name.localeCompare(b.name));
  const real = reports.filter((report) => report.sourceKind === 'real-device-sanitized');
  const lines: string[] = [
    '# D10 - sanitized real-device GPS traces replayed through the v1 evaluator',
    '',
    'Generated by `npm run gps:report` from the fixtures in `apps/api/test/fixtures/gps-traces/`. Do not edit by hand; a test fails when this file is out of date. Method and privacy model: `docs/runbooks/gps-traces.md`.',
    '',
    '## Sample',
    '',
    `Traces analyzed: ${String(reports.length)}${reports.length === 0 ? '' : ` (${countBy(reports.map((report) => report.sourceKind))})`}`,
    '',
    `Real-device traces: ${String(real.length)}`,
    '',
  ];

  if (real.length === 0) {
    lines.push(
      '> Real trace analysis is blocked on collecting/importing device traces. No sanitized real-device trace is committed yet, so nothing in this report is a measurement of a real receiver. D10 stays PARTIAL.',
      '',
    );
  }

  if (reports.length > 0) {
    lines.push(
      `Scenarios: ${countBy(reports.map((report) => report.scenario))}`,
      '',
      `Algorithm version: ${[...new Set(reports.map((report) => report.algorithmVersion))].join(', ')}. The replay anchors every trace at a fixed synthetic location and time, so it does not test other places on the globe.`,
      '',
      '## Per trace',
      '',
      '| Trace | Scenario | Points | Duration (s) | Raw distance (m) | Canonical distance (m) | Canonical vs raw (%) | Rejected edges | Max speed (m/s) | Display vertices | Max display deviation (m) |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const report of reports) {
      lines.push(
        `| ${report.name} | ${report.scenario} | ${String(report.characteristics.pointCount)} | ${number(report.characteristics.durationS, 1)} | ${number(report.distance.rawObservedM, 1)} | ${number(report.distance.canonicalM, 1)} | ${number(report.distance.differencePercent, 1)} | ${String(report.edges.rejectedCount)} of ${String(report.edges.edgeCount)} | ${number(report.edges.maxSpeedMps, 2)} | ${
          report.display.simplifiedVertexCount === null
            ? '-'
            : `${String(report.display.acceptedVertexCount)} to ${String(report.display.simplifiedVertexCount)}`
        } | ${number(report.display.maxDeviationM, 2)} |`,
      );
    }

    const totalEdges = reports.reduce((sum, report) => sum + report.edges.edgeCount, 0);
    const totalRejected = reports.reduce((sum, report) => sum + report.edges.rejectedCount, 0);
    const rejectedPercents = reports.map((report) => report.edges.rejectedPercent);
    const differences = reports.flatMap((report) => (report.distance.differencePercent === null ? [] : [report.distance.differencePercent]));
    const deviations = reports.flatMap((report) => (report.display.maxDeviationM === null ? [] : [report.display.maxDeviationM]));
    const speeds = reports.flatMap((report) => (report.edges.maxSpeedMps === null ? [] : [report.edges.maxSpeedMps]));
    lines.push(
      '',
      '## Aggregate',
      '',
      'Counts are pooled; ratios are shown per trace as ranges. Nothing is blended into a single score, because traces differ in scenario, device and length.',
      '',
      `- Pooled points: ${String(reports.reduce((sum, report) => sum + report.characteristics.pointCount, 0))}; pooled duration ${number(reports.reduce((sum, report) => sum + report.characteristics.durationS, 0), 1)} s`,
      `- Pooled edges: ${String(totalEdges)}, rejected ${String(totalRejected)} (${percent(totalEdges === 0 ? 0 : (totalRejected / totalEdges) * 100)})`,
      `- Rejected-edge share, per-trace range: ${percent(Math.min(...rejectedPercents))} to ${percent(Math.max(...rejectedPercents))}`,
      `- Canonical vs raw distance, per-trace range: ${differences.length === 0 ? '-' : `${percent(Math.min(...differences))} to ${percent(Math.max(...differences))}`}`,
      `- Highest single-edge speed in any trace: ${speeds.length === 0 ? '-' : `${number(Math.max(...speeds), 2)} m/s`} (the evaluator rejects above 12 m/s)`,
      `- Maximum display deviation in any trace: ${metres(deviations.length === 0 ? null : Math.max(...deviations), 2)} (tolerance 5 m)`,
      '',
      '## Detail',
      '',
    );
    for (const report of reports) {
      lines.push(renderTraceReport(report));
    }
  }

  lines.push('## What this does and does not show', '');
  if (reports.length > 0) {
    lines.push(
      `It shows what the current v1 implementation does with ${String(reports.length)} sanitized trace(s): which edges it rejects and why, how its canonical distance relates to the raw polyline, and how far the 5 m display line stays from the accepted fixes.`,
      '',
    );
  }
  lines.push(
    'It does not establish that the 12 m/s rule, the 30 m accuracy cutoff or the 10 s gap limit are right or wrong, that smoothing is or is not needed, or that v1 is acceptable across devices, placements and terrain. A handful of traces from one device cannot show that. A device polyline is not ground truth, so a difference between two distances is not an error of either. Treat every number here as a sample, state the sample size when quoting it, and collect more traces before deciding on an algorithm v2.',
    '',
  );
  return lines.join('\n');
}
