import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { VERSION as OPENAI_SDK_VERSION } from 'openai/version';

import { systemClock } from '../clock.js';
import { loadEnvironmentSource } from '../config/environment.js';
import { resolveSecretFiles } from '../config/secret-files.js';
import {
  INTERPRETATION_INSTRUCTIONS,
  INTERPRETATION_PROMPT_VERSION,
} from '../runs/interpretation/interpretation-prompt.js';
import {
  INTERPRETATION_SCHEMA_NAME,
  providerOutputJsonSchema,
} from '../runs/interpretation/interpretation-schema.js';
import { OpenAiInterpreter } from '../runs/interpretation/openai-interpreter.js';
import { loadEvaluationDataset } from './run-search-evaluation-dataset.js';
import {
  formatEvaluationReport,
  loadLiveEvaluationConfig,
  parseEvaluationArguments,
} from './run-search-evaluation-cli.js';
import { runEvaluation, selectEvaluationCases } from './run-search-evaluator.js';

// The opt-in LIVE evaluation of the "My runs" interpreter (docs/runbooks/run-search-ai.md). It is never part of
// `npm test`, `npm run verify` or CI: it needs --live, a credential and a model, it sends the synthetic dataset's
// texts to the provider, and it spends tokens. Nothing from a database is involved.
//
//   npm run eval:run-search -- --dry-run
//   npm run eval:run-search -- --dry-run --cases en-last-month-min-longest,ru-last-month-min-longest
//   npm run eval:run-search -- --live --cases en-last-month-min-longest,ru-last-month-min-longest
//   npm run eval:run-search -- --live --out .local/eval-reports/run-search.json

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function main(): Promise<void> {
  const args = parseEvaluationArguments(process.argv.slice(2));
  const dataset = loadEvaluationDataset();
  const source = resolveSecretFiles(loadEnvironmentSource(), ['OPENAI_API_KEY']);
  const config = loadLiveEvaluationConfig(source);
  // Throws on an unknown id here, before the interpreter exists, so a typo costs nothing.
  const selected = selectEvaluationCases(dataset, args.caseIds, args.maxCases);

  console.info(
    [
      `Dataset v${dataset.datasetVersion}: ${dataset.cases.length} cases (${selected.length} to run)`,
      `Cases: ${selected.map((entry) => entry.id).join(', ')}`,
      `Prompt: ${INTERPRETATION_PROMPT_VERSION}`,
      `Model: ${config.model}`,
      `Calls: at most ${selected.length}, one per case, no retries; at most ${args.concurrency} at a time; ${config.timeoutMs} ms each; stops early after 3 identical systemic failures in a row`,
      `Output tokens per call: at most ${config.maxOutputTokens}`,
    ].join('\n'),
  );

  if (args.dryRun) {
    console.info('Dry run: the dataset and the configuration are valid. No request was made.');
    return;
  }

  const interpreter = new OpenAiInterpreter({
    apiKey: config.apiKey as string,
    maxOutputTokens: config.maxOutputTokens,
    maxResponseBytes: config.maxResponseBytes,
    model: config.model,
    timeoutMs: config.timeoutMs,
  });
  const report = await runEvaluation({
    callTimeoutMs: config.timeoutMs,
    ...(args.caseIds === undefined ? {} : { caseIds: args.caseIds }),
    clock: systemClock,
    concurrency: args.concurrency,
    dataset,
    interpreter,
    ...(args.maxCases === undefined ? {} : { maxCases: args.maxCases }),
    onCase: ({ done, total }) => {
      process.stderr.write(`\r${done}/${total}`);
    },
  });
  process.stderr.write('\n');

  console.info(formatEvaluationReport(report));

  // What was frozen for this run, so that a later report with a different prompt, schema, model or limit cannot be
  // taken for the same measurement. No key, no text of the person, no provider response.
  const run = {
    concurrency: args.concurrency,
    instructionsSha256: sha256(INTERPRETATION_INSTRUCTIONS),
    maxOutputTokens: config.maxOutputTokens,
    maxResponseBytes: config.maxResponseBytes,
    openaiSdkVersion: OPENAI_SDK_VERSION,
    schemaName: INTERPRETATION_SCHEMA_NAME,
    schemaSha256: sha256(JSON.stringify(providerOutputJsonSchema)),
    selection: args.caseIds !== undefined ? 'ids' : args.maxCases !== undefined ? 'first-n' : 'all',
    timeoutMs: config.timeoutMs,
  };

  const out = resolve(
    args.out ?? `.local/eval-reports/run-search-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ ...report, recordedAt: new Date().toISOString(), run }, null, 2)}\n`,
    'utf8',
  );
  console.info(`Report written to ${out}`);
}

main().catch((error: unknown) => {
  // Messages here are written to name variables and limits only; nothing prints a credential.
  console.error(error instanceof Error ? error.message : 'The evaluation failed');
  process.exitCode = 1;
});
