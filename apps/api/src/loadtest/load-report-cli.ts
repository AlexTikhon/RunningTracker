import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { ExplainRunResult } from './explain-run-cli.js';
import { aggregateLoadRuns, evaluateTargets } from './load-report-data.js';
import { renderReport } from './load-report-render.js';
import { defaultResultsDirectory } from './load-run-arguments.js';
import { resultSchemaName, type LoadRunResult } from './load-result.js';

const explainSchemaName = 'running-tracker.explain-result';

export const reportUsage =
  'Usage: npm run load:report -- [--results-dir <path>] [--since <UTC instant>] [--out <file>] ' +
  '(prints the report when --out is absent)';

export interface ReportArguments {
  out: string | undefined;
  resultsDir: string;
  since: Date | undefined;
}

export function parseReportArguments(argv: readonly string[]): ReportArguments {
  let out: string | undefined;
  let resultsDir = defaultResultsDirectory;
  let since: Date | undefined;
  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    if (flag !== '--out' && flag !== '--results-dir' && flag !== '--since') {
      throw new Error(`Unknown argument ${flag ?? ''}. ${reportUsage}`);
    }
    const value = argv[position + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value. ${reportUsage}`);
    }
    position += 1;
    if (flag === '--out') {
      out = resolve(value);
    } else if (flag === '--results-dir') {
      resultsDir = resolve(value);
    } else {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`--since must be a canonical UTC instant such as 2026-09-30T09:00:00.000Z. ${reportUsage}`);
      }
      since = parsed;
    }
  }
  return { out, resultsDir, since };
}

export interface ReportCliDependencies {
  argv: readonly string[];
  log?: (line: string) => void;
  write?: (text: string) => void;
}

export interface ReportCliOutcome {
  explainResults: number;
  loadResults: number;
  outPath: string | null;
}

interface Loaded<Result> {
  file: string;
  result: Result;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function schemaOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'schema' in value && typeof value.schema === 'string'
    ? value.schema
    : undefined;
}

/**
 * `npm run load:report`: turns the raw load and EXPLAIN result files into one Markdown document. Files of
 * another schema (raw plans, unrelated JSON) are skipped, results before `--since` are left out, and only
 * the newest EXPLAIN result of each profile is used. Nothing is written when there is no load result.
 */
export async function runReportCli(dependencies: ReportCliDependencies): Promise<ReportCliOutcome> {
  const log = dependencies.log ?? ((line: string) => console.error(line));
  const write = dependencies.write ?? ((text: string) => console.info(text));
  const args = parseReportArguments(dependencies.argv);
  const files = (await readdir(args.resultsDir)).filter((name) => name.endsWith('.json')).toSorted();
  const since = args.since?.getTime() ?? Number.NEGATIVE_INFINITY;

  const loads: Loaded<LoadRunResult>[] = [];
  const explains = new Map<string, Loaded<ExplainRunResult>>();
  for (const file of files) {
    const value = await readJson(join(args.resultsDir, file));
    const schema = schemaOf(value);
    const startedAt = (value as { startedAt?: unknown } | undefined)?.startedAt;
    if (typeof startedAt !== 'string' || Date.parse(startedAt) < since) {
      continue;
    }
    if (schema === resultSchemaName) {
      const result = value as LoadRunResult;
      // Results written before lock sampling existed carry no samples.
      result.lockSamples ??= [];
      loads.push({ file, result });
    } else if (schema === explainSchemaName) {
      const result = value as ExplainRunResult;
      const current = explains.get(result.profile);
      if (!current || Date.parse(result.startedAt) > Date.parse(current.result.startedAt)) {
        explains.set(result.profile, { file, result });
      }
    }
  }
  if (loads.length === 0) {
    throw new Error(`No load result matched in ${basename(args.resultsDir)}; run npm run load:run first`);
  }

  const groups = aggregateLoadRuns(loads.map(({ result }) => result));
  const chosen = [...explains.values()].toSorted((left, right) => left.result.profile.localeCompare(right.result.profile));
  const text = renderReport({
    explain: chosen.map(({ result }) => result),
    groups,
    sources: {
      explainFiles: chosen.map(({ file }) => file),
      loadFiles: loads.map(({ file }) => file),
      since: args.since?.toISOString() ?? null,
    },
    targets: evaluateTargets(groups),
  });
  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, text, 'utf8');
    log(`report written to ${args.out}`);
  } else {
    write(text);
  }
  return { explainResults: chosen.length, loadResults: loads.length, outPath: args.out ?? null };
}
