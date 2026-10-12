import { z } from 'zod';

import {
  buildRunSearchAiConfig,
  checkRunSearchAiEnvironment,
  runSearchAiEnvironmentFields,
  type RunSearchAiConfig,
} from '../config/run-search-ai-config.js';
import { FILTER_FIELDS } from './run-search-scoring.js';
import { EVALUATION_MAX_CONCURRENCY, type EvaluationReport } from './run-search-evaluator.js';

export const EVALUATION_MAX_CASES = 200;

export interface EvaluationArguments {
  concurrency: number;
  dryRun: boolean;
  live: boolean;
  maxCases: number | undefined;
  out: string | undefined;
}

function boundedInteger(name: string, value: string | undefined, minimum: number, maximum: number): number {
  const parsed = value !== undefined && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return parsed;
}

/**
 * A live evaluation spends real money and sends the dataset's texts to the provider, so it never starts by accident:
 * `--live` has to be spelled out, unknown arguments are refused, and the number of calls is bounded.
 */
export function parseEvaluationArguments(argv: readonly string[]): EvaluationArguments {
  const parsed: EvaluationArguments = {
    concurrency: 1,
    dryRun: false,
    live: false,
    maxCases: undefined,
    out: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    switch (argument) {
      case '--live':
        parsed.live = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--max-cases':
        parsed.maxCases = boundedInteger('--max-cases', value, 1, EVALUATION_MAX_CASES);
        index += 1;
        break;
      case '--concurrency':
        parsed.concurrency = boundedInteger('--concurrency', value, 1, EVALUATION_MAX_CONCURRENCY);
        index += 1;
        break;
      case '--out':
        if (value === undefined || value.startsWith('--')) {
          throw new Error('--out needs a file path');
        }
        parsed.out = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument.slice(0, 40)}`);
    }
  }
  if (!parsed.live && !parsed.dryRun) {
    throw new Error(
      'Refusing to start: a live evaluation calls the real provider and costs money. Pass --live to run it, or --dry-run to only check the dataset and the configuration.',
    );
  }
  return parsed;
}

/**
 * The same settings, with the same bounds and the same model check, as the application's own configuration, read
 * from the environment (and `OPENAI_API_KEY_FILE`, resolved by the caller). The provider is always the real one: a
 * fake provider would make the numbers worthless, and the enabling flag is irrelevant to an explicit live run.
 */
export function loadLiveEvaluationConfig(source: Record<string, string | undefined>): RunSearchAiConfig {
  const schema = z
    .object(runSearchAiEnvironmentFields)
    .superRefine((values, context) => {
      checkRunSearchAiEnvironment(values, { APP_ENV: 'production' }, context);
    });
  const result = schema.safeParse({
    ...source,
    RUN_SEARCH_AI_ENABLED: 'true',
    RUN_SEARCH_AI_PROVIDER: 'openai',
  });
  if (!result.success) {
    // Messages name variables and limits; none of them carries a value of OPENAI_API_KEY.
    throw new Error(`Invalid evaluation configuration: ${z.prettifyError(result.error)}`);
  }
  const config = buildRunSearchAiConfig(result.data);
  if (config === undefined) {
    throw new Error('Invalid evaluation configuration');
  }
  return config;
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push(`Run search interpreter evaluation`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Prompt: ${report.promptVersion}`);
  lines.push(`Data: dataset v${report.datasetVersion}, ${report.executedCount} of ${report.caseCount} cases run`);
  lines.push('');
  lines.push(`Outcome accuracy: ${percent(report.outcomeAccuracy)}`);
  lines.push(`Reason accuracy: ${percent(report.reasonAccuracy)} (clarify and unsupported cases)`);
  lines.push(`Exact filter accuracy: ${percent(report.exactFilterAccuracy)} (search cases)`);
  lines.push(
    `Field errors: ${FILTER_FIELDS.map((field) => `${field} ${report.fieldErrors[field]}`).join(', ')}`,
  );
  const failureReasons = Object.entries(report.failures.byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  lines.push(`Failures: ${report.failures.total}${failureReasons === '' ? '' : ` (${failureReasons})`}`);
  lines.push(
    `Latency: mean ${Math.round(report.latencyMs.mean)} ms, p50 ${report.latencyMs.p50} ms, p95 ${report.latencyMs.p95} ms, max ${report.latencyMs.max} ms`,
  );
  lines.push(
    `Tokens: input ${report.usage.inputTokens}, output ${report.usage.outputTokens} (${report.usage.callsWithUsage} calls reported usage)`,
  );
  lines.push('');
  lines.push('By category (outcome correct / cases, exact filters):');
  for (const [category, entry] of Object.entries(report.byCategory).sort(([a], [b]) => a.localeCompare(b))) {
    const filters = entry.exactFilters === null ? '' : `, exact filters ${entry.exactFilters}`;
    lines.push(`  ${category}: ${entry.outcomeCorrect}/${entry.cases}${filters}`);
  }
  if (report.mismatches.length > 0) {
    lines.push('');
    lines.push(`Cases that did not match (${report.mismatches.length}):`);
    for (const mismatch of report.mismatches) {
      const expected = `${mismatch.expectedOutcome}${mismatch.expectedReason === null ? '' : `/${mismatch.expectedReason}`}`;
      const actual = `${mismatch.actualOutcome}${mismatch.actualReason === null ? '' : `/${mismatch.actualReason}`}`;
      const fields = mismatch.fieldErrors.length === 0 ? '' : ` fields: ${mismatch.fieldErrors.join(', ')}`;
      lines.push(`  ${mismatch.id}: expected ${expected}, got ${actual}${fields}`);
    }
  }
  lines.push('');
  lines.push(
    'This run only describes one model, one prompt version and one day: it is a measurement, not a guarantee. The dataset is synthetic and small.',
  );
  return lines.join('\n');
}
