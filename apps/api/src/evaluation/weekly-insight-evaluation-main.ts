import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, release, totalmem, type as osType } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { isLocalOllamaModel } from '../config/run-search-ai-config.js';
import { isLocalOllamaBaseUrl } from '../config/weekly-insights-config.js';
import { OLLAMA_INSIGHT_GENERATION, OllamaProvider } from '../insights/ollama-provider.js';
import { WEEKLY_INSIGHT_PROMPT_VERSION, weeklyInsightPromptVersions, type WeeklyInsightPromptVersion } from '../insights/insight-prompt.js';
import { WEEKLY_INSIGHT_POLICY_VERSION } from '../insights/weekly-aggregate.js';
import {
  CallBudget,
  evaluateCase,
  evaluationCases,
  summarize,
  validationCases,
  type CaseResult,
  type ModelSummary,
} from './weekly-insight-evaluation.js';

// npm run eval:weekly-insights -- --models qwen3:4b,qwen3:8b [--cases development|validation]
//   [--prompt weekly-insight-v2|v3|v4] [--max-calls <n>] [--base-url http://127.0.0.1:11434] [--out <dir>]
//   [--attempt-timeout-ms 240000] [--total-budget-ms 600000]
// Opt-in, never in CI. Talks only to a local Ollama (the same destination rule as the API). A model that is not
// installed is reported as unavailable, never as passed. --max-calls is a hard limit on actual provider calls (retries
// and regenerations included) for the whole run: a call beyond it is never sent, the case is reported as cut short by
// the budget, and cases that cannot start are reported as not run.

const MAX_OUTPUT_TOKENS = 800;

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

interface RunHeader {
  callBudget: { limit: number; refused: number; used: number };
  caseSet: string;
  cases: number;
  promptVersion: WeeklyInsightPromptVersion;
}

