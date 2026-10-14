import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  buildRunSearchAiConfig,
  checkRunSearchAiEnvironment,
  runSearchAiEnvironmentFields,
  type RealRunSearchAiConfig,
} from '../config/run-search-ai-config.js';
import {
  INTERPRETATION_INSTRUCTIONS,
  INTERPRETATION_PROMPT_VERSION,
  OLLAMA_INTERPRETATION_INSTRUCTIONS,
  OLLAMA_INTERPRETATION_PROMPT_VERSION,
} from '../runs/interpretation/interpretation-prompt.js';
import {
  INTERPRETATION_SCHEMA_NAME,
  providerOutputJsonSchema,
} from '../runs/interpretation/interpretation-schema.js';
import { OLLAMA_GENERATION } from '../runs/interpretation/ollama-interpreter.js';
import {
  OLLAMA_OUTPUT_SCHEMA_NAME,
  ollamaOutputJsonSchema,
} from '../runs/interpretation/ollama-output-schema.js';
import { FILTER_FIELDS } from './run-search-scoring.js';
import { EVALUATION_MAX_CONCURRENCY, type EvaluationReport } from './run-search-evaluator.js';

export const EVALUATION_MAX_CASES = 200;

export interface EvaluationArguments {
  /** Run exactly these dataset cases (checked against the dataset before any call). */
  caseIds: string[] | undefined;
  concurrency: number;
  dryRun: boolean;
  /** Exit 2 unless every selected case was executed once and matched exactly (see evaluateAcceptance). */
  failOnMismatch: boolean;
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
    caseIds: undefined,
    concurrency: 1,
    dryRun: false,
    failOnMismatch: false,
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
      case '--fail-on-mismatch':
        parsed.failOnMismatch = true;
        break;
      case '--max-cases':
        parsed.maxCases = boundedInteger('--max-cases', value, 1, EVALUATION_MAX_CASES);
        index += 1;
        break;
      case '--cases': {
        // Chosen by identity, so a smoke run can be one case of each kind instead of the first few of the file.
        const ids = (value ?? '').split(',');
        if (value === undefined || value.startsWith('--') || ids.some((id) => !/^[a-z][a-z0-9-]{2,60}$/u.test(id))) {
          throw new Error('--cases needs a comma-separated list of dataset case ids');
        }
        if (new Set(ids).size !== ids.length) {
          throw new Error('--cases lists a case id twice');
        }
        if (ids.length > EVALUATION_MAX_CASES) {
          throw new Error(`--cases takes at most ${EVALUATION_MAX_CASES} ids`);
        }
        parsed.caseIds = ids;
        index += 1;
        break;
      }
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
  if (parsed.caseIds !== undefined && parsed.maxCases !== undefined) {
    throw new Error('--cases and --max-cases select cases in different ways; use one of them');
  }
  if (parsed.dryRun && parsed.failOnMismatch) {
    // A dry run answers nothing, so there is nothing to accept; exiting 0 here would read as "accepted".
    throw new Error(
      '--fail-on-mismatch needs answers to judge: a dry run makes no request and can never be accepted. Use --live.',
    );
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
 * from the environment (and `OPENAI_API_KEY_FILE`, resolved by the caller when OpenAI is the provider). The provider
 * is the configured REAL one, `openai` or `ollama`: a fake provider would make the numbers worthless, so it is
 * refused rather than replaced by a paid one, and the enabling flag is irrelevant to an explicit live run.
 */
export function loadLiveEvaluationConfig(source: Record<string, string | undefined>): RealRunSearchAiConfig {
  const schema = z
    .object(runSearchAiEnvironmentFields)
    .superRefine((values, context) => {
      // Not production: the local provider is for development machines, and this is a development tool.
      checkRunSearchAiEnvironment(values, { APP_ENV: 'development' }, context);
    });
  const result = schema.safeParse({
    ...source,
    RUN_SEARCH_AI_ENABLED: 'true',
  });
  if (!result.success) {
    // Messages name variables and limits; none of them carries a value of OPENAI_API_KEY.
    throw new Error(`Invalid evaluation configuration: ${z.prettifyError(result.error)}`);
  }
  const config = buildRunSearchAiConfig(result.data);
  if (config === undefined) {
    throw new Error('Invalid evaluation configuration');
  }
  if (config.provider === 'fake') {
    throw new Error(
      'RUN_SEARCH_AI_PROVIDER is fake: an evaluation measures a real model. Set RUN_SEARCH_AI_PROVIDER to openai or ollama for this run.',
    );
  }
  return config;
}

/**
 * The instructions, output schema and wording version the configured provider's adapter actually sends. Chosen by
 * the provider alone, so a report can never describe one provider's run with the other's wire contract.
 */
export function evaluationWireContract(provider: RealRunSearchAiConfig['provider']): {
  instructions: string;
  promptVersion: string;
  schema: unknown;
  schemaName: string;
} {
  switch (provider) {
    case 'ollama':
      return {
        instructions: OLLAMA_INTERPRETATION_INSTRUCTIONS,
        promptVersion: OLLAMA_INTERPRETATION_PROMPT_VERSION,
        schema: ollamaOutputJsonSchema,
        schemaName: OLLAMA_OUTPUT_SCHEMA_NAME,
      };
    case 'openai':
      return {
        instructions: INTERPRETATION_INSTRUCTIONS,
        promptVersion: INTERPRETATION_PROMPT_VERSION,
        schema: providerOutputJsonSchema,
        schemaName: INTERPRETATION_SCHEMA_NAME,
      };
    default:
      return unsupportedEvaluationProvider(provider);
  }
}

export interface EvaluationRunDescription {
  concurrency: number;
  /** The settings that shape what a model produces, as the provider receives them. */
  generation: Record<string, boolean | number | string>;
  instructionsSha256: string;
  maxOutputTokens: number;
  maxResponseBytes: number;
  model: string;
  promptVersion: string;
  provider: 'ollama' | 'openai';
  /** What served the requests: the local runtime for Ollama, the client library for OpenAI. */
  runtime: { name: string; version: string | null };
  schemaName: string;
  schemaSha256: string;
  selection: 'all' | 'first-n' | 'ids';
  timeoutMs: number;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * What was frozen for a run, so that a later report with a different prompt, schema, model, runtime or limit cannot
 * be taken for the same measurement. An Ollama run is described by the local runtime's version and its generation
 * settings; the OpenAI SDK's version describes an OpenAI run and is never attached to anything else. No key, no text
 * of a person, no provider response.
 */
export function describeEvaluationRun(options: {
  args: EvaluationArguments;
  config: RealRunSearchAiConfig;
  openaiSdkVersion: string;
  /** The local runtime's reported version; null when it was not asked (a dry run) or for OpenAI. */
  runtimeVersion: string | null;
}): EvaluationRunDescription {
  const { args, config } = options;
  // The wire contract is taken from the provider here and not passed in: what is hashed is what the adapter sends.
  const wire = evaluationWireContract(config.provider);
  const common = {
    concurrency: args.concurrency,
    instructionsSha256: sha256(wire.instructions),
    maxOutputTokens: config.maxOutputTokens,
    maxResponseBytes: config.maxResponseBytes,
    model: config.model,
    promptVersion: wire.promptVersion,
    schemaName: wire.schemaName,
    schemaSha256: sha256(JSON.stringify(wire.schema)),
    selection: args.caseIds !== undefined ? ('ids' as const) : args.maxCases !== undefined ? ('first-n' as const) : ('all' as const),
    timeoutMs: config.timeoutMs,
  };
  switch (config.provider) {
    case 'ollama':
      return {
        ...common,
        generation: {
          numCtx: OLLAMA_GENERATION.numCtx,
          numPredict: config.maxOutputTokens,
          stream: false,
          temperature: OLLAMA_GENERATION.temperature,
          think: OLLAMA_GENERATION.think,
        },
        provider: 'ollama',
        runtime: { name: 'ollama', version: options.runtimeVersion },
      };
    case 'openai':
      return {
        ...common,
        generation: { maxOutputTokens: config.maxOutputTokens, retries: 0, store: false },
        provider: 'openai',
        runtime: { name: 'openai-node-sdk', version: options.openaiSdkVersion },
      };
    default:
      return unsupportedEvaluationProvider(config);
  }
}

function unsupportedEvaluationProvider(provider: never): never {
  throw new Error(`Unsupported evaluation provider: ${String(provider).slice(0, 32)}`);
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/**
 * The verdict of `--fail-on-mismatch`: whether a run matched every case that was SELECTED. It is a statement about
 * those synthetic cases and nothing wider. It is recorded in the report file next to the numbers it was derived from.
 */
export interface EvaluationAcceptance {
  /** Why not, at most ten short entries; empty when passed. Case ids are listed, never request texts. */
  failures: string[];
  passed: boolean;
  scope: 'selected-synthetic-cases';
  selectedIds: string[];
  statement: string;
}

const ACCEPTANCE_STATEMENT =
  'Acceptance is a statement about the selected synthetic cases only: it does not describe general model quality or production readiness.';
const ACCEPTANCE_MAX_FAILURES = 10;
const ACCEPTANCE_MAX_LISTED = 5;
const ACCEPTANCE_MAX_FAILURE_LENGTH = 300;

function listed(ids: readonly string[]): string {
  const shown = ids.slice(0, ACCEPTANCE_MAX_LISTED).join(', ');
  return ids.length > ACCEPTANCE_MAX_LISTED ? `${shown} and ${ids.length - ACCEPTANCE_MAX_LISTED} more` : shown;
}

/**
 * Pure: the report and the ids that were selected, nothing else. Completeness is judged against the SELECTION, not the
 * dataset, so five selected cases that all ran can pass although `report.partial` is true relative to the dataset.
 *
 * Passes only when every selected case was executed exactly once, no other case was, the run did not stop early, no
 * operation is unsettled, no call failed, and every outcome, reason and filter set matched. Nothing is repaired or
 * discounted: a failed call is a failure, not a skipped case.
 */
export function evaluateAcceptance(report: EvaluationReport, selectedIds: readonly string[]): EvaluationAcceptance {
  const failures: string[] = [];
  const selected = [...selectedIds];
  const selectedSet = new Set(selected);

  if (selected.length === 0) {
    failures.push('No cases were selected, so there is nothing to accept.');
  }
  if (selectedSet.size !== selected.length) {
    failures.push('The selection lists a case more than once.');
  }

  const timesExecuted = new Map<string, number>();
  for (const id of report.executedIds) {
    timesExecuted.set(id, (timesExecuted.get(id) ?? 0) + 1);
  }
  const notExecuted = selected.filter((id) => !timesExecuted.has(id));
  if (notExecuted.length > 0) {
    failures.push(`${notExecuted.length} selected case(s) not executed: ${listed(notExecuted)}.`);
  }
  const notSelected = [...timesExecuted.keys()].filter((id) => !selectedSet.has(id));
  if (notSelected.length > 0) {
    failures.push(`${notSelected.length} executed case(s) were not selected: ${listed(notSelected)}.`);
  }
  const repeated = [...timesExecuted].filter(([, count]) => count > 1).map(([id]) => id);
  if (repeated.length > 0) {
    failures.push(`${repeated.length} case(s) were executed more than once: ${listed(repeated)}.`);
  }
  if (report.executedCount !== report.executedIds.length) {
    failures.push('The report is inconsistent: its executed count does not match its executed case ids.');
  }

  if (report.aborted !== null) {
    failures.push(
      `The run stopped early: ${report.aborted.consecutive} identical failures in a row (${report.aborted.reason}) after ${report.aborted.afterCases} cases.`,
    );
  }
  if (report.unsettled.count > 0) {
    failures.push(
      `${report.unsettled.count} interpreter operation(s) unsettled after cancellation: ${listed(report.unsettled.caseIds)}.`,
    );
  }
  if (report.failures.total > 0) {
    const reasons = Object.entries(report.failures.byReason)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ');
    failures.push(`${report.failures.total} provider failure(s): ${reasons}.`);
  }

  // A failed call is reported above; this is what the model answered and got wrong.
  const wrong = report.mismatches.filter((entry) => !entry.actualOutcome.startsWith('failure:'));
  if (wrong.length > 0) {
    const detail = wrong
      .slice(0, ACCEPTANCE_MAX_LISTED)
      .map((entry) => {
        const expected = `${entry.expectedOutcome}${entry.expectedReason === null ? '' : `/${entry.expectedReason}`}`;
        const actual = `${entry.actualOutcome}${entry.actualReason === null ? '' : `/${entry.actualReason}`}`;
        const fields = entry.fieldErrors.length === 0 ? '' : `, fields ${entry.fieldErrors.join('+')}`;
        return `${entry.id} (expected ${expected}, got ${actual}${fields})`;
      })
      .join('; ');
    const more = wrong.length > ACCEPTANCE_MAX_LISTED ? ` and ${wrong.length - ACCEPTANCE_MAX_LISTED} more` : '';
    failures.push(`${wrong.length} case(s) did not match: ${detail}${more}.`);
  }
  if (report.incorrectAcceptances.total > 0) {
    failures.push(
      `${report.incorrectAcceptances.total} request(s) that needed a clarification or are unsupported were answered as a search: ${listed(report.incorrectAcceptances.ids)}.`,
    );
  }

  // A backstop for a report whose list of mismatches is empty while its tallies are not complete.
  if (failures.length === 0) {
    const { exactFilters, outcome, reason } = report.counts;
    const complete =
      outcome.total === selected.length &&
      outcome.correct === outcome.total &&
      reason.correct === reason.total &&
      exactFilters.correct === exactFilters.total;
    if (!complete) {
      failures.push(
        `The scoring tallies are not complete: outcome ${outcome.correct}/${outcome.total}, reason ${reason.correct}/${reason.total}, exact filters ${exactFilters.correct}/${exactFilters.total} for ${selected.length} selected case(s).`,
      );
    }
  }

  return {
    failures: failures
      .slice(0, ACCEPTANCE_MAX_FAILURES)
      .map((entry) => entry.slice(0, ACCEPTANCE_MAX_FAILURE_LENGTH)),
    passed: failures.length === 0,
    scope: 'selected-synthetic-cases',
    selectedIds: selected,
    statement: ACCEPTANCE_STATEMENT,
  };
}

export function formatAcceptance(acceptance: EvaluationAcceptance): string {
  const count = acceptance.selectedIds.length;
  if (acceptance.passed) {
    return [
      `ACCEPTANCE PASSED: all ${count} selected synthetic case(s) were executed once and matched their expected outcome, reason and filters.`,
      acceptance.statement,
    ].join('\n');
  }
  return [
    `ACCEPTANCE FAILED for ${count} selected synthetic case(s):`,
    ...acceptance.failures.map((failure) => `  - ${failure}`),
    acceptance.statement,
  ].join('\n');
}

export function formatEvaluationReport(report: EvaluationReport, run?: EvaluationRunDescription): string {
  const lines: string[] = [];
  lines.push(`Run search interpreter evaluation`);
  if (run !== undefined) {
    const kind = run.provider === 'ollama' ? 'local runtime' : 'client library';
    lines.push(`Provider: ${run.provider} (${kind} ${run.runtime.name} ${run.runtime.version ?? 'version not read'})`);
    lines.push(
      `Generation: ${Object.entries(run.generation)
        .map(([name, value]) => `${name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)} ${String(value)}`)
        .join(', ')}`,
    );
  }
  lines.push(`Model: ${report.model}`);
  lines.push(`Prompt: ${report.promptVersion}`);
  lines.push(`Data: dataset v${report.datasetVersion}, ${report.executedCount} of ${report.caseCount} cases run`);
  if (report.aborted !== null) {
    lines.push(
      `PARTIAL, STOPPED EARLY: ${report.aborted.consecutive} identical failures in a row (${report.aborted.reason}) after ${report.aborted.afterCases} cases; the remaining calls were not made. This is a compatibility problem to fix, not a measurement.`,
    );
  } else if (report.partial) {
    lines.push(
      `PARTIAL: ${report.executedCount} of ${report.caseCount} cases. The percentages below describe only the cases that were run.`,
    );
  }
  if (report.unsettled.count > 0) {
    lines.push(
      `UNSETTLED: ${report.unsettled.count} interpreter operation(s) had not ended after cancellation was requested (${report.unsettled.caseIds.join(', ')}). No further cases were started, so the concurrency limit was not exceeded. Those cases are counted as timeouts.`,
    );
  }
  lines.push('');
  const { counts } = report;
  lines.push(`Outcome accuracy: ${percent(report.outcomeAccuracy)} (${counts.outcome.correct}/${counts.outcome.total})`);
  lines.push(
    `Reason accuracy: ${percent(report.reasonAccuracy)} (${counts.reason.correct}/${counts.reason.total}; clarify and unsupported cases)`,
  );
  lines.push(
    `Exact filter accuracy: ${percent(report.exactFilterAccuracy)} (${counts.exactFilters.correct}/${counts.exactFilters.total}; search cases)`,
  );
  lines.push(
    `Accepted as a search although a clarification or an unsupported answer was expected: ${report.incorrectAcceptances.total} of ${report.incorrectAcceptances.ofCases}${report.incorrectAcceptances.ids.length === 0 ? '' : ` (${report.incorrectAcceptances.ids.join(', ')})`}`,
  );
  lines.push(
    `Field errors: ${FILTER_FIELDS.map((field) => `${field} ${report.fieldErrors[field]}`).join(', ')}`,
  );
  lines.push('By language (outcome / reason / exact filters, failed calls included):');
  for (const [language, entry] of Object.entries(report.byLanguage).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `  ${language}: ${entry.cases} cases, outcome ${entry.outcome.correct}/${entry.outcome.total}, reason ${entry.reason.correct}/${entry.reason.total}, exact filters ${entry.exactFilters.correct}/${entry.exactFilters.total}, failures ${entry.failures}`,
    );
  }
  lines.push('Expected -> got (search / clarify / unsupported / failed call):');
  for (const expected of ['search', 'clarify', 'unsupported'] as const) {
    const row = report.outcomeMatrix[expected];
    lines.push(`  ${expected}: ${row.search} / ${row.clarify} / ${row.unsupported} / ${row.failure}`);
  }
  const failureReasons = Object.entries(report.failures.byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  lines.push(`Failures: ${report.failures.total}${failureReasons === '' ? '' : ` (${failureReasons})`}`);
  lines.push(
    `Latency: mean ${Math.round(report.latencyMs.mean)} ms, p50 ${report.latencyMs.p50} ms, p95 ${report.latencyMs.p95} ms, max ${report.latencyMs.max} ms`,
  );
  lines.push(
    `Tokens: input ${report.usage.inputTokens} (cached ${report.usage.cachedInputTokens}), output ${report.usage.outputTokens} (reasoning ${report.usage.reasoningTokens}; ${report.usage.callsWithReasoningDetail} calls reported it) over ${report.usage.callsWithUsage} calls that reported usage. Cost is not calculated.`,
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
