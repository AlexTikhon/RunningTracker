import type { PlanSummary } from './explain-plan.js';
import type { StatementMeasurement } from './explain-collect.js';
import type { ExplainRunResult } from './explain-run-cli.js';
import type { RunGroup, TargetOutcome } from './load-report-data.js';
import { percentile, type SampleSummary } from './load-stats.js';

export interface ReportSources {
  explainFiles: readonly string[];
  loadFiles: readonly string[];
  since: string | null;
}

export interface ReportInput {
  explain: readonly ExplainRunResult[];
  groups: readonly RunGroup[];
  sources?: ReportSources;
  targets: readonly TargetOutcome[];
}

const f1 = (value: number | null | undefined): string =>
  value === null || value === undefined ? 'n/a' : Number.isFinite(value) ? value.toFixed(1) : '∞';
const f0 = (value: number | null | undefined): string =>
  value === null || value === undefined ? 'n/a' : Number.isFinite(value) ? String(Math.round(value)) : '∞';
const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);
const gib = (bytes: number): string => (bytes / 2 ** 30).toFixed(0);
const mib = (bytes: number | null): string => (bytes === null ? 'n/a' : (bytes / 2 ** 20).toFixed(1));

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function summaryCells(sample: SampleSummary): string[] {
  return [String(sample.count), f0(sample.p50), f0(sample.p95), f0(sample.p99), f0(sample.max)];
}

function median(values: readonly number[]): number | null {
  return values.length === 0 ? null : percentile(values, 50);
}

function scanLabel(plan: PlanSummary | undefined): string {
  if (!plan || plan.sequentialScans.length === 0) {
    return 'none';
  }
  const counts = new Map<string, number>();
  for (const scan of plan.sequentialScans) {
    counts.set(scan.relation, (counts.get(scan.relation) ?? 0) + 1);
  }
  return [...counts].map(([relation, count]) => (count > 1 ? `${relation} ×${count}` : relation)).join(', ');
}

function targetsSection(title: string, intro: string, targets: readonly TargetOutcome[]): string {
  const body =
    targets.length === 0
      ? '_None._'
      : targets.map((item) => `- **${item.target}** — ${item.measured}. ${item.basis}`).join('\n');
  return `## ${title}\n\n${intro}\n\n${body}`;
}

function environmentSection(input: ReportInput): string {
  const commits = [...new Set(input.groups.flatMap((group) => group.commits))];
  const explain = input.explain[0];
  const lines = [
    `- Application commit: ${commits.join(', ') || 'unknown'} (the working tree may contain uncommitted changes; the commit names the base)`,
    explain ? `- Node ${explain.node}; ${explain.postgres}; PostGIS ${explain.postgis}` : '- Database versions: no EXPLAIN result supplied',
  ];
  if (explain) {
    lines.push(
      `- Host: ${explain.host.cpuModel}, ${explain.host.cpuCount} logical CPUs, ${gib(explain.host.totalMemoryBytes)} GiB RAM, ${explain.host.platform} ${explain.host.osRelease}` +
        (explain.host.diskTotalBytes === undefined
          ? ''
          : `, disk ${gib(explain.host.diskTotalBytes)} GiB total / ${gib(explain.host.diskFreeBytes ?? 0)} GiB free`),
      '- The load runner, the API process, and PostgreSQL share this one machine.',
      `- PostgreSQL settings: ${explain.relations.settings.map((setting) => `${setting.name}=${setting.setting}${setting.unit ?? ''}`).join(', ')}`,
    );
  }
  const configuration = input.groups[0]?.configuration;
  if (configuration) {
    const varies = input.groups.some((group) => group.configurationVaries)
      ? ' (differs between runs; see the result files)'
      : '';
    lines.push(
      `- API settings${varies}: ${Object.entries(configuration)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(', ')}`,
    );
  }
  return `## Environment\n\n${lines.join('\n')}`;
}

function sourcesSection(sources: ReportSources): string {
  return `## Sources

- Load results${sources.since ? ` started at or after ${sources.since}` : ""}: ${sources.loadFiles.join(", ")}
- EXPLAIN results (newest per profile): ${sources.explainFiles.join(", ") || "none"}`;
}