function markdown(
  header: RunHeader,
  summaries: readonly (ModelSummary | { model: string; unavailable: string })[],
  perModel: Record<string, CaseResult[]>,
  notRun: Record<string, string[]>,
): string {
  const lines = [
    `# Weekly insight model evaluation`,
    '',
    `Prompt ${header.promptVersion}, policy ${WEEKLY_INSIGHT_POLICY_VERSION}, ${header.caseSet} set (${header.cases} synthetic weeks per model). Provider calls: ${header.callBudget.used} of a limit of ${header.callBudget.limit} (${header.callBudget.refused} refused by the limit). Small sample: percentages and p95 are indicative only.`,
    '',
    '| model | schema pass | ready | global grounding | scoped grounding | unit/direction | safety | attempts (schema / transport failures) | timeouts | cold | warm median | warm p95 (n) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const summary of summaries) {
    if ('unavailable' in summary) {
      lines.push(`| ${summary.model} | unavailable: ${summary.unavailable} | | | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${summary.model} | ${Math.round(summary.schemaPassRate * 100)}% | ${summary.ready}/${summary.cases} | ${summary.globalGroundingFailures} | ${summary.scopedGroundingFailures} | ${summary.unitDirectionFailures} | ${summary.safetyFailures} | ${summary.totalAttempts} (${summary.totalSchemaFailures} / ${summary.totalTransportFailures}) | ${summary.timeouts} | ${ms(summary.coldMs)} | ${ms(summary.warmMedianMs)} | ${ms(summary.warmP95Ms)} (${summary.warmSamples}) |`,
    );
  }
  lines.push('', 'Grounding failures by kind (cases with at least one):', '');
  for (const summary of summaries) {
    if ('unavailable' in summary) continue;
    const kinds = Object.entries(summary.groundingCasesByKind).map(([kind, count]) => `${kind} ${count}`);
    lines.push(`- ${summary.model}: ${kinds.join(', ') || 'none'}${summary.casesCutByCallBudget > 0 ? `; ${summary.casesCutByCallBudget} cut short by the call limit` : ''}`);
  }
  for (const [model, results] of Object.entries(perModel)) {
    lines.push('', `## ${model}: per case`, '', '| case | status | reason / violations | attempts | duration |', '| --- | --- | --- | --- | --- |');
    for (const result of results) {
      const violations = [
        ...Object.entries(result.grounding).map(([kind, count]) => `${kind}×${count}`),
        ...result.safetyRules,
        ...(result.suggestionDropped ? ['suggestion dropped (extreme week)'] : []),
        ...(result.cutByCallBudget ? ['cut short by the call limit'] : []),
      ];
      lines.push(`| ${result.id}${result.cold ? ' (cold)' : ''} | ${result.status} | ${[result.reason, ...violations].filter(Boolean).join(', ') || '-'} | ${result.attempts} | ${ms(result.durationMs)} |`);
    }
    for (const id of notRun[model] ?? []) lines.push(`| ${id} | not run (call limit reached) | - | 0 | - |`);
    for (const result of results.filter((entry) => entry.modelOutput !== null)) {
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
  const caseSet = argument('cases', 'development')!;
  if (caseSet !== 'development' && caseSet !== 'validation') throw new Error('--cases must be development or validation');
  const promptVersion = argument('prompt', WEEKLY_INSIGHT_PROMPT_VERSION) as WeeklyInsightPromptVersion;
  if (!weeklyInsightPromptVersions.includes(promptVersion)) throw new Error(`--prompt must be one of ${weeklyInsightPromptVersions.join(', ')}`);
  const out = resolve(argument('out', join(process.cwd(), '.local', 'eval-reports'))!);
  const budget = {
    attemptTimeoutMs: Number(argument('attempt-timeout-ms', '240000')),
    maxAttempts: 3,
    totalBudgetMs: Number(argument('total-budget-ms', '600000')),
  };
  const cases = caseSet === 'validation' ? validationCases() : evaluationCases();
  const callBudget = new CallBudget(Number(argument('max-calls', String(cases.length * models.length * budget.maxAttempts))));
  if (!Number.isInteger(callBudget.limit) || callBudget.limit < 1) throw new Error('--max-calls must be a positive integer');
  const version = (await ollamaJson(baseUrl, '/api/version')) as { version?: string };
  const tags = (await ollamaJson(baseUrl, '/api/tags')) as { models?: { digest?: string; name: string }[] };
  const installed = new Map((tags.models ?? []).map((entry) => [entry.name, entry.digest ?? null]));
  const summaries: (ModelSummary | { model: string; unavailable: string })[] = [];
  const perModel: Record<string, CaseResult[]> = {};
  const notRun: Record<string, string[]> = {};
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
    // Cold start: unload the model first, so the first case includes loading it. (keep_alive 0 with no prompt loads
    // and generates nothing; it is not a provider call.)
    await ollamaJson(baseUrl, '/api/generate', { keep_alive: 0, model });
    const results: CaseResult[] = [];
    for (const [index, evaluationCase] of cases.entries()) {
      if (callBudget.remaining === 0) {
        (notRun[model] ??= []).push(evaluationCase.id);
        continue;
      }
      process.stdout.write(`${model} ${promptVersion} ${evaluationCase.id} ... `);
      const result = await evaluateCase(evaluationCase, provider, budget, index === 0, { callBudget, promptVersion });
      process.stdout.write(`${result.status} ${(result.durationMs / 1000).toFixed(1)} s (calls used ${callBudget.used}/${callBudget.limit})\n`);
      results.push(result);
      if (index === 0) residency[model] = await ollamaJson(baseUrl, '/api/ps').catch(() => null);
    }
    perModel[model] = results;
    summaries.push(summarize(model, results));
    await ollamaJson(baseUrl, '/api/generate', { keep_alive: 0, model }).catch(() => undefined);
  }

  await mkdir(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const header: RunHeader = {
    callBudget: { limit: callBudget.limit, refused: callBudget.refused, used: callBudget.used },
    caseSet,
    cases: cases.length,
    promptVersion,
  };
  const report = {
    budget,
    ...header,
    caseIds: cases.map((entry) => entry.id),
    generatedAt: new Date().toISOString(),
    generation: { ...OLLAMA_INSIGHT_GENERATION, maxOutputTokens: MAX_OUTPUT_TOKENS },
    hardware: { arch: arch(), cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length, os: `${osType()} ${release()}`, totalMemoryBytes: totalmem() },
    modelDigests: Object.fromEntries(models.map((model) => [model, installed.get(model) ?? null])),
    notRun,
    ollamaVersion: version.version ?? null,
    perModel,
    policyVersion: WEEKLY_INSIGHT_POLICY_VERSION,
    residency,
    summaries,
  };
  const base = `weekly-insights-${promptVersion}-${caseSet}-${stamp}`;
  await writeFile(join(out, `${base}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const text = markdown(header, summaries, perModel, notRun);
  await writeFile(join(out, `${base}.md`), text);
  process.stdout.write(`\n${text}\nWritten to ${join(out, base)}.{json,md}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
