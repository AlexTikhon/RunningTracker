import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { systemClock } from '../clock.js';
import { loadEnvironmentSource } from '../config/environment.js';
import { resolveSecretFiles } from '../config/secret-files.js';
import { INTERPRETATION_PROMPT_VERSION } from '../runs/interpretation/interpretation-prompt.js';
import { OpenAiInterpreter } from '../runs/interpretation/openai-interpreter.js';
import { loadEvaluationDataset } from './run-search-evaluation-dataset.js';
import {
  formatEvaluationReport,
  loadLiveEvaluationConfig,
  parseEvaluationArguments,
} from './run-search-evaluation-cli.js';
import { runEvaluation } from './run-search-evaluator.js';

// The opt-in LIVE evaluation of the "My runs" interpreter (docs/runbooks/run-search-ai.md). It is never part of
// `npm test`, `npm run verify` or CI: it needs --live, a credential and a model, it sends the synthetic dataset's
// texts to the provider, and it spends tokens. Nothing from a database is involved.
//
//   npm run eval:run-search -- --dry-run
//   npm run eval:run-search -- --live --max-cases 10
//   npm run eval:run-search -- --live --out .local/eval-reports/run-search.json

async function main(): Promise<void> {
  const args = parseEvaluationArguments(process.argv.slice(2));
  const dataset = loadEvaluationDataset();
  const source = resolveSecretFiles(loadEnvironmentSource(), ['OPENAI_API_KEY']);
  const config = loadLiveEvaluationConfig(source);
  const planned = Math.min(args.maxCases ?? dataset.cases.length, dataset.cases.length);

  console.info(
    [
      `Dataset v${dataset.datasetVersion}: ${dataset.cases.length} cases (${planned} to run)`,
      `Prompt: ${INTERPRETATION_PROMPT_VERSION}`,
      `Model: ${config.model}`,
      `Calls: ${planned}, one per case, no retries; at most ${args.concurrency} at a time; ${config.timeoutMs} ms each`,
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

  const out = resolve(
    args.out ?? `.local/eval-reports/run-search-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ ...report, recordedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  console.info(`Report written to ${out}`);
}

main().catch((error: unknown) => {
  // Messages here are written to name variables and limits only; nothing prints a credential.
  console.error(error instanceof Error ? error.message : 'The evaluation failed');
  process.exitCode = 1;
});