function groupSection(group: RunGroup): string {
  const title = `### ${group.profile} — ${group.tiles ? 'with tile bursts' : 'without tile bursts (baseline)'} — ${group.runs} runs`;
  const ingestion = table(
    ['Ingestion request (ms)', 'n', 'p50', 'p95', 'p99', 'max'],
    [
      ...Object.entries(group.ingestion)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([kind, sample]) => [kind, ...summaryCells(sample)]),
      ['all kinds', ...summaryCells(group.ingestionAll)],
    ],
  );
  const zooms = Object.entries(group.tileByZoom).toSorted(([left], [right]) => Number(left) - Number(right));
  const tiles =
    zooms.length === 0
      ? '_No tile bursts were sent._'
      : table(
          ['Tile (ms)', 'n', 'p50', 'p95', 'p99', 'max', 'empty tiles', 'non-empty bytes p50 / max'],
          zooms.map(([zoom, entry]) => [
            `z${zoom}`,
            ...summaryCells(entry.durationMs),
            String(entry.emptyCount),
            `${f0(entry.bytes.p50)} / ${f0(entry.bytes.max)}`,
          ]),
        );
  const facts = [
    `- Fresh point → observer (ms, bridge points excluded): n=${group.freshLatency.count}, p50 ${f0(group.freshLatency.p50)}, p95 ${f0(group.freshLatency.p95)}, p99 ${f0(group.freshLatency.p99)}, max ${f0(group.freshLatency.max)}`,
    `- Finish acknowledged (ms, per run): ${group.finishAckedMs.map(f0).join(', ')}`,
    `- Summary visible to the owner (ms after the run started finishing, per run): ${group.summaryVisibleMs.map(f0).join(', ')}`,
    `- Archive revision visible (ms, per run): ${group.archiveRevisionVisibleMs.map(f0).join(', ')}`,
    `- Failed runs: ${group.failedRuns}; unexpected ingestion responses: ${group.unexpectedResponses}; server error log lines: ${group.serverErrorLines}; observer problems: ${group.observerProblems}`,
    `- Tile outcomes: ${Object.entries(group.tileOutcomes).map(([outcome, count]) => `${outcome} ${count}`).join(', ') || 'none'}`,
    `- Lock waits (sampled every 250 ms, ${group.locks.sampleCount} samples): ${group.locks.samplesWithWaiters} samples with a waiter, peak ${group.locks.peakWaiting}; by application: ${Object.entries(group.locks.byApplication).map(([application, wait]) => `${application} ${wait.samplesWithWaiters} samples (peak ${wait.peakWaiting})`).join('; ') || 'none'}`,
    `- Server-side ingestion request p95 upper bound (ms, per run): ${group.server.ingestionRequestP95Ms.map(f0).join(', ')}; pool acquire p95 upper bound (ms): ${group.server.poolAcquireP95Ms.map(f0).join(', ')}`,
    `- Peaks: tile queue depth ${group.server.tileQueueDepthPeak ?? 'n/a'}, tile cache ${mib(group.server.tileCacheBytesPeak)} MiB, resident memory ${mib(group.server.residentMemoryPeakBytes)} MiB`,
  ];
  return [title, `Seed ${group.seed}, dataset instant ${group.asOf}. Per-run ingestion p95 (ms): ${group.perRunIngestionP95Ms.map(f0).join(', ')}.`, ingestion, tiles, facts.join('\n')].join(
    '\n\n',
  );
}

function statementRow(measurement: StatementMeasurement): string[] {
  const first = measurement.executions[0];
  if (measurement.error !== null || first === undefined) {
    return [measurement.name, `failed (${measurement.error?.code ?? 'no SQLSTATE'}, ${measurement.error?.errorClass ?? 'unknown'})`, '', '', '', '', '', '', ''];
  }
  const times = measurement.executions.map((execution) => execution.executionMs);
  const responseMs = measurement.response ? median(measurement.response.elapsedMs) : null;
  return [
    measurement.name,
    f1(first.executionMs),
    f1(median(times)),
    f1(first.planningMs),
    String(first.buffers.sharedHit),
    String(first.buffers.sharedRead),
    scanLabel(first),
    measurement.response ? String(measurement.response.bytes) : '–',
    responseMs === null ? '–' : f1(responseMs),
  ];
}

