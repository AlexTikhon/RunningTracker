import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import { systemClock } from '../clock.js';
import { loadEnvironmentSource } from '../config/environment.js';
import { mealDraftsEnvironmentFields } from '../config/meal-drafts-config.js';
import { isLocalOllamaModel } from '../config/run-search-ai-config.js';
import { isLocalOllamaBaseUrl } from '../config/weekly-insights-config.js';
import { OLLAMA_INSIGHT_GENERATION, OllamaProvider } from '../insights/ollama-provider.js';
import { FakeMealDraftProvider } from '../meals/drafts/fake-meal-draft-provider.js';
import {
  buildMealDraftReport,
  formatMealDraftReport,
  loadMealDraftDataset,
  MEAL_DRAFT_EVALUATION_MAX_CALLS,
  MEAL_DRAFT_EVALUATION_SETS,
  runMealDraftEvaluation,
  type MealDraftEvaluationSet,
} from './meal-draft-evaluation.js';

// The opt-in evaluation of "Draft from text" (docs/runbooks/meal-drafts.md). Never part of `npm test`, `npm run verify`
// or CI. With --provider ollama it sends the synthetic set's texts, one call per case and no retries, to the local Ollama
// named by MEAL_DRAFTS_OLLAMA_BASE_URL and MEAL_DRAFTS_MODEL, after checking that the model is already installed (nothing
// is ever pulled). With --provider fake it verifies this harness and says nothing about a model.
//
//   npm run eval:meal-drafts -- --set development --provider fake
//   npm run eval:meal-drafts -- --set development --provider ollama --dry-run
//   npm run eval:meal-drafts -- --set heldout --provider ollama --max-calls 20 --out docs/reports/artifacts/x/heldout.json
//
// Exit codes: 0 the run finished (also with failures it measured), 1 anything that prevented a run or its report.

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const settingsSchema = z.object({
  MEAL_DRAFTS_MAX_OUTPUT_TOKENS: mealDraftsEnvironmentFields.MEAL_DRAFTS_MAX_OUTPUT_TOKENS,
  MEAL_DRAFTS_MODEL: mealDraftsEnvironmentFields.MEAL_DRAFTS_MODEL,
  MEAL_DRAFTS_OLLAMA_BASE_URL: mealDraftsEnvironmentFields.MEAL_DRAFTS_OLLAMA_BASE_URL,
  MEAL_DRAFTS_TIMEOUT_MS: mealDraftsEnvironmentFields.MEAL_DRAFTS_TIMEOUT_MS,
});

async function ollamaJson(baseUrl: string, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Ollama ${path} answered ${response.status}`);
  return response.json();
}

async function main(): Promise<void> {
  const set = argument('set') as MealDraftEvaluationSet | undefined;
  if (set === undefined || !MEAL_DRAFT_EVALUATION_SETS.includes(set)) throw new Error(`--set must be one of ${MEAL_DRAFT_EVALUATION_SETS.join(', ')}`);
  const providerName = argument('provider');
  if (providerName !== 'fake' && providerName !== 'ollama') throw new Error('--provider must be fake or ollama (stated explicitly, never inferred)');
  const { dataset, digest } = loadMealDraftDataset(set);
  const maxCalls = Number(argument('max-calls') ?? String(Math.min(dataset.cases.length, MEAL_DRAFT_EVALUATION_MAX_CALLS)));
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MEAL_DRAFT_EVALUATION_MAX_CALLS) {
    throw new Error(`--max-calls must be an integer from 1 to ${MEAL_DRAFT_EVALUATION_MAX_CALLS}`);
  }
  const settings = settingsSchema.parse(loadEnvironmentSource());
  const generation = { ...OLLAMA_INSIGHT_GENERATION, maxOutputTokens: settings.MEAL_DRAFTS_MAX_OUTPUT_TOKENS, stream: false };

  let model = 'fake';
  let runtimeVersion: string | null = null;
  let provider;
  if (providerName === 'ollama') {
    model = settings.MEAL_DRAFTS_MODEL?.trim() ?? '';
    if (!isLocalOllamaModel(model)) throw new Error('MEAL_DRAFTS_MODEL must name a local Ollama model');
    if (!isLocalOllamaBaseUrl(settings.MEAL_DRAFTS_OLLAMA_BASE_URL)) throw new Error('MEAL_DRAFTS_OLLAMA_BASE_URL must be a local Ollama origin');
    const baseUrl = new URL(settings.MEAL_DRAFTS_OLLAMA_BASE_URL).origin;
    // Two reads, no inference: the runtime's version and whether the model is ALREADY installed. Nothing is pulled.
    runtimeVersion = ((await ollamaJson(baseUrl, '/api/version')) as { version?: string }).version ?? null;
    const tags = (await ollamaJson(baseUrl, '/api/tags')) as { models?: Array<{ name: string }> };
    if (!(tags.models ?? []).some((entry) => entry.name === model)) {
      console.info(`Model ${model} is not installed in the local Ollama; nothing was pulled. Real-model evaluation: NOT RUN.`);
      process.exitCode = 1;
      return;
    }
    provider = new OllamaProvider({ baseUrl, maxResponseBytes: 32_768, model });
  } else {
    provider = new FakeMealDraftProvider();
  }

  console.info(
    [
      `Set: ${set} v${dataset.datasetVersion} (${dataset.cases.length} cases; digest ${digest.slice(0, 12)}…)`,
      `Provider: ${providerName}${providerName === 'fake' ? ' (harness verification only; NOT model evidence)' : ` ${model}, Ollama ${runtimeVersion ?? 'unknown'}`}`,
      `Calls: at most ${Math.min(maxCalls, dataset.cases.length)}, one per case, sequential, no retries; deadline ${settings.MEAL_DRAFTS_TIMEOUT_MS} ms each`,
    ].join('\n'),
  );
  if (process.argv.includes('--dry-run')) {
    console.info('Dry run: the set and the configuration are valid. No request was made.');
    return;
  }

  const run = await runMealDraftEvaluation({
    cases: dataset.cases,
    clock: systemClock,
    maxCalls,
    maxOutputTokens: settings.MEAL_DRAFTS_MAX_OUTPUT_TOKENS,
    onCase: ({ done, id, total }) => console.info(`  ${done}/${total} ${id}`),
    provider,
    timeoutMs: settings.MEAL_DRAFTS_TIMEOUT_MS,
  });
  const report = buildMealDraftReport({ dataset, digest, generation, model, provider: providerName, run, runtimeVersion, timeoutMs: settings.MEAL_DRAFTS_TIMEOUT_MS });
  console.info(formatMealDraftReport(report));
  const out = argument('out');
  if (out !== undefined) {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.info(`Report written to ${path}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The evaluation failed');
  process.exitCode = 1;
});
