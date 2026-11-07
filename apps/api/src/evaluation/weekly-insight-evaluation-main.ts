import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { isLocalOllamaModel } from '../config/run-search-ai-config.js';
import { isLocalOllamaBaseUrl } from '../config/weekly-insights-config.js';
import { OllamaProvider } from '../insights/ollama-provider.js';
import { WEEKLY_INSIGHT_PROMPT_VERSION } from '../insights/insight-prompt.js';
import { WEEKLY_INSIGHT_POLICY_VERSION } from '../insights/weekly-aggregate.js';
import { evaluateCase, evaluationCases, summarize, type CaseResult, type ModelSummary } from './weekly-insight-evaluation.js';

// npm run eval:weekly-insights -- --models qwen3:4b,qwen3:8b [--base-url http://127.0.0.1:11434] [--out <dir>]
//   [--attempt-timeout-ms 240000] [--total-budget-ms 600000]
// Opt-in, never in CI. Talks only to a local Ollama (the same destination rule as the API). A model that is not
// installed is reported as unavailable, never as passed.

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function ollamaJson(baseUrl: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), {
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' }),
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Ollama ${path} answered ${response.status}`);
  return response.json();
}

const ms = (value: number | null) => (value === null ? 'n/a' : `${(value / 1000).toFixed(1)} s`);

function markdown(summaries: readonly (ModelSummary | { model: string; unavailable: string })[], examples: Record<string, CaseResult[]>): string {
  const lines = [
    `# Weekly insight model evaluation`,
    '',
    `Prompt ${WEEKLY_INSIGHT_PROMPT_VERSION}, policy ${WEEKLY_INSIGHT_POLICY_VERSION}, ${evaluationCases().length} synthetic weeks per model. Small sample: percentages and p95 are indicative only.`,
    '',
    '| model | schema pass | ready | global grounding | scoped grounding | unit/direction | safety | attempts (schema / transport failures) | cold | warm median | warm p95 (n) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const summary of summaries) {
    if ('unavailable' in summary) {
      lines.push(`| ${summary.model} | unavailable: ${summary.unavailable} | | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${summary.model} | ${Math.round(summary.schemaPassRate * 100)}% | ${summary.ready}/${summary.cases} | ${summary.globalGroundingFailures} | ${summary.scopedGroundingFailures} | ${summary.unitDirectionFailures} | ${summary.safetyFailures} | ${summary.totalAttempts} (${summary.totalSchemaFailures} / ${summary.totalTransportFailures}) | ${ms(summary.coldMs)} | ${ms(summary.warmMedianMs)} | ${ms(summary.warmP95Ms)} (${summary.warmSamples}) |`,
    );
  }
  for (const [model, results] of Object.entries(examples)) {
    lines.push('', `## ${model}: per case`, '', '| case | status | reason / violations | attempts | duration |', '| --- | --- | --- | --- | --- |');
    for (const result of results) {
      const violations = [
        ...Object.entries(result.grounding).map(([kind, count]) => `${kind}×${count}`),
        ...result.safetyRules,
        ...(result.suggestionDropped ? ['suggestion dropped (extreme week)'] : []),
      ];
      lines.push(`| ${result.id}${result.cold ? ' (cold)' : ''} | ${result.status} | ${[result.reason, ...violations].filter(Boolean).join(', ') || '-'} | ${result.attempts} | ${ms(result.durationMs)} |`);
    }
    const verbatim = results.filter((result) => result.modelOutput !== null).slice(0, 3);
    for (const result of verbatim) {
      lines.push('', `### ${model}, ${result.id} (${result.status}), verbatim model answer`, '', '```json', JSON.stringify(result.modelOutput, null, 2), '```');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const models = (argument('models') ?? '').split(',').map((model) => model.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('Name the models: --models qwen3:4b,qwen3:8b');
  const baseUrl = argument('base-url', 'http://127.0.0.1:11434')!;
  if (!isLocalOllamaBaseUrl(baseUrl)) throw new Error('--base-url must be a local Ollama origin');
  const out = resolve(argument('out', join(process.cwd(), '.local', 'eval-reports'))!);
  const budget = {
    attemptTimeoutMs: Number(argument('attempt-timeout-ms', '240000')),
    maxAttempts: 3,
    totalBudgetMs: Number(argument('total-budget-ms', '600000')),
  };
  const version = (await ollamaJson(baseUrl, '/api/version')) as { version?: string };
  const tags = (await ollamaJson(baseUrl, '/api/tags')) as { models?: { name: string }[] };
  const installed = new Set((tags.models ?? []).map((entry) => entry.name));
  const cases = evaluationCases();
  const summaries: (ModelSummary | { model: string; unavailable: string })[] = [];
  const perModel: Record<string, CaseResult[]> = {};
  const residency: Record<string, unknown> = {};

  for (const model of models) {
    if (!isLocalOllamaModel(model)) {
      summaries.push({ model, unavailable: 'not a local model name' });
      continue;
    }
    if (!installed.has(model)) {
      summaries.push({ model, unavailable: 'not installed' });
      continue;
    }
    const provider = new OllamaProvider({ baseUrl, maxResponseBytes: 262_144, model });
    // Cold start: unload the model first, so the first case includes loading it.
    await ollamaJson(baseUrl, '/api/generate', { keep_alive: 0, model });
    const results: CaseResult[] = [];
    for (const [index, evaluationCase] of cases.entries()) {
      process.stdout.write(`${model} ${evaluationCase.id} ... `);
      const result = await evaluateCase(evaluationCase, provider, budget, index === 0);
      process.stdout.write(`${result.status} ${(result.durationMs / 1000).toFixed(1)} s\n`);
      results.push(result);
      if (index === 0) residency[model] = await ollamaJson(baseUrl, '/api/ps').catch(() => null);
    }
    perModel[model] = results;
    summaries.push(summarize(model, results));
    await ollamaJson(baseUrl, '/api/generate', { keep_alive: 0, model }).catch(() => undefined);
  }

  await mkdir(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const report = {
    budget,
    cases: cases.map((entry) => entry.id),
    generatedAt: new Date().toISOString(),
    ollamaVersion: version.version ?? null,
    perModel,
    policyVersion: WEEKLY_INSIGHT_POLICY_VERSION,
    promptVersion: WEEKLY_INSIGHT_PROMPT_VERSION,
    residency,
    summaries,
  };
  await writeFile(join(out, `weekly-insights-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const text = markdown(summaries, perModel);
  await writeFile(join(out, `weekly-insights-${stamp}.md`), text);
  process.stdout.write(`\n${text}\nWritten to ${out}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