function explainSection(result: ExplainRunResult): string {
  const profile = result.profile.replace(/^explain-/u, '');
  const header = table(
    ['Statement', 'first ms', 'median ms', 'planning ms', 'shared hit', 'shared read', 'sequential scans', 'response bytes', 'service call median ms'],
    result.statements.map(statementRow),
  );
  const wal = result.statements
    .filter((measurement) => (measurement.executions[0]?.wal.records ?? 0) > 0)
    .map((measurement) => {
      const first = measurement.executions[0] as PlanSummary;
      return `- ${measurement.name}: ${first.wal.records} WAL records, ${first.wal.bytes} bytes, ${first.wal.fullPageImages} full-page images; trigger time ${first.triggers.map((trigger) => `${trigger.name} ${f1(trigger.totalMs)} ms over ${trigger.calls} calls`).join(', ') || 'none'}`;
    });
  const lines = [
    `### ${profile} (seed ${result.seed}, as of ${result.asOf}, ${result.repetitions} repetitions)`,
    header,
    wal.length > 0
      ? `Statements that produced WAL (every one is rolled back; a read can also write WAL through page pruning and hint bits):\n\n${wal.join('\n')}`
      : '',
  ];
  return lines.filter((line) => line !== '').join('\n\n');
}

function relationSection(result: ExplainRunResult): string {
  const profile = result.profile.replace(/^explain-/u, '');
  const tables = table(
    ['Table', 'live tuples', 'dead tuples', 'heap MB', 'index MB', 'toast MB', 'total MB', 'seq scans', 'index scans'],
    result.relations.tables
      .filter((entry) => entry.totalBytes > 0)
      .map((entry) => [
        entry.name,
        String(entry.liveTuples),
        String(entry.deadTuples),
        mb(entry.heapBytes),
        mb(entry.indexBytes),
        mb(entry.toastBytes),
        mb(entry.totalBytes),
        String(entry.sequentialScans),
        String(entry.indexScans),
      ]),
  );
  const indexes = table(
    ['Index', 'table', 'method', 'MB'],
    result.relations.indexes.slice(0, 12).map((entry) => [entry.name, entry.table, entry.accessMethod, mb(entry.bytes)]),
  );
  return `### ${profile}\n\n${tables}\n\nLargest indexes:\n\n${indexes}`;
}

const methodSection = `## Method and limits

- Percentiles are nearest-rank over the raw samples of all runs of a group pooled together; run-to-run spread is shown as per-run p95 values. Histogram percentiles from server metrics are the upper bound of the containing bucket, so they overstate.
- Load figures are client-measured on loopback while the runner, the API, and PostgreSQL compete for one machine. They describe this workload on this machine and are not a capacity claim for other hardware.
- EXPLAIN (ANALYZE, BUFFERS, WAL) runs under the real runtime and maintenance roles with the tenant context set, inside transactions that are always rolled back. The first execution follows a fresh connection but the operating-system and shared-buffer caches are warm from the seeding and earlier statements, so "first" is not a cold-cache figure. Shared reads stayed near zero because the working set fits in memory.
- EXPLAIN times are database execution only. The service-call column includes SQL, row mapping, and schema validation; response bytes are the serialized JSON or the MVT bytes.
- Statements executed inside PL/pgSQL functions appear as one node, so their inner statements are not itemised.
- A real browser was not driven: frame time, map rendering, and the web application's own polling are not measured.`;

export function renderReport(input: ReportInput): string {
  const met = input.targets.filter((item) => item.status === 'met');
  const notMet = input.targets.filter((item) => item.status === 'not met');
  const unconfirmed = input.targets.filter((item) => item.status === 'not confirmed');
  const parts = [
    '# P11 performance measurements',
    'Generated by `npm run load:report` from the raw result files; every figure below is computed from them, and the interpretation lives in the progress log and ADR, not here.',
    environmentSection(input),
    ...(input.sources ? [sourcesSection(input.sources)] : []),
    targetsSection('Goals met', 'Targets whose measured value satisfied the SDD limit under the stated rule.', met),
    targetsSection('Goals not met', 'Targets whose measured value exceeded the SDD limit.', notMet),
    targetsSection(
      'Goals not confirmed',
      'Targets this workload cannot decide: the measurement is missing, indirect, or the workload never reached the condition.',
      unconfirmed,
    ),
    `## Load scenario results\n\n${input.groups.map(groupSection).join('\n\n')}`,
    `## EXPLAIN evidence\n\n${input.explain.map(explainSection).join('\n\n')}`,
    `## Relation and index sizes\n\n${input.explain.map(relationSection).join('\n\n')}`,
    methodSection,
  ];
  return `${parts.join('\n\n')}\n`;
}
