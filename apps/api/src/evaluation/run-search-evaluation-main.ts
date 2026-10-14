import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { VERSION as OPENAI_SDK_VERSION } from 'openai/version';

import { systemClock } from '../clock.js';
import { loadEnvironmentSource } from '../config/environment.js';
import { runSearchAiSecretVariables } from '../config/run-search-ai-config.js';
import { resolveSecretFiles } from '../config/secret-files.js';
import {
  INTERPRETATION_INSTRUCTIONS,
  INTERPRETATION_PROMPT_VERSION,
} from '../runs/interpretation/interpretation-prompt.js';
import { createInterpreter } from '../runs/interpretation/interpretation-factory.js';
import { providerOutputJsonSchema } from '../runs/interpretation/interpretation-schema.js';
import { readOllamaVersion } from '../runs/interpretation/ollama-interpreter.js';
import { loadEvaluationDataset } from './run-search-evaluation-dataset.js';
import {
  describeEvaluationRun,
  formatEvaluationReport,
  loadLiveEvaluationConfig,
  parseEvaluationArguments,
} from './run-search-evaluation-cli.js';
import { runEvaluation, selectEvaluationCases } from './run-search-evaluator.js';

// The opt-in LIVE evaluation of the "My runs" interpreter (docs/runbooks/run-search-ai.md). It is never part of
// `npm test`, `npm run verify` or CI: it needs --live and a model, it sends the synthetic dataset's texts to the
// configured provider (OpenAI with a credential and tokens that cost money, or the local Ollama on this machine, which
// needs no credential), and nothing from a database is involved. RUN_SEARCH_AI_PROVIDER picks the provider.
//
//   npm run eval:run-search -- --dry-run
//   npm run eval:run-search -- --dry-run --cases en-last-month-min-longest,ru-last-month-min-longest
//   npm run eval:run-search -- --live --cases en-last-month-min-longest,ru-last-month-min-longest
//   npm run eval:run-search -- --live --out .local/eval-reports/run-search.json

async function main(): Promise<void> {
  const args = parseEvaluationArguments(process.argv.slice(2));
  const dataset = loadEvaluationDataset();
  const rawSource = loadEnvironmentSource();
  // Ollama needs no credential: its mode neither reads nor validates OPENAI_API_KEY_FILE.
  const source = resolveSecretFiles(rawSource, runSearchAiSecretVariables(rawSource));
  const config = loadLiveEvaluationConfig(source);
  // Throws on an unknown id here, before the interpreter exists, so a typo costs nothing.
  const selected = selectEvaluationCases(dataset, args.caseIds, args.maxCases);

  console.info(
    [
      `Dataset v${dataset.datasetVersion}: ${dataset.cases.length} cases (${selected.length} to run)`,
      `Cases: ${selected.map((entry) => entry.id).join(', ')}`,
      `Prompt: ${INTERPRETATION_PROMPT_VERSION}`,
      `Provider: ${config.provider}`,
      `Model: ${config.model}`,
      `Calls: at most ${selected.length}, one per case, no retries; at most ${args.concurrency} at a time; ${config.timeoutMs} ms each; stops early after 3 identical systemic failures in a row`,
      `Output tokens per call: at most ${config.maxOutputTokens}`,
    ].join('\n'),
  );

  if (args.dryRun) {
    console.info('Dry run: the dataset and the configuration are valid. No request was made.');
    return;
  }

  // Asked once, before any inference, so that an Ollama that is not running is one clear prerequisite failure and not
  // a run of identical failures. The report names the runtime that served the requests.
  const runtimeVersion = config.provider === 'ollama' ? await readOllamaVersion() : null;
  const interpreter = createInterpreter(config);
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

  const run = describeEvaluationRun({
    args,
    config,
    instructions: INTERPRETATION_INSTRUCTIONS,
    openaiSdkVersion: OPENAI_SDK_VERSION,
    runtimeVersion,
    schema: providerOutputJsonSchema,
  });
  console.info(formatEvaluationReport(report, run));

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
